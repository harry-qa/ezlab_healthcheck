"""fail_streak.py 시퀀스 테스트 — 외부 의존성 없이 표준 라이브러리만으로 돈다.

알림·이슈 게이트의 판정은 실제 장애가 나야만 확인되는데, 그때는 이미 늦다.
연속 판정(누적 교집합·폴백·복구 재현)을 여기서 고정한다.

  python3 scripts/test_fail_streak.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fail_streak import effective_streak, previous_effective_streak  # noqa: E402

A = 'ezlab.im/ko|HTTP_5XX'
B = 'cdn.ezlab.im/x.exe|HTTP_4XX'
CUR = '2026-07-31_02-47'
P1, P2, P3 = '2026-07-31_02-17', '2026-07-31_01-47', '2026-07-31_01-17'
THRESHOLD = 2

failures = []


def _files(history, cur_fps):
    d = tempfile.mkdtemp()
    hp, sp = os.path.join(d, 'h.json'), os.path.join(d, 's.json')
    with open(hp, 'w') as f:
        json.dump({k: [{'fingerprint': x} for x in v] for k, v in history.items()}, f)
    with open(sp, 'w') as f:
        json.dump({'failFingerprints': cur_fps}, f)
    return sp, hp


def check(name, got, expected):
    if got == expected:
        print(f'  OK   {name}')
    else:
        failures.append(name)
        print(f'  FAIL {name}: got={got} expected={expected}')


def alert(history, cur_fps, recent):
    """현재 런이 FAIL일 때 장애 알림이 나가는지."""
    sp, hp = _files(history, cur_fps)
    eff, _fp, _cnt = effective_streak('FAIL', recent, CUR, sp, hp)
    return eff >= THRESHOLD, eff


def recovery(history, recent):
    """현재 런이 PASS일 때 복구 알림이 나가는지(직전 장애가 실제 알림된 수준이었는지)."""
    sp, hp = _files(history, [])          # 현재 PASS → 지문 없음
    return previous_effective_streak(recent, CUR, hp) >= THRESHOLD


print('연속 장애 판정')
check('같은 지문 2런 연속 → 알림',
      alert({CUR: [A], P1: [A]}, [A], ['FAIL', 'PASS']), (True, 2))
check('같은 지문 3런 연속 → 알림',
      alert({CUR: [A], P1: [A], P2: [A]}, [A], ['FAIL', 'FAIL']), (True, 3))
check('A→B 서로 다른 단발 → 억제',
      alert({CUR: [B], P1: [A]}, [B], ['FAIL', 'PASS']), (False, 1))
check('누적 교집합 {A,B}→{A}→{B} → 2에서 끊김',
      alert({CUR: [A, B], P1: [A], P2: [B]}, [A, B], ['FAIL', 'FAIL']), (True, 2))
check('지문 이력 없음 → 횟수 기준 폴백(알림)',
      alert({}, [A], ['FAIL', 'PASS']), (True, 2))
check('단발 FAIL 1회 → 억제',
      alert({CUR: [A]}, [A], ['PASS', 'PASS']), (False, 1))

print('\n복구 알림 판정')
# A→B→PASS: 장애 알림이 나간 적 없으므로 복구 알림도 나가면 안 된다.
check('A→B→PASS → 복구 알림 없음',
      recovery({P1: [B], P2: [A]}, ['FAIL', 'FAIL']), False)
# A→A→PASS: 같은 장애가 2런 이어져 알림이 나갔으므로 복구 알림이 나가야 한다.
check('A→A→PASS → 복구 알림 발송',
      recovery({P1: [A], P2: [A]}, ['FAIL', 'FAIL']), True)
check('단발 FAIL 1회 후 PASS → 복구 알림 없음',
      recovery({P1: [A]}, ['FAIL', 'PASS']), False)
check('지문 이력 없음 + 연속 FAIL 2회 → 폴백으로 복구 알림',
      recovery({}, ['FAIL', 'FAIL']), True)
check('직전이 PASS → 복구 대상 아님',
      recovery({}, ['PASS', 'PASS']), False)

print()
if failures:
    print(f'실패 {len(failures)}건: {", ".join(failures)}')
    sys.exit(1)
print('전체 통과')
