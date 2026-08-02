"""대시보드 지표 계산 — 헬스체크 '판정'이 아니라 '집계' 규칙만 담는다.

배경: 예전 Health Score 는 `PASS / (PASS+WARN+FAIL)` 하나였다. 산식에 WARN 과 FAIL 을
구분하는 항이 없어 품질 경고가 장애와 똑같이 100% 감점됐고, 그래서 탐지 범위를 넓힐수록
가동률이 떨어졌다. 실측: OG 이미지 403 검사를 추가한 2026-07-31 직후부터 거의 모든 런이
WARN 이 되어 8월 가동률이 0% 로 표시됐다. 사이트가 나빠진 게 아니라 검사가 늘어난 것이다.

→ 성격이 다른 질문 네 가지를 각각 답하도록 지표를 분리한다.
    1. 서비스 가용률   : 사이트가 실제로 살아 있었는가
    2. 점검 완주율     : 헬스체크가 제 일을 다 했는가
    3. 무경고 실행률   : 경고 없이 완벽했던 실행의 비율 (기존 산식 · 보조 지표)
    4. 열린 품질 경고  : 지금 몇 개의 결함이 열려 있는가 (런 단위가 아니라 결함 단위)

이 모듈은 순수 함수만 둔다 — 파일 I/O 도 HTML 생성도 하지 않아야 테스트로 규칙을 고정할 수 있다.
"""

AVAILABLE     = '가용'
OUTAGE        = '장애'
INDETERMINATE = '확인불가'

# 월별·일별 집계에 담기는 서비스 분류 벡터의 키. 셋은 항상 '한 벌'로 다룬다.
VECTOR_KEYS = ('avail', 'outage', 'indet')

# 집계 스키마 버전. 서비스 분류 벡터(avail/outage/indet)가 들어간 버전이 2다.
# 부분 마이그레이션 상태(일부 월에만 벡터가 있는 상태)를 정상 데이터로 읽으면
# 백필 전 월은 0% 같은 엉뚱한 가용률로 표시된다 → 완료 표시가 있을 때만 벡터를 신뢰한다.
STATS_SCHEMA_VERSION = 2


def is_migrated(meta):
    """집계 파일이 서비스 분류 벡터를 신뢰할 수 있는 상태인지.

    백필이 전 구간을 재구성하고 stats-meta.json 에 완료 표시를 남겼을 때만 True.
    False 면 월별 지표는 벡터를 쓰지 않고 보수적 환산(WARN=확인 불가)으로 통일한다 —
    마이그레이션된 월과 안 된 월을 섞어 보여주는 것이 가장 위험하다.
    """
    if not isinstance(meta, dict):
        return False
    try:
        version = int(meta.get('schemaVersion', 0))
    except (TypeError, ValueError):
        return False
    return version >= STATS_SCHEMA_VERSION and meta.get('backfillComplete') is True


def vector_of(bucket_data):
    """집계 dict 에서 서비스 분류 벡터를 꺼낸다. 키가 하나라도 없으면 None(불완전)."""
    if not isinstance(bucket_data, dict):
        return None
    if not all(k in bucket_data for k in VECTOR_KEYS):
        return None
    try:
        return tuple(int(bucket_data[k]) for k in VECTOR_KEYS)
    except (TypeError, ValueError):
        return None


def vector_replaced(existing, rebuilt):
    """이 구간에서 merge_bucket 이 재구성 벡터로 '교체'하는가(아니면 기존 벡터를 보존하는가).

    교체 판정 규칙을 merge_bucket 과 백필 검증이 각자 다시 쓰면 둘이 어긋날 수 있어
    한 함수로 둔다. 백필 검증은 '교체된 구간'에서만 벡터합 == 실행 수를 요구한다 —
    보존된 구간의 벡터는 이번 재구성이 본 실행 수와 무관한 과거 누적이기 때문이다.
    """
    rb_vec = vector_of(rebuilt)
    if rb_vec is None:
        return False
    return sum(rb_vec) >= sum(vector_of(existing) or (0, 0, 0))


def merge_bucket(existing, rebuilt):
    """백필 병합 — PASS/WARN/FAIL 은 항목별 max(축소 방지), 서비스 분류는 '벡터 단위'로 처리.

    벡터를 항목별 max 로 섞으면 avail+outage+indet 가 실제 실행 수와 어긋난 조합이 만들어진다
    (예: 기존 가용 10·확인불가 0 과 재구성 가용 0·확인불가 10 을 섞으면 합이 20이 된다).
    → 재구성이 더 많은 실행을 본 경우에만 벡터를 통째로 교체하고, 아니면 통째로 보존한다.
    """
    out = {k: v for k, v in existing.items()} if isinstance(existing, dict) else {}
    for field in ('PASS', 'WARN', 'FAIL'):
        out[field] = max(int(out.get(field, 0) or 0), int((rebuilt or {}).get(field, 0) or 0))
    if vector_replaced(existing, rebuilt):
        for key, value in zip(VECTOR_KEYS, vector_of(rebuilt)):
            out[key] = value
    elif vector_of(out) is None:
        # 어느 쪽에도 완전한 벡터가 없으면 키를 만들지 않는다 — 부분 키 상태를 남기지 않기 위함.
        for key in VECTOR_KEYS:
            out.pop(key, None)
    return out


def vector_invariant_errors(buckets, runs_seen):
    """벡터합 == 실행 수 검사: avail + outage + indet 가 분류된 실행 수와 정확히 같은가.

    적용 대상은 '이번 재구성이 권위를 갖는' 벡터뿐이다.
      · 병합 전 순수 재구성 결과 전체
      · 병합 결과 중 재구성 벡터로 교체된 구간
    병합 결과 전체에 걸면 안 된다 — prune 으로 폴더가 사라진 뒤 기존 벡터 100건을 보존하고
    남은 폴더 10건만 재구성한 정상 상황에서도 100 != 10 으로 실패한다.

    반환: 위반 항목 [(키, 벡터합, 기대값)] — 비어 있으면 정상.
    """
    errors = []
    for key, data in buckets.items():
        vec = vector_of(data)
        expected = runs_seen.get(key)
        if expected is None:
            continue
        if vec is None or sum(vec) != expected:
            errors.append((key, None if vec is None else sum(vec), expected))
    return errors


def vector_shape_errors(buckets, required=()):
    """병합 결과의 '구조' 검사 — 합계가 아니라 형태만 본다.

    병합 결과에는 보존 구간(과거 누적)과 교체 구간(이번 재구성)이 섞여 있어 실행 수와의
    합 일치를 요구할 수 없다. 대신 두 가지만 확인한다.
      · required 구간(재구성이 실제로 본 월·일)의 벡터가 세 키 모두 있는 완전한 벡터인가
      · 어느 벡터에도 음수가 섞이지 않았는가 (기존 파일 손상·수기 편집 방어)
    required 밖에서 벡터가 아예 없는 것은 오류가 아니라 '부분 마이그레이션'이다 —
    호출 측이 backfillComplete=False 로 표시하고 대시보드는 보수적 환산으로 폴백한다.

    반환: 위반 항목 [(키, 사유)] — 비어 있으면 정상.
    """
    errors = []
    required = set(required)
    for key, data in buckets.items():
        vec = vector_of(data)
        if vec is None:
            if key in required:
                errors.append((key, '벡터 불완전 (세 키가 한 벌로 있어야 함)'))
            continue
        if any(v < 0 for v in vec):
            errors.append((key, f'음수 값 {vec}'))
    return errors


def classify_run(status, coverage):
    """런 하나를 '서비스 관점'으로 분류한다.

        FAIL                      → 장애
        PASS                      → 가용
        WARN + 완주(coverage=True)→ 가용 (품질 경고는 있지만 사용자는 서비스를 쓸 수 있었다)
        WARN + 미완주             → 확인 불가 (점검을 덜 했으므로 가용을 주장할 근거가 없다)
        UNKNOWN                   → 확인 불가

    coverage 가 None 인 경우(= coverageComplete 도입 이전의 과거 런)에도 WARN 을 임의로
    가용 처리하지 않는다. 모르는 것은 모른다고 표시하는 편이 가용률을 부풀리는 것보다 낫다.
    """
    if status == 'FAIL':
        return OUTAGE
    if status == 'PASS':
        return AVAILABLE
    if status == 'WARN':
        return AVAILABLE if coverage is True else INDETERMINATE
    return INDETERMINATE


def classify_counts(runs):
    """[(status, coverage), ...] → {가용: n, 장애: n, 확인불가: n}"""
    counts = {AVAILABLE: 0, OUTAGE: 0, INDETERMINATE: 0}
    for status, coverage in runs:
        counts[classify_run(status, coverage)] += 1
    return counts


def availability(counts):
    """서비스 가용률 = 가용 / (가용 + 장애).

    확인 불가는 분모에서 뺀다 — 판정하지 못한 런을 실패로 세면 헬스체크 자체의 문제가
    사이트 점수로 둔갑한다. 대신 호출 측이 확인 불가 건수를 반드시 함께 표시해야 한다.
    판정된 런이 하나도 없으면 None(데이터 없음) — 0% 로 적으면 '전면 장애'로 오독된다.
    """
    denom = counts[AVAILABLE] + counts[OUTAGE]
    if denom == 0:
        return None
    return round(counts[AVAILABLE] / denom * 100, 1)


def completion_rate(coverages):
    """점검 완주율 = 완주 실행 / 완주 여부를 아는 실행.

    반환: (비율 또는 None, 완주 수, 판정 가능 수)
    coverageComplete 필드가 없는 과거 런은 분모에서 제외한다. 필드가 있는 런이 표본으로
    너무 적으면(호출 측에서 판단) 비율 대신 '데이터 부족'으로 표시해야 한다.
    """
    known = [c for c in coverages if c is not None]
    if not known:
        return None, 0, 0
    done = sum(1 for c in known if c is True)
    return round(done / len(known) * 100, 1), done, len(known)


def no_warning_rate(statuses):
    """무경고 실행률 = PASS / (PASS+WARN+FAIL). 기존 Health Score 와 동일한 산식.

    주 지표가 아니라 품질 추이 보조 지표다. 검사를 추가하면 낮아지는 것이 정상이므로
    이 값만 보고 서비스가 나빠졌다고 읽으면 안 된다.
    """
    scored = sum(1 for s in statuses if s in ('PASS', 'WARN', 'FAIL'))
    if scored == 0:
        return None, 0
    passed = sum(1 for s in statuses if s == 'PASS')
    return round(passed / scored * 100, 1), scored


def open_quality_warnings(runs_chrono, warn_fingerprints, coverage, resolve_after=2):
    """열린 품질 경고를 '결함 단위'로 관리한다.

    런 단위로 세면 결함 하나가 30분마다 새 경고로 잡힌다 — 실측에서 'WARN 22건' 이
    실제로는 OG 이미지 403 하나가 22번 반복된 것이었다. 지문(fingerprint)으로 묶어
    '지금 열려 있는 결함이 몇 개인가' 를 답하게 한다.

    해결 판정은 완주 실행만 쓴다. 미완주 실행은 그 검사를 아예 안 했을 수 있어
    '지문이 안 보였다' 가 '고쳐졌다' 를 뜻하지 않는다 → 판정에서 통째로 제외한다.
    완주 실행에서 연속 resolve_after 회 미검출이면 해결로 전환한다.

    인자:
        runs_chrono       : 과거→현재 순서의 런 키 목록
        warn_fingerprints : {런: set(WARN 등급 지문)} — FAIL 은 장애, INFO 는 정보성이라 제외
        coverage          : {런: True|False|None}
    반환: (열린 경고 목록, 해결된 경고 목록) — 각 항목은 dict
    """
    open_map = {}
    resolved = []
    for run in runs_chrono:
        if coverage.get(run) is not True:
            continue  # 미완주·완주 미상 실행은 검출에도 해결에도 쓰지 않는다
        seen = warn_fingerprints.get(run, set())
        for fp in seen:
            state = open_map.setdefault(fp, {'fingerprint': fp, 'first': run, 'last': run,
                                             'detected': 0, 'missed': 0})
            state['last'] = run
            state['missed'] = 0
            state['detected'] += 1
        for fp in list(open_map):
            if fp in seen:
                continue
            open_map[fp]['missed'] += 1
            if open_map[fp]['missed'] >= resolve_after:
                resolved.append(open_map.pop(fp))
    ordered = sorted(open_map.values(), key=lambda s: (-s['detected'], s['fingerprint']))
    return ordered, resolved


# 결함 카드에 붙는 관측 상태. 판정(FAIL/WARN/INFO)이 아니라 '언제부터 보이는가' 만 답한다.
OCCURRENCE_NEW        = 'new'          # 이 실행에서 처음 관측된 지문
OCCURRENCE_PERSISTING = 'persisting'   # 이전 완주 실행에서도 관측됐고 지금도 있는 지문


def occurrence_states(runs_chrono, fingerprints_by_run, coverage, resolve_after=2):
    """실행별로 '이 지문이 이번에 처음인가(신규), 계속 보이던 것인가(지속)' 를 계산한다.

    같은 결함이 30분마다 똑같이 보이면 사용자는 새로 생긴 문제인지 구분할 수 없다.
    open_quality_warnings 와 '완전히 같은 규칙'을 쓴다 — 규칙이 갈라지면 열린 품질 경고
    카운트와 카드 배지가 서로 다른 말을 하게 된다.
      · 상태 갱신은 완주 실행만 한다. 미완주 실행은 검사를 덜 했을 수 있어
        '안 보였다'가 해결의 근거가 아니고, 거기서만 보인 지문을 '지속'의 근거로도 쓰지 않는다.
      · 완주 실행에서 resolve_after 회 연속 미검출이면 닫히고, 뒤에 다시 나오면 '신규'(재발)다.

    미완주 실행의 카드도 배지는 붙여야 하므로, 그 실행은 상태를 '읽기만' 하고 갱신하지 않는다.

    인자:
        fingerprints_by_run : {런: set(지문)} — INFO 를 뺀 FAIL·WARN 지문
        coverage            : {런: True|False|None}
    반환: {런: {지문: {'state': OCCURRENCE_*, 'detected': 누적 검출 횟수}}}
          detected 는 '지금 열려 있는 그 결함'에서 완주 실행 기준 **누적** 검출 횟수다.
          연속 횟수가 아니다 — 해결 기준이 완주 2회 연속 미검출이라 1회 미검출로는 결함이
          닫히지 않고, 그 뒤 검출도 같은 결함의 누적으로 이어서 센다.
          (검출 → 완주 미검출 1회 → 검출 = 누적 2회)
          미완주 실행에서는 늘지 않는다. 결함이 닫히면 0부터 다시 센다.
    """
    open_map = {}
    states = {}
    for run in runs_chrono:
        seen = {fp for fp in (fingerprints_by_run.get(run) or ()) if fp}
        complete = coverage.get(run) is True
        current = {}
        for fp in seen:
            prev = open_map.get(fp)
            current[fp] = {
                'state': OCCURRENCE_PERSISTING if prev else OCCURRENCE_NEW,
                'detected': (prev['detected'] if prev else 0) + (1 if complete else 0),
            }
        states[run] = current
        if not complete:
            continue
        for fp in seen:
            state = open_map.setdefault(fp, {'detected': 0, 'missed': 0})
            state['detected'] += 1
            state['missed'] = 0
        for fp in list(open_map):
            if fp in seen:
                continue
            open_map[fp]['missed'] += 1
            if open_map[fp]['missed'] >= resolve_after:
                open_map.pop(fp)
    return states


def is_recovery_record(record):
    """재시도 후 정상으로 돌아온 기록인가(= 결함 해결이 아니라 '그 실행에서 회복').

    spec 의 intermittentRecoveries 는 severity INFO 로 남고 증상에 '회복'을 적는다.
    별도 플래그 필드가 없어 증상 문구로 식별한다 — 판정에는 쓰지 않고 표시 구분에만 쓴다.
    """
    if not isinstance(record, dict) or record.get('severity') != 'INFO':
        return False
    return '회복' in str(record.get('symptom', ''))


def current_state(status, coverage, open_warn_count):
    """현재 상태 표시 — '가용'과 '확인 불가'를 뭉뚱그리지 않는다.

    반환: (라벨, 상태키) — 상태키는 대시보드 CSS 클래스 선택에 쓴다.
    """
    if status == 'FAIL':
        return '서비스 장애', 'fail'
    if status not in ('PASS', 'WARN') or coverage is not True:
        # UNKNOWN(런 미완주로 결과 파일 없음) 또는 점검이 축소된 런
        return '점검 결과 확인 불가', 'unknown'
    if status == 'WARN':
        return f'서비스 정상 · 품질 경고 {open_warn_count}건', 'warn'
    return '서비스 정상', 'pass'


def month_buckets(month_data, migrated=False):
    """월별 카드용 버킷.

    migrated=True(백필 완료 표시 있음)이고 그 월의 벡터가 '완전할 때만' 새 키를 쓴다.
    부분 마이그레이션 상태에서 있는 월만 벡터를 쓰면 백필 전 월이 0% 로 표시돼
    "그 달에 서비스가 죽어 있었다"는 잘못된 결론이 나온다 → 섞지 않는다.

    폴백은 보수적 환산이다. 과거 월에는 완주 여부 기록이 없고, 그 WARN 을 가용으로 세면
    없는 근거로 가용률을 올리는 셈이라 전부 확인 불가로 둔다(가용률은 PASS·FAIL 로만 계산).
    """
    if migrated:
        vec = vector_of(month_data)
        if vec is not None:
            return {AVAILABLE: vec[0], OUTAGE: vec[1], INDETERMINATE: vec[2]}
    return {
        AVAILABLE:     month_data.get('PASS', 0),
        OUTAGE:        month_data.get('FAIL', 0),
        INDETERMINATE: month_data.get('WARN', 0),
    }
