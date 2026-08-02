import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dashboard_metrics import classify_run, AVAILABLE, OUTAGE, INDETERMINATE

datetime_key = sys.argv[1]
status_val   = sys.argv[2]
# 이 런의 점검 완주 여부(report-status.json 의 coverageComplete). 세 번째 인자가 없거나
# 'true'/'false' 가 아니면 None — 완주 여부를 '모른다'는 뜻이며 가용 판정에 쓰지 않는다.
_cov_arg = sys.argv[3].strip().lower() if len(sys.argv) > 3 else ''
coverage = True if _cov_arg == 'true' else False if _cov_arg == 'false' else None

with open('/tmp/statuses.json') as f:
    s = json.load(f)

# 이 datetime_key가 처음 보는 것인지 '덮어쓰기 전에' 판별한다. statuses.json은 key로 dedup되지만
# monthly/daily는 무조건 +1이라, workflow_dispatch가 스케줄과 같은 분(YYYY-MM-DD_HH-MM)에 겹치면
# statuses는 1건인데 누적은 2건으로 갈라진다 → 새 key일 때만 누적 증가시킨다.
is_new_key = datetime_key not in s

s[datetime_key] = status_val
keys = sorted(s.keys(), reverse=True)[:500]
s = {k: s[k] for k in keys}

with open('/tmp/statuses.json', 'w') as f:
    json.dump(s, f)

# coverage.json — 런별 점검 완주 여부.
# 별도 파일로 두는 이유: statuses.json 의 값 타입(문자열)을 바꾸면 notify_slack.py 와
# fail_streak.py 가 함께 깨진다. 대시보드 전용 신호는 대시보드 전용 파일에 담는다.
# 정리 기준은 '자체 상위 500개'가 아니라 statuses.json 에 남은 키다 — 따로 자르면 두 파일의
# 윈도우가 어긋나 statuses 에서 이미 밀려난 런의 완주 기록만 남는다.
try:
    with open('/tmp/coverage.json') as f:
        cov = json.load(f)
    if not isinstance(cov, dict):
        cov = {}
except Exception:
    cov = {}
if coverage is not None:
    cov[datetime_key] = coverage
# 손상된 값(불리언 아님)은 버린다 — 완주 여부를 '모름'으로 두는 편이 잘못된 가용 판정보다 낫다.
cov = {k: v for k, v in cov.items() if k in s and isinstance(v, bool)}
with open('/tmp/coverage.json', 'w') as f:
    json.dump(cov, f)

# 월별·일별 집계에 담을 서비스 분류 키. PASS/WARN/FAIL 카운트는 기존 그대로 두고
# (과거 기록을 고쳐 쓰지 않는다) 새 키만 덧붙인다.
bucket_key = {AVAILABLE: 'avail', OUTAGE: 'outage', INDETERMINATE: 'indet'}[
    classify_run(status_val, coverage)]

# monthly-stats.json 누적 업데이트
try:
    with open('/tmp/monthly-stats.json') as f:
        monthly = json.load(f)
except Exception:
    monthly = {}

month_key = datetime_key[:7]  # "2026-05"
if month_key not in monthly:
    monthly[month_key] = {'PASS': 0, 'WARN': 0, 'FAIL': 0}

if is_new_key and status_val in ('PASS', 'WARN', 'FAIL'):
    monthly[month_key][status_val] += 1
if is_new_key:
    # UNKNOWN 도 서비스 분류(확인 불가)에는 잡힌다 — 위 PASS/WARN/FAIL 카운트와 분모가 다르다.
    monthly[month_key][bucket_key] = monthly[month_key].get(bucket_key, 0) + 1

with open('/tmp/monthly-stats.json', 'w') as f:
    json.dump(monthly, f)

# daily-stats.json 누적 업데이트
try:
    with open('/tmp/daily-stats.json') as f:
        daily = json.load(f)
except Exception:
    daily = {}

day_key = datetime_key[:10]  # "2026-05-28"
if day_key not in daily:
    daily[day_key] = {'PASS': 0, 'WARN': 0, 'FAIL': 0}

if is_new_key and status_val in ('PASS', 'WARN', 'FAIL'):
    daily[day_key][status_val] += 1
if is_new_key:
    daily[day_key][bucket_key] = daily[day_key].get(bucket_key, 0) + 1

with open('/tmp/daily-stats.json', 'w') as f:
    json.dump(daily, f)
