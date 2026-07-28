"""
Slack 알림 — 디바운스 기반 발송(스팸 방지).

발송 조건(워크플로우에서 if로 1차 필터, 여기서 2차 확정):
- 장애 감지 : FAIL이 연속 FAIL_ALERT_THRESHOLD(기본 2)런 이어졌을 때 첫 알림.
              단발 blip(1런 FAIL 후 자동 회복)은 침묵. 이후 FAIL 지속 시 매 런 '지속 중' 재알림.
- 실행 실패 : HEALTH_STATUS == UNKNOWN — 테스트가 완주하지 못해 결과 파일이 없음.
              사이트가 아니라 헬스체크 자체의 이상이라 방치되면 감시 공백이 생기므로 즉시(1회부터) 알림.
- 간헐 불안정: 연속은 아니지만 최근 FLAP_WINDOW(기본 6)런 중 FLAP_DOWNS(기본 3)회 이상 다운.
              FAIL↔PASS/WARN을 오가는 flapping이 연속 임계에 안 걸려 침묵하는 사각 보완.
              조건을 '새로 넘는 순간' 1회만 발송(에피소드당 1회) — 복구 알림 없음.
- 복구      : PASS/WARN 전환 && 직전 장애가 실제 알림된 수준(연속 임계 도달 또는 UNKNOWN)이었을 때 1회.

환경변수:
  SLACK_WEBHOOK_URL (필수 — 없으면 조용히 스킵)
  HEALTH_STATUS, PREV_STATUS, RECENT_STATUSES(최신→과거, 현재 런 제외), RUN_DATETIME, RUN_URL, PAGES_URL
  FAIL_ALERT_THRESHOLD(기본 2), FLAP_WINDOW(기본 6), FLAP_DOWNS(기본 3)
report-status.json 에서 상세(failCount/warnCount/failures)를 읽는다.
"""
import os, json, sys, time, urllib.request

WEBHOOK = os.environ.get('SLACK_WEBHOOK_URL', '').strip()
if not WEBHOOK:
    print('SLACK_WEBHOOK_URL 미설정 — 스킵')
    sys.exit(0)

# 일시적 네트워크 오류로 알림(특히 FAIL)이 유실되지 않도록 재시도+백오프.
# 과거 FAIL 알림이 단일 urlopen timeout으로 그대로 날아간 사례가 있어 도입.
ATTEMPTS = 4
TIMEOUT = 15


def post(payload, label=''):
    if os.environ.get('DRY_RUN') == '1':
        print(f'[DRY_RUN] {label} 미리보기:')
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    data = json.dumps(payload).encode('utf-8')
    last_err = None
    for i in range(1, ATTEMPTS + 1):
        req = urllib.request.Request(
            WEBHOOK, data=data, headers={'Content-Type': 'application/json'},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                print(f'Slack 발송 완료 ({label}) — HTTP {r.status} (시도 {i}/{ATTEMPTS})')
                return
        except Exception as e:
            last_err = e
            print(f'Slack 발송 시도 {i}/{ATTEMPTS} 실패: {e}')
            if i < ATTEMPTS:
                backoff = min(2 ** i, 30)  # 2s, 4s, 8s...
                time.sleep(backoff)
    print(f'Slack 발송 최종 실패 ({label}): {last_err}')
    sys.exit(1)


# 연동 테스트 모드 (Actions의 'Slack 연동 테스트' 워크플로우에서 사용)
if os.environ.get('SLACK_TEST') == '1':
    post({'attachments': [{'color': '#58a6ff', 'blocks': [
        {'type': 'section', 'text': {'type': 'mrkdwn',
         'text': '🔔 *이지랩 헬스체크* · Slack 연동 테스트\n이 메시지가 보이면 웹훅 설정이 정상입니다 ✅'}},
    ]}]}, '테스트')
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

# 최근 상태 이력(현재 런 제외, 최신→과거) — 단발 blip 억제(디바운스)에 사용.
recent = [s for s in os.environ.get('RECENT_STATUSES', '').split(',') if s]
if not recent and prev not in ('', 'NONE'):
    recent = [prev]  # 폴백: RECENT 미전달 시 직전 상태만이라도 사용
# FAIL은 연속 N런부터 알림(단발 오탐 억제). UNKNOWN은 즉시 알림(헬스체크 자체 이상이라 방치 위험).
THRESHOLD = max(1, int(os.environ.get('FAIL_ALERT_THRESHOLD', '2')))


def _down(s):
    return s in ('FAIL', 'UNKNOWN')


# 현재까지 이어진 다운(FAIL/UNKNOWN) 스트릭 길이(현재 런 포함) — 복구 알림 판정에 사용
streak = 0
if _down(cur):
    streak = 1
    for s in recent:
        if _down(s):
            streak += 1
        else:
            break
# FAIL 전용 스트릭 — 사이트 '장애 감지' 알림은 연속 FAIL만으로 판정한다.
# UNKNOWN(테스트 미완주=인프라 이상)은 아래에서 1회부터 즉시 별도 알림되므로, 여기에 섞으면
# UNKNOWN 직후 단발 FAIL이 streak=2를 채워 실제 사이트 장애처럼 '장애 감지'로 오승격된다(QA-17).
fail_streak = 0
if cur == 'FAIL':
    fail_streak = 1
    for s in recent:
        if s == 'FAIL':
            fail_streak += 1
        else:
            break
# 현재 직전까지 이어졌던 다운 스트릭 길이 — 복구 알림을 낼지(=직전 장애가 실제 알림됐는지) 판단용
prev_streak = 0
for s in recent:
    if _down(s):
        prev_streak += 1
    else:
        break

is_fail     = cur == 'FAIL'
is_unknown  = cur == 'UNKNOWN'                       # 테스트 미완주 — 헬스체크 자체 이상
# UNKNOWN은 1회부터, FAIL은 연속 FAIL THRESHOLD회부터 알림
down_alert  = is_unknown or (is_fail and fail_streak >= THRESHOLD)
is_new_fail = is_fail and fail_streak == THRESHOLD   # 임계 도달 첫 알림 = '장애 감지', 이후 = '지속 중'
# 복구: 정상 전환 && 직전 장애가 '실제로 알림된' 수준이었을 때만 — 단발 blip 자동회복은 침묵.
prev_alerted = prev_streak >= THRESHOLD or (bool(recent) and recent[0] == 'UNKNOWN')
is_recovery  = cur in ('PASS', 'WARN') and _down(prev) and prev_alerted

# 간헐 불안정(flapping): FAIL↔PASS/WARN 교차는 연속 임계에 안 걸려 위 로직만으론 영원히 침묵한다.
# → 최근 W런(현재 포함) 중 다운이 K회 이상이면 '불안정'으로 1회 알림.
#   직전 런 시점의 창(현재 제외)에서는 K 미만이었을 때만 발송 = 조건을 '새로 넘는 순간'에만 울려
#   flapping이 이어져도 에피소드당 1회로 끝난다. 복구 알림은 내지 않는다(복구-재발 반복 스팸 방지).
FLAP_WINDOW = max(2, int(os.environ.get('FLAP_WINDOW', '6')))
FLAP_DOWNS  = max(2, int(os.environ.get('FLAP_DOWNS', '3')))
downs_now   = sum(1 for s in [cur] + recent[:FLAP_WINDOW - 1] if _down(s))
downs_prev  = sum(1 for s in recent[:FLAP_WINDOW] if _down(s))
is_unstable = (_down(cur) and not down_alert
               and downs_now >= FLAP_DOWNS and downs_prev < FLAP_DOWNS)

if not (down_alert or is_unstable or is_recovery):
    print(f'알림 대상 아님(cur={cur}, prev={prev}, streak={streak}, prev_streak={prev_streak}, '
          f'thr={THRESHOLD}, downs={downs_now}/{FLAP_WINDOW}) — 스킵')
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
# report-status.json 의 failures 는 FAIL+WARN+INFO 혼합 기록 — 장애 알림엔 실제 FAIL만 나열한다.
# severity 미지정(None)이 FAIL이므로 '제외할 등급'을 나열하는 방식으로 필터한다. 새 등급이 생겼을 때
# != 'WARN' 식으로 두면 그 등급이 조용히 장애 목록에 섞여 들어간다(INFO 도입 시 실제로 그럴 뻔했음).
fail_only = [f for f in failures if f.get('severity') not in ('WARN', 'INFO')]

links = []
if pages_url: links.append(f'<{pages_url}|📊 대시보드>')
if run_url:   links.append(f'<{run_url}|🔧 실행 로그>')
link_line = '   ·   '.join(links)

if is_unknown:
    header = '⚠️ 이지랩 헬스체크 *실행 실패*'
    color  = '#d29922'
    body   = ('테스트가 완주하지 못해 결과 파일이 생성되지 않았습니다.\n'
              '(브라우저 크래시 / 전체 타임아웃 / 의존성 설치 실패 가능성)\n'
              '이번 런에서는 *사이트 상태가 확인되지 않았습니다* — 실행 로그를 확인해주세요.')
elif is_unstable:
    header = '🟠 이지랩 헬스체크 *간헐 장애 (불안정)*'
    color  = '#d29922'
    lines  = [f'최근 {FLAP_WINDOW}런 중 *{downs_now}회* 실패 — 연속은 아니지만 반복되고 있습니다.',
              f'이번 런: *FAIL {fail_c}* · WARN {warn_c} · PASS {pass_c}']
    for i, fr in enumerate(fail_only[:5], 1):
        st  = fr.get('status', 0)
        st_txt = 'timeout' if not st else str(st)
        lines.append(f"{i}. [{fr.get('type','-')}/{fr.get('lang','-')}] `{st_txt}` {fr.get('url','-')}  — {fr.get('symptom','-')}")
    lines.append('간헐 장애는 이 알림 1회만 발송됩니다 — 추이는 대시보드를 확인해주세요.')
    body = '\n'.join(lines)
elif is_fail:
    header = '🚨 이지랩 헬스체크 *장애 감지*' if is_new_fail else '🚨 이지랩 헬스체크 *장애 지속 중*'
    color  = '#e5534b'
    types  = ', '.join(sorted({f.get('type', '-') for f in fail_only})) or '-'
    # 연속 실패 횟수를 항상 본문에 남긴다. 첫 '장애 감지' 알림의 POST가 4회 재시도까지 모두 실패해
    # 유실돼도(이후 런은 '지속 중'만 발송), 이 줄로 '몇 회째 지속'인지가 채널에 남아 시작 시점을 알 수 있다.
    lines  = [f'*FAIL {fail_c}* · WARN {warn_c} · PASS {pass_c}',
              f'영향 범위: *{types}*', f'연속 실패: *{fail_streak}회째*']
    for i, fr in enumerate(fail_only[:5], 1):
        st  = fr.get('status', 0)
        st_txt = 'timeout' if not st else str(st)
        lines.append(f"{i}. [{fr.get('type','-')}/{fr.get('lang','-')}] `{st_txt}` {fr.get('url','-')}  — {fr.get('symptom','-')}")
    if len(fail_only) > 5:
        lines.append(f'…외 {len(fail_only) - 5}건')
    body = '\n'.join(lines)
else:  # recovery
    header = '✅ 이지랩 헬스체크 *복구됨*'
    color  = '#3fb950'
    body   = f'직전 {prev} → 현재 *{cur}* 로 복구되었습니다.\nPASS {pass_c} · WARN {warn_c} · FAIL {fail_c}'

payload = {
    'attachments': [{
        'color': color,
        'blocks': [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'{header}\n{when} KST'}},
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': body}},
        ] + ([{'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': link_line}]}] if link_line else []),
    }]
}

label = ('실행실패' if is_unknown else
         '간헐불안정' if is_unstable else
         '신규장애' if is_new_fail else
         '장애지속' if is_fail else '복구')
post(payload, label)
