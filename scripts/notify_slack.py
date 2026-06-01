"""
Slack 알림 — 상태 전환 시에만 발송(스팸 방지).

발송 조건(워크플로우에서 if로 1차 필터, 여기서 2차 확정):
- 신규 장애 : HEALTH_STATUS == FAIL 이고 PREV_STATUS != FAIL
- 복구      : HEALTH_STATUS != FAIL 이고 PREV_STATUS == FAIL

환경변수:
  SLACK_WEBHOOK_URL (필수 — 없으면 조용히 스킵)
  HEALTH_STATUS, PREV_STATUS, RUN_DATETIME, RUN_URL, PAGES_URL
report-status.json 에서 상세(failCount/warnCount/failures)를 읽는다.
"""
import os, json, sys, urllib.request

WEBHOOK = os.environ.get('SLACK_WEBHOOK_URL', '').strip()
if not WEBHOOK:
    print('SLACK_WEBHOOK_URL 미설정 — 스킵')
    sys.exit(0)

cur  = os.environ.get('HEALTH_STATUS', 'UNKNOWN')
prev = os.environ.get('PREV_STATUS', 'NONE')
_dt = os.environ.get('RUN_DATETIME', '')  # "2026-06-01_15-20"
if '_' in _dt:
    _d, _t = _dt.split('_', 1)
    when = f"{_d} {_t.replace('-', ':')}"
else:
    when = _dt
run_url   = os.environ.get('RUN_URL', '')
pages_url = os.environ.get('PAGES_URL', '')

is_new_fail = cur == 'FAIL' and prev != 'FAIL'
is_recovery = cur != 'FAIL' and prev == 'FAIL'
if not (is_new_fail or is_recovery):
    print(f'전환 아님(cur={cur}, prev={prev}) — 스킵')
    sys.exit(0)

try:
    with open('report-status.json') as f:
        data = json.load(f)
except Exception:
    data = {}
fail_c   = data.get('failCount', 0)
warn_c   = data.get('warnCount', 0)
pass_c   = data.get('passCount', 0)
failures = data.get('failures', []) or []

links = []
if pages_url: links.append(f'<{pages_url}|📊 대시보드>')
if run_url:   links.append(f'<{run_url}|🔧 실행 로그>')
link_line = '   ·   '.join(links)

if is_new_fail:
    header = '🚨 이지랩 헬스체크 *장애 감지*'
    color  = '#e5534b'
    types  = ', '.join(sorted({f.get('type', '-') for f in failures})) or '-'
    lines  = [f'*FAIL {fail_c}* · WARN {warn_c} · PASS {pass_c}', f'영향 범위: *{types}*']
    for i, fr in enumerate(failures[:5], 1):
        st  = fr.get('status', 0)
        st_txt = 'timeout' if not st else str(st)
        lines.append(f"{i}. [{fr.get('type','-')}/{fr.get('lang','-')}] `{st_txt}` {fr.get('url','-')}  — {fr.get('symptom','-')}")
    if len(failures) > 5:
        lines.append(f'…외 {len(failures) - 5}건')
    body = '\n'.join(lines)
else:  # recovery
    header = '✅ 이지랩 헬스체크 *복구됨*'
    color  = '#3fb950'
    body   = f'직전 FAIL → 현재 *{cur}* 로 복구되었습니다.\nPASS {pass_c} · WARN {warn_c} · FAIL {fail_c}'

payload = {
    'attachments': [{
        'color': color,
        'blocks': [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'{header}\n{when} KST'}},
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': body}},
        ] + ([{'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': link_line}]}] if link_line else []),
    }]
}

if os.environ.get('DRY_RUN') == '1':
    print(f'[DRY_RUN] {"신규장애" if is_new_fail else "복구"} 메시지 미리보기:')
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.exit(0)

req = urllib.request.Request(
    WEBHOOK,
    data=json.dumps(payload).encode('utf-8'),
    headers={'Content-Type': 'application/json'},
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f'Slack 발송 완료 ({"신규장애" if is_new_fail else "복구"}) — HTTP {r.status}')
except Exception as e:
    print(f'Slack 발송 실패: {e}')
    sys.exit(1)
