import sys
import re
import json
import math
from datetime import datetime, timedelta
from collections import defaultdict

# ── CLI args ──────────────────────────────────────────────────────────
runs_file    = sys.argv[1]
current_run  = sys.argv[2]
statuses_file= sys.argv[3]
perf_file    = sys.argv[4]
monthly_file  = sys.argv[5]
daily_file    = sys.argv[6]
failures_file = sys.argv[7]
output_file   = sys.argv[8]

# ── Load data ─────────────────────────────────────────────────────────
with open(runs_file) as f:
    entries = sorted(
        {d.strip() for d in f if re.match(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$', d.strip())},
        reverse=True
    )

def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default

statuses         = load_json(statuses_file, {})
perf_history     = load_json(perf_file, {})
monthly_stats    = load_json(monthly_file, {})
daily_stats      = load_json(daily_file, {})
failures_history = load_json(failures_file, {})

# ── Constants ─────────────────────────────────────────────────────────
LANGS       = ['ko', 'en', 'jp', 'tw']
LANG_LABELS = {'ko': '한국어', 'en': '영어', 'jp': '일본어', 'tw': '중국어'}
BASE_URL    = 'https://ezlab.im'
THRESHOLD   = 500  # ms danger threshold (TTFB 첫 응답 기준 · 본문 다운로드 제외)

# ── Overview stats ────────────────────────────────────────────────────
total  = len(entries)
pass_c = sum(1 for e in entries if statuses.get(e) == 'PASS')
fail_c = sum(1 for e in entries if statuses.get(e) == 'FAIL')
warn_c = sum(1 for e in entries if statuses.get(e) == 'WARN')

health_score = round(pass_c / total * 100, 1) if total else 0
cur_status   = statuses.get(current_run, 'UNKNOWN')

# 진짜 24시간 윈도우 — 실행이 시간당이 아니라(GitHub 스케줄러가 상당수 드랍)
# entries[:24]="최근 24회"는 약 3.4일이라 "24시간" 라벨과 안 맞음. 타임스탬프로 계산.
def _parse_run(e):
    return datetime.strptime(e, '%Y-%m-%d_%H-%M')
try:
    _window_start = _parse_run(current_run) - timedelta(hours=24)
    fail_24h = sum(1 for e in entries
                   if statuses.get(e) == 'FAIL' and _parse_run(e) >= _window_start)
except ValueError:
    fail_24h = sum(1 for e in entries[:24] if statuses.get(e) == 'FAIL')

cur_date_str, cur_time_str = current_run.split('_')
cur_display = f"{cur_date_str} {cur_time_str.replace('-', ':')}"

# ── Overview card HTML ────────────────────────────────────────────────
score_cls = (
    'score-great' if health_score >= 99 else
    'score-good'  if health_score >= 95 else
    'score-warn'  if health_score >= 90 else
    'score-bad'
)
status_dot = {
    'PASS':    ('<span class="dot dot-pass"></span>', '정상 운영',   'ov-card--pass'),
    'WARN':    ('<span class="dot dot-warn"></span>', '주의 필요',   'ov-card--warn'),
    'FAIL':    ('<span class="dot dot-fail"></span>', '장애 감지',   'ov-card--fail'),
    'UNKNOWN': ('<span class="dot dot-unknown"></span>', '알 수 없음', ''),
}
dot_html, status_label, status_card_cls = status_dot.get(cur_status, status_dot['UNKNOWN'])
alert_cls = 'val-danger' if fail_24h > 0 else 'val-ok'
alert_val = f'{fail_24h}건' if fail_24h > 0 else '이상 없음'

overview_html = f'''
    <div class="ov-grid">
      <div class="ov-card">
        <div class="ov-label">Health Score</div>
        <div class="ov-value {score_cls}">{health_score}%</div>
        <div class="ov-sub">최근 {total}회 기준</div>
      </div>
      <div class="ov-card {status_card_cls}">
        <div class="ov-label">현재 시스템 상태</div>
        <div class="ov-status-row">{dot_html}<span class="ov-status-text">{status_label}</span></div>
        <div class="ov-sub">{cur_display} KST</div>
      </div>
      <div class="ov-card">
        <div class="ov-label">최근 24시간 장애</div>
        <div class="ov-value {alert_cls}">{alert_val}</div>
        <div class="ov-sub">FAIL 감지 횟수</div>
      </div>
    </div>'''

# ── Response time line chart ──────────────────────────────────────────
LANG_COLORS = {'ko': '#58a6ff', 'en': '#3fb950', 'jp': '#f78166', 'tw': '#d2a8ff'}

def smooth_path(pts, lo=None, hi=None):
    """Monotone cubic Hermite (Fritsch–Carlson): smooth but never overshoots,
    so no false peaks/valleys are introduced between real data points."""
    n = len(pts)
    if n < 2:
        return ''
    if n == 2:
        return f'M{pts[0][0]:.1f},{pts[0][1]:.1f} L{pts[1][0]:.1f},{pts[1][1]:.1f}'

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    dx = [xs[i + 1] - xs[i] for i in range(n - 1)]
    delta = [(ys[i + 1] - ys[i]) / dx[i] if dx[i] else 0 for i in range(n - 1)]

    m = [0.0] * n
    m[0] = delta[0]
    m[-1] = delta[-1]
    for i in range(1, n - 1):
        if delta[i - 1] * delta[i] <= 0:
            m[i] = 0.0
        else:
            m[i] = (delta[i - 1] + delta[i]) / 2

    for i in range(n - 1):
        if delta[i] == 0:
            m[i] = m[i + 1] = 0.0
        else:
            a = m[i] / delta[i]
            b = m[i + 1] / delta[i]
            s = a * a + b * b
            if s > 9:
                t = 3.0 / math.sqrt(s)
                m[i] = t * a * delta[i]
                m[i + 1] = t * b * delta[i]

    d = f'M{xs[0]:.1f},{ys[0]:.1f}'
    for i in range(n - 1):
        c1x = xs[i] + dx[i] / 3
        c1y = ys[i] + m[i] * dx[i] / 3
        c2x = xs[i + 1] - dx[i] / 3
        c2y = ys[i + 1] - m[i + 1] * dx[i] / 3
        d += f' C{c1x:.1f},{c1y:.1f} {c2x:.1f},{c2y:.1f} {xs[i+1]:.1f},{ys[i+1]:.1f}'
    return d

def make_lang_sparklines():
    """Small-multiples: one sparkline card per language (no overlap)."""
    recent = list(reversed(entries[:24]))
    if not recent:
        return ''
    series = {}
    for lang in LANGS:
        vals = [perf_history.get(r, {}).get('serverTimes', {}).get(lang, 0) for r in recent]
        if any(v > 0 for v in vals):
            series[lang] = vals
    if not series:
        return ''

    all_vals = [v for vs in series.values() for v in vs if v > 0]
    raw_max  = max(max(all_vals) * 1.12, THRESHOLD * 1.3)
    max_val  = math.ceil(raw_max / 200) * 200

    W, H   = 200, 56
    PT, PB = 7, 7
    CH     = H - PT - PB

    cards = ''
    for lang in LANGS:
        if lang not in series:
            continue
        color = LANG_COLORS[lang]
        vals  = series[lang]
        pos   = [v for v in vals if v > 0]
        avg_ms = round(sum(pos) / len(pos))
        max_ms = max(pos)
        latest = next((v for v in reversed(vals) if v > 0), 0)
        n = len(vals)

        def cx(i): return (i / (n - 1) * W) if n > 1 else W / 2
        def cy(ms): return PT + CH * (1 - ms / max_val)

        raw  = [(cx(i), cy(v), v) for i, v in enumerate(vals) if v > 0]
        pts  = [(x, y) for x, y, _ in raw]
        line = smooth_path(pts)

        gid = f'sg-{lang}'
        body = [
            f'<defs><linearGradient id="{gid}" x1="0" x2="0" y1="0" y2="1">'
            f'<stop offset="0" stop-color="{color}" stop-opacity="0.34"/>'
            f'<stop offset="1" stop-color="{color}" stop-opacity="0"/></linearGradient></defs>'
        ]
        ty = cy(THRESHOLD)
        if PT <= ty <= PT + CH:
            body.append(f'<line x1="0" y1="{ty:.1f}" x2="{W}" y2="{ty:.1f}" stroke="#e5534b" stroke-width="1" stroke-dasharray="3,3" opacity="0.45"/>')
        if line:
            area = line + f' L{pts[-1][0]:.1f},{H-PB:.1f} L{pts[0][0]:.1f},{H-PB:.1f} Z'
            body.append(f'<path d="{area}" fill="url(#{gid})"/>')
            body.append(f'<path d="{line}" fill="none" stroke="{color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>')
        if raw:
            lx, ly, _ = raw[-1]
            body.append(f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="2.8" fill="{color}" stroke="#0d1117" stroke-width="1.5"/>')

        spark = (
            f'<svg viewBox="0 0 {W} {H}" width="100%" height="{H}" '
            f'preserveAspectRatio="none" style="display:block">{"".join(body)}</svg>'
        )
        cur_cls = 'spark-cur--danger' if latest >= THRESHOLD else ''
        cards += (
            f'<div class="spark-card">'
            f'<div class="spark-head">'
            f'<span class="lang-dot" style="background:{color}"></span>'
            f'<span class="spark-lang">{LANG_LABELS[lang]}</span>'
            f'<span class="spark-cur {cur_cls}">{latest}<span class="unit">ms</span></span>'
            f'</div>'
            f'{spark}'
            f'<div class="spark-foot">평균 {avg_ms} · 최대 {max_ms}<span class="unit-sm">ms</span></div>'
            f'</div>'
        )
    return f'<div class="spark-grid">{cards}</div>'

sparklines_html = make_lang_sparklines()

# ── 90-day heatmap bar chart ──────────────────────────────────────────
def make_heatmap():
    cur_date = datetime.strptime(current_run[:10], '%Y-%m-%d')
    dates    = [(cur_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(89, -1, -1)]
    bar_w, gap, chart_h = 6, 1, 56
    total_w  = len(dates) * (bar_w + gap)
    total_h  = chart_h + 18
    bars = []
    for i, date in enumerate(dates):
        d = daily_stats.get(date, {})
        p, w, f_ = d.get('PASS', 0), d.get('WARN', 0), d.get('FAIL', 0)
        t = p + w + f_
        x = i * (bar_w + gap)
        if t == 0:
            bars.append(f'<rect x="{x}" y="{chart_h-3}" width="{bar_w}" height="3" fill="#1c2333" rx="1"/>')
        else:
            h = max(4, round(p / t * chart_h))
            color = '#f85149' if f_ > 0 else ('#d29922' if w > 0 else '#3fb950')
            tip = f"{date}  PASS {p}  WARN {w}  FAIL {f_}"
            bars.append(f'<rect x="{x}" y="{chart_h-h}" width="{bar_w}" height="{h}" fill="{color}" rx="1" opacity="0.85"><title>{tip}</title></rect>')
        if i % 14 == 0:
            lx = x + bar_w // 2
            bars.append(f'<text x="{lx}" y="{chart_h+13}" text-anchor="middle" font-size="8" fill="#3d4451">{date[5:]}</text>')
    return f'<svg viewBox="0 0 {total_w} {total_h}" width="100%" style="display:block;overflow:visible">{"".join(bars)}</svg>'

heatmap_svg = make_heatmap()

# ── Monthly donut charts ──────────────────────────────────────────────
def make_donut_svg(p, w, f_):
    total = p + w + f_
    r, circ = 38, 2 * math.pi * 38
    if total == 0:
        return f'<svg viewBox="0 0 100 100" width="88" height="88"><circle cx="50" cy="50" r="{r}" fill="none" stroke="#1c2333" stroke-width="13"/></svg>'
    segs, cum = [], 0.0
    for cnt, color in [(p, '#3fb950'), (w, '#d29922'), (f_, '#f85149')]:
        seg = circ * cnt / total
        if seg > 0:
            segs.append(
                f'<circle cx="50" cy="50" r="{r}" fill="none" stroke="{color}" stroke-width="13" '
                f'stroke-dasharray="{seg:.2f} {circ:.2f}" stroke-dashoffset="{-cum:.2f}" '
                f'transform="rotate(-90,50,50)"/>'
            )
        cum += seg
    avail = round(p / total * 100)
    center = f'<text x="50" y="55" text-anchor="middle" font-size="16" font-weight="700" fill="#e6edf3">{avail}%</text>'
    return f'<svg viewBox="0 0 100 100" width="88" height="88">{"".join(segs)}{center}</svg>'

monthly_cards_html = ''
if monthly_stats:
    for m in sorted(monthly_stats.keys(), reverse=True):
        d = monthly_stats[m]
        p, w, f_ = d.get('PASS', 0), d.get('WARN', 0), d.get('FAIL', 0)
        total_m = p + w + f_
        year, mon = m.split('-')
        label = f"{year}년 {int(mon)}월"
        donut = make_donut_svg(p, w, f_)
        monthly_cards_html += f'''
      <div class="month-card">
        <div class="month-card-title">{label}</div>
        {donut}
        <div class="month-legend">
          <span class="leg-pass">PASS {p}</span>
          <span class="leg-warn">WARN {w}</span>
          <span class="leg-fail">FAIL {f_}</span>
        </div>
        <div class="month-total">총 {total_m}회</div>
      </div>'''

# ── Report list rows ──────────────────────────────────────────────────
by_month = defaultdict(lambda: defaultdict(list))
for entry in entries:
    date, time_str = entry.split('_')
    by_month[date[:7]][date].append((entry, time_str.replace('-', ':')))

sorted_months_list = sorted(by_month.keys(), reverse=True)

rows_html = ''
for midx, month in enumerate(sorted_months_list):
    days = by_month[month]
    sorted_days = sorted(days.keys(), reverse=True)
    total_runs_m = sum(len(v) for v in days.values())
    gid = f"g{month.replace('-', '')}"
    month_open = (midx == 0)
    year, mon = month.split('-')
    month_label = f"{year}년 {int(mon)}월"
    arrow_char = '▼' if month_open else '▶'

    rows_html += (
        f'<tr class="month-header" data-gid="{gid}" onclick="toggleGroup(\'{gid}\')">'
        f'<td colspan="4"><span class="arrow" id="arrow-{gid}">{arrow_char}</span>'
        f' {month_label} <span class="grp-count">{total_runs_m}건</span></td></tr>\n'
    )

    for date in sorted_days:
        runs = days[date]
        did  = f"d{date.replace('-', '')}"
        dp   = date.split('-')
        date_short  = f"{dp[1]}/{dp[2]}"
        day_statuses = [statuses.get(e, 'UNKNOWN') for e, _ in runs]
        if 'FAIL' in day_statuses:               day_st, day_css = 'FAIL', 'badge-fail'
        elif 'WARN' in day_statuses:             day_st, day_css = 'WARN', 'badge-warn'
        elif all(s == 'PASS' for s in day_statuses): day_st, day_css = 'PASS', 'badge-pass'
        else:                                    day_st, day_css = '?',    'badge-unknown'

        hidden_cls = '' if month_open else ' hidden'
        rows_html += (
            f'<tr class="day-header{hidden_cls}" data-parent="{gid}" data-gid="{did}"'
            f' onclick="toggleGroup(\'{did}\')">'
            f'<td colspan="3" style="padding-left:28px">'
            f'<span class="arrow" id="arrow-{did}">▶</span>'
            f' {date_short} <span class="grp-count">{len(runs)}건</span></td>'
            f'<td><span class="status-badge {day_css}">{day_st}</span></td></tr>\n'
        )

        for entry, time_display in runs:
            is_new  = (entry == current_run)
            st      = statuses.get(entry, 'UNKNOWN')
            badge_css = {'PASS': 'badge-pass', 'FAIL': 'badge-fail', 'WARN': 'badge-warn'}.get(st, 'badge-unknown')
            new_badge = '<span class="badge-new">최신</span> ' if is_new else ''
            new_cls   = ' row-new' if is_new else ''

            perf = perf_history.get(entry, {}).get('serverTimes', {})
            perf_cells = ''
            for lang in LANGS:
                ms = perf.get(lang, 0)
                if ms > 0:
                    slow_cls = ' slow' if ms >= THRESHOLD else ''
                    perf_cells += (
                        f'<span class="perf-chip{slow_cls}">'
                        f'<span class="pc-dot" style="background:{LANG_COLORS[lang]}"></span>'
                        f'<span class="pc-lang">{lang.upper()}</span>'
                        f'<span class="pc-ms">{ms}</span>'
                        f'</span>'
                    )

            eid = entry.replace('_', '-')

            # Detail panel content
            perf_rows = ''
            for lang in LANGS:
                ms = perf.get(lang, 0)
                if ms <= 0:
                    continue
                slow_td = ' class="dt-slow"' if ms >= THRESHOLD else ''
                perf_rows += (
                    f'<tr><td class="dt-lang">{lang.upper()}</td>'
                    f'<td{slow_td}>{ms}ms</td>'
                    f'<td class="dt-status">{"🔴 위험" if ms >= THRESHOLD else "🟢 정상"}</td></tr>'
                )

            curl_rows = ''
            for lang in LANGS:
                url = f'{BASE_URL}/{lang}'
                cmd = f'curl -s -o /dev/null -w "%{{time_starttransfer}}s" {url}'
                ms  = perf.get(lang, 0)
                ms_info = f'{ms}ms' if ms > 0 else '—'
                ms_cls  = ' curl-time-slow' if ms > 0 and ms >= THRESHOLD else ''
                curl_rows += (
                    f'<div class="curl-row">'
                    f'<span class="curl-lang">{lang.upper()}</span>'
                    f'<code class="curl-code" id="curl-{eid}-{lang}">{cmd}</code>'
                    f'<button class="curl-copy" onclick="copyCurl(\'curl-{eid}-{lang}\', this)">복사</button>'
                    f'<span class="curl-ms{ms_cls}">{ms_info}</span>'
                    f'</div>'
                )

            perf_section = (
                f'<div class="dp-section">'
                f'<div class="dp-title">서버 첫 응답 시간 (TTFB · 3회 중앙값)</div>'
                f'<table class="perf-tbl"><tbody>{perf_rows}</tbody></table>'
                f'</div>'
            ) if perf_rows else ''

            # 장애 상세 섹션
            run_failures = failures_history.get(entry, [])
            failure_section = ''
            if run_failures:
                type_icons = {
                    '서버': '🖥️', 'API': '🔌', '다운로드': '📥',
                    '파일': '📄', '콘텐츠': '📝', '이미지': '🖼️',
                    '로그인': '🔑', 'UI': '🖱️', '이지다운': '📱',
                }
                f_rows = ''
                for fr in run_failures:
                    icon     = type_icons.get(fr.get('type', ''), '⚠️')
                    f_url    = fr.get('url', '-')
                    f_status = fr.get('status', 0)
                    f_time   = fr.get('responseTime', 0)
                    f_sym    = fr.get('symptom', '-')
                    f_step   = fr.get('step', '-')
                    f_lang   = fr.get('lang', '-')
                    status_cls = 'fs-5xx' if f_status >= 500 else ('fs-4xx' if f_status >= 400 else 'fs-other')
                    status_txt = str(f_status) if f_status > 0 else 'timeout'
                    time_txt   = f'{f_time}ms' if f_time > 0 else '—'
                    f_rows += (
                        f'<tr>'
                        f'<td class="fd-icon">{icon}</td>'
                        f'<td class="fd-step">{f_step}</td>'
                        f'<td class="fd-lang">{f_lang}</td>'
                        f'<td class="fd-url" title="{f_url}">{f_url}</td>'
                        f'<td class="fd-status {status_cls}">{status_txt}</td>'
                        f'<td class="fd-time">{time_txt}</td>'
                        f'<td class="fd-sym">{f_sym}</td>'
                        f'</tr>'
                    )
                failure_section = (
                    f'<div class="dp-section dp-failure">'
                    f'<div class="dp-title dp-title-fail">장애 상세 <span class="dp-sub">{len(run_failures)}건</span></div>'
                    f'<div class="fd-scroll">'
                    f'<table class="fd-table"><tbody>{f_rows}</tbody></table>'
                    f'</div>'
                    f'</div>'
                )

            rows_html += (
                f'<tr class="run-row hidden{new_cls}" data-parent="{did}" data-status="{st}" data-eid="{eid}"'
                f' onclick="toggleDetail(\'{eid}\')">'
                f'<td class="run-time">{new_badge}{date_short} {time_display}</td>'
                f'<td><span class="status-badge {badge_css}">{st}</span></td>'
                f'<td class="perf-summary">{perf_cells}</td>'
                f'<td class="chev-cell"><span class="chev" id="chev-{eid}">›</span></td></tr>\n'
            )
            rows_html += (
                f'<tr class="run-detail hidden" id="detail-{eid}">'
                f'<td colspan="4">'
                f'<div class="detail-panel">'
                f'{failure_section}'
                f'{perf_section}'
                f'<div class="dp-section">'
                f'<div class="dp-title">cURL 명령어 <span class="dp-sub">로컬에서 바로 테스트</span></div>'
                f'{curl_rows}'
                f'</div>'
                f'<a href="{entry}/" target="_blank" class="detail-report-btn">📋 상세 Playwright 리포트 열기</a>'
                f'</div>'
                f'</td></tr>\n'
            )

# ── CSS ───────────────────────────────────────────────────────────────
css = """
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', sans-serif;
         background: #0d1117; color: #c9d1d9; min-height: 100vh; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  .container { max-width: 760px; margin: 0 auto; padding: 32px 20px 60px; }

  /* Header */
  .header { margin-bottom: 28px; }
  .header-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 1.35rem; font-weight: 700; color: #e6edf3; }
  .header-sub { color: #484f58; font-size: .8rem; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
  .info-tag { display: inline-flex; align-items: center; gap: 4px; background: #161b22;
              border: 1px solid #21262d; border-radius: 6px; padding: 3px 8px;
              font-size: .72rem; color: #8b949e; }
  .info-icon { font-style: normal; color: #58a6ff; font-weight: 700; }

  /* Section title */
  .section-title { font-size: .85rem; font-weight: 700; color: #8b949e;
                   letter-spacing: .06em; text-transform: uppercase; margin-bottom: 10px; }
  .section-sub { font-size: .72rem; font-weight: 400; color: #484f58;
                 text-transform: none; letter-spacing: 0; margin-left: 8px; }

  /* Card base */
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
          padding: 18px 20px; margin-bottom: 18px; }

  /* Overview grid */
  .ov-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 18px; }
  .ov-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
             padding: 18px 16px; }
  .ov-card--pass { border-color: #2ea043; }
  .ov-card--warn { border-color: #9e6a03; }
  .ov-card--fail { border-color: #b91c1c; }
  .ov-label { font-size: .72rem; color: #8b949e; font-weight: 600;
              text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
  .ov-value { font-size: 1.9rem; font-weight: 800; line-height: 1; margin-bottom: 6px; }
  .score-great { color: #3fb950; }
  .score-good  { color: #56d364; }
  .score-warn  { color: #d29922; }
  .score-bad   { color: #f85149; }
  .val-ok      { color: #3fb950; font-size: 1.4rem; }
  .val-danger  { color: #f85149; font-size: 1.4rem; }
  .ov-status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .ov-status-text { font-size: 1.15rem; font-weight: 700; color: #e6edf3; }
  .ov-sub { font-size: .72rem; color: #484f58; }

  /* Status dots */
  .dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .dot-pass    { background: #3fb950; box-shadow: 0 0 6px #3fb95066; }
  .dot-warn    { background: #d29922; box-shadow: 0 0 6px #d2992266; }
  .dot-fail    { background: #f85149; box-shadow: 0 0 6px #f8514966;
                 animation: pulse 1.5s ease-in-out infinite; }
  .dot-unknown { background: #484f58; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 6px #f8514966; }
    50%       { box-shadow: 0 0 12px #f85149cc; }
  }

  /* Chart card */
  .chart-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
                padding: 18px 20px; margin-bottom: 18px; }
  .chart-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
  .threshold-note { font-size: .72rem; color: #484f58; margin-left: auto; }
  .threshold-note span { color: #f85149; font-weight: 600; }

  /* Per-language sparkline cards (small multiples) */
  .lang-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .spark-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .spark-card { background: #0d1117; border: 1px solid #21262d; border-radius: 10px;
                padding: 11px 13px 9px; }
  .spark-head { display: flex; align-items: center; gap: 6px; margin-bottom: 9px; }
  .spark-lang { font-size: .73rem; color: #adbac7; font-weight: 600; }
  .spark-cur { margin-left: auto; font-size: 1.05rem; font-weight: 800; color: #f0f6fc;
               line-height: 1; font-variant-numeric: tabular-nums; }
  .spark-cur .unit { font-size: .6rem; font-weight: 600; color: #6e7681; margin-left: 1px; }
  .spark-cur--danger { color: #ff7b72; }
  .spark-foot { font-size: .64rem; color: #6e7681; margin-top: 8px;
                font-variant-numeric: tabular-nums; }

  /* Heatmap */
  .heatmap-legend { display: flex; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
  .hm-item { display: flex; align-items: center; gap: 6px; font-size: .72rem; color: #8b949e; }
  .hm-dot { width: 10px; height: 10px; border-radius: 2px; }

  /* Monthly donuts */
  .monthly-grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .month-card { flex: 1 1 130px; max-width: 160px; display: flex; flex-direction: column;
                align-items: center; background: #0d1117; border: 1px solid #21262d;
                border-radius: 8px; padding: 14px 8px 12px; }
  .month-card-title { font-size: .75rem; font-weight: 700; color: #8b949e; margin-bottom: 8px; }
  .month-legend { display: flex; gap: 5px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
  .leg-pass { font-size: .65rem; font-weight: 600; padding: 2px 6px; border-radius: 6px;
              background: #0f2d1a; color: #3fb950; }
  .leg-warn { font-size: .65rem; font-weight: 600; padding: 2px 6px; border-radius: 6px;
              background: #2d2008; color: #d29922; }
  .leg-fail { font-size: .65rem; font-weight: 600; padding: 2px 6px; border-radius: 6px;
              background: #2d0f0f; color: #f85149; }
  .month-total { font-size: .65rem; color: #484f58; margin-top: 5px; }

  /* Filter tabs */
  .filter-bar { display: flex; gap: 4px; padding: 14px 16px 0; border-bottom: 1px solid #21262d;
                flex-wrap: wrap; }
  .tab-btn { background: none; border: none; color: #8b949e; font-size: .8rem; font-weight: 500;
             padding: 6px 12px; border-radius: 6px 6px 0 0; cursor: pointer;
             border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .15s; }
  .tab-btn:hover { color: #c9d1d9; }
  .tab-btn.active { color: #e6edf3; border-bottom-color: #58a6ff; font-weight: 700; }
  .tab-cnt { font-size: .7rem; color: #484f58; margin-left: 4px; }
  .tab-btn.active .tab-cnt { color: #8b949e; }

  /* Report table */
  .report-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
                 overflow: hidden; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; }
  td { border-bottom: 1px solid #21262d; font-size: .85rem; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }

  /* Month header rows */
  .month-header td { background: #0d1117; padding: 8px 16px; font-size: .72rem; font-weight: 700;
                     color: #484f58; letter-spacing: .06em; text-transform: uppercase;
                     cursor: pointer; user-select: none; }
  .month-header td:hover { background: #131820 !important; }

  /* Day header rows */
  .day-header td { background: #161b22; padding: 8px 16px; font-size: .8rem; font-weight: 600;
                   color: #8b949e; cursor: pointer; user-select: none; }
  .day-header td:hover { background: #1c2333 !important; }

  /* Run rows */
  .run-row td { padding: 10px 14px; cursor: pointer; }
  .run-row:hover td { background: #1c2333; }
  .row-new td { background: #0f1f0f; }
  .row-new:hover td { background: #132a13 !important; }
  .run-time { padding-left: 44px !important; color: #c9d1d9; white-space: nowrap; }
  .chev-cell { width: 24px; text-align: center; }
  .chev { color: #484f58; font-size: 1.2rem; display: inline-block; transition: transform .2s; }
  .chev.open { transform: rotate(90deg); }

  /* Perf summary chips */
  .perf-summary { white-space: nowrap; text-align: right; }
  .perf-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px 2px 6px;
               margin-left: 4px; border-radius: 6px; background: #0d1117;
               border: 1px solid #21262d; vertical-align: middle; }
  .pc-dot  { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pc-lang { font-size: .6rem; font-weight: 700; color: #6e7681; letter-spacing: .03em; }
  .pc-ms   { font-size: .72rem; font-weight: 600; color: #8b949e; font-variant-numeric: tabular-nums; }
  .perf-chip.slow { background: #2a1414; border-color: #4d2424; }
  .perf-chip.slow .pc-ms { color: #ff7b72; font-weight: 700; }
  .perf-chip.slow .pc-lang { color: #b9686a; }

  /* Detail panel */
  .run-detail td { padding: 0; border-top: none; }
  .detail-panel { padding: 14px 16px 16px 44px; background: #0d1117;
                  border-top: 1px solid #21262d; animation: fadeSlide .2s ease; }
  @keyframes fadeSlide {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .dp-section { margin-bottom: 14px; }
  .dp-title { font-size: .72rem; font-weight: 700; color: #8b949e;
              text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
  .dp-sub { font-weight: 400; text-transform: none; letter-spacing: 0; color: #484f58; }

  /* Perf detail table */
  .perf-tbl { border-collapse: collapse; font-size: .8rem; margin-bottom: 4px; }
  .perf-tbl td { border: none; padding: 2px 14px 2px 0; color: #8b949e; border-bottom: none; }
  .dt-lang { font-weight: 700; color: #58a6ff !important; width: 40px; padding-left: 0 !important; }
  .dt-slow { color: #f85149 !important; font-weight: 700; }
  .dt-status { color: #484f58; font-size: .72rem; }

  /* cURL rows */
  .curl-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .curl-lang { font-size: .68rem; font-weight: 700; color: #58a6ff; width: 28px;
               flex-shrink: 0; text-align: center; }
  .curl-code { flex: 1; font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
               font-size: .72rem; background: #161b22; border: 1px solid #21262d;
               border-radius: 4px; padding: 4px 8px; color: #adbac7;
               white-space: nowrap; overflow: auto; min-width: 0; }
  .curl-copy { font-size: .68rem; padding: 3px 8px; background: #21262d; border: 1px solid #30363d;
               color: #8b949e; border-radius: 4px; cursor: pointer; white-space: nowrap;
               flex-shrink: 0; transition: background .15s; }
  .curl-copy:hover { background: #30363d; color: #e6edf3; }
  .curl-copy.copied { background: #1f3a1f; color: #3fb950; border-color: #2ea043; }
  .curl-ms { font-size: .72rem; color: #484f58; width: 54px; text-align: right; flex-shrink: 0; }
  .curl-ms.curl-time-slow { color: #f85149; font-weight: 700; }

  /* Failure detail table */
  .dp-failure { border-left: 2px solid #f85149; padding-left: 10px; }
  .dp-title-fail { color: #f85149 !important; }
  .fd-scroll { overflow-x: auto; }
  .fd-table { border-collapse: collapse; font-size: .75rem; width: 100%; min-width: 520px; }
  .fd-table tbody tr { border-bottom: 1px solid #1c2333; }
  .fd-table tbody tr:last-child { border-bottom: none; }
  .fd-table td { padding: 5px 8px; color: #8b949e; vertical-align: top; border-bottom: none; }
  .fd-icon  { width: 20px; font-size: .85rem; padding-left: 0 !important; }
  .fd-step  { color: #484f58; font-size: .68rem; white-space: nowrap; }
  .fd-lang  { color: #58a6ff; font-weight: 700; font-size: .68rem; width: 30px; }
  .fd-url   { color: #c9d1d9; font-family: 'SF Mono', Consolas, monospace; font-size: .7rem;
              max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fd-status { font-weight: 700; font-size: .72rem; white-space: nowrap; }
  .fs-5xx   { color: #f85149; }
  .fs-4xx   { color: #d29922; }
  .fs-other { color: #8b949e; }
  .fd-time  { color: #484f58; font-size: .68rem; white-space: nowrap; }
  .fd-sym   { color: #8b949e; font-size: .72rem; }

  .detail-report-btn { display: inline-block; margin-top: 4px; font-size: .75rem;
                       color: #58a6ff; border: 1px solid #21262d; border-radius: 6px;
                       padding: 5px 12px; background: #161b22; transition: background .15s; }
  .detail-report-btn:hover { background: #21262d; text-decoration: none; }

  /* Status badges */
  .status-badge { font-size: .68rem; font-weight: 700; padding: 2px 8px;
                  border-radius: 10px; white-space: nowrap; }
  .badge-pass    { background: #0f2d1a; color: #3fb950; }
  .badge-fail    { background: #2d0f0f; color: #f85149; }
  .badge-warn    { background: #2d2008; color: #d29922; }
  .badge-unknown { background: #161b22; color: #484f58; border: 1px solid #21262d; }
  .badge-new     { background: #1f4024; color: #56d364; font-size: .65rem;
                   padding: 2px 7px; border-radius: 10px; font-weight: 700; }

  /* Misc */
  .arrow { font-size: .6rem; margin-right: 6px; display: inline-block; transition: transform .15s; }
  .grp-count { font-size: .7rem; color: #484f58; font-weight: 400; margin-left: 6px; }
  .hidden { display: none !important; }

  .footer { text-align: center; color: #3d4451; font-size: .75rem; margin-top: 20px; }

  @media (max-width: 540px) {
    .ov-grid { grid-template-columns: 1fr 1fr; }
    .ov-grid > .ov-card:last-child { grid-column: span 2; }
    .spark-grid { grid-template-columns: repeat(2, 1fr); }
    .perf-summary { display: none; }
  }
"""

# ── HTML ──────────────────────────────────────────────────────────────
html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>이지랩 헬스체크 대시보드</title>
  <style>{css}</style>
</head>
<body>
<div class="container">

  <header class="header">
    <div class="header-top">
      <h1>이지랩 헬스체크 대시보드</h1>
      <span class="info-tag"><i class="info-icon">ⓘ</i> 최근 {total}개 리포트 기준 · 일 24회 자동 실행</span>
    </div>
    <p class="header-sub">마지막 실행: {cur_display} KST</p>
  </header>

  {overview_html}

  <div class="chart-card">
    <div class="chart-header">
      <span class="section-title">서버 첫 응답(TTFB) 추이<span class="section-sub">언어별 · 최근 24회 · 3회 중앙값</span></span>
      <span class="threshold-note">위험 임계치 <span>{THRESHOLD}ms</span></span>
    </div>
    {sparklines_html}
  </div>

  <div class="card">
    <div class="section-title">일별 가동률<span class="section-sub">최근 90일</span></div>
    <div class="heatmap-legend">
      <span class="hm-item"><span class="hm-dot" style="background:#3fb950"></span>PASS</span>
      <span class="hm-item"><span class="hm-dot" style="background:#d29922"></span>WARN 포함</span>
      <span class="hm-item"><span class="hm-dot" style="background:#f85149"></span>FAIL 포함</span>
      <span class="hm-item"><span class="hm-dot" style="background:#1c2333"></span>데이터 없음</span>
    </div>
    {heatmap_svg}
  </div>

  {'<div class="card"><div class="section-title">월별 요약</div><div class="monthly-grid">' + monthly_cards_html + '</div></div>' if monthly_cards_html else ''}

  <div class="report-card">
    <div class="filter-bar">
      <button class="tab-btn active" onclick="filterRuns('all', this)">전체<span class="tab-cnt">{total}</span></button>
      <button class="tab-btn" onclick="filterRuns('PASS', this)">성공 (PASS)<span class="tab-cnt">{pass_c}</span></button>
      <button class="tab-btn" onclick="filterRuns('WARN', this)">경고 (WARN)<span class="tab-cnt">{warn_c}</span></button>
      <button class="tab-btn" onclick="filterRuns('FAIL', this)">장애 (FAIL)<span class="tab-cnt">{fail_c}</span></button>
    </div>
    <table>
      <colgroup>
        <col style="width:auto"><col style="width:72px">
        <col style="width:250px"><col style="width:28px">
      </colgroup>
      <tbody id="report-body">
{rows_html}      </tbody>
    </table>
  </div>

  <p class="footer">EZLAB Health Check · {cur_display} KST</p>
</div>

<script>
// ── Accordion: month/day groups ──────────────────────────────────────
function toggleGroup(id) {{
  var allChildren = document.querySelectorAll('[data-parent="' + id + '"]');
  var runChildren = Array.from(allChildren).filter(r => !r.classList.contains('run-detail'));
  if (runChildren.length === 0) return;
  var nowOpen = runChildren[0].classList.contains('hidden');
  var arrow = document.getElementById('arrow-' + id);
  if (arrow) arrow.textContent = nowOpen ? '▼' : '▶';
  if (nowOpen) {{
    // Opening: only show non-detail rows (respecting current filter)
    var activeFilter = document.querySelector('.tab-btn.active')?.dataset.filter || 'all';
    runChildren.forEach(function(r) {{
      if (activeFilter === 'all' || !r.classList.contains('run-row') || r.dataset.status === activeFilter) {{
        r.classList.remove('hidden');
      }}
    }});
  }} else {{
    // Closing: hide everything including details
    allChildren.forEach(function(r) {{
      r.classList.add('hidden');
      if (r.classList.contains('run-row')) {{
        var eid = r.dataset.eid;
        if (eid) {{
          var det = document.getElementById('detail-' + eid);
          if (det) det.classList.add('hidden');
          var chev = document.getElementById('chev-' + eid);
          if (chev) {{ chev.textContent = '›'; chev.classList.remove('open'); }}
        }}
      }}
      var childGid = r.dataset.gid;
      if (childGid) collapseGroup(childGid);
    }});
  }}
}}

function collapseGroup(id) {{
  var arrow = document.getElementById('arrow-' + id);
  if (arrow) arrow.textContent = '▶';
  document.querySelectorAll('[data-parent="' + id + '"]').forEach(function(r) {{
    r.classList.add('hidden');
    if (r.classList.contains('run-row')) {{
      var eid = r.dataset.eid;
      if (eid) {{
        var det = document.getElementById('detail-' + eid);
        if (det) det.classList.add('hidden');
        var chev = document.getElementById('chev-' + eid);
        if (chev) {{ chev.textContent = '›'; chev.classList.remove('open'); }}
      }}
    }}
    var childGid = r.dataset.gid;
    if (childGid) collapseGroup(childGid);
  }});
}}

// ── Accordion: individual run detail ────────────────────────────────
function toggleDetail(eid) {{
  var det  = document.getElementById('detail-' + eid);
  var chev = document.getElementById('chev-' + eid);
  if (!det) return;
  var isOpen = !det.classList.contains('hidden');
  if (isOpen) {{
    det.classList.add('hidden');
    if (chev) {{ chev.textContent = '›'; chev.classList.remove('open'); }}
  }} else {{
    det.classList.remove('hidden');
    if (chev) {{ chev.textContent = '›'; chev.classList.add('open'); }}
  }}
}}

// ── Status filter tabs ────────────────────────────────────────────────
function filterRuns(status, btn) {{
  document.querySelectorAll('.tab-btn').forEach(function(b) {{ b.classList.remove('active'); }});
  btn.classList.add('active');
  btn.dataset.filter = status;

  if (status === 'all') {{
    // Restore default: only first month open, days collapsed, details closed
    var allRows = document.querySelectorAll('.run-row, .run-detail, .day-header, .month-header');
    allRows.forEach(function(r) {{ r.style.display = ''; }});
    document.querySelectorAll('.run-row, .run-detail').forEach(function(r) {{
      r.classList.add('hidden');
    }});
    document.querySelectorAll('.day-header').forEach(function(r) {{
      if (!r.classList.contains('hidden')) r.classList.add('hidden');
    }});
    // Re-open first month
    var firstMonth = document.querySelector('.month-header');
    if (firstMonth) {{
      var gid = firstMonth.dataset.gid;
      var arrow = document.getElementById('arrow-' + gid);
      if (arrow) arrow.textContent = '▼';
      document.querySelectorAll('[data-parent="' + gid + '"]:not(.run-detail)').forEach(function(r) {{
        r.classList.remove('hidden');
      }});
    }}
    return;
  }}

  // Expand all groups, then filter
  document.querySelectorAll('.month-header').forEach(function(h) {{
    var gid = h.dataset.gid;
    var arrow = document.getElementById('arrow-' + gid);
    if (arrow) arrow.textContent = '▼';
  }});
  document.querySelectorAll('.day-header').forEach(function(h) {{
    var gid = h.dataset.gid;
    var arrow = document.getElementById('arrow-' + gid);
    if (arrow) arrow.textContent = '▼';
  }});

  // Show/hide run rows
  document.querySelectorAll('.run-row').forEach(function(r) {{
    var match = (r.dataset.status === status);
    if (match) {{
      r.classList.remove('hidden');
      r.style.display = '';
    }} else {{
      r.classList.add('hidden');
      // Also close its detail
      var eid = r.dataset.eid;
      if (eid) {{
        var det = document.getElementById('detail-' + eid);
        if (det) det.classList.add('hidden');
        var chev = document.getElementById('chev-' + eid);
        if (chev) {{ chev.textContent = '›'; chev.classList.remove('open'); }}
      }}
    }}
  }});

  // Hide day headers with no visible runs
  document.querySelectorAll('.day-header').forEach(function(h) {{
    var gid = h.dataset.gid;
    var visibleRuns = document.querySelectorAll('.run-row[data-parent="' + gid + '"]:not(.hidden)');
    h.classList.toggle('hidden', visibleRuns.length === 0);
  }});

  // Hide month headers with no visible days
  document.querySelectorAll('.month-header').forEach(function(h) {{
    var gid = h.dataset.gid;
    var visibleDays = document.querySelectorAll('.day-header[data-parent="' + gid + '"]:not(.hidden)');
    h.classList.toggle('hidden', visibleDays.length === 0);
  }});
}}

// ── cURL copy ────────────────────────────────────────────────────────
function copyCurl(id, btn) {{
  var el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(function() {{
    btn.textContent = '✓ 복사됨';
    btn.classList.add('copied');
    setTimeout(function() {{
      btn.textContent = '복사';
      btn.classList.remove('copied');
    }}, 2000);
  }}).catch(function() {{
    var ta = document.createElement('textarea');
    ta.value = el.textContent;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✓ 복사됨';
    btn.classList.add('copied');
    setTimeout(function() {{ btn.textContent = '복사'; btn.classList.remove('copied'); }}, 2000);
  }});
}}
</script>
</body>
</html>"""

with open(output_file, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"인덱스 생성 완료: {total}개 실행 기록 (PASS {pass_c} / FAIL {fail_c} / WARN {warn_c})")
