"""
gh-pages 브랜치의 각 실행 폴더 status.json을 읽어 집계 파일을 재구성하는 백필 스크립트.

- daily-stats.json / monthly-stats.json : 전체 누적 (캡 없음)
- statuses.json / perf-history.json     : 리포트 목록 노출 윈도우(CAP)만큼 최신순
                                          → 캡에서 밀려난 과거(예: 4월) 데이터 복원용

출력 디렉터리는 첫 번째 인자로 지정(기본 /tmp).
"""
import subprocess, json, re, tarfile, io, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dashboard_metrics import classify_run, AVAILABLE, OUTAGE, INDETERMINATE

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
coverage = {}   # "2026-04-07_18-24" -> True/False (필드가 있는 런만)

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
    date = folder[:10]
    if status in ('PASS', 'WARN', 'FAIL'):
        daily[date][status]      += 1
        monthly[date[:7]][status] += 1
    # 서비스 분류 버킷 — coverageComplete 가 없는 과거 런은 None 이라 WARN 이 확인 불가로 잡힌다.
    cov = data.get('coverageComplete', None)
    bkey = {AVAILABLE: 'avail', OUTAGE: 'outage', INDETERMINATE: 'indet'}[classify_run(status, cov)]
    daily[date][bkey]       = daily[date].get(bkey, 0) + 1
    monthly[date[:7]][bkey] = monthly[date[:7]].get(bkey, 0) + 1
    if cov is not None:
        coverage[folder] = cov
    statuses[folder] = status
    perf[folder] = {'serverTimes': data.get('serverTimes', {})}

# 캡: 최신순 CAP개만 유지 (목록/스파클라인이 읽는 per-run 데이터)
recent = sorted(statuses.keys(), reverse=True)[:CAP]
statuses_out = {k: statuses[k] for k in recent}
perf_out     = {k: perf[k] for k in recent}

# 기존 집계(gh-pages 루트)와 '축소 방지' 병합 — prune로 원본 실행 폴더가 삭제된 뒤 백필을 돌리면
# 살아남은 폴더만으로 재구성돼 과거 월/일 누적이 줄어드는 footgun이 있었다(모듈 docstring 경고).
# 항목별 max를 취해 과거 데이터가 절대 줄지 않게 한다. 폴더가 모두 사라진 과거 월도 기존값으로 보존.
def _load_root(name):
    try:
        return json.loads(tf.extractfile(tf.getmember(name)).read())
    except Exception:
        return {}


def _merge_max(existing, rebuilt):
    out = {k: dict(v) for k, v in existing.items()}
    for k, v in rebuilt.items():
        if k not in out:
            out[k] = dict(v)
        else:
            # 서비스 분류 버킷도 같은 '축소 방지' 규칙을 따른다 — prune 로 폴더가 사라진 구간의
            # 누적이 재구성 때문에 줄어들면 안 된다.
            for s in ('PASS', 'WARN', 'FAIL', 'avail', 'outage', 'indet'):
                merged = max(int(out[k].get(s, 0)), int(v.get(s, 0)))
                if merged or s in out[k] or s in v:
                    out[k][s] = merged
    return out


daily_out   = dict(sorted(_merge_max(_load_root('daily-stats.json'), daily).items()))
monthly_out = dict(sorted(_merge_max(_load_root('monthly-stats.json'), monthly).items()))

with open(f'{OUT}/daily-stats.json', 'w') as f:
    json.dump(daily_out, f, indent=2)
with open(f'{OUT}/monthly-stats.json', 'w') as f:
    json.dump(monthly_out, f, indent=2)
with open(f'{OUT}/statuses.json', 'w') as f:
    json.dump(statuses_out, f)
with open(f'{OUT}/perf-history.json', 'w') as f:
    json.dump(perf_out, f)
coverage_out = {k: coverage[k] for k in recent if k in coverage}
with open(f'{OUT}/coverage.json', 'w') as f:
    json.dump(coverage_out, f)

print(f"백필 완료 → {OUT}")
print(f"  statuses.json   : {len(statuses_out)}건 (캡 {CAP})")
print(f"  perf-history.json: {len(perf_out)}건")
print(f"  coverage.json   : {len(coverage_out)}건 (완주 여부가 기록된 런만)")
print(f"  daily-stats.json : {len(daily_out)}일치")
print(f"  monthly-stats.json: {len(monthly_out)}개월치")
for m_key in sorted(monthly_out.keys()):
    d = monthly_out[m_key]
    print(f"    {m_key}  PASS {d['PASS']}  WARN {d['WARN']}  FAIL {d['FAIL']}"
          f"   |  가용 {d.get('avail', 0)}  장애 {d.get('outage', 0)}  확인불가 {d.get('indet', 0)}")
oldest = min(recent) if recent else '-'
print(f"  목록 노출 윈도우 최古: {oldest}")
