"""
gh-pages 브랜치의 기존 status.json 파일들을 읽어
daily-stats.json과 monthly-stats.json을 재구성하는 일회성 백필 스크립트.
"""
import subprocess, json, re, tarfile, io
from collections import defaultdict

result = subprocess.run(
    ['git', 'archive', 'origin/gh-pages'],
    capture_output=True
)
if result.returncode != 0:
    print("ERROR: git archive 실패 — git fetch origin gh-pages 먼저 실행하세요")
    raise SystemExit(1)

tf = tarfile.open(fileobj=io.BytesIO(result.stdout))

daily   = defaultdict(lambda: {'PASS': 0, 'WARN': 0, 'FAIL': 0})
monthly = defaultdict(lambda: {'PASS': 0, 'WARN': 0, 'FAIL': 0})

for member in tf.getmembers():
    if not member.name.endswith('/status.json'):
        continue
    folder = member.name[:-len('/status.json')]
    m = re.match(r'^(\d{4}-\d{2}-\d{2})', folder)
    if not m:
        continue
    date  = m.group(1)
    month = date[:7]

    f = tf.extractfile(member)
    if not f:
        continue
    try:
        data   = json.loads(f.read())
        status = data.get('status', 'UNKNOWN')
        if status in ('PASS', 'WARN', 'FAIL'):
            daily[date][status]   += 1
            monthly[month][status] += 1
    except Exception:
        pass

daily_out   = dict(sorted(daily.items()))
monthly_out = dict(sorted(monthly.items()))

with open('/tmp/daily-stats.json', 'w') as f:
    json.dump(daily_out, f, indent=2)
with open('/tmp/monthly-stats.json', 'w') as f:
    json.dump(monthly_out, f, indent=2)

print(f"백필 완료: {len(daily_out)}일치 / {len(monthly_out)}개월치")
for m_key in sorted(monthly_out.keys()):
    d = monthly_out[m_key]
    print(f"  {m_key}  PASS {d['PASS']}  WARN {d['WARN']}  FAIL {d['FAIL']}")
