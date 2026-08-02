"""dashboard_metrics.py 계산 규칙 테스트 — 운영 데이터 없이 규칙만 고정한다.

대시보드 산식은 한 번 잘못되면 '사이트가 나빠졌다'는 잘못된 결론으로 이어지므로
(실제로 WARN=장애 취급이 8월 가동률 0% 를 만들었다) 규칙을 여기서 못박는다.
CI 는 test_fail_streak.py 와 같은 자리에서 이 파일을 실행한다.
"""
import sys

from dashboard_metrics import (
    AVAILABLE, OUTAGE, INDETERMINATE,
    classify_run, classify_counts, availability, completion_rate, no_warning_rate,
    open_quality_warnings, current_state, month_buckets,
)

failures = []


def check(name, actual, expected):
    if actual == expected:
        print(f"  OK   {name}")
    else:
        print(f"  FAIL {name}\n       기대: {expected}\n       실제: {actual}")
        failures.append(name)


print("== 런 분류 ==")
check('FAIL 은 완주해도 장애', classify_run('FAIL', True), OUTAGE)
check('FAIL 은 미완주여도 장애', classify_run('FAIL', False), OUTAGE)
check('PASS 는 가용', classify_run('PASS', True), AVAILABLE)
check('완주 WARN 은 가용 (품질 경고 존재)', classify_run('WARN', True), AVAILABLE)
check('미완주 WARN 은 확인 불가', classify_run('WARN', False), INDETERMINATE)
check('과거 필드 없는 WARN 은 확인 불가 (임의 가용 처리 금지)', classify_run('WARN', None), INDETERMINATE)
check('UNKNOWN 은 확인 불가', classify_run('UNKNOWN', None), INDETERMINATE)
check('UNKNOWN 은 완주값이 있어도 확인 불가', classify_run('UNKNOWN', True), INDETERMINATE)

print("\n== 서비스 가용률 ==")
counts = classify_counts([('PASS', True), ('WARN', True), ('FAIL', True), ('WARN', None)])
check('분류 집계', counts, {AVAILABLE: 2, OUTAGE: 1, INDETERMINATE: 1})
check('가용/(가용+장애) — 확인 불가는 분모 제외', availability(counts), round(2 / 3 * 100, 1))
check('전부 가용이면 100%', availability({AVAILABLE: 10, OUTAGE: 0, INDETERMINATE: 5}), 100.0)
check('전부 장애면 0%', availability({AVAILABLE: 0, OUTAGE: 3, INDETERMINATE: 0}), 0.0)
check('판정된 런이 없으면 None (0% 로 적으면 전면 장애로 오독)',
      availability({AVAILABLE: 0, OUTAGE: 0, INDETERMINATE: 7}), None)
# 회귀 방지: 품질 경고가 늘어도 가용률은 떨어지지 않아야 한다 (이번 개편의 핵심).
# 단, 이는 '전 실행이 완주(coverageComplete=true)한 경우'에 한한다 — 미완주 WARN 은 가용이 아니다.
before = availability(classify_counts([('PASS', True)] * 48))
after = availability(classify_counts([('WARN', True)] * 48))
check('전 런이 WARN 이어도 모두 완주면 가용률 100% 유지 (검사 추가가 가용률을 깎지 않음)',
      (before, after), (100.0, 100.0))
# 대비 케이스: 같은 48런이 전부 미완주 WARN 이면 판정 가능한 런이 없어 '데이터 없음'이다.
mixed = classify_counts([('WARN', False)] * 48)
check('전 런이 미완주 WARN 이면 가용 0 · 확인 불가 48',
      (mixed[AVAILABLE], mixed[INDETERMINATE]), (0, 48))
check('미완주 WARN 만 있으면 가용률은 100% 가 아니라 데이터 없음', availability(mixed), None)
# 완주 WARN 과 미완주 WARN 이 섞이면 완주분만 가용으로 잡힌다
both = classify_counts([('WARN', True)] * 3 + [('WARN', False)] * 2 + [('FAIL', True)])
check('완주 WARN 3 · 미완주 WARN 2 · FAIL 1 → 가용 3 / 장애 1 / 확인 불가 2',
      (both[AVAILABLE], both[OUTAGE], both[INDETERMINATE]), (3, 1, 2))
check('섞인 경우 가용률은 완주분으로만 계산 (3/4)', availability(both), 75.0)

print("\n== 점검 완주율 ==")
check('완주 3 / 판정가능 4', completion_rate([True, True, True, False]), (75.0, 3, 4))
check('필드 없는 런은 분모에서 제외', completion_rate([True, None, None]), (100.0, 1, 1))
check('전부 필드 없음이면 None', completion_rate([None, None]), (None, 0, 0))
check('전부 미완주면 0%', completion_rate([False, False]), (0.0, 0, 2))

print("\n== 무경고 실행률 (보조 지표) ==")
check('PASS/(P+W+F) — 기존 Health Score 산식 유지',
      no_warning_rate(['PASS', 'PASS', 'WARN', 'FAIL']), (50.0, 4))
check('UNKNOWN 은 분모에서 제외', no_warning_rate(['PASS', 'UNKNOWN']), (100.0, 1))
check('판정된 런이 없으면 None', no_warning_rate(['UNKNOWN']), (None, 0))
check('전 런이 WARN 이면 0% (가용률과 달리 떨어지는 게 정상)',
      no_warning_rate(['WARN'] * 22), (0.0, 22))

print("\n== 열린 품질 경고 (결함 단위 상태 관리) ==")
OG = 'cdn.ezlab.im/og.png|HTTP_4XX'
BTN = 'ezlab.im/ko/tool/x|UI_MISSING'

# 같은 결함이 반복돼도 열린 경고는 1건 — 런 단위로 세던 'WARN 22건' 문제의 교정
runs = [f'r{i}' for i in range(22)]
opened, resolved = open_quality_warnings(
    runs, {r: {OG} for r in runs}, {r: True for r in runs})
check('같은 지문 22런 반복 → 열린 경고 1건', len(opened), 1)
check('검출 횟수 누적', opened[0]['detected'], 22)
check('최초·최근 런 보존', (opened[0]['first'], opened[0]['last']), ('r0', 'r21'))
check('해결된 경고 없음', resolved, [])

# 완주 실행 2회 연속 미검출 → 해결
opened, resolved = open_quality_warnings(
    ['r1', 'r2', 'r3', 'r4'],
    {'r1': {BTN}, 'r2': set(), 'r3': set(), 'r4': set()},
    {'r1': True, 'r2': True, 'r3': True, 'r4': True})
check('완주 2회 연속 미검출이면 해결', ([o['fingerprint'] for o in opened],
                                       [r['fingerprint'] for r in resolved]), ([], [BTN]))

# 1회만 사라진 것으로는 해결하지 않는다 (blip 이 해결로 둔갑하지 않게)
opened, resolved = open_quality_warnings(
    ['r1', 'r2'], {'r1': {BTN}, 'r2': set()}, {'r1': True, 'r2': True})
check('완주 1회 미검출로는 해결하지 않음', ([o['fingerprint'] for o in opened], resolved), ([BTN], []))

# 미완주 실행은 해결 판정에서 제외 — 점검을 덜 한 런의 '안 보임'은 근거가 아니다
opened, resolved = open_quality_warnings(
    ['r1', 'r2', 'r3'],
    {'r1': {OG}, 'r2': set(), 'r3': set()},
    {'r1': True, 'r2': False, 'r3': None})
check('미완주·완주 미상 실행은 해결 판정에서 제외', ([o['fingerprint'] for o in opened], resolved),
      ([OG], []))

# 미완주 실행에서 지문이 보여도 상태를 만들지 않는다(검출도 완주 실행 기준)
opened, _ = open_quality_warnings(['r1'], {'r1': {OG}}, {'r1': False})
check('미완주 실행의 검출은 열린 경고를 만들지 않음', opened, [])

# 해결 후 재발하면 다시 열린다
opened, resolved = open_quality_warnings(
    ['r1', 'r2', 'r3', 'r4'],
    {'r1': {BTN}, 'r2': set(), 'r3': set(), 'r4': {BTN}},
    {r: True for r in ['r1', 'r2', 'r3', 'r4']})
check('해결 후 재발하면 다시 열림', ([o['fingerprint'] for o in opened],
                                    [r['fingerprint'] for r in resolved]), ([BTN], [BTN]))

# 여러 결함이 섞여도 각각 독립 관리
opened, resolved = open_quality_warnings(
    ['r1', 'r2', 'r3'],
    {'r1': {OG, BTN}, 'r2': {OG}, 'r3': {OG}},
    {r: True for r in ['r1', 'r2', 'r3']})
check('결함별 독립 관리 (OG 유지 · 버튼 해결)',
      ([o['fingerprint'] for o in opened], [r['fingerprint'] for r in resolved]), ([OG], [BTN]))

print("\n== 현재 상태 표시 ==")
check('FAIL → 서비스 장애', current_state('FAIL', True, 0), ('서비스 장애', 'fail'))
check('FAIL 은 미완주여도 장애로 표시', current_state('FAIL', False, 0), ('서비스 장애', 'fail'))
check('UNKNOWN → 확인 불가', current_state('UNKNOWN', None, 0), ('점검 결과 확인 불가', 'unknown'))
check('미완주 WARN → 확인 불가', current_state('WARN', False, 3), ('점검 결과 확인 불가', 'unknown'))
check('미완주 PASS → 확인 불가', current_state('PASS', False, 0), ('점검 결과 확인 불가', 'unknown'))
check('완주 WARN → 정상 + 경고 건수', current_state('WARN', True, 2), ('서비스 정상 · 품질 경고 2건', 'warn'))
check('완주 PASS → 서비스 정상', current_state('PASS', True, 0), ('서비스 정상', 'pass'))

print("\n== 월별 버킷 ==")
check('새 집계 키가 있으면 그대로 사용',
      month_buckets({'PASS': 1, 'WARN': 2, 'FAIL': 3, 'avail': 10, 'outage': 1, 'indet': 4}),
      {AVAILABLE: 10, OUTAGE: 1, INDETERMINATE: 4})
check('과거 월은 WARN 을 확인 불가로 환산 (없는 근거로 가용률을 올리지 않는다)',
      month_buckets({'PASS': 368, 'WARN': 30, 'FAIL': 6}),
      {AVAILABLE: 368, OUTAGE: 6, INDETERMINATE: 30})
check('과거 월 가용률은 PASS 와 FAIL 로만 계산',
      availability(month_buckets({'PASS': 368, 'WARN': 30, 'FAIL': 6})), 98.4)
check('빈 월은 None', availability(month_buckets({})), None)


# ── update_statuses.py 통합 검증 ───────────────────────────────────
# 집계 파일 갱신은 순수 함수가 아니라 실제 스크립트를 돌려 확인한다. 여기서 막는 사고는
#   · 같은 실행 ID 재처리로 월별/일별 누적이 두 배가 되는 것
#   · statuses.json 과 coverage.json 의 롤링 윈도우가 어긋나는 것
#   · coverage.json 이 깨졌을 때 갱신이 통째로 실패하는 것
import json as _json
import os as _os
import subprocess as _sub
import tempfile as _tmp

_SCRIPT = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'update_statuses.py')

print("\n== 집계 갱신 (update_statuses.py) ==")


def run_updates(rows, seed_coverage=None, tmpdir=None):
    """rows: [(run, status, coverage_arg)] 를 순서대로 처리하고 결과 파일을 돌려준다."""
    d = tmpdir or _tmp.mkdtemp()
    for name, init in (('statuses.json', {}), ('monthly-stats.json', {}), ('daily-stats.json', {})):
        with open(_os.path.join(d, name), 'w') as fh:
            _json.dump(init, fh)
    if seed_coverage is not None:
        with open(_os.path.join(d, 'coverage.json'), 'w') as fh:
            fh.write(seed_coverage)
    env = dict(_os.environ, TMPDIR=d)
    for run, status, cov_arg in rows:
        r = _sub.run([sys.executable, _SCRIPT, run, status, cov_arg],
                     capture_output=True, text=True, env=env, cwd=d)
        if r.returncode != 0:
            return {'error': r.stderr.strip()[:300]}
    out = {}
    for name in ('statuses.json', 'monthly-stats.json', 'daily-stats.json', 'coverage.json'):
        p = _os.path.join(d, name)
        out[name] = _json.load(open(p)) if _os.path.exists(p) else None
    return out


# update_statuses.py 는 /tmp 고정 경로를 쓰므로, 테스트도 같은 경로를 쓰되 원본을 보존했다 되돌린다.
_BACKUP = {}
for _n in ('statuses.json', 'monthly-stats.json', 'daily-stats.json', 'coverage.json'):
    _p = f'/tmp/{_n}'
    if _os.path.exists(_p):
        _BACKUP[_p] = open(_p).read()


def run_updates_tmp(rows, seed_coverage=None):
    for name, init in (('statuses.json', '{}'), ('monthly-stats.json', '{}'), ('daily-stats.json', '{}')):
        open(f'/tmp/{name}', 'w').write(init)
    if seed_coverage is None:
        if _os.path.exists('/tmp/coverage.json'):
            _os.remove('/tmp/coverage.json')
    else:
        open('/tmp/coverage.json', 'w').write(seed_coverage)
    for run, status, cov_arg in rows:
        r = _sub.run([sys.executable, _SCRIPT, run, status, cov_arg], capture_output=True, text=True)
        if r.returncode != 0:
            return {'error': r.stderr.strip()[:300]}
    return {n: _json.load(open(f'/tmp/{n}')) for n in
            ('statuses.json', 'monthly-stats.json', 'daily-stats.json', 'coverage.json')}


try:
    # 1) 같은 실행 ID 를 다시 처리해도 누적이 늘지 않는다 (workflow_dispatch 가 스케줄과 같은 분에 겹치는 경우)
    once = run_updates_tmp([('2026-08-02_10-00', 'WARN', 'true')])
    twice = run_updates_tmp([('2026-08-02_10-00', 'WARN', 'true'),
                             ('2026-08-02_10-00', 'WARN', 'true')])
    check('동일 실행 ID 재처리 — 월별 원본 카운트 불변',
          twice['monthly-stats.json']['2026-08'], once['monthly-stats.json']['2026-08'])
    check('동일 실행 ID 재처리 — 일별 누적 불변',
          twice['daily-stats.json']['2026-08-02'], once['daily-stats.json']['2026-08-02'])
    check('동일 실행 ID 재처리 — 서비스 버킷도 1회만 집계',
          (twice['monthly-stats.json']['2026-08'].get('avail', 0),
           twice['monthly-stats.json']['2026-08'].get('WARN', 0)), (1, 1))

    # 2) 상태 변화로 재처리해도 (재실행) 누적이 이중으로 늘지 않는다
    changed = run_updates_tmp([('2026-08-02_10-00', 'WARN', 'true'),
                               ('2026-08-02_10-00', 'PASS', 'true')])
    total = sum(changed['monthly-stats.json']['2026-08'].get(k, 0) for k in ('PASS', 'WARN', 'FAIL'))
    check('같은 ID 를 다른 상태로 재처리해도 누적 총합은 1', total, 1)
    check('최신 상태로 덮어쓴다', changed['statuses.json']['2026-08-02_10-00'], 'PASS')

    # 3) statuses.json 과 coverage.json 의 키가 같은 윈도우로 정리된다
    rows = [(f'2026-08-02_{h:02d}-00', 'PASS', 'true') for h in range(4)]
    win = run_updates_tmp(rows)
    check('coverage.json 키가 statuses.json 키 집합을 벗어나지 않는다',
          set(win['coverage.json']) - set(win['statuses.json']), set())
    check('완주 여부를 기록한 런은 모두 coverage.json 에 남는다',
          set(win['coverage.json']), set(win['statuses.json']))

    # 4) 완주 여부를 모르는 런(빈 인자)은 coverage.json 에 넣지 않는다
    unknown_cov = run_updates_tmp([('2026-08-02_10-00', 'WARN', '')])
    check('완주 여부 미상 런은 coverage.json 에 기록하지 않음', unknown_cov['coverage.json'], {})
    check('완주 여부 미상 WARN 은 확인 불가 버킷',
          unknown_cov['monthly-stats.json']['2026-08'].get('indet'), 1)

    # 5) coverage.json 이 깨져 있어도 갱신이 실패하지 않는다
    broken = run_updates_tmp([('2026-08-02_10-00', 'PASS', 'true')], seed_coverage='{ not json')
    check('손상된 coverage.json — 갱신 성공', 'error' in broken, False)
    check('손상된 coverage.json — 새 기록으로 복구',
          broken.get('coverage.json'), {'2026-08-02_10-00': True})

    # 6) 값 타입이 깨진 항목은 버린다 (문자열 'true' 를 불리언으로 오인하면 잘못된 가용 판정이 된다)
    dirty = run_updates_tmp([('2026-08-02_11-00', 'PASS', 'true')],
                            seed_coverage='{"2026-08-02_10-00": "true"}')
    check('불리언이 아닌 완주 값은 제거', dirty['coverage.json'], {'2026-08-02_11-00': True})
finally:
    for _p, _c in _BACKUP.items():
        open(_p, 'w').write(_c)

print()
if failures:
    print(f"실패 {len(failures)}건: {', '.join(failures)}")
    sys.exit(1)
print("전체 통과")
