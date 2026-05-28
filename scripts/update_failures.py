import json, sys

datetime_key = sys.argv[1]

try:
    with open('/tmp/failures-history.json') as f:
        history = json.load(f)
except Exception:
    history = {}

try:
    with open('report-status.json') as f:
        data = json.load(f)
    failures = data.get('failures', [])[:20]
except Exception:
    failures = []

if failures:
    history[datetime_key] = failures

keys = sorted(history.keys(), reverse=True)[:180]
history = {k: history[k] for k in keys}

with open('/tmp/failures-history.json', 'w') as f:
    json.dump(history, f)
