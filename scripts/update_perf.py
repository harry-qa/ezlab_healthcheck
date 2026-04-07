import json, sys

datetime_key = sys.argv[1]

with open('/tmp/perf-history.json') as f:
    h = json.load(f)

try:
    with open('report-status.json') as f:
        d = json.load(f)
    h[datetime_key] = {'serverTimes': d.get('serverTimes', {})}
except Exception:
    h[datetime_key] = {}

keys = sorted(h.keys(), reverse=True)[:180]
h = {k: h[k] for k in keys}

with open('/tmp/perf-history.json', 'w') as f:
    json.dump(h, f)
