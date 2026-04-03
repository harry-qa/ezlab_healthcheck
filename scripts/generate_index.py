import sys
import re

dates_file = sys.argv[1]
current_date = sys.argv[2]
output_file = sys.argv[3]

with open(dates_file) as f:
    dates = sorted(
        {d.strip() for d in f if re.match(r'^\d{4}-\d{2}-\d{2}$', d.strip())},
        reverse=True
    )

rows = ""
for d in dates:
    is_new = d == current_date
    badge = '<span class="badge-new">최신</span>' if is_new else ''
    row_class = ' class="row-new"' if is_new else ''
    rows += f'<tr{row_class}><td><a href="{d}/">{d}</a></td><td>{badge}</td></tr>\n'

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
    th {{ background: #f6f8fa; padding: 10px 16px; text-align: left; font-size: .8rem; color: #57606a; font-weight: 600; border-bottom: 1px solid #d0d7de; letter-spacing: .04em; }}
    td {{ padding: 11px 16px; border-bottom: 1px solid #f0f0f0; font-size: .9rem; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: #f6f8fa; }}
    a {{ color: #0969da; text-decoration: none; font-weight: 500; }}
    a:hover {{ text-decoration: underline; }}
    .badge-new {{ background: #2da44e; color: white; font-size: .7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }}
    .row-new td {{ background: #f0fff4; }}
    .row-new:hover td {{ background: #e6fced; }}
    .footer {{ text-align: center; color: #8c959f; font-size: .8rem; margin-top: 16px; }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>이지랩 헬스체크 리포트</h1>
      <p class="subtitle">총 {len(dates)}개 리포트 &nbsp;·&nbsp; 매일 KST 00:00 자동 실행</p>
    </header>
    <div class="card">
      <table>
        <thead><tr><th>날짜</th><th></th></tr></thead>
        <tbody>
{rows}        </tbody>
      </table>
    </div>
    <p class="footer">최근 업데이트: {current_date}</p>
  </div>
</body>
</html>"""

with open(output_file, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"인덱스 생성 완료: {len(dates)}개 날짜")
