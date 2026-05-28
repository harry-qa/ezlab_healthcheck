import sys
import re
import json
import math
from datetime import datetime, timedelta
from collections import defaultdict

runs_file     = sys.argv[1]
current_run   = sys.argv[2]
statuses_file = sys.argv[3]
perf_file     = sys.argv[4]
monthly_file  = sys.argv[5]
daily_file    = sys.argv[6]
output_file   = sys.argv[7]

with open(runs_file) as f:
    entries = sorted(
        {d.strip() for d in f if re.match(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$', d.strip())},
        reverse=True
    )

try:
    with open(statuses_file) as f:
        statuses = json.load(f)
except Exception:
    statuses = {}

try:
    with open(perf_file) as f:
        perf_history = json.load(f)
except Exception:
    perf_history = {}

try:
    with open(monthly_file) as f:
        monthly_stats = json.load(f)
except Exception:
    monthly_stats = {}

try:
    with open(daily_file) as f:
        daily_stats = json.load(f)
except Exception:
    daily_stats = {}

STATUS_MAP = {
    'PASS':    ('PASS', 'status-pass'),
    'FAIL':    ('FAIL', 'status-fail'),
    'WARN':    ('WARN', 'status-warn'),
    'UNKNOWN': ('?',    'status-unknown'),
}

# month → day → runs (3단계)
by_month = defaultdict(lambda: defaultdict(list))
for entry in entries:
    date, time_str = entry.split('_')
    month = date[:7]
    by_month[month][date].append((entry, time_str.replace('-', ':')))

sorted_months = sorted(by_month.keys(), reverse=True)
current_date = current_run.split('_')[0]

rows = ""
for midx, month in enumerate(sorted_months):
    days = by_month[month]
    sorted_days = sorted(days.keys(), reverse=True)
    total_runs = sum(len(v) for v in days.values())
    gid = f"g{month.replace('-', '')}"
    month_open = (midx == 0)
    arrow_char = "▼" if month_open else "▶"
    year, mon = month.split('-')
    month_label = f"{year}년 {int(mon)}월"
    rows += f'<tr class="month-header" data-gid="{gid}" onclick="toggleGroup(\'{gid}\')"><td colspan="3"><span class="arrow" id="arrow-{gid}">{arrow_char}</span> {month_label} <span class="group-count">{total_runs}건</span></td></tr>\n'

    for date in sorted_days:
        runs = days[date]
        did = f"d{date.replace('-', '')}"
        day_open = False
        day_arrow = "▼" if day_open else "▶"
        date_parts = date.split('-')
        date_short = f"{date_parts[1]}/{date_parts[2]}"

        day_statuses = [statuses.get(e, 'UNKNOWN') for e, _ in runs]
        if 'FAIL' in day_statuses:        day_st, day_css = 'FAIL', 'status-fail'
        elif 'WARN' in day_statuses:      day_st, day_css = 'WARN', 'status-warn'
        elif all(s == 'PASS' for s in day_statuses): day_st, day_css = 'PASS', 'status-pass'
        else:                              day_st, day_css = '?',    'status-unknown'
        day_badge = f'<span class="status-badge {day_css}">{day_st}</span>'

        day_hidden_cls = "" if month_open else " hidden"
        rows += (f'<tr class="day-header{day_hidden_cls}" data-parent="{gid}" data-gid="{did}"'
                 f' onclick="toggleGroup(\'{did}\')">'
                 f'<td colspan="2" style="padding-left:32px"><span class="arrow" id="arrow-{did}">{day_arrow}</span>'
                 f' {date_short} <span class="group-count">{len(runs)}건</span></td>'
                 f'<td>{day_badge}</td></tr>\n')

        for entry, time_display in runs:
            is_new = entry == current_run
            new_badge = '<span class="badge-new">최신</span>' if is_new else ''
            run_hidden_cls = "" if (month_open and day_open) else " hidden"
            row_cls = "run-row" + run_hidden_cls + (" row-new" if is_new else "")
            st = statuses.get(entry, 'UNKNOWN')
            label, css = STATUS_MAP.get(st, ('?', 'status-unknown'))
            status_html = f'<span class="status-badge {css}">{label}</span>'
            rows += (f'<tr class="{row_cls}" data-parent="{did}">'
                     f'<td class="time-cell" style="padding-left:48px"><a href="{entry}/">{date_short} {time_display}</a></td>'
                     f'<td>{status_html}</td><td>{new_badge}</td></tr>\n')

cur_date, cur_time = current_run.split('_')
cur_display = f"{cur_date} {cur_time.replace('-', ':')}"

total = len(entries)
pass_c = sum(1 for e in entries if statuses.get(e) == 'PASS')
fail_c = sum(1 for e in entries if statuses.get(e) == 'FAIL')
warn_c = sum(1 for e in entries if statuses.get(e) == 'WARN')

# ── 응답 시간 트렌드 (최근 12회) ─────────────────────────────────
LANGS = ['ko', 'en', 'jp', 'tw']
LANG_LABELS = {'ko': '한국어', 'en': '영어', 'jp': '일본어', 'tw': '중국어'}
recent_runs = entries[:12]

def bar_color(ms):
    if ms <= 0:    return '#d0d7de'
    if ms < 1000:  return '#2da44e'
    if ms < 3000:  return '#bf8700'
    return '#cf222e'

def bar_width(ms, max_ms):
    if max_ms <= 0 or ms <= 0:
        return 0
    return min(100, round(ms / max_ms * 100))

trend_rows = ""
for lang in LANGS:
    times = []
    for run in recent_runs:
        perf = perf_history.get(run, {})
        t = perf.get('serverTimes', {}).get(lang, 0)
        times.append((run, t))

    has_data = any(t > 0 for _, t in times)
    if not has_data:
        continue

    max_t = max((t for _, t in times if t > 0), default=0)
    label = LANG_LABELS.get(lang, lang)

    bars_html = ""
    for run, t in times:
        date_str, time_str = run.split('_')
        dp = date_str.split('-')
        display_time = f"{dp[1]}/{dp[2]} {time_str.replace('-', ':')}"
        width = bar_width(t, max_t)
        color = bar_color(t)
        tip = f"{display_time} · {t}ms" if t > 0 else f"{display_time} · -"
        bars_html += f'''
        <div class="bar-row">
          <span class="bar-label">{display_time}</span>
          <div class="bar-wrap">
            <div class="bar" style="width:{width}%;background:{color}" title="{tip}"></div>
            <span class="bar-val">{t}ms</span>
          </div>
        </div>'''

    trend_rows += f'''
      <div class="trend-group">
        <div class="trend-lang">{label} (/{lang})</div>
        {bars_html}
      </div>'''

trend_section = ""
if trend_rows:
    trend_section = f'''
    <div class="trend-card">
      <div class="trend-title">서버 응답 시간 추이 <span class="trend-sub">최근 {len(recent_runs)}회</span></div>
      {trend_rows}
    </div>'''

# ── 월별 요약 도넛 차트 ─────────────────────────────────────────────
def make_donut_svg(pass_c, warn_c, fail_c):
    total = pass_c + warn_c + fail_c
    r = 40
    circ = 2 * math.pi * r

    if total == 0:
        empty = f'<circle cx="50" cy="50" r="{r}" fill="none" stroke="#d0d7de" stroke-width="14"/>'
        return f'<svg viewBox="0 0 100 100" width="90" height="90">{empty}</svg>'

    segments = []
    cumulative = 0.0
    for length_raw, color in [
        (pass_c, '#2da44e'),
        (warn_c, '#d4a72c'),
        (fail_c, '#cf222e'),
    ]:
        seg = circ * length_raw / total
        if seg > 0:
            segments.append(
                f'<circle cx="50" cy="50" r="{r}" fill="none" stroke="{color}" stroke-width="14" '
                f'stroke-dasharray="{seg:.2f} {circ:.2f}" stroke-dashoffset="{-cumulative:.2f}" '
                f'transform="rotate(-90, 50, 50)"/>'
            )
        cumulative += seg

    avail = round(pass_c / total * 100)
    center = f'<text x="50" y="55" text-anchor="middle" font-size="15" font-weight="700" fill="#24292f">{avail}%</text>'
    return f'<svg viewBox="0 0 100 100" width="90" height="90">{"".join(segments)}{center}</svg>'

# ── 90일 일별 가동률 바 차트 ────────────────────────────────────────
def make_daily_chart(daily_stats, current_run):
    cur_date = datetime.strptime(current_run[:10], '%Y-%m-%d')
    dates = [(cur_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(89, -1, -1)]

    bar_w, gap, chart_h = 6, 1, 60
    total_w = len(dates) * (bar_w + gap)
    total_h = chart_h + 18

    bars = []
    for i, date in enumerate(dates):
        d = daily_stats.get(date, {})
        p, w, f_ = d.get('PASS', 0), d.get('WARN', 0), d.get('FAIL', 0)
        total = p + w + f_
        x = i * (bar_w + gap)
        if total == 0:
            bars.append(f'<rect x="{x}" y="{chart_h - 3}" width="{bar_w}" height="3" fill="#d0d7de" rx="1"/>')
        else:
            h = max(4, round(p / total * chart_h))
            color = '#cf222e' if f_ > 0 else ('#d4a72c' if w > 0 else '#2da44e')
            tip = f"{date}  PASS {p}  WARN {w}  FAIL {f_}"
            bars.append(f'<rect x="{x}" y="{chart_h - h}" width="{bar_w}" height="{h}" fill="{color}" rx="1"><title>{tip}</title></rect>')
        if i % 14 == 0:
            lx = x + bar_w // 2
            bars.append(f'<text x="{lx}" y="{chart_h + 13}" text-anchor="middle" font-size="8" fill="#8c959f">{date[5:]}</text>')

    return f'<svg viewBox="0 0 {total_w} {total_h}" width="100%" style="display:block;overflow:visible">{"".join(bars)}</svg>'

daily_chart_html = make_daily_chart(daily_stats, current_run)

monthly_section = ""
if monthly_stats:
    sorted_months = sorted(monthly_stats.keys(), reverse=True)
    month_cards = ""
    for m in sorted_months:
        d = monthly_stats[m]
        p, w, f_ = d.get('PASS', 0), d.get('WARN', 0), d.get('FAIL', 0)
        total_m = p + w + f_
        year, mon = m.split('-')
        label = f"{year}년 {int(mon)}월"
        donut = make_donut_svg(p, w, f_)
        avail_pct = f"{round(p/total_m*100)}%" if total_m else "-"
        month_cards += f'''
      <div class="month-card">
        <div class="month-card-title">{label}</div>
        <div class="month-card-donut">{donut}</div>
        <div class="month-card-legend">
          <span class="leg-item leg-pass">PASS {p}</span>
          <span class="leg-item leg-warn">WARN {w}</span>
          <span class="leg-item leg-fail">FAIL {f_}</span>
        </div>
        <div class="month-card-total">총 {total_m}회 실행</div>
      </div>'''

    monthly_section = f'''
    <div class="monthly-card">
      <div class="monthly-title">월별 헬스체크 요약</div>
      <div class="monthly-grid">{month_cards}
      </div>
    </div>'''

daily_section = f'''
    <div class="daily-card">
      <div class="daily-title">일별 가동률 <span class="trend-sub">최근 90일</span></div>
      <div class="daily-legend">
        <span class="dl-item dl-pass">PASS</span>
        <span class="dl-item dl-warn">WARN 포함</span>
        <span class="dl-item dl-fail">FAIL 포함</span>
        <span class="dl-item dl-none">데이터 없음</span>
      </div>
      <div class="daily-chart">{daily_chart_html}</div>
    </div>'''

css = """
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f8fa; min-height: 100vh; }
    .container { max-width: 720px; margin: 48px auto; padding: 0 20px 40px; }
    header { margin-bottom: 24px; }
    h1 { font-size: 1.4rem; color: #24292f; }
    .subtitle { color: #57606a; font-size: .875rem; margin-top: 6px; }
    .summary { display: flex; gap: 12px; margin-top: 12px; }
    .sum-badge { font-size: .78rem; font-weight: 600; padding: 3px 10px; border-radius: 12px; }
    .sum-pass { background: #dafbe1; color: #1a7f37; }
    .sum-fail { background: #ffebe9; color: #cf222e; }
    .sum-warn { background: #fff8c5; color: #9a6700; }
    .card { background: white; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    .month-header td { background: #f6f8fa; padding: 8px 16px; font-size: .78rem; font-weight: 700;
                       color: #57606a; letter-spacing: .06em; border-bottom: 1px solid #d0d7de;
                       border-top: 2px solid #d0d7de; cursor: pointer; user-select: none; }
    .month-header:first-child td { border-top: none; }
    .month-header td:hover { background: #eaeef2 !important; }
    .day-header td { background: #fafbfc; padding: 7px 16px; font-size: .8rem; font-weight: 600;
                     color: #57606a; border-bottom: 1px solid #eaecef; cursor: pointer; user-select: none; }
    .day-header td:hover { background: #f0f3f6 !important; }
    td { padding: 10px 16px; border-bottom: 1px solid #f0f0f0; font-size: .9rem; }
    tr:last-child td { border-bottom: none; }
    tr:not(.month-header):not(.day-header):hover td { background: #f6f8fa; }
    .time-cell { padding-left: 28px; width: 100%; }
    a { color: #0969da; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    .badge-new { background: #2da44e; color: white; font-size: .7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
    .row-new td { background: #f0fff4; }
    .row-new:hover td { background: #e6fced !important; }
    .status-badge { font-size: .7rem; padding: 2px 8px; border-radius: 10px; font-weight: 700; white-space: nowrap; }
    .status-pass    { background: #dafbe1; color: #1a7f37; }
    .status-fail    { background: #ffebe9; color: #cf222e; }
    .status-warn    { background: #fff8c5; color: #9a6700; }
    .status-unknown { background: #f6f8fa; color: #8c959f; border: 1px solid #d0d7de; }
    .trend-card { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px 20px; }
    .trend-title { font-size: .9rem; font-weight: 700; color: #24292f; margin-bottom: 14px; }
    .trend-sub { font-size: .75rem; font-weight: 400; color: #8c959f; margin-left: 6px; }
    .trend-group { margin-bottom: 16px; }
    .trend-group:last-child { margin-bottom: 0; }
    .trend-lang { font-size: .75rem; font-weight: 600; color: #57606a; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em; }
    .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .bar-label { font-size: .72rem; color: #8c959f; width: 80px; flex-shrink: 0; text-align: right; }
    .bar-wrap { flex: 1; display: flex; align-items: center; gap: 6px; }
    .bar { height: 12px; border-radius: 3px; min-width: 2px; transition: width .3s; }
    .bar-val { font-size: .72rem; color: #57606a; white-space: nowrap; }
    .footer { text-align: center; color: #8c959f; font-size: .8rem; margin-top: 16px; }
    .monthly-card { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
    .monthly-title { font-size: .9rem; font-weight: 700; color: #24292f; margin-bottom: 16px; }
    .monthly-grid { display: flex; flex-wrap: wrap; gap: 16px; }
    .month-card { flex: 1 1 140px; min-width: 130px; max-width: 180px; display: flex; flex-direction: column; align-items: center; border: 1px solid #eaecef; border-radius: 8px; padding: 12px 8px 10px; }
    .month-card-title { font-size: .78rem; font-weight: 700; color: #24292f; margin-bottom: 8px; }
    .month-card-donut { margin-bottom: 8px; }
    .month-card-legend { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-bottom: 4px; }
    .leg-item { font-size: .68rem; font-weight: 600; padding: 2px 6px; border-radius: 8px; }
    .leg-pass { background: #dafbe1; color: #1a7f37; }
    .leg-warn { background: #fff8c5; color: #9a6700; }
    .leg-fail { background: #ffebe9; color: #cf222e; }
    .month-card-total { font-size: .68rem; color: #8c959f; }
    .daily-card { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
    .daily-title { font-size: .9rem; font-weight: 700; color: #24292f; margin-bottom: 8px; }
    .daily-legend { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .dl-item { font-size: .72rem; font-weight: 600; padding: 2px 8px; border-radius: 8px; }
    .dl-pass { background: #dafbe1; color: #1a7f37; }
    .dl-warn { background: #fff8c5; color: #9a6700; }
    .dl-fail { background: #ffebe9; color: #cf222e; }
    .dl-none { background: #f6f8fa; color: #8c959f; border: 1px solid #d0d7de; }
    .daily-chart { padding: 4px 0 8px; }
    .arrow { font-size: .65rem; margin-right: 6px; display: inline-block; transition: transform .2s; }
    .group-count { font-size: .72rem; color: #8c959f; font-weight: 400; margin-left: 6px; }
    .hidden { display: none; }
"""

html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>이지랩 헬스체크 리포트</title>
  <style>{css}  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>이지랩 헬스체크 리포트</h1>
      <p class="subtitle">총 {total}개 리포트 &nbsp;·&nbsp; 하루 24회 자동 실행</p>
      <div class="summary">
        <span class="sum-badge sum-pass">PASS {pass_c}</span>
        <span class="sum-badge sum-fail">FAIL {fail_c}</span>
        <span class="sum-badge sum-warn">WARN {warn_c}</span>
      </div>
    </header>
    <div class="card">
      <table>
        <tbody>
{rows}        </tbody>
      </table>
    </div>
{daily_section}
{monthly_section}
{trend_section}
    <p class="footer">최근 실행: {cur_display} (KST)</p>
  </div>
<script>
function toggleGroup(id) {{
  var children = document.querySelectorAll('[data-parent="' + id + '"]');
  if (children.length === 0) return;
  var nowOpen = children[0].classList.contains('hidden');
  var arrow = document.getElementById('arrow-' + id);
  if (arrow) arrow.textContent = nowOpen ? '▼' : '▶';
  children.forEach(function(r) {{
    if (nowOpen) {{
      r.classList.remove('hidden');
    }} else {{
      r.classList.add('hidden');
      var childGid = r.dataset.gid;
      if (childGid) collapseGroup(childGid);
    }}
  }});
}}
function collapseGroup(id) {{
  var arrow = document.getElementById('arrow-' + id);
  if (arrow) arrow.textContent = '▶';
  document.querySelectorAll('[data-parent="' + id + '"]').forEach(function(r) {{
    r.classList.add('hidden');
    var childGid = r.dataset.gid;
    if (childGid) collapseGroup(childGid);
  }});
}}
</script>
</body>
</html>"""

with open(output_file, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"인덱스 생성 완료: {total}개 실행 기록 (PASS {pass_c} / FAIL {fail_c} / WARN {warn_c})")
