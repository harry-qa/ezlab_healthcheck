"""dashboard_metrics.py 계산 규칙 테스트 — 운영 데이터 없이 규칙만 고정한다.

대시보드 산식은 한 번 잘못되면 '사이트가 나빠졌다'는 잘못된 결론으로 이어지므로
(실제로 WARN=장애 취급이 8월 가동률 0% 를 만들었다) 규칙을 여기서 못박는다.
CI 는 test_fail_streak.py 와 같은 자리에서 이 파일을 실행한다.
"""
import sys

from dashboard_metrics import (
    AVAILABLE, OUTAGE, INDETERMINATE, VECTOR_KEYS, STATS_SCHEMA_VERSION,
    classify_run, classify_counts, availability, completion_rate, no_warning_rate,
    open_quality_warnings, current_state, month_buckets, is_migrated,
    vector_of, merge_bucket, vector_invariant_errors, vector_shape_errors, vector_replaced,
    occurrence_states, is_recovery_record, OCCURRENCE_NEW, OCCURRENCE_PERSISTING,
    expected_runs_per_day, execution_rate, SCHEDULE_HISTORY, SCHEDULE_CHANGE_DAYS,
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

print("\n== 점검 실행률 (감시 커버리지) ==")
# 하루 기대 실행 수는 cron 이력에 따라 달라진다. 48 을 전 구간에 적용하면 6회/일로
# 돌던 4~5월이 드랍처럼 보인다 — 설정이 그랬던 것이지 누락이 아니다.
check('4월은 하루 6회 기준', expected_runs_per_day('2026-04-20'), 6)
check('5월 중순은 하루 24회 기준', expected_runs_per_day('2026-05-20'), 24)
check('6월 09일부터 하루 48회 기준', expected_runs_per_day('2026-06-09'), 48)
check('현재도 하루 48회 기준', expected_runs_per_day('2026-08-29'), 48)
check('이력보다 앞선 날짜는 기대값 없음(None)', expected_runs_per_day('2026-01-01'), None)

check('전부 돌면 100%', execution_rate({'2026-08-20': 48, '2026-08-21': 48}), (100.0, 96, 96, 2))
check('절반만 돌면 50%', execution_rate({'2026-08-20': 24}), (50.0, 24, 48, 1))
check('한 번도 안 돌면 0% (기대값은 그대로 남는다)',
      execution_rate({'2026-08-20': 0}), (0.0, 0, 48, 1))
check('기대값 없는 구간만 있으면 None — 0% 로 적으면 전면 누락으로 오독',
      execution_rate({'2026-01-01': 0}), (None, 0, 0, 0))
check('빈 입력도 None', execution_rate({}), (None, 0, 0, 0))

# 기대값이 다른 구간이 섞이면 날짜별 기대값으로 각각 더한다(평균을 내지 않는다).
check('구간이 섞이면 날짜별 기대값 합산',
      execution_rate({'2026-04-20': 6, '2026-08-20': 24}), (round(30 / 54 * 100, 1), 30, 54, 2))

# 하루 안에서 cron 이 바뀐 날은 어느 기대값도 맞지 않아 분모·분자에서 함께 뺀다.
check('스케줄 변경일은 집계에서 제외',
      execution_rate({'2026-06-08': 40, '2026-08-20': 48}), (100.0, 48, 48, 1))
check('제외 대상 날짜 목록이 이력 경계와 일치',
      sorted(SCHEDULE_CHANGE_DAYS), ['2026-04-07', '2026-05-11', '2026-05-12', '2026-06-08'])
check('이력은 날짜 오름차순이어야 조회가 성립',
      [d for d, _ in SCHEDULE_HISTORY], sorted(d for d, _ in SCHEDULE_HISTORY))

# 상한을 두지 않는다 — 100% 초과는 기대값 표가 실제 cron 과 어긋났다는 신호다.
check('기대보다 많이 돌면 100% 를 넘겨 그대로 드러낸다',
      execution_rate({'2026-08-20': 60}), (125.0, 60, 48, 1))

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

print("\n== 결함 관측 상태 (신규 · 지속) ==")
# 같은 OG 403 이 매 실행 반복될 때 '새로 생긴 문제'인지 구분하기 위한 배지의 판정 규칙.
# 열린 품질 경고와 같은 규칙(완주 실행만 갱신 · 2회 연속 미검출이면 닫힘)을 써야 한다.


def _state(states, run, fp):
    return states.get(run, {}).get(fp, {}).get('state')


def _detected(states, run, fp):
    return states.get(run, {}).get(fp, {}).get('detected')


runs3 = ['r1', 'r2', 'r3']
st = occurrence_states(runs3, {'r1': {OG}, 'r2': {OG}, 'r3': {OG}}, {r: True for r in runs3})
check('최초 등장은 신규', _state(st, 'r1', OG), OCCURRENCE_NEW)
check('다음 완주 실행에서 재등장하면 지속', _state(st, 'r2', OG), OCCURRENCE_PERSISTING)
check('계속 보이면 계속 지속', _state(st, 'r3', OG), OCCURRENCE_PERSISTING)
check('누적 검출 횟수 증가', [_detected(st, r, OG) for r in runs3], [1, 2, 3])

# 다른 지문은 서로 영향을 주지 않는다 — 각각 자기 시점에 신규다.
st = occurrence_states(['r1', 'r2'], {'r1': {OG}, 'r2': {OG, BTN}}, {'r1': True, 'r2': True})
check('다른 지문은 각각 신규', (_state(st, 'r2', OG), _state(st, 'r2', BTN)),
      (OCCURRENCE_PERSISTING, OCCURRENCE_NEW))

# 미완주 실행은 상태를 갱신하지 않는다 — 거기서만 본 지문이 다음 실행을 '지속'으로 만들면 안 된다.
st = occurrence_states(['r1', 'r2'], {'r1': {OG}, 'r2': {OG}}, {'r1': False, 'r2': True})
check('미완주 실행에서만 등장한 지문은 지속 근거가 아니다', _state(st, 'r2', OG), OCCURRENCE_NEW)
check('미완주 실행 자신의 배지는 신규로 표시', _state(st, 'r1', OG), OCCURRENCE_NEW)
check('미완주 실행에서는 누적 검출 횟수가 늘지 않는다', _detected(st, 'r1', OG), 0)

# 완주 실행에서 열린 뒤 미완주 실행이 끼어도 지속 판정은 유지된다(미검출로 세지 않는다).
st = occurrence_states(['r1', 'r2', 'r3'], {'r1': {OG}, 'r2': set(), 'r3': {OG}},
                       {'r1': True, 'r2': False, 'r3': True})
check('중간 미완주 실행은 해결 근거가 아니다 (지속 유지)', _state(st, 'r3', OG), OCCURRENCE_PERSISTING)

# 완주 실행 2회 연속 미검출이면 닫히고, 다시 나오면 재발이므로 신규다.
st = occurrence_states(['r1', 'r2', 'r3', 'r4'],
                       {'r1': {OG}, 'r2': set(), 'r3': set(), 'r4': {OG}},
                       {r: True for r in ['r1', 'r2', 'r3', 'r4']})
check('완주 2회 연속 미검출 후 재발은 신규 (해결 규칙과 동일)', _state(st, 'r4', OG), OCCURRENCE_NEW)
st = occurrence_states(['r1', 'r2', 'r3'], {'r1': {OG}, 'r2': set(), 'r3': {OG}},
                       {r: True for r in ['r1', 'r2', 'r3']})
check('완주 1회 미검출로는 닫히지 않는다 (지속 유지)', _state(st, 'r3', OG), OCCURRENCE_PERSISTING)
# detected 는 '연속'이 아니라 '누적'이다 — 1회 미검출로는 결함이 닫히지 않으므로
# 그 사이를 건너뛴 검출도 같은 결함의 누적으로 이어서 센다.
check('검출 → 완주 미검출 1회 → 재검출 = 누적 2회 (연속이 아님)', _detected(st, 'r3', OG), 2)
check('중간 미검출 실행에는 상태가 생기지 않는다', st['r2'], {})
# 닫힌 뒤 재발하면 누적도 처음부터 다시 센다.
st = occurrence_states(['r1', 'r2', 'r3', 'r4'],
                       {'r1': {OG}, 'r2': set(), 'r3': set(), 'r4': {OG}},
                       {r: True for r in ['r1', 'r2', 'r3', 'r4']})
check('해결 후 재발하면 누적 검출은 1부터 다시 센다', _detected(st, 'r4', OG), 1)

check('지문이 없는 기록은 상태를 만들지 않는다',
      occurrence_states(['r1'], {'r1': {None, ''}}, {'r1': True}), {'r1': {}})
check('기록이 없는 실행도 빈 상태로 존재', occurrence_states(['r1'], {}, {'r1': True}), {'r1': {}})

print("\n== 재시도 회복 식별 ==")
# INFO 이면서 '회복'이 적힌 기록만 재시도 회복이다. 결함 해결(완주 2회 미검출)과는 다른 개념.
check('INFO + 회복 문구 → 재시도 회복',
      is_recovery_record({'severity': 'INFO', 'symptom': '간헐 실패 후 회복 (최초 HTTP 502 → 재확인 200)'}), True)
check('INFO + 재측정 회복 문구 → 재시도 회복',
      is_recovery_record({'severity': 'INFO', 'symptom': '본측정 간헐 실패 후 재측정 회복'}), True)
check('INFO 이지만 회복이 아니면 아님',
      is_recovery_record({'severity': 'INFO', 'symptom': '외부 링크 응답 이상 (HTTP 404)'}), False)
check('WARN 은 회복 문구가 있어도 아님',
      is_recovery_record({'severity': 'WARN', 'symptom': '회복'}), False)
check('구버전 severity 없음은 아님 (장애 성격 유지)',
      is_recovery_record({'symptom': '간헐 실패 후 회복'}), False)
check('dict 가 아니어도 죽지 않음', is_recovery_record(None), False)

# 구버전 기록(severity 없음)은 FAIL 성격이므로 지문 집계에 그대로 들어가야 한다.
st = occurrence_states(['r1', 'r2'], {'r1': {OG}, 'r2': {OG}}, {'r1': True, 'r2': True})
check('severity 없는 구버전 지문도 신규→지속으로 이어진다',
      (_state(st, 'r1', OG), _state(st, 'r2', OG)), (OCCURRENCE_NEW, OCCURRENCE_PERSISTING))

# 배지를 추가해도 열린 품질 경고 규칙은 그대로여야 한다(같은 입력·같은 결과).
opened_after, resolved_after = open_quality_warnings(
    ['r1', 'r2', 'r3', 'r4'],
    {'r1': {BTN}, 'r2': set(), 'r3': set(), 'r4': set()},
    {r: True for r in ['r1', 'r2', 'r3', 'r4']})
check('열린 품질 경고의 2회 연속 미검출 해결 규칙 불변',
      ([o['fingerprint'] for o in opened_after], [r['fingerprint'] for r in resolved_after]), ([], [BTN]))

print("\n== 현재 상태 표시 ==")
check('FAIL → 서비스 장애', current_state('FAIL', True, 0), ('서비스 장애', 'fail'))
check('FAIL 은 미완주여도 장애로 표시', current_state('FAIL', False, 0), ('서비스 장애', 'fail'))
check('UNKNOWN → 확인 불가', current_state('UNKNOWN', None, 0), ('점검 결과 확인 불가', 'unknown'))
check('미완주 WARN → 확인 불가', current_state('WARN', False, 3), ('점검 결과 확인 불가', 'unknown'))
check('미완주 PASS → 확인 불가', current_state('PASS', False, 0), ('점검 결과 확인 불가', 'unknown'))
check('완주 WARN → 정상 + 경고 건수', current_state('WARN', True, 2), ('서비스 정상 · 품질 경고 2건', 'warn'))
check('완주 PASS → 서비스 정상', current_state('PASS', True, 0), ('서비스 정상', 'pass'))

print("\n== 마이그레이션 상태 판정 ==")
DONE = {'schemaVersion': STATS_SCHEMA_VERSION, 'backfillComplete': True}
check('완료 표시가 있으면 마이그레이션됨', is_migrated(DONE), True)
check('완료 표시가 없으면 미마이그레이션', is_migrated({'schemaVersion': 2}), False)
check('backfillComplete=False 는 부분 마이그레이션', is_migrated({'schemaVersion': 2, 'backfillComplete': False}), False)
check('구버전 스키마는 미마이그레이션', is_migrated({'schemaVersion': 1, 'backfillComplete': True}), False)
check('메타 파일이 없으면 미마이그레이션', is_migrated({}), False)
check('메타가 dict 가 아니면 미마이그레이션', is_migrated(['x']), False)
check('schemaVersion 이 숫자가 아니어도 죽지 않음', is_migrated({'schemaVersion': 'v2', 'backfillComplete': True}), False)

print("\n== 월별 버킷 ==")
MIGRATED_MONTH = {'PASS': 1, 'WARN': 2, 'FAIL': 3, 'avail': 10, 'outage': 1, 'indet': 4}
check('마이그레이션 완료 + 완전한 벡터 → 벡터 사용',
      month_buckets(MIGRATED_MONTH, migrated=True), {AVAILABLE: 10, OUTAGE: 1, INDETERMINATE: 4})
# 부분 마이그레이션 방어: 완료 표시가 없으면 벡터가 있어도 쓰지 않는다.
check('미마이그레이션이면 벡터가 있어도 보수적 환산 (부분 마이그레이션을 정상 데이터로 읽지 않음)',
      month_buckets(MIGRATED_MONTH, migrated=False), {AVAILABLE: 1, OUTAGE: 3, INDETERMINATE: 2})
check('완료 표시가 있어도 벡터가 불완전하면 폴백 (부분 키 상태 방어)',
      month_buckets({'PASS': 5, 'WARN': 2, 'FAIL': 1, 'avail': 5}, migrated=True),
      {AVAILABLE: 5, OUTAGE: 1, INDETERMINATE: 2})
check('과거 월은 WARN 을 확인 불가로 환산 (없는 근거로 가용률을 올리지 않는다)',
      month_buckets({'PASS': 368, 'WARN': 30, 'FAIL': 6}, migrated=True),
      {AVAILABLE: 368, OUTAGE: 6, INDETERMINATE: 30})
check('과거 월 가용률은 PASS 와 FAIL 로만 계산',
      availability(month_buckets({'PASS': 368, 'WARN': 30, 'FAIL': 6}, migrated=True)), 98.4)
check('빈 월은 None', availability(month_buckets({}, migrated=True)), None)

print("\n== 서비스 분류 벡터 (병합·불변식) ==")
check('벡터가 완전하면 튜플로 반환', vector_of({'avail': 3, 'outage': 1, 'indet': 2}), (3, 1, 2))
check('키가 하나라도 없으면 None (부분 키는 벡터가 아니다)', vector_of({'avail': 3, 'outage': 1}), None)
check('값이 숫자가 아니면 None', vector_of({'avail': 'x', 'outage': 1, 'indet': 2}), None)

# 항목별 max 로 섞으면 합이 실제 실행 수를 넘는다 — 벡터 단위 교체·보존이어야 한다.
merged = merge_bucket({'PASS': 10, 'WARN': 0, 'FAIL': 0, 'avail': 10, 'outage': 0, 'indet': 0},
                      {'PASS': 0, 'WARN': 10, 'FAIL': 0, 'avail': 0, 'outage': 0, 'indet': 10})
check('벡터는 항목별 max 로 섞이지 않는다 (합이 20이 되면 안 됨)',
      sum(vector_of(merged)), 10)
check('재구성이 더 많이 봤으면 벡터 전체 교체', vector_of(merged), (0, 0, 10))
check('원본 카운트는 축소 방지 max 유지', (merged['PASS'], merged['WARN']), (10, 10))

kept = merge_bucket({'PASS': 50, 'WARN': 0, 'FAIL': 0, 'avail': 50, 'outage': 0, 'indet': 0},
                    {'PASS': 2, 'WARN': 0, 'FAIL': 0, 'avail': 2, 'outage': 0, 'indet': 0})
check('재구성이 적게 봤으면(prune 구간) 기존 벡터 통째로 보존', vector_of(kept), (50, 0, 0))

part = merge_bucket({'PASS': 5, 'WARN': 1, 'FAIL': 0}, {'PASS': 5, 'WARN': 1, 'FAIL': 0})
check('양쪽에 벡터가 없으면 부분 키를 만들지 않는다',
      [k for k in VECTOR_KEYS if k in part], [])

check('불변식 통과 — 벡터합이 실행 수와 일치',
      vector_invariant_errors({'2026-08': {'avail': 19, 'outage': 1, 'indet': 3}}, {'2026-08': 23}), [])
check('불변식 위반 — 벡터합이 실행 수와 다름',
      vector_invariant_errors({'2026-08': {'avail': 19, 'outage': 1, 'indet': 3}}, {'2026-08': 24}),
      [('2026-08', 23, 24)])
check('불변식 위반 — 벡터 자체가 없음',
      vector_invariant_errors({'2026-08': {'PASS': 5}}, {'2026-08': 5}), [('2026-08', None, 5)])

# 교체 판정 — 백필 검증이 '이번 재구성이 권위를 갖는 구간'을 고르는 기준.
FULL_100 = {'PASS': 100, 'WARN': 0, 'FAIL': 0, 'avail': 100, 'outage': 0, 'indet': 0}
SMALL_10 = {'PASS': 10, 'WARN': 0, 'FAIL': 0, 'avail': 10, 'outage': 0, 'indet': 0}
check('재구성이 더 적게 봤으면 교체하지 않음 (prune 구간)', vector_replaced(FULL_100, SMALL_10), False)
check('재구성이 더 많이 봤으면 교체', vector_replaced(SMALL_10, FULL_100), True)
check('같은 크기면 교체 (최신 재구성 우선)', vector_replaced(SMALL_10, dict(SMALL_10)), True)
check('기존 벡터가 없으면 교체', vector_replaced({'PASS': 5}, SMALL_10), True)
check('재구성 벡터가 불완전하면 교체하지 않음', vector_replaced(FULL_100, {'PASS': 3, 'avail': 3}), False)
check('교체 판정과 merge_bucket 결과가 일치 (보존)', vector_of(merge_bucket(FULL_100, SMALL_10)), (100, 0, 0))
check('교체 판정과 merge_bucket 결과가 일치 (교체)', vector_of(merge_bucket(SMALL_10, FULL_100)), (100, 0, 0))

# 병합 결과 검사는 '형태'만 본다 — 합계는 보존 구간에서 실행 수와 다른 것이 정상이다.
check('형태 검사 통과 — 완전한 벡터·음수 없음',
      vector_shape_errors({'2026-07': FULL_100, '2026-08': SMALL_10}, required={'2026-08'}), [])
check('보존 구간의 벡터합이 실행 수와 달라도 형태 검사는 통과 (기존 100 · 재구성 10)',
      vector_shape_errors({'2026-07': FULL_100}, required={'2026-07': 10}), [])
check('재구성 구간의 벡터가 불완전하면 오류',
      vector_shape_errors({'2026-08': {'PASS': 5, 'avail': 5}}, required={'2026-08'}),
      [('2026-08', '벡터 불완전 (세 키가 한 벌로 있어야 함)')])
check('재구성 밖 구간은 벡터가 없어도 오류가 아니다 (부분 마이그레이션으로 표시)',
      vector_shape_errors({'2026-05': {'PASS': 5}}, required={'2026-08'}), [])
check('음수 값은 재구성 밖 구간이어도 오류',
      vector_shape_errors({'2026-05': {'avail': -1, 'outage': 0, 'indet': 6}}, required=()),
      [('2026-05', '음수 값 (-1, 0, 6)')])


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


def run_updates_tmp(rows, seed_coverage=None, seed_monthly=None, seed_statuses=None):
    for name, init in (('statuses.json', seed_statuses or '{}'),
                       ('monthly-stats.json', seed_monthly or '{}'),
                       ('daily-stats.json', '{}')):
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


def month(res):
    return res['monthly-stats.json']['2026-08']


def vec(res):
    return vector_of(month(res))


try:
    # 1) 같은 실행 ID·같은 값 재처리는 완전한 no-op
    once = run_updates_tmp([('2026-08-02_10-00', 'WARN', 'true')])
    twice = run_updates_tmp([('2026-08-02_10-00', 'WARN', 'true'),
                             ('2026-08-02_10-00', 'WARN', 'true')])
    check('동일 ID·동일 값 재처리 — 월별 전체가 완전한 no-op', month(twice), month(once))
    check('동일 ID·동일 값 재처리 — 일별 전체가 완전한 no-op',
          twice['daily-stats.json']['2026-08-02'], once['daily-stats.json']['2026-08-02'])
    check('동일 ID·동일 값 재처리 — coverage.json 도 동일',
          twice['coverage.json'], once['coverage.json'])

    # 2) upsert — 이전 분류를 회수하고 새 분류로 이동한다 (누적이 남거나 늘지 않는다)
    f2p = run_updates_tmp([('2026-08-02_10-00', 'FAIL', 'false'),
                           ('2026-08-02_10-00', 'PASS', 'true')])
    check('동일 ID FAIL,false → PASS,true : 원본 카운트 이동',
          (month(f2p)['PASS'], month(f2p)['FAIL'], month(f2p)['WARN']), (1, 0, 0))
    check('동일 ID FAIL,false → PASS,true : 서비스 벡터 이동 (장애 회수 · 가용 가산)',
          vec(f2p), (1, 0, 0))
    check('동일 ID FAIL,false → PASS,true : 벡터합 = 실행 1건', sum(vec(f2p)), 1)

    w2w = run_updates_tmp([('2026-08-02_10-00', 'WARN', ''),
                           ('2026-08-02_10-00', 'WARN', 'true')])
    check('동일 ID WARN,None → WARN,true : 원본 WARN 은 1건 유지',
          (month(w2w)['WARN'], month(w2w)['PASS']), (1, 0))
    check('동일 ID WARN,None → WARN,true : 확인 불가에서 가용으로 이동', vec(w2w), (1, 0, 0))
    check('동일 ID WARN,None → WARN,true : coverage 기록됨',
          w2w['coverage.json'], {'2026-08-02_10-00': True})

    # 완주 정보가 사라지는 방향(true → None)도 대칭으로 처리된다
    w2n = run_updates_tmp([('2026-08-02_10-00', 'WARN', 'true'),
                           ('2026-08-02_10-00', 'WARN', '')])
    check('동일 ID WARN,true → WARN,None : 가용에서 확인 불가로 되돌림', vec(w2n), (0, 0, 1))
    check('동일 ID WARN,true → WARN,None : coverage 기록 제거', w2n['coverage.json'], {})

    # 3) 기존 8월 데이터(PASS 0 / WARN 22 / FAIL 1)에 새 완주 WARN 1건이 들어와도 과거가 사라지지 않는다
    seed_month = {'2026-08': {'PASS': 0, 'WARN': 22, 'FAIL': 1,
                              'avail': 19, 'outage': 1, 'indet': 3}}
    grown = run_updates_tmp([('2026-08-02_23-59', 'WARN', 'true')],
                            seed_monthly=_json.dumps(seed_month))
    check('기존 8월 원본 카운트 보존 + 새 WARN 1건 가산',
          (month(grown)['PASS'], month(grown)['WARN'], month(grown)['FAIL']), (0, 23, 1))
    check('기존 서비스 벡터 보존 + 새 완주 WARN 은 가용으로 가산', vec(grown), (20, 1, 3))
    check('벡터합 = 기존 23건 + 신규 1건', sum(vec(grown)), 24)

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

    # 7) 백필 후 서비스 버킷 합계가 실제 실행 수와 일치 (불변식이 갱신 뒤에도 유지되는지)
    seq = [(f'2026-08-02_{h:02d}-00', st, cv) for h, (st, cv) in enumerate(
        [('PASS', 'true'), ('WARN', 'true'), ('WARN', 'false'), ('FAIL', 'true'),
         ('UNKNOWN', ''), ('PASS', 'true')])]
    grown_seq = run_updates_tmp(seq)
    check('연속 갱신 후에도 벡터합 = 실행 수', sum(vec(grown_seq)), len(seq))
    check('연속 갱신 후 불변식 검사 통과',
          vector_invariant_errors({'2026-08': month(grown_seq)}, {'2026-08': len(seq)}), [])
    check('분류 내역 (가용 3 · 장애 1 · 확인 불가 2)', vec(grown_seq), (3, 1, 2))

    # 8) 부분 마이그레이션 파일을 정상 데이터로 사용하지 않는다 (읽기 측 최종 방어)
    partial_month = {'2026-07': {'PASS': 368, 'WARN': 30, 'FAIL': 6},                    # 벡터 없음
                     '2026-08': {'PASS': 0, 'WARN': 22, 'FAIL': 1,
                                 'avail': 19, 'outage': 1, 'indet': 3}}                  # 벡터 있음
    no_meta = {AVAILABLE: 0, OUTAGE: 1, INDETERMINATE: 22}       # 보수적 환산 (8월)
    check('완료 표시 없는 부분 마이그레이션 — 벡터가 있는 월도 보수적 환산으로 통일',
          month_buckets(partial_month['2026-08'], migrated=is_migrated({})), no_meta)
    check('완료 표시 없는 부분 마이그레이션 — 벡터 없는 월도 같은 규칙',
          month_buckets(partial_month['2026-07'], migrated=is_migrated({})),
          {AVAILABLE: 368, OUTAGE: 6, INDETERMINATE: 30})
    check('부분 마이그레이션에서 두 월이 같은 규칙으로 계산된다 (섞이지 않음)',
          [availability(month_buckets(partial_month[m], migrated=is_migrated({}))) for m in ('2026-07', '2026-08')],
          [98.4, 0.0])
    check('완료 표시가 붙으면 비로소 벡터 사용 (8월 95%)',
          availability(month_buckets(partial_month['2026-08'], migrated=is_migrated(DONE))), 95.0)
finally:
    for _p, _c in _BACKUP.items():
        open(_p, 'w').write(_c)


# ── backfill_stats.py 통합 검증 ────────────────────────────────────
# 백필은 gh-pages 사본을 원본으로 집계를 재구성한다. 여기서 막는 사고는
#   · prune 로 폴더가 사라진 뒤 재구성분이 과거 누적을 덮어써 데이터가 줄어드는 것
#   · 반대로 검증이 과민해서 정상적인 '보존' 상황을 실패로 만드는 것 (기존 100 vs 재구성 10)
#   · 벡터가 깨진 채로 backfillComplete=true 가 찍혀 대시보드가 잘못된 가용률을 그리는 것
_BACKFILL = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'backfill_stats.py')

print("\n== 백필 병합·검증 (backfill_stats.py) ==")


def make_ghpages(runs, root=None):
    """gh-pages 사본을 흉내낸 임시 저장소. origin/gh-pages ref 를 직접 만든다
    (백필이 `git archive origin/gh-pages` 로 읽으므로 원격이 실제로 필요하지는 않다)."""
    d = _tmp.mkdtemp()

    def git(*args):
        return _sub.run(['git', '-C', d, *args], capture_output=True, text=True)

    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    for folder, payload in runs.items():
        _os.makedirs(_os.path.join(d, folder), exist_ok=True)
        with open(_os.path.join(d, folder, 'status.json'), 'w') as fh:
            _json.dump(payload, fh)
    for name, payload in (root or {}).items():
        with open(_os.path.join(d, name), 'w') as fh:
            _json.dump(payload, fh)
    git('add', '-A')
    git('commit', '-qm', 'seed')
    git('update-ref', 'refs/remotes/origin/gh-pages', git('rev-parse', 'HEAD').stdout.strip())
    return d


def run_backfill(repo):
    """(종료 코드, 출력, {파일명: 내용}) — 실패한 경우 파일은 쓰이지 않아야 한다."""
    out = _tmp.mkdtemp()
    r = _sub.run([sys.executable, _BACKFILL, out], capture_output=True, text=True, cwd=repo)
    files = {}
    for name in ('monthly-stats.json', 'daily-stats.json', 'stats-meta.json', 'coverage.json'):
        p = _os.path.join(out, name)
        if _os.path.exists(p):
            files[name] = _json.load(open(p))
    return r.returncode, r.stdout + r.stderr, files


def pass_runs(day, count, hour0=0):
    return {f'{day}_{hour0 + i:02d}-00': {'status': 'PASS', 'coverageComplete': True}
            for i in range(count)}


FULL_MONTH = {'PASS': 100, 'WARN': 0, 'FAIL': 0, 'avail': 100, 'outage': 0, 'indet': 0}

# 1) prune 이후 상황 — 기존 벡터 100건 / 폴더는 10건만 남음. 보존하면서 성공해야 한다.
#    (검증을 병합 결과에 걸면 100 != 10 으로 실패하던 케이스)
rc, log, out = run_backfill(make_ghpages(
    pass_runs('2026-07-20', 10),
    {'monthly-stats.json': {'2026-07': dict(FULL_MONTH)},
     'daily-stats.json': {'2026-07-01': dict(FULL_MONTH)}}))
check('기존 100 · 재구성 10 — 백필 성공 (종료 코드 0)', rc, 0)
check('기존 100 · 재구성 10 — 기존 월 벡터 보존', vector_of(out['monthly-stats.json']['2026-07']), (100, 0, 0))
check('기존 100 · 재구성 10 — 기존 월 원본 카운트 보존', out['monthly-stats.json']['2026-07']['PASS'], 100)
check('기존 100 · 재구성 10 — 폴더가 사라진 과거 일자도 보존',
      vector_of(out['daily-stats.json']['2026-07-01']), (100, 0, 0))
check('기존 100 · 재구성 10 — 재구성된 일자는 실제 실행 수와 일치',
      vector_of(out['daily-stats.json']['2026-07-20']), (10, 0, 0))
check('기존 100 · 재구성 10 — 마이그레이션 완료로 표시', out['stats-meta.json']['backfillComplete'], True)
check('기존 100 · 재구성 10 — runsSeen 은 이번에 읽은 실행 수', out['stats-meta.json']['runsSeen'], 10)

# 2) 재구성이 기존보다 크거나 같으면 벡터를 통째로 교체한다 (항목별 max 로 섞지 않는다)
rc, log, out = run_backfill(make_ghpages(
    {**pass_runs('2026-07-20', 9),
     '2026-07-20_09-00': {'status': 'FAIL', 'coverageComplete': True}},
    {'monthly-stats.json': {'2026-07': {'PASS': 3, 'WARN': 0, 'FAIL': 0,
                                        'avail': 3, 'outage': 0, 'indet': 0}}}))
check('재구성이 더 크면 벡터 교체 — 성공', rc, 0)
check('재구성이 더 크면 벡터 교체 — 가용 9 · 장애 1',
      vector_of(out['monthly-stats.json']['2026-07']), (9, 1, 0))
check('재구성이 더 크면 벡터 교체 — 벡터합 = 실행 10건',
      sum(vector_of(out['monthly-stats.json']['2026-07'])), 10)

# 3) 완주 여부가 없는 과거 런은 확인 불가로 잡히고, 벡터합은 여전히 실행 수와 같다
rc, log, out = run_backfill(make_ghpages({
    '2026-07-20_00-00': {'status': 'PASS'},
    '2026-07-20_01-00': {'status': 'WARN'},
    '2026-07-20_02-00': {'status': 'WARN', 'coverageComplete': True},
    '2026-07-20_03-00': {'status': 'FAIL', 'coverageComplete': False},
}))
check('완주 기록 없는 과거 런 — 성공', rc, 0)
check('완주 기록 없는 WARN 은 확인 불가 (가용 2 · 장애 1 · 확인 불가 1)',
      vector_of(out['monthly-stats.json']['2026-07']), (2, 1, 1))
check('완주 기록 없는 런 — 벡터합 = 실행 4건',
      sum(vector_of(out['monthly-stats.json']['2026-07'])), 4)

# 4) 벡터가 깨진 기존 파일(음수)은 종료 코드 1 — 완료 표시를 남기지 않는다
rc, log, out = run_backfill(make_ghpages(
    pass_runs('2026-07-20', 3),
    {'monthly-stats.json': {'2026-06': {'PASS': 5, 'WARN': 0, 'FAIL': 0,
                                        'avail': -1, 'outage': 0, 'indet': 6}}}))
check('기존 벡터에 음수가 섞이면 종료 코드 1', rc, 1)
check('기존 벡터에 음수가 섞이면 사유 출력', '음수 값' in log, True)
check('검증 실패 시 stats-meta.json 을 쓰지 않는다 (부분 마이그레이션을 정상으로 표시 금지)',
      'stats-meta.json' in out, False)
check('검증 실패 시 집계 파일도 쓰지 않는다', 'monthly-stats.json' in out, False)

# 5) 재구성 밖 구간에 벡터가 없으면 실패가 아니라 '부분 마이그레이션'이다
rc, log, out = run_backfill(make_ghpages(
    pass_runs('2026-07-20', 3),
    {'monthly-stats.json': {'2026-05': {'PASS': 40, 'WARN': 2, 'FAIL': 1}}}))
check('벡터 없는 과거 월 — 백필 자체는 성공', rc, 0)
check('벡터 없는 과거 월 — 완료 표시를 붙이지 않는다',
      out['stats-meta.json']['backfillComplete'], False)
check('벡터 없는 과거 월 — 어느 구간인지 남긴다',
      '2026-05' in out['stats-meta.json'].get('incompleteKeys', []), True)
check('벡터 없는 과거 월 — 재구성한 월은 정상 기록',
      vector_of(out['monthly-stats.json']['2026-07']), (3, 0, 0))

# 6) 재구성 벡터합이 자체 실행 수와 어긋나면 (집계 루프가 깨진 경우) 백필은 중단된다.
#    데이터로는 재현할 수 없는 상태라 — 분류 카운터와 실행 카운터가 한 몸으로 증가한다 —
#    백필 1단계가 쓰는 판정 함수 자체로 고정한다. 위반이 나오면 스크립트는 종료 코드 1이다.
check('재구성 벡터합 ≠ 실행 수 → 위반으로 보고 (백필 1단계 중단 조건)',
      vector_invariant_errors({'2026-07': {'avail': 9, 'outage': 0, 'indet': 0}}, {'2026-07': 10}),
      [('2026-07', 9, 10)])
check('재구성 벡터 자체가 없으면 → 위반 (백필 1단계 중단 조건)',
      vector_invariant_errors({'2026-07': {'PASS': 10}}, {'2026-07': 10}), [('2026-07', None, 10)])

print()
if failures:
    print(f"실패 {len(failures)}건: {', '.join(failures)}")
    sys.exit(1)
print("전체 통과")
