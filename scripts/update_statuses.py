import json, sys

datetime_key = sys.argv[1]
status_val   = sys.argv[2]

with open('/tmp/statuses.json') as f:
    s = json.load(f)

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

if status_val in ('PASS', 'WARN', 'FAIL'):
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

if status_val in ('PASS', 'WARN', 'FAIL'):
    daily[day_key][status_val] += 1

with open('/tmp/daily-stats.json', 'w') as f:
    json.dump(daily, f)
