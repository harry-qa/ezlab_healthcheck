import json, sys

datetime_key = sys.argv[1]

with open('/tmp/perf-history.json') as f:
    h = json.load(f)

try:
    with open('report-status.json') as f:
        d = json.load(f)
    # certs: 최신 런의 SSL 인증서 스냅샷도 함께 저장 → 대시보드 인증서 패널이 읽는다.
    h[datetime_key] = {'serverTimes': d.get('serverTimes', {}), 'certs': d.get('certs', [])}
except Exception:
    h[datetime_key] = {}

keys = sorted(h.keys(), reverse=True)[:500]
h = {k: h[k] for k in keys}

with open('/tmp/perf-history.json', 'w') as f:
    json.dump(h, f)
