"""
gh-pages 브랜치의 각 실행 폴더 status.json을 읽어 집계 파일을 재구성하는 백필 스크립트.

- daily-stats.json / monthly-stats.json : 전체 누적 (캡 없음)
- statuses.json / perf-history.json     : 리포트 목록 노출 윈도우(CAP)만큼 최신순
                                          → 캡에서 밀려난 과거(예: 4월) 데이터 복원용

출력 디렉터리는 첫 번째 인자로 지정(기본 /tmp).
"""
import subprocess, json, re, tarfile, io, os, sys
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dashboard_metrics import (
    classify_run, merge_bucket, vector_invariant_errors, vector_of,
    STATS_SCHEMA_VERSION, VECTOR_KEYS, AVAILABLE, OUTAGE, INDETERMINATE,
)

CAP = 500  # update_statuses.py / update_perf.py / 워크플로우 head -N 과 동일하게 유지
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
RUN_RE = re.compile(r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})$')

result = subprocess.run(['git', 'archive', 'origin/gh-pages'], capture_output=True)
if result.returncode != 0:
    print("ERROR: git archive 실패 — git fetch origin gh-pages 먼저 실행하세요")
    raise SystemExit(1)

tf = tarfile.open(fileobj=io.BytesIO(result.stdout))

def _empty():
    # 서비스 분류 벡터는 항상 셋을 함께 만든다 — 부분 키 상태를 남기지 않기 위함.
    return {'PASS': 0, 'WARN': 0, 'FAIL': 0, 'avail': 0, 'outage': 0, 'indet': 0}

daily    = defaultdict(_empty)
monthly  = defaultdict(_empty)
statuses = {}   # "2026-04-07_18-24" -> "PASS"
perf     = {}   # "2026-04-07_18-24" -> {"serverTimes": {...}}
coverage = {}   # "2026-04-07_18-24" -> True/False (필드가 있는 런만)
# 불변식 검증용 — 재구성 과정에서 실제로 본 실행 수 (UNKNOWN 포함)
runs_daily   = defaultdict(int)
runs_monthly = defaultdict(int)

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
    daily[date][bkey]       += 1
    monthly[date[:7]][bkey] += 1
    runs_daily[date]        += 1
    runs_monthly[date[:7]]  += 1
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


def _merge(existing, rebuilt):
    """PASS/WARN/FAIL 은 항목별 max(축소 방지), 서비스 분류는 벡터 단위로 교체·보존.

    벡터를 항목별 max 로 섞으면 합이 실제 실행 수를 넘는 조합이 만들어진다
    (기존 가용 10 + 재구성 확인불가 10 → 합 20). 규칙은 dashboard_metrics.merge_bucket 하나에 둔다.
    """
    out = {k: dict(v) for k, v in existing.items()}
    for k, v in rebuilt.items():
        out[k] = merge_bucket(out.get(k, {}), v)
    return out


daily_out   = dict(sorted(_merge(_load_root('daily-stats.json'), daily).items()))
monthly_out = dict(sorted(_merge(_load_root('monthly-stats.json'), monthly).items()))

# ── 불변식 검증 ──────────────────────────────────────────────────
# 이번 재구성이 '권위 있게' 본 구간(실행 폴더가 남아 있는 월·일)에서는
# avail + outage + indet 가 실제로 본 실행 수와 정확히 같아야 한다.
# 어긋나면 벡터가 오염된 것이므로 완료 표시를 남기지 않고 중단한다 —
# 부분 마이그레이션 상태를 '정상'으로 표시하면 대시보드가 잘못된 가용률을 그린다.
errors = (vector_invariant_errors({k: monthly_out[k] for k in runs_monthly}, runs_monthly)
          + vector_invariant_errors({k: daily_out[k] for k in runs_daily}, runs_daily))
if errors:
    print('ERROR: 서비스 분류 벡터 불변식 위반 (avail+outage+indet ≠ 실행 수)')
    for key, got, expected in errors[:10]:
        print(f'  {key}: 벡터합 {got} · 기대 {expected}')
    raise SystemExit(1)

# 재구성 범위 밖(폴더가 prune 된 과거 구간)에 벡터가 없는 항목이 남아 있으면
# 부분 마이그레이션이다. 이 경우에도 완료로 표시하지 않는다.
incomplete = [k for k, v in monthly_out.items() if vector_of(v) is None] \
           + [k for k, v in daily_out.items() if vector_of(v) is None]

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

# 마이그레이션 완료 표시 — 대시보드는 이 표시가 있을 때만 서비스 분류 벡터를 신뢰한다.
meta = {
    'schemaVersion': STATS_SCHEMA_VERSION,
    'backfillComplete': not incomplete,
    'backfilledAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'runsSeen': sum(runs_monthly.values()),
    'months': len(monthly_out),
}
if incomplete:
    meta['incompleteKeys'] = sorted(set(incomplete))[:20]
with open(f'{OUT}/stats-meta.json', 'w') as f:
    json.dump(meta, f, indent=2)

print(f"백필 완료 → {OUT}")
print(f"  stats-meta.json  : schemaVersion {STATS_SCHEMA_VERSION} · "
      f"backfillComplete {meta['backfillComplete']} · 재구성 실행 {meta['runsSeen']}건")
if incomplete:
    print(f"  ※ 벡터가 없는 구간 {len(set(incomplete))}건 — 부분 마이그레이션으로 표시됨 "
          f"(대시보드는 보수적 환산으로 폴백)")
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
