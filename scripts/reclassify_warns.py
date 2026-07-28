"""
과거 WARN 판정 정정 (일회성 마이그레이션).

헬스 스코어가 92.6%까지 떨어진 원인의 대부분은 '이미 코드에서 고친 판정'이 gh-pages에
기록으로 남아 계속 점수를 깎고 있던 것이다. statuses.json은 최근 500런(약 43일)을 보므로
방치하면 그 기간 내내 낡은 WARN이 스코어를 끌어내린다.

정정 대상 (셋 다 '지금 코드로 다시 돌리면 PASS가 나오는' 런이다):

  1. 근거 없는 WARN   — warnCount>=1 인데 failures가 비어 있는 런.
                        cd34601(2026-07-13) 이전 '느린 응답 = WARN' 판정의 잔재.
                        그 커밋에서 응답시간은 SLOW(정보성)로 분리돼 더는 스코어에 반영되지 않는다.

  2. 외부링크 단독 WARN — 이지랩이 소유·수정할 수 없는 제3자 도메인(abr.ge 등) 이상.
                        현재 코드는 이를 INFO(정보성)로 기록한다.

  3. 단발 간헐회복 WARN — 재시도로 회복돼 사용자에겐 정상 페이지가 보인 항목.
                        6f36076(2026-07-24)에서 INTERMITTENT_WARN_THRESHOLD=2 도입 후
                        단발은 런 상태를 바꾸지 않는다. 그 커밋 이전 런만 정정한다.

정정 제외 — '오리진 간헐 불안정'(type='간헐') 종합 판정은 그대로 WARN으로 둔다.
임계치에 도달했다는 건 한 런에 회복이 여러 건 몰렸다는 뜻이고, 실제로 1회차 응답이
10초 넘게 걸리며 502/504가 떴던 구간이다. 이것까지 지우면 헬스체크가 초록불만 보여준다.

쓰기 대상:
  statuses.json / daily-stats.json / monthly-stats.json   (루트 집계)
  <런>/status.json                                        (개별 런 원본)
  failures-history.json / <런>/status.json 의 severity    (외부링크 → INFO)

개별 런 status.json까지 고치는 이유: backfill_stats.py는 런 폴더를 원본으로 집계를 재구성한다.
루트 집계만 고치면 다음 백필 때 낡은 WARN이 그대로 되살아난다.

사용법:
  python3 scripts/reclassify_warns.py <gh-pages_체크아웃_경로>            # dry-run (기본)
  python3 scripts/reclassify_warns.py <gh-pages_체크아웃_경로> --apply    # 실제 반영
"""
import json
import os
import re
import sys

RUN_RE = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$')

# 6f36076 — 간헐 회복 임계치(2건) 도입. 이 시각 이후 런은 단발 회복으로 WARN이 되지 않으므로
# 정정 대상에서 뺀다(이후에 남아 있는 WARN은 임계치를 실제로 넘긴 진짜 신호다).
INTERMITTENT_FIX_RUN = '2026-07-24_19-06'

REASON_EMPTY = '근거 없는 WARN (응답속도 판정 잔재 · cd34601에서 SLOW로 분리)'
REASON_EXT   = '외부링크 단독 (제3자 도메인 · 현재 코드는 INFO)'
REASON_INTER = '단발 간헐회복 (6f36076 임계치 도입 이전 판정)'


def is_external(item):
    return item.get('type') == '외부링크'


def is_single_intermittent(item):
    # type='간헐'은 임계치를 넘긴 '오리진 불안정' 종합 판정 — 정정 대상이 아니다.
    return item.get('type') != '간헐' and str(item.get('symptom', '')).startswith('간헐 실패 후 회복')


def classify(run, failures):
    """이 WARN 런을 PASS로 정정해야 하면 사유를, 아니면 None을 반환."""
    if not failures:
        return REASON_EMPTY
    # 스코어를 깎을 자격이 있는 항목이 하나라도 남으면 WARN 유지.
    kept = []
    for it in failures:
        if is_external(it):
            continue
        if is_single_intermittent(it) and run < INTERMITTENT_FIX_RUN:
            continue
        kept.append(it)
    if kept:
        return None
    if any(is_single_intermittent(it) for it in failures):
        return REASON_INTER
    return REASON_EXT


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    root = sys.argv[1].rstrip('/')
    apply_changes = '--apply' in sys.argv[2:]

    if not os.path.isfile(f'{root}/statuses.json'):
        print(f"ERROR: {root}/statuses.json 이 없습니다 — gh-pages 체크아웃 경로가 맞는지 확인하세요")
        raise SystemExit(1)

    statuses  = load(f'{root}/statuses.json', {})
    failures  = load(f'{root}/failures-history.json', {})
    daily     = load(f'{root}/daily-stats.json', {})
    monthly   = load(f'{root}/monthly-stats.json', {})

    # 런 폴더의 status.json — statuses.json(500 캡) 밖의 과거도 집계 정정에 반영하기 위해 함께 읽는다.
    run_files = {}
    for name in os.listdir(root):
        if RUN_RE.match(name) and os.path.isfile(f'{root}/{name}/status.json'):
            run_files[name] = load(f'{root}/{name}/status.json', {})

    # 정정 판단 — 근거는 failures-history 우선, 없으면 런 폴더 status.json의 failures.
    fixed = {}
    for run in sorted(set(statuses) | set(run_files), reverse=True):
        status = statuses.get(run) or run_files.get(run, {}).get('status')
        if status != 'WARN':
            continue
        items = failures.get(run)
        if items is None:
            items = run_files.get(run, {}).get('failures', [])
        reason = classify(run, items)
        if reason:
            fixed[run] = reason

    # ── 리포트 ────────────────────────────────────────────────────
    def score(st):
        p = sum(1 for v in st.values() if v == 'PASS')
        w = sum(1 for v in st.values() if v == 'WARN')
        f_ = sum(1 for v in st.values() if v == 'FAIL')
        d = p + w + f_
        return (round(p / d * 100, 1) if d else 0), p, w, f_

    before = score(statuses)
    after_statuses = dict(statuses)
    for run in fixed:
        if run in after_statuses:
            after_statuses[run] = 'PASS'
    after = score(after_statuses)

    by_reason = {}
    for run, reason in fixed.items():
        by_reason.setdefault(reason, []).append(run)

    print('=' * 72)
    print(f"WARN 정정 {'실행' if apply_changes else '검토(dry-run)'} — {root}")
    print('=' * 72)
    for reason in (REASON_EMPTY, REASON_INTER, REASON_EXT):
        runs = sorted(by_reason.get(reason, []), reverse=True)
        if not runs:
            continue
        print(f"\n[{len(runs)}건] {reason}")
        for run in runs:
            print(f"    {run}")

    kept_warns = sorted((r for r, v in statuses.items() if v == 'WARN' and r not in fixed), reverse=True)
    print(f"\n[유지] WARN으로 남는 런 {len(kept_warns)}건 — 실제 이지랩 이슈")
    for run in kept_warns:
        syms = '; '.join(str(i.get('symptom', ''))[:52] for i in failures.get(run, [])) or '-'
        print(f"    {run}  {syms}")

    print(f"\n{'-' * 72}")
    print(f"Health Score  {before[0]}%  →  {after[0]}%")
    print(f"  이전: PASS {before[1]} / WARN {before[2]} / FAIL {before[3]}")
    print(f"  이후: PASS {after[1]} / WARN {after[2]} / FAIL {after[3]}")
    print(f"  집계 정정 대상(런 폴더 포함): {len(fixed)}건")

    if not apply_changes:
        print(f"\n※ dry-run 입니다 — 파일은 변경되지 않았습니다.")
        print(f"   실제 반영: python3 scripts/reclassify_warns.py {root} --apply")
        return

    if not fixed:
        print('\n정정할 런이 없습니다.')
        return

    # ── 반영 ──────────────────────────────────────────────────────
    # 1) 루트 집계
    for run in fixed:
        if statuses.get(run) == 'WARN':
            statuses[run] = 'PASS'
        for bucket, key in ((daily, run[:10]), (monthly, run[:7])):
            if key in bucket and bucket[key].get('WARN', 0) > 0:
                bucket[key]['WARN'] -= 1
                bucket[key]['PASS'] = bucket[key].get('PASS', 0) + 1

    # 2) 외부링크 항목의 severity를 INFO로 승격 — 대시보드가 '참고 항목'으로 렌더하도록.
    #    (현재 코드가 새로 남기는 기록과 과거 기록의 표기를 일치시킨다)
    for run, items in failures.items():
        for it in items:
            if is_external(it):
                it['severity'] = 'INFO'

    # 3) 개별 런 status.json — 다음 backfill_stats.py 실행 때 낡은 값이 되살아나지 않도록 원본도 정정.
    touched_runs = 0
    for run, data in run_files.items():
        changed = False
        if run in fixed and data.get('status') == 'WARN':
            data['status'] = 'PASS'
            data['warnCount'] = 0
            changed = True
        info_n = 0
        for it in data.get('failures', []):
            if is_external(it) and it.get('severity') != 'INFO':
                it['severity'] = 'INFO'
                info_n += 1
                changed = True
        if info_n:
            data['infoCount'] = data.get('infoCount', 0) + info_n
        if changed:
            with open(f'{root}/{run}/status.json', 'w') as f:
                json.dump(data, f)
            touched_runs += 1

    with open(f'{root}/statuses.json', 'w') as f:
        json.dump(statuses, f)
    with open(f'{root}/failures-history.json', 'w') as f:
        json.dump(failures, f)
    with open(f'{root}/daily-stats.json', 'w') as f:
        json.dump(daily, f, indent=2)
    with open(f'{root}/monthly-stats.json', 'w') as f:
        json.dump(monthly, f, indent=2)

    print(f"\n반영 완료")
    print(f"  루트 집계 4개 파일 갱신")
    print(f"  개별 런 status.json {touched_runs}건 갱신")
    print(f"  → {root} 에서 커밋·푸시하면 대시보드에 반영됩니다.")


if __name__ == '__main__':
    main()
