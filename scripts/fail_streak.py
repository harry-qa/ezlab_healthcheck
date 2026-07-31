"""장애 지문을 반영한 '연속 실패' 계산 — Slack 알림과 GitHub 이슈 생성이 같은 기준을 쓰게 한다.

전체 재시도(retries)를 없앤 뒤로는 단발 FAIL이 리포트에 그대로 남는다. 연속 횟수만 보면
서로 무관한 오류 두 개(A → B)가 하나의 장애로 묶여 알림·이슈가 나간다.
→ 현재 런의 지문과 직전 런들의 지문을 '누적 교집합'으로 좁혀, 같은 장애가 실제로 이어질 때만
  연속으로 인정한다. {A,B} → {A} → {B} 는 2회에서 끊긴다(교집합이 비므로).

판정 불가(지문 정보가 없는 과거 이력·이력 유실·첫 배포)면 지문 게이트를 걸지 않고
횟수 기준으로 폴백한다 — 실제 장애 알림을 놓치는 것보다 과다 알림이 안전하다.

단독 실행 시 effective streak 을 표준출력으로 낸다(워크플로에서 이슈 생성 게이트로 사용).
  python3 scripts/fail_streak.py <CURRENT_STATUS> <RUN_DATETIME> "<RECENT_STATUSES>"
"""
import json
import os
import sys

HISTORY_PATH = os.environ.get('FAILURES_HISTORY', '/tmp/failures-history.json')
STATUS_PATH = os.environ.get('REPORT_STATUS', 'report-status.json')


def load_current_fingerprints(path=STATUS_PATH):
    try:
        with open(path) as f:
            return set(json.load(f).get('failFingerprints') or [])
    except Exception:
        return set()


def load_history_fingerprints(exclude_key, path=HISTORY_PATH):
    """현재 런을 제외한 최근 런들의 FAIL 지문을 최신순으로 돌려준다.

    update_failures.py 가 먼저 돌아 현재 런까지 history 에 넣으므로 반드시 제외해야 한다.
    '지문이 같으면 현재 런'이라는 추정은 쓰지 않는다 — 같은 장애가 이어질 때 직전 런의 지문이
    현재와 같아서, 진짜 연속 장애를 현재 런으로 오인해 알림이 통째로 죽는다.
    """
    try:
        with open(path) as f:
            hist = json.load(f)
    except Exception:
        return []
    out = []
    for k in sorted(hist, reverse=True):
        if exclude_key and k == exclude_key:
            continue
        recs = hist.get(k) or []
        out.append({r.get('fingerprint') for r in recs
                    if r.get('fingerprint') and r.get('severity') not in ('WARN', 'INFO')})
    return out


def count_streak(cur_status, recent):
    """상태 문자열만으로 세는 연속 FAIL 횟수(현재 런 포함)."""
    if cur_status != 'FAIL':
        return 0
    streak = 1
    for s in recent:
        if s == 'FAIL':
            streak += 1
        else:
            break
    return streak


def fingerprint_streak(cur_fps, history_fps):
    """지문 기준 연속 횟수. 대조할 이력이 없으면 None(폴백 신호)."""
    if not cur_fps or not history_fps or not history_fps[0]:
        return None
    shared = set(cur_fps)
    streak = 1
    for fps in history_fps:
        if not fps:
            break
        shared &= fps          # 누적 교집합 — A→B 처럼 갈아타면 여기서 비고 끊긴다
        if not shared:
            break
        streak += 1
    return streak


def effective_streak(cur_status, recent, exclude_key,
                     status_path=STATUS_PATH, history_path=HISTORY_PATH, cur_fps=None):
    """알림·이슈 게이트에 쓸 최종 연속 횟수와 지문 연속 횟수를 함께 돌려준다."""
    cnt = count_streak(cur_status, recent)
    if cur_fps is None:
        cur_fps = load_current_fingerprints(status_path)
    fps_streak = fingerprint_streak(cur_fps, load_history_fingerprints(exclude_key, history_path))
    return (cnt if fps_streak is None else min(cnt, fps_streak)), fps_streak, cnt


def previous_effective_streak(recent, exclude_key, history_path=HISTORY_PATH):
    """직전 런 시점의 판정을 재현한다 — 복구 알림을 낼지(직전 장애가 실제 알림됐는지) 결정용.

    현재 런이 PASS면 report-status.json 의 지문이 비어 있어, 그걸로 재현하면 지문 판정을 포기하고
    원시 횟수로 폴백한다. 그러면 A→B→PASS 처럼 장애 알림이 억제된 조합에서도 복구 알림만 나간다.
    → 직전 런의 지문은 반드시 '이력'에서 읽는다.
    """
    if not recent:
        return 0
    hist = load_history_fingerprints(exclude_key, history_path)  # 현재 런 제외, 최신→과거
    prev_fps = hist[0] if hist else set()
    cnt = count_streak(recent[0], recent[1:])
    fps_streak = fingerprint_streak(prev_fps, hist[1:])
    return cnt if fps_streak is None else min(cnt, fps_streak)


if __name__ == '__main__':
    status = sys.argv[1] if len(sys.argv) > 1 else 'UNKNOWN'
    run_key = sys.argv[2] if len(sys.argv) > 2 else ''
    recents = [s for s in (sys.argv[3] if len(sys.argv) > 3 else '').split(',') if s]
    eff, _fp, _cnt = effective_streak(status, recents, run_key)
    print(eff)
