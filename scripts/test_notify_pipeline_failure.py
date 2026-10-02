"""notify_pipeline_failure.py 연속 실패 집계 테스트 — 표준 라이브러리만으로 돈다.

반복 알림 억제는 '직전 운영 런이 몇 번 연속 실패했나'에 달려 있다. 이 값이 틀리면
같은 장애 알림이 매번 나가거나(과소 집계) 필요한 재알림이 빠진다(과대 집계).
특히 cancelled 는 '대기 중 대체'와 '시간 제한 초과'가 섞여 있어 여기서 고정한다.

  python3 scripts/test_notify_pipeline_failure.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from notify_pipeline_failure import count_consecutive_failures, PRODUCTION_TITLE  # noqa: E402

failures = []


def check(name, got, expected):
    if got == expected:
        print(f'  OK   {name}')
    else:
        failures.append(name)
        print(f'  FAIL {name}: got={got} expected={expected}')


def run(i, conclusion, event='workflow_dispatch', title=PRODUCTION_TITLE):
    return {'databaseId': i, 'conclusion': conclusion, 'event': event, 'displayTitle': title}


# 취소된 런 중 잡이 있었던 것(시간 제한 초과)만 True
TIMED_OUT_IDS = {50}
had_jobs = lambda i: i in TIMED_OUT_IDS  # noqa: E731
unknown = lambda i: None  # noqa: E731


def count(runs, cur='', lookup=had_jobs):
    return count_consecutive_failures(runs, cur, lookup)


print('== 기본 ==')
check('실패 2연속 후 성공', count([run(1, 'failure'), run(2, 'failure'), run(3, 'success')]), 2)
check('직전이 성공이면 0', count([run(1, 'success'), run(2, 'failure')]), 0)
check('이번 런 자신은 세지 않음', count([run(9, 'failure'), run(1, 'failure'), run(2, 'success')], cur='9'), 1)

print('\n== cancelled 구분 ==')
# 대기 중 대체된 런 하나가 연속을 끊어 억제가 풀리던 버그
check('대기 중 대체(잡 없음)는 건너뛰고 연속 유지',
      count([run(1, 'failure'), run(40, 'cancelled'), run(2, 'failure'), run(3, 'success')]), 2)
check('시간 제한 초과(잡 있음)는 실패로 셈',
      count([run(1, 'failure'), run(50, 'cancelled'), run(2, 'success')]), 2)
check('잡 유무를 모르면 건너뜀(끊지도 늘리지도 않음)',
      count([run(1, 'failure'), run(40, 'cancelled'), run(2, 'failure'), run(3, 'success')], lookup=unknown), 2)
check('대체 런만 연속으로 있어도 그 뒤 실패까지 셈',
      count([run(40, 'cancelled'), run(41, 'cancelled'), run(1, 'failure'), run(2, 'success')]), 1)

print('\n== 운영 런만 ==')
check('검증 런은 무시',
      count([run(1, 'failure'), run(7, 'success', title='이지랩 헬스체크 (검증)'), run(2, 'failure'), run(3, 'success')]), 2)
check('예전 schedule 런도 운영 런',
      count([run(1, 'failure'), run(2, 'failure', event='schedule', title='이지랩 헬스체크'), run(3, 'success', event='schedule', title='이지랩 헬스체크')]), 2)
check('예전 main 수동 런(제목 구분 전)은 무시',
      count([run(1, 'failure'), run(8, 'success', title='이지랩 헬스체크'), run(2, 'failure'), run(3, 'success')]), 2)

print()
if failures:
    print(f'실패 {len(failures)}건: {", ".join(failures)}')
    sys.exit(1)
print('전체 통과')
