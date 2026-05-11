import sys
import re
import json
from collections import defaultdict

runs_file     = sys.argv[1]
current_run   = sys.argv[2]
statuses_file = sys.argv[3]
perf_file     = sys.argv[4]
output_file   = sys.argv[5]

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
