"""
gh-pages 브랜치의 각 실행 폴더 status.json을 읽어 집계 파일을 재구성하는 백필 스크립트.

- daily-stats.json / monthly-stats.json : 전체 누적 (캡 없음)
- statuses.json / perf-history.json     : 리포트 목록 노출 윈도우(CAP)만큼 최신순
                                          → 캡에서 밀려난 과거(예: 4월) 데이터 복원용

출력 디렉터리는 첫 번째 인자로 지정(기본 /tmp).
"""
import subprocess, json, re, tarfile, io, sys
from collections import defaultdict

CAP = 500  # update_statuses.py / update_perf.py / 워크플로우 head -N 과 동일하게 유지
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
RUN_RE = re.compile(r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})$')

result = subprocess.run(['git', 'archive', 'origin/gh-pages'], capture_output=True)
if result.returncode != 0:
    print("ERROR: git archive 실패 — git fetch origin gh-pages 먼저 실행하세요")
    raise SystemExit(1)

tf = tarfile.open(fileobj=io.BytesIO(result.stdout))

daily    = defaultdict(lambda: {'PASS': 0, 'WARN': 0, 'FAIL': 0})
monthly  = defaultdict(lambda: {'PASS': 0, 'WARN': 0, 'FAIL': 0})
statuses = {}   # "2026-04-07_18-24" -> "PASS"
perf     = {}   # "2026-04-07_18-24" -> {"serverTimes": {...}}

for member in tf.getmembers():
    if not member.name.endswith('/status.json'):
        continue
    folder = member.name[:-len('/status.json')]
    if not RUN_RE.match(folder):
        continue
    f = tf.extractfile(member)
    if not f:
        continue
    try:
        data = json.loads(f.read())
    except Exception:
        continue
    status = data.get('status', 'UNKNOWN')
    if status in ('PASS', 'WARN', 'FAIL'):
        date = folder[:10]
        daily[date][status]      += 1
        monthly[date[:7]][status] += 1
    statuses[folder] = status
    perf[folder] = {'serverTimes': data.get('serverTimes', {})}

# 캡: 최신순 CAP개만 유지 (목록/스파클라인이 읽는 per-run 데이터)
recent = sorted(statuses.keys(), reverse=True)[:CAP]
statuses_out = {k: statuses[k] for k in recent}
perf_out     = {k: perf[k] for k in recent}

daily_out   = dict(sorted(daily.items()))
monthly_out = dict(sorted(monthly.items()))

with open(f'{OUT}/daily-stats.json', 'w') as f:
    json.dump(daily_out, f, indent=2)
with open(f'{OUT}/monthly-stats.json', 'w') as f:
    json.dump(monthly_out, f, indent=2)
with open(f'{OUT}/statuses.json', 'w') as f:
    json.dump(statuses_out, f)
with open(f'{OUT}/perf-history.json', 'w') as f:
    json.dump(perf_out, f)

print(f"백필 완료 → {OUT}")
print(f"  statuses.json   : {len(statuses_out)}건 (캡 {CAP})")
print(f"  perf-history.json: {len(perf_out)}건")
print(f"  daily-stats.json : {len(daily_out)}일치")
print(f"  monthly-stats.json: {len(monthly_out)}개월치")
for m_key in sorted(monthly_out.keys()):
    d = monthly_out[m_key]
    print(f"    {m_key}  PASS {d['PASS']}  WARN {d['WARN']}  FAIL {d['FAIL']}")
oldest = min(recent) if recent else '-'
print(f"  목록 노출 윈도우 최古: {oldest}")
