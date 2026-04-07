import sys
import re
from collections import defaultdict

runs_file   = sys.argv[1]
current_run = sys.argv[2]   # e.g. "2026-04-07_09-00"
output_file = sys.argv[3]

with open(runs_file) as f:
    entries = sorted(
        {d.strip() for d in f if re.match(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$', d.strip())},
        reverse=True
    )

# 날짜별 그룹핑
grouped = defaultdict(list)
for entry in entries:
    date, time_str = entry.split('_')
    grouped[date].append((entry, time_str.replace('-', ':')))

sorted_dates = sorted(grouped.keys(), reverse=True)

rows = ""
for date in sorted_dates:
    runs = grouped[date]
    rows += f'<tr class="date-header"><td colspan="3">{date}</td></tr>\n'
    for entry, time_display in runs:
        is_new = entry == current_run
        badge = '<span class="badge-new">최신</span>' if is_new else ''
        row_class = ' class="row-new"' if is_new else ''
        rows += f'<tr{row_class}><td class="time-cell"><a href="{entry}/">{time_display}</a></td><td>{badge}</td></tr>\n'

cur_date, cur_time = current_run.split('_')
cur_display = f"{cur_date} {cur_time.replace('-', ':')}"

html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>이지랩 헬스체크 리포트</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f8fa; min-height: 100vh; }}
    .container {{ max-width: 680px; margin: 48px auto; padding: 0 20px; }}
    header {{ margin-bottom: 24px; }}
    h1 {{ font-size: 1.4rem; color: #24292f; }}
    .subtitle {{ color: #57606a; font-size: .875rem; margin-top: 6px; }}
    .card {{ background: white; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }}
    table {{ width: 100%; border-collapse: collapse; }}
    .date-header td {{ background: #f6f8fa; padding: 8px 16px; font-size: .78rem; font-weight: 700;
                       color: #57606a; letter-spacing: .06em; border-bottom: 1px solid #d0d7de;
                       border-top: 2px solid #d0d7de; text-transform: uppercase; }}
    .date-header:first-child td {{ border-top: none; }}
    td {{ padding: 10px 16px; border-bottom: 1px solid #f0f0f0; font-size: .9rem; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:not(.date-header):hover td {{ background: #f6f8fa; }}
    .time-cell {{ padding-left: 28px; }}
    a {{ color: #0969da; text-decoration: none; font-weight: 500; }}
    a:hover {{ text-decoration: underline; }}
    .badge-new {{ background: #2da44e; color: white; font-size: .7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }}
    .row-new td {{ background: #f0fff4; }}
    .row-new:hover td {{ background: #e6fced !important; }}
    .footer {{ text-align: center; color: #8c959f; font-size: .8rem; margin-top: 16px; }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>이지랩 헬스체크 리포트</h1>
      <p class="subtitle">총 {len(entries)}개 리포트 &nbsp;·&nbsp; KST 01:00 / 05:00 / 09:00 / 12:00 / 15:00 / 19:00 자동 실행</p>
    </header>
    <div class="card">
      <table>
        <tbody>
{rows}        </tbody>
      </table>
    </div>
    <p class="footer">최근 실행: {cur_display} (KST)</p>
  </div>
</body>
</html>"""

with open(output_file, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"인덱스 생성 완료: {len(entries)}개 실행 기록")
