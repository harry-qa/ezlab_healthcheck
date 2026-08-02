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


def month_buckets(month_data):
    """월별 카드용 버킷. 새 집계 키가 있으면 그것을 쓰고, 없으면 보수적으로 환산한다.

    과거 월에는 완주 여부 기록이 없다. 그 WARN 을 가용으로 세면 없는 근거로 가용률을
    올리는 셈이라, 규칙대로 전부 확인 불가로 둔다(가용률은 PASS 와 FAIL 로만 계산된다).
    """
    if 'avail' in month_data or 'outage' in month_data or 'indet' in month_data:
        return {
            AVAILABLE:     month_data.get('avail', 0),
            OUTAGE:        month_data.get('outage', 0),
            INDETERMINATE: month_data.get('indet', 0),
        }
    return {
        AVAILABLE:     month_data.get('PASS', 0),
        OUTAGE:        month_data.get('FAIL', 0),
        INDETERMINATE: month_data.get('WARN', 0),
    }
