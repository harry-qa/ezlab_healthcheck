import json, sys

datetime_key = sys.argv[1]
status_val   = sys.argv[2]

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

with open('/tmp/daily-stats.json', 'w') as f:
    json.dump(daily, f)
