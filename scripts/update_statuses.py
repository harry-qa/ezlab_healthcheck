"""런 1건의 결과를 상태 이력·누적 집계에 반영한다 (운영 런에서만 호출).

같은 실행 ID 가 다시 처리되는 경우가 실제로 있다 — workflow_dispatch 가 스케줄과 같은 분에
겹치거나, 실패한 런을 재실행하면 같은 `YYYY-MM-DD_HH-MM` 키로 다시 들어온다.
statuses.json 은 key 로 덮어써서 문제가 없지만 monthly/daily 는 누적이라, 예전에는
'새 키일 때만 +1' 로 중복만 막았다. 그러면 재처리로 판정이 바뀌었을 때(WARN → PASS)
과거 분류가 그대로 남아 집계가 실제와 어긋난다.
→ 이전 분류를 빼고 새 분류를 더하는 upsert 로 처리한다.

한계: statuses.json 은 최근 500건만 유지하므로, 그보다 오래된 런을 재처리하면 '이전 값'을
알 수 없어 새 실행으로 간주된다(중복 가산). 런은 발생 직후 1회 처리되므로 실무에서는
발생하지 않지만, 아주 오래된 런을 수동 재처리할 때는 backfill_stats.py 로 재구성해야 한다.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dashboard_metrics import classify_run, VECTOR_KEYS, AVAILABLE, OUTAGE, INDETERMINATE

datetime_key = sys.argv[1]
status_val   = sys.argv[2]
# 이 런의 점검 완주 여부(report-status.json 의 coverageComplete). 세 번째 인자가 없거나
# 'true'/'false' 가 아니면 None — 완주 여부를 '모른다'는 뜻이며 가용 판정에 쓰지 않는다.
_cov_arg = sys.argv[3].strip().lower() if len(sys.argv) > 3 else ''
coverage = True if _cov_arg == 'true' else False if _cov_arg == 'false' else None

BUCKET_KEY = {AVAILABLE: 'avail', OUTAGE: 'outage', INDETERMINATE: 'indet'}

with open('/tmp/statuses.json') as f:
    s = json.load(f)

try:
    with open('/tmp/coverage.json') as f:
        cov = json.load(f)
    if not isinstance(cov, dict):
        cov = {}
except Exception:
    cov = {}

# ── 이전 처리 결과 (upsert 판단 근거) ─────────────────────────────
# 덮어쓰기 '전에' 읽어야 한다. 없으면 이 런은 처음 처리되는 것이다.
prev_status   = s.get(datetime_key)
prev_coverage = cov.get(datetime_key) if isinstance(cov.get(datetime_key), bool) else None
is_new_key    = prev_status is None
unchanged     = (not is_new_key) and prev_status == status_val and prev_coverage == coverage

s[datetime_key] = status_val
keys = sorted(s.keys(), reverse=True)[:500]
s = {k: s[k] for k in keys}

with open('/tmp/statuses.json', 'w') as f:
    json.dump(s, f)

# coverage.json — 런별 점검 완주 여부.
# 별도 파일로 두는 이유: statuses.json 의 값 타입(문자열)을 바꾸면 notify_slack.py 와
# fail_streak.py 가 함께 깨진다. 대시보드 전용 신호는 대시보드 전용 파일에 담는다.
# 정리 기준은 '자체 상위 500개'가 아니라 statuses.json 에 남은 키다 — 따로 자르면 두 파일의
# 윈도우가 어긋나 statuses 에서 이미 밀려난 런의 완주 기록만 남는다.
if coverage is None:
    cov.pop(datetime_key, None)   # 완주 여부를 모르게 됐으면 옛 값을 남겨두지 않는다
else:
    cov[datetime_key] = coverage
# 손상된 값(불리언 아님)은 버린다 — 완주 여부를 '모름'으로 두는 편이 잘못된 가용 판정보다 낫다.
cov = {k: v for k, v in cov.items() if k in s and isinstance(v, bool)}
with open('/tmp/coverage.json', 'w') as f:
    json.dump(cov, f)


def apply_delta(bucket, status, cov_val, sign):
    """원본 카운트(PASS/WARN/FAIL)와 서비스 분류 벡터를 함께 증감한다.

    둘을 따로 다루면 재처리 때 한쪽만 갱신돼 합이 어긋난다 → 항상 같은 함수로 묶어 처리한다.
    음수 방지: 집계가 손상돼 있어도 0 아래로 내려가지 않게 한다.
    """
    if status in ('PASS', 'WARN', 'FAIL'):
        bucket[status] = max(0, int(bucket.get(status, 0)) + sign)
    key = BUCKET_KEY[classify_run(status, cov_val)]
    bucket[key] = max(0, int(bucket.get(key, 0)) + sign)


def upsert(path, key):
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}

    bucket = data.setdefault(key, {'PASS': 0, 'WARN': 0, 'FAIL': 0})
    for field in ('PASS', 'WARN', 'FAIL'):
        bucket.setdefault(field, 0)
    # 벡터 키는 '한 벌'로만 존재해야 한다 — 부분 키 상태를 만들지 않도록 셋을 함께 초기화한다.
    for vkey in VECTOR_KEYS:
        bucket.setdefault(vkey, 0)

    if unchanged:
        pass                                        # 완전한 no-op — 같은 값 재처리
    elif is_new_key:
        apply_delta(bucket, status_val, coverage, +1)
    else:
        apply_delta(bucket, prev_status, prev_coverage, -1)   # 이전 분류 회수
        apply_delta(bucket, status_val, coverage, +1)         # 새 분류로 이동

    with open(path, 'w') as f:
        json.dump(data, f)


upsert('/tmp/monthly-stats.json', datetime_key[:7])   # "2026-05"
upsert('/tmp/daily-stats.json',   datetime_key[:10])  # "2026-05-28"
