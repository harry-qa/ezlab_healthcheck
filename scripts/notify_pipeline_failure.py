"""Slack 알림 — 헬스체크 '파이프라인 자체'가 깨졌을 때.

notify_slack.py 는 사이트 상태(FAIL/UNKNOWN/복구)를 알린다. 그런데 그 판단 재료
(HEALTH_STATUS 등)는 '리포트 저장' 단계가 끝나야 생긴다. 그 앞 단계 — 패키지 설치,
타입 체크, 판정 규칙 테스트, 브라우저 설치 — 나 리포트 생성·Pages 배포가 실패하면,
예전엔 알림 단계가 통째로 건너뛰어져 **사이트가 실제로 죽어 있어도 채널이 조용했다.**
대시보드도 마지막 '정상'에서 멈춰 감시 공백이 드러나지 않았다.

워크플로의 마지막 단계에서 `if: failure()` 로 불린다. 어느 단계가 실패했는지는
워크플로가 단계별 결과를 환경변수(STEP_<이름>=success|failure|skipped)로 넘겨준다.

반복 억제: 계속 깨져 있으면(예: main 에 타입 오류) 30분마다 울려 채널이 무뎌진다. 직전 운영
런들의 결과를 GitHub 에서 읽어, 연속 실패의 첫 회와 그 뒤 REPEAT_EVERY 회(기본 6 = 3시간)마다만
보낸다. 결과를 못 읽으면 보낸다 — 알림을 놓치는 것보다 한 번 더 받는 게 낫다.

환경변수:
  SLACK_WEBHOOK_URL (필수 — 없으면 조용히 스킵)
  RUN_URL, PAGES_URL, HEALTH_STATUS(있으면 표시)
  STEP_* — 단계 이름 → 결과
  GH_TOKEN, RUN_ID — 직전 런 조회용 (PREV_FAILS 를 주면 조회 대신 그 값을 쓴다 — 테스트용)
  PIPELINE_ALERT_REPEAT — 연속 실패 시 몇 런마다 다시 알릴지 (기본 6)
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

WEBHOOK = os.environ.get('SLACK_WEBHOOK_URL', '').strip()
ATTEMPTS = 4
TIMEOUT = 15
REPEAT_EVERY = max(1, int(os.environ.get('PIPELINE_ALERT_REPEAT', '6')))
# 이 결론이면 '점검이 제대로 안 돈 런'으로 센다. cancelled 는 동시 실행 그룹에서 밀려 취소된
# 대기 런도 포함돼 세지 않는다.
FAILED_CONCLUSIONS = {'failure', 'timed_out'}


def previous_consecutive_failures(env=os.environ):
    """이번 런 직전까지 운영 런(main 정기 스케줄)이 연속으로 실패한 횟수. 모르면 0."""
    if env.get('PREV_FAILS', '').strip():
        return int(env['PREV_FAILS'])
    try:
        out = subprocess.run(
            ['gh', 'run', 'list', '--workflow', 'ezlab-health-check.yml', '--branch', 'main',
             '--event', 'schedule', '--status', 'completed', '--limit', '60',
             '--json', 'databaseId,conclusion'],
            capture_output=True, text=True, timeout=30)
        runs = json.loads(out.stdout or '[]')
    except Exception as e:
        print(f'직전 런 조회 실패 — 억제 없이 보낸다: {e}')
        return 0
    n = 0
    for r in runs:
        if str(r.get('databaseId')) == env.get('RUN_ID', ''):
            continue
        if r.get('conclusion') in FAILED_CONCLUSIONS:
            n += 1
        else:
            break
    return n


def should_send(prev_fails):
    """연속 실패의 첫 회, 그리고 그 뒤 REPEAT_EVERY 회마다."""
    return prev_fails == 0 or (prev_fails + 1) % REPEAT_EVERY == 0

# 환경변수 이름 → 사람이 읽는 단계 이름 (워크플로 순서대로)
STEP_LABELS = [
    ('STEP_INSTALL',   '패키지 설치 (npm ci)'),
    ('STEP_TYPECHECK', '타입 체크'),
    ('STEP_BROWSER',   'Playwright 브라우저 설치'),
    ('STEP_JUDGE',     '판정 규칙 테스트'),
    ('STEP_REPORT',    '리포트 저장·인덱스 생성'),
    ('STEP_PAGES',     'GitHub Pages 배포'),
]


def failed_steps(env=os.environ):
    return [label for key, label in STEP_LABELS if env.get(key) == 'failure']


def build_payload(env=os.environ, prev_fails=0):
    now = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d %H:%M')
    steps = failed_steps(env)
    status = env.get('HEALTH_STATUS', '').strip()
    lines = []
    if prev_fails:
        lines.append(f'*{prev_fails + 1}회 연속* 실패 중 — {REPEAT_EVERY}회({REPEAT_EVERY // 2}시간)마다 다시 알립니다.')
    if steps:
        lines.append('실패한 단계: *' + '*, *'.join(steps) + '*')
    else:
        lines.append('실패한 단계를 특정하지 못했습니다 — 실행 로그를 확인해 주세요.')
    if status:
        lines.append(f'이번 런의 사이트 점검 결과: *{status}* (사이트 장애 알림은 연속 여부에 따라 따로 판단합니다)')
    else:
        lines.append('이번 런에서는 *사이트 상태가 확인되지 않았습니다.*')
    lines.append('헬스체크가 이 상태로 계속 실패하면 장애가 나도 알림이 가지 않습니다 — 먼저 복구해 주세요.')

    links = []
    if env.get('PAGES_URL'):
        links.append(f"<{env['PAGES_URL']}|📊 대시보드>")
    if env.get('RUN_URL'):
        links.append(f"<{env['RUN_URL']}|🔧 실행 로그>")
    blocks = [
        {'type': 'section', 'text': {'type': 'mrkdwn',
                                     'text': f'⚠️ 이지랩 헬스체크 *파이프라인 실패*\n{now} KST'}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(lines)}},
    ]
    if links:
        blocks.append({'type': 'context',
                       'elements': [{'type': 'mrkdwn', 'text': '   ·   '.join(links)}]})
    return {'attachments': [{'color': '#d29922', 'blocks': blocks}]}


def post(payload):
    if os.environ.get('DRY_RUN') == '1':
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    data = json.dumps(payload).encode('utf-8')
    last_err = None
    for i in range(1, ATTEMPTS + 1):
        req = urllib.request.Request(WEBHOOK, data=data,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                print(f'Slack 발송 완료 (파이프라인 실패) — HTTP {r.status} (시도 {i}/{ATTEMPTS})')
                return
        except Exception as e:
            last_err = e
            print(f'Slack 발송 시도 {i}/{ATTEMPTS} 실패: {e}')
            if i < ATTEMPTS:
                time.sleep(min(2 ** i, 30))
    print(f'Slack 발송 최종 실패 (파이프라인 실패): {last_err}')
    sys.exit(1)


if __name__ == '__main__':
    if not WEBHOOK and os.environ.get('DRY_RUN') != '1':
        print('SLACK_WEBHOOK_URL 미설정 — 스킵')
        sys.exit(0)
    prev = previous_consecutive_failures()
    if not should_send(prev):
        print(f'연속 {prev + 1}회째 실패 — 반복 알림 억제 ({REPEAT_EVERY}회마다 발송)')
        sys.exit(0)
    post(build_payload(prev_fails=prev))
