import json, sys

datetime_key = sys.argv[1]
status_val   = sys.argv[2]

with open('/tmp/statuses.json') as f:
    s = json.load(f)

s[datetime_key] = status_val
keys = sorted(s.keys(), reverse=True)[:180]
s = {k: s[k] for k in keys}

with open('/tmp/statuses.json', 'w') as f:
    json.dump(s, f)
