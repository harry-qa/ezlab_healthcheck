import sys
import os
import re
import json
import math
from html import escape
from datetime import datetime, timedelta
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dashboard_metrics import (
    AVAILABLE, OUTAGE, INDETERMINATE,
    classify_counts, availability, completion_rate, no_warning_rate,
    open_quality_warnings, current_state, month_buckets, is_migrated,
)

# ── CLI args ──────────────────────────────────────────────────────────
runs_file    = sys.argv[1]
current_run  = sys.argv[2]
statuses_file= sys.argv[3]
perf_file    = sys.argv[4]
monthly_file  = sys.argv[5]
daily_file    = sys.argv[6]
failures_file = sys.argv[7]
output_file   = sys.argv[8]
# 런별 점검 완주 여부. 없으면 빈 dict — 그 경우 WARN 은 전부 '확인 불가'로 분류된다
# (완주 여부를 모르는데 가용으로 세면 없는 근거로 가용률을 부풀리게 된다).
coverage_file = sys.argv[9] if len(sys.argv) > 9 else None
# 집계 스키마 상태(stats-meta.json). 백필 완료 표시가 없으면 월별 지표는 서비스 분류 벡터를
# 쓰지 않고 보수적 환산으로 통일한다 — 일부 월에만 벡터가 있는 상태를 정상 데이터로 읽으면
# 백필 전 월이 0% 로 표시돼 '그 달에 서비스가 죽어 있었다'는 잘못된 결론이 나온다.
meta_file     = sys.argv[10] if len(sys.argv) > 10 else None

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
# coverage.json 은 없거나 깨져 있어도 대시보드 생성을 막지 않는다 — 그 경우 완주 여부를
# '모름'으로 두고 지표가 '데이터 없음/부족'으로 표시되게 한다(대시보드가 통째로 죽는 것보다 낫다).
coverage_map     = load_json(coverage_file, {}) if coverage_file else {}
if not isinstance(coverage_map, dict):
    coverage_map = {}
stats_meta       = load_json(meta_file, {}) if meta_file else {}
stats_migrated   = is_migrated(stats_meta)

# ── Constants ─────────────────────────────────────────────────────────
LANGS       = ['ko', 'en', 'jp', 'tw']
LANG_LABELS = {'ko': '한국어', 'en': '영어', 'jp': '일본어', 'tw': '중국어'}
BASE_URL    = 'https://ezlab.im'
THRESHOLD   = 500  # ms danger threshold (TTFB 첫 응답 기준 · 본문 다운로드 제외)

# ── Overview stats ────────────────────────────────────────────────────
# 지표를 넷으로 분리한다(산식·근거는 dashboard_metrics.py 참고).
# 예전엔 PASS/(PASS+WARN+FAIL) 하나뿐이라 품질 경고가 장애와 똑같이 감점됐고,
# 그래서 검사를 추가할수록 '가동률'이 떨어지는 구조였다.
total  = len(entries)
pass_c = sum(1 for e in entries if statuses.get(e) == 'PASS')
fail_c = sum(1 for e in entries if statuses.get(e) == 'FAIL')
warn_c = sum(1 for e in entries if statuses.get(e) == 'WARN')

def _cov(run):
    """런의 완주 여부. 기록이 없으면 None(모름) — False(미완주)와 구분해야 한다."""
    v = coverage_map.get(run)
    return v if isinstance(v, bool) else None

cur_status = statuses.get(current_run, 'UNKNOWN')
cur_cov    = _cov(current_run)

svc_counts = classify_counts([(statuses.get(e, 'UNKNOWN'), _cov(e)) for e in entries])
avail_rate = availability(svc_counts)                       # 서비스 가용률 (주 지표)
comp_rate, comp_done, comp_known = completion_rate([_cov(e) for e in entries])
nowarn_rate, nowarn_scored = no_warning_rate([statuses.get(e, 'UNKNOWN') for e in entries])

# 열린 품질 경고 — 런 단위가 아니라 결함(지문) 단위. 완주 실행만으로 상태를 관리한다.
def _warn_fps(run):
    items = failures_history.get(run, [])
    if not isinstance(items, list):
        items = items.get('failures', [])
    return {i.get('fingerprint') for i in items
            if i.get('severity') == 'WARN' and i.get('fingerprint')}

_chrono = sorted(entries)  # 과거 → 현재
open_warnings, resolved_warnings = open_quality_warnings(
    _chrono, {r: _warn_fps(r) for r in _chrono}, {r: _cov(r) for r in _chrono})

_status_label, status_key = current_state(cur_status, cur_cov, len(open_warnings))

def _fmt_rate(v):
    return f'{v}%' if v is not None else '데이터 없음'

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
# '가용률/열린 경고/현재 상태'를 같은 크기의 카드로 나열하면 서비스 장애와 품질 이슈가
# 동급처럼 보인다. 현재 서비스 상태를 한 문장으로 먼저 보여주고, 기간 지표는 아래 보조 카드로 둔다.
# 가용률 색은 장애 기준으로만 판단한다 — 품질 경고는 여기서 색을 바꾸지 않는다.
avail_cls = (
    'score-neutral' if avail_rate is None else
    'score-great'   if avail_rate >= 99.9 else
    'score-good'    if avail_rate >= 99 else
    'score-warn'    if avail_rate >= 95 else
    'score-bad'
)
service_visual_key = 'pass' if status_key in ('pass', 'warn') else status_key
status_dot_html = {
    'pass':    '<span class="dot dot-pass"></span>',
    'warn':    '<span class="dot dot-warn"></span>',
    'fail':    '<span class="dot dot-fail"></span>',
    'unknown': '<span class="dot dot-unknown"></span>',
}[service_visual_key]
status_panel_cls = {'pass': 'status-hero--pass', 'warn': 'status-hero--pass',
                    'fail': 'status-hero--fail', 'unknown': 'status-hero--unknown'}[status_key]
status_headline = {
    'pass': '정상 운영 중',
    'warn': '정상 운영 중',
    'fail': '장애 감지',
    'unknown': '점검 결과 확인 필요',
}[status_key]
if status_key == 'fail':
    status_description = '최근 점검에서 서비스 이용에 영향을 줄 수 있는 장애를 감지했습니다.'
elif status_key == 'unknown':
    status_description = '점검이 끝까지 완료되지 않아 현재 서비스 상태를 확정할 수 없습니다.'
elif open_warnings:
    status_description = f'서비스 이용은 정상입니다. 확인이 필요한 항목 {len(open_warnings)}건을 별도로 추적 중입니다.'
elif status_key == 'warn':
    status_description = '서비스 이용은 정상입니다. 이번 실행의 경고 상세는 아래 점검 내역에서 확인할 수 있습니다.'
else:
    status_description = '최근 점검에서 서비스 장애와 추가 확인 항목이 발견되지 않았습니다.'

if status_key == 'fail':
    status_action = f'최근 24시간 장애 {fail_24h}건'
    status_action_cls = 'status-action--fail'
elif status_key == 'unknown':
    status_action = '점검 미완료'
    status_action_cls = 'status-action--unknown'
elif open_warnings:
    status_action = f'확인 필요 {len(open_warnings)}건'
    status_action_cls = 'status-action--warn'
else:
    status_action = '추가 확인 없음'
    status_action_cls = 'status-action--pass'
alert_cls = 'val-danger' if fail_24h > 0 else 'val-ok'
alert_val = f'{fail_24h}건' if fail_24h > 0 else '이상 없음'

# 완주 표본이 너무 적으면 비율을 적지 않는다 — 4건 중 3건으로 '75%'를 적으면 과대해석된다.
comp_display = ('데이터 부족' if comp_known < 10 and comp_known > 0 else _fmt_rate(comp_rate))
comp_sub = (f'완주 기록 {comp_done}/{comp_known}회'
            if comp_known else '완주 기록 없음')

overview_html = f'''
    <section class="status-hero {status_panel_cls}">
      <div class="status-copy">
        <div class="status-eyebrow">현재 서비스</div>
        <div class="status-title-row">{status_dot_html}<strong>{escape(status_headline)}</strong></div>
        <p>{escape(status_description)}</p>
      </div>
      <div class="status-aside">
        <span class="status-action {status_action_cls}">{escape(status_action)}</span>
        <span class="status-time">{cur_display} KST</span>
      </div>
    </section>
    <div class="metric-grid">
      <div class="metric-card">
        <div class="metric-label">최근 {total}회 정상률</div>
        <div class="metric-value {avail_cls}">{_fmt_rate(avail_rate)}</div>
        <div class="metric-sub">정상 {svc_counts[AVAILABLE]} · 장애 {svc_counts[OUTAGE]} · 확인 불가 {svc_counts[INDETERMINATE]}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">최근 24시간 장애 감지</div>
        <div class="metric-value {alert_cls}">{alert_val}</div>
        <div class="metric-sub">서비스 장애(FAIL) 판정 기준</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">점검 완료율</div>
        <div class="metric-value">{comp_display}</div>
        <div class="metric-sub">{comp_sub}</div>
      </div>
    </div>
    <details class="metric-help">
      <summary>지표 계산 기준</summary>
      <div class="metric-help-body">
        <span><b>서비스 정상률</b>은 정상 이용 가능 실행을 기준으로 계산하며, 점검 미완료·UNKNOWN은 분모에서 제외합니다.</span>
        <span><b>경고 없는 실행</b> {_fmt_rate(nowarn_rate)} <span class="muted">(최근 {nowarn_scored}회 · 검사를 추가하면 낮아질 수 있는 보조 지표)</span></span>
        <span>완주 여부 기록이 없는 과거 실행 {total - comp_known}회는 점검 완료율 계산에서 제외했습니다.</span>
      </div>
    </details>'''

# ── 열린 품질 경고 목록 ────────────────────────────────────────────────
# 런 단위로 세면 결함 하나가 30분마다 새 경고로 잡힌다(실측: 'WARN 22건' = OG 403 하나가 22회).
# 지문 단위로 묶고 최초·최근 감지와 연속 검출 횟수를 함께 보여 조치 근거로 쓰게 한다.
def _warning_display(fingerprint):
    """내부 지문을 사용자에게 노출할 파일/경로·오류 유형·미리보기 URL로 나눈다."""
    resource, kind = (fingerprint.rsplit('|', 1) + [''])[:2] if '|' in fingerprint else (fingerprint, '')
    clean = resource.split('?', 1)[0].rstrip('/')
    leaf = clean.rsplit('/', 1)[-1] if '/' in clean else clean
    # 파일이면 파일명을 제목으로, 페이지/호스트면 전체 경로를 제목으로 쓴다.
    title = leaf if re.search(r'\.[a-z0-9]{2,5}$', leaf, re.I) else clean
    kind_label = {
        'HTTP_4XX': 'HTTP 4xx 응답',
        'HTTP_5XX': 'HTTP 5xx 응답',
        'TIMEOUT': '응답 시간 초과',
        'NETWORK': '네트워크 연결 실패',
        'CONTENT': '콘텐츠 확인 실패',
    }.get(kind, kind.replace('_', ' ').strip() or '점검 경고')
    # 이미지 경고만 사용자가 클릭했을 때 원본을 불러온다. 평소에는 추가 요청이 없다.
    preview_url = None
    if re.search(r'\.(?:avif|gif|jpe?g|png|webp)$', leaf, re.I):
        if re.match(r'^https?://', clean, re.I):
            preview_url = clean
        elif clean and not clean.startswith(('/', '.')):
            preview_url = f'https://{clean}'
    return title or fingerprint, clean or fingerprint, kind_label, preview_url

def _display_run_time(run):
    try:
        return datetime.strptime(run, '%Y-%m-%d_%H-%M').strftime('%Y-%m-%d %H:%M')
    except (ValueError, TypeError):
        return str(run).replace('_', ' ')

if open_warnings:
    rows = ''
    for issue_idx, w in enumerate(open_warnings):
        miss = (f'<span class="qw-miss">최근 {w["missed"]}회 미검출</span>' if w['missed'] else '')
        issue_title, issue_resource, issue_kind, preview_url = _warning_display(w['fingerprint'])
        if preview_url:
            preview_id = f'issue-preview-{issue_idx}'
            title_html = f'''
            <button type="button" class="issue-title issue-title-btn"
                    data-preview-url="{escape(preview_url, quote=True)}"
                    aria-expanded="false" aria-controls="{preview_id}"
                    onclick="toggleIssuePreview('{preview_id}', this)">
              <span>{escape(issue_title)}</span><span class="issue-preview-hint">이미지 보기</span>
            </button>'''
            preview_html = f'''
          <div id="{preview_id}" class="issue-preview hidden" data-loaded="false">
            <div class="issue-preview-head">
              <strong>이미지 미리보기</strong>
              <a href="{escape(preview_url, quote=True)}" target="_blank" rel="noopener noreferrer">원본 응답 열기 ↗</a>
            </div>
            <div class="issue-preview-stage">
              <span class="issue-preview-loading">이미지를 불러오는 중입니다.</span>
              <img class="issue-preview-img hidden" alt="{escape(issue_title, quote=True)} 미리보기" decoding="async">
              <div class="issue-preview-error hidden">
                <strong>현재 이미지를 불러올 수 없습니다.</strong>
                <span>{escape(issue_kind)}이 계속되고 있거나 브라우저가 해당 응답을 이미지로 표시할 수 없습니다.</span>
              </div>
            </div>
          </div>'''
        else:
            title_html = f'<strong class="issue-title">{escape(issue_title)}</strong>'
            preview_html = ''
        rows += f'''
        <div class="issue-item">
          <div class="issue-row">
            <div class="issue-main">
              {title_html}
              <span class="issue-meta">{escape(issue_resource)} · {escape(issue_kind)}</span>
            </div>
            <div class="issue-count"><span>{w['detected']}회 확인</span>{miss}</div>
            <div class="issue-dates">
              <span><small>처음</small>{escape(_display_run_time(w['first']))}</span>
              <span><small>최근</small>{escape(_display_run_time(w['last']))}</span>
            </div>
          </div>
          {preview_html}
        </div>'''
    quality_html = f'''
    <div class="card quality-card">
      <div class="quality-head">
        <div><div class="card-title">확인이 필요한 항목</div>
        <div class="card-sub">서비스는 정상 이용 가능하며, 아래 {len(open_warnings)}건을 계속 확인하고 있습니다.</div></div>
        <span class="quality-count">{len(open_warnings)}건</span>
      </div>
      <div class="issue-list">{rows}</div>
      <div class="quality-foot">완주한 점검에서 2회 연속 다시 발견되지 않으면 자동으로 목록에서 정리됩니다.</div>
    </div>'''
else:
    quality_html = f'''
    <div class="card quality-card">
      <div class="quality-head"><div><div class="card-title">확인이 필요한 항목</div>
      <div class="card-sub">최근 완료된 점검 기준</div></div><span class="quality-count quality-count--ok">0건</span></div>
      <div class="qw-empty">현재 추가로 확인할 항목이 없습니다.</div>
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
def make_donut_svg(avail_n, outage_n, indet_n, rate):
    """월별 도넛 — 세그먼트는 가용/장애/확인 불가, 가운데 숫자는 '서비스 가용률'.

    예전엔 가운데가 PASS/(PASS+WARN+FAIL) 이라 품질 경고가 장애와 같은 감점이었다.
    가용률은 확인 불가를 분모에서 빼므로 세그먼트 비율과 가운데 숫자가 일부러 다르다
    (확인 불가 구간은 회색으로 보이되 점수를 깎지도 올리지도 않는다).
    """
    total = avail_n + outage_n + indet_n
    r, circ = 38, 2 * math.pi * 38
    if total == 0:
        return (f'<svg viewBox="0 0 100 100" width="88" height="88">'
                f'<circle cx="50" cy="50" r="{r}" fill="none" stroke="#1c2333" stroke-width="13"/></svg>')
    segs, cum = [], 0.0
    for cnt, color in [(avail_n, '#3fb950'), (outage_n, '#f85149'), (indet_n, '#6e7681')]:
        seg = circ * cnt / total
        if seg > 0:
            segs.append(
                f'<circle cx="50" cy="50" r="{r}" fill="none" stroke="{color}" stroke-width="13" '
                f'stroke-dasharray="{seg:.2f} {circ:.2f}" stroke-dashoffset="{-cum:.2f}" '
                f'transform="rotate(-90,50,50)"/>'
            )
        cum += seg
    label = f'{round(rate)}%' if rate is not None else '–'
    size = 16 if rate is not None else 20
    center = (f'<text x="50" y="55" text-anchor="middle" font-size="{size}" font-weight="700" '
              f'fill="#e6edf3">{label}</text>')
    return f'<svg viewBox="0 0 100 100" width="88" height="88">{"".join(segs)}{center}</svg>'

# 마이그레이션이 끝나지 않았으면 화면에 그 사실을 적는다 — 숫자만 보면 보수적 환산값을
# 서비스 가용률로 오해한다(백필 전 WARN 이 전부 확인 불가로 잡혀 실제보다 낮게 나온다).
monthly_note = ('<span class="section-sub">서비스 정상률</span>' if stats_migrated else
                '<span class="section-sub section-sub--warn">서비스 정상률 · 집계 마이그레이션 전 —'
                ' WARN 을 전부 확인 불가로 환산한 보수적 값입니다'
                ' (<code>scripts/backfill_stats.py</code> 실행 필요)</span>')

monthly_cards_html = ''
if monthly_stats:
    for m in sorted(monthly_stats.keys(), reverse=True):
        d = monthly_stats[m]
        w = d.get('WARN', 0)
        b = month_buckets(d, stats_migrated)
        a_n, o_n, i_n = b[AVAILABLE], b[OUTAGE], b[INDETERMINATE]
        total_m = a_n + o_n + i_n
        rate_m = availability(b)
        year, mon = m.split('-')
        label = f"{year}년 {int(mon)}월"
        donut = make_donut_svg(a_n, o_n, i_n, rate_m)
        monthly_cards_html += f'''
      <div class="month-card">
        <div class="month-card-title">{label}</div>
        {donut}
        <div class="month-sub">서비스 정상률</div>
        <div class="month-legend">
          <span class="leg-warn">WARN {w}</span>
          <span class="leg-fail">FAIL {o_n}</span>
          <span class="leg-indet">확인 불가 {i_n}</span>
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
                # 스코어에 반영되는 등급(FAIL/WARN)과 정보성 등급(INFO)을 한 표에 섞어 보여주되
                # 행을 흐리게 처리하고 배지를 달아 구분한다. 섞지 않고 숨기면 "왜 외부 링크가
                # 깨졌는데 대시보드에 아무것도 없냐"가 되고, 구분 없이 섞으면 스코어가 왜 안 깎였는지 모른다.
                f_rows = ''
                info_n = 0
                for fr in run_failures:
                    sev      = fr.get('severity')
                    is_info  = sev == 'INFO'
                    if is_info:
                        info_n += 1
                    icon     = 'ℹ️' if is_info else type_icons.get(fr.get('type', ''), '⚠️')
                    # 점검 대상 사이트에서 크롤링한 값(url/symptom 등)이 그대로 HTML에 들어가므로
                    # escape로 코드 실행/속성 탈출 차단 (html.escape는 따옴표까지 이스케이프 → title 속성도 안전).
                    f_url    = escape(str(fr.get('url', '-')))
                    f_status = fr.get('status', 0)
                    f_time   = fr.get('responseTime', 0)
                    f_sym    = escape(str(fr.get('symptom', '-')))
                    f_step   = escape(str(fr.get('step', '-')))
                    f_lang   = escape(str(fr.get('lang', '-')))
                    status_cls = 'fs-5xx' if f_status >= 500 else ('fs-4xx' if f_status >= 400 else 'fs-other')
                    status_txt = str(f_status) if f_status > 0 else 'timeout'
                    time_txt   = f'{f_time}ms' if f_time > 0 else '—'
                    if is_info:
                        f_sym += ' <span class="fd-info-tag">스코어 미반영</span>'
                    f_rows += (
                        f'<tr class="{"fd-row-info" if is_info else ""}">'
                        f'<td class="fd-icon">{icon}</td>'
                        f'<td class="fd-step">{f_step}</td>'
                        f'<td class="fd-lang">{f_lang}</td>'
                        f'<td class="fd-url" title="{f_url}">{f_url}</td>'
                        f'<td class="fd-status {status_cls}">{status_txt}</td>'
                        f'<td class="fd-time">{time_txt}</td>'
                        f'<td class="fd-sym">{f_sym}</td>'
                        f'</tr>'
                    )
                scored_n = len(run_failures) - info_n
                # 전건이 INFO면 런은 PASS인데 제목이 '장애 상세'라 초록 런에 빨간 헤더가 붙는다 → 제목·색을 등급에 맞춘다.
                title_txt = '장애 상세' if scored_n else '참고 항목'
                title_cls = 'dp-title-fail' if scored_n else 'dp-title-info'
                count_txt = f'{scored_n}건' if not info_n else (
                    f'{scored_n}건 · 참고 {info_n}건' if scored_n else f'{info_n}건'
                )
                failure_section = (
                    f'<div class="dp-section dp-failure{"" if scored_n else " dp-failure-info"}">'
                    f'<div class="dp-title {title_cls}">{title_txt} <span class="dp-sub">{count_txt}</span></div>'
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

  /* Current service first, historical metrics second */
  .status-hero { display: flex; justify-content: space-between; align-items: center; gap: 24px;
                 background: linear-gradient(135deg, #111820 0%, #161b22 72%);
                 border: 1px solid #2d333b; border-radius: 12px; padding: 22px 24px;
                 margin-bottom: 12px; }
  .status-hero--pass { border-color: #238636; box-shadow: inset 3px 0 0 #3fb950; }
  .status-hero--fail { border-color: #b91c1c; box-shadow: inset 3px 0 0 #f85149; }
  .status-hero--unknown { border-color: #484f58; box-shadow: inset 3px 0 0 #6e7681; }
  .status-copy { min-width: 0; }
  .status-eyebrow { color: #8b949e; font-size: .7rem; font-weight: 700;
                    letter-spacing: .08em; text-transform: uppercase; margin-bottom: 7px; }
  .status-title-row { display: flex; align-items: center; gap: 10px; }
  .status-title-row strong { color: #f0f6fc; font-size: 1.45rem; line-height: 1.25; }
  .status-copy p { color: #8b949e; font-size: .78rem; line-height: 1.55; margin-top: 7px; }
  .status-aside { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; flex-shrink: 0; }
  .status-action { display: inline-flex; align-items: center; border-radius: 999px; padding: 5px 10px;
                   font-size: .72rem; font-weight: 700; white-space: nowrap; border: 1px solid transparent; }
  .status-action--pass { color: #56d364; background: #0f2d1a; border-color: #1d4b2a; }
  .status-action--warn { color: #e3b341; background: #2d2008; border-color: #5f450d; }
  .status-action--fail { color: #ff7b72; background: #2d0f0f; border-color: #6e2020; }
  .status-action--unknown { color: #adbac7; background: #21262d; border-color: #30363d; }
  .status-time { color: #484f58; font-size: .68rem; white-space: nowrap; }

  .metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
  .metric-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
                 padding: 15px 16px; min-width: 0; }
  .metric-label { font-size: .7rem; color: #8b949e; font-weight: 650; margin-bottom: 8px; }
  .metric-value { color: #e6edf3; font-size: 1.55rem; font-weight: 800; line-height: 1; margin-bottom: 7px; }
  .metric-sub { font-size: .68rem; color: #5f6772; line-height: 1.4; }
  .score-great { color: #3fb950; }
  .score-good  { color: #56d364; }
  .score-warn  { color: #d29922; }
  .score-bad   { color: #f85149; }
  .val-ok      { color: #3fb950; }
  .val-danger  { color: #f85149; }

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
  .leg-indet { font-size: .65rem; font-weight: 600; padding: 2px 6px; border-radius: 6px;
               background: #21262d; color: #8b949e; }
  .month-sub { font-size: .62rem; color: #6e7681; margin-top: 4px; }
  .section-sub--warn { color: #d29922; }
  .section-sub--warn code { background: #21262d; padding: 1px 5px; border-radius: 4px; }
  .month-total { font-size: .65rem; color: #484f58; margin-top: 5px; }

  /* 지표 설명은 기본 화면에서 접어 둔다. */
  .metric-help { margin: 3px 0 18px; color: #6e7681; font-size: .7rem; }
  .metric-help summary { width: fit-content; cursor: pointer; color: #6e7681; padding: 3px 2px;
                         user-select: none; }
  .metric-help summary:hover { color: #8b949e; }
  .metric-help-body { display: flex; flex-direction: column; gap: 5px; margin-top: 6px;
                      padding: 10px 12px; background: #0d1117; border: 1px solid #21262d;
                      border-radius: 8px; line-height: 1.55; }
  .metric-help-body b { color: #c9d1d9; font-weight: 600; }
  .metric-help-body .muted { color: #5f6772; }
  .score-neutral { color: #8b949e; }

  /* 확인이 필요한 항목 — 내부 지문 대신 파일/경로와 오류 유형을 보여준다. */
  .quality-card { padding: 18px 20px 14px; }
  .quality-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .card-title { color: #e6edf3; font-size: .9rem; font-weight: 700; }
  .card-sub { display: block; font-size: .7rem; font-weight: 500; color: #6e7681; margin-top: 4px; }
  .quality-count { display: inline-flex; align-items: center; justify-content: center; min-width: 38px;
                   border-radius: 999px; padding: 4px 9px; background: #2d2008; color: #e3b341;
                   border: 1px solid #5f450d; font-size: .72rem; font-weight: 700; white-space: nowrap; }
  .quality-count--ok { background: #0f2d1a; color: #56d364; border-color: #1d4b2a; }
  .issue-list { margin-top: 14px; border-top: 1px solid #21262d; }
  .issue-item { border-bottom: 1px solid #21262d; }
  .issue-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center;
               gap: 18px; padding: 13px 2px; }
  .issue-main { min-width: 0; }
  .issue-title { display: block; color: #e6edf3; font-size: .8rem; margin-bottom: 4px; }
  .issue-title-btn { width: fit-content; max-width: 100%; padding: 0; border: 0; background: none;
                     font: inherit; font-weight: 700; text-align: left; cursor: pointer; }
  .issue-title-btn > span:first-child { text-decoration: underline; text-decoration-color: #30363d;
                                        text-underline-offset: 3px; }
  .issue-title-btn:hover > span:first-child { color: #58a6ff; text-decoration-color: #58a6ff; }
  .issue-title-btn:focus-visible { outline: 2px solid #58a6ff; outline-offset: 4px; border-radius: 2px; }
  .issue-preview-hint { display: inline-flex; margin-left: 8px; padding: 2px 6px; border: 1px solid #30363d;
                        border-radius: 999px; color: #8b949e; font-size: .59rem; font-weight: 650;
                        line-height: 1.2; vertical-align: 1px; text-decoration: none; }
  .issue-meta { display: block; color: #6e7681; font-size: .68rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .issue-count { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; color: #d29922;
                 font-size: .7rem; font-weight: 650; white-space: nowrap; }
  .issue-dates { display: flex; flex-direction: column; gap: 4px; min-width: 126px; color: #8b949e;
                 font-size: .67rem; font-variant-numeric: tabular-nums; }
  .issue-dates span { display: flex; gap: 7px; justify-content: space-between; }
  .issue-dates small { color: #484f58; font-size: .64rem; }
  .issue-preview { margin: 0 2px 14px; overflow: hidden; border: 1px solid #30363d;
                   border-radius: 9px; background: #0d1117; }
  .issue-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                        padding: 9px 11px; border-bottom: 1px solid #21262d; font-size: .69rem; }
  .issue-preview-head strong { color: #c9d1d9; font-weight: 650; }
  .issue-preview-head a { color: #58a6ff; text-decoration: none; white-space: nowrap; }
  .issue-preview-head a:hover { text-decoration: underline; }
  .issue-preview-stage { display: flex; min-height: 148px; align-items: center; justify-content: center;
                         padding: 14px; background: #090c10; }
  .issue-preview-loading { color: #6e7681; font-size: .72rem; }
  .issue-preview-img { display: block; max-width: 100%; max-height: 420px; border-radius: 6px;
                       object-fit: contain; background: #fff; }
  .issue-preview-error { display: flex; max-width: 420px; flex-direction: column; align-items: center;
                         gap: 6px; color: #8b949e; font-size: .71rem; line-height: 1.5; text-align: center; }
  .issue-preview-error strong { color: #f0b04b; font-size: .78rem; }
  .qw-miss { font-size: .62rem; color: #6e7681; font-weight: 500; }
  .quality-foot { color: #484f58; font-size: .66rem; line-height: 1.45; padding-top: 10px; }
  .qw-empty { color: #6e7681; font-size: .78rem; padding: 20px 2px 8px; }

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
  /* 전건이 INFO(스코어 미반영)인 런은 빨간 강조를 걷어낸다 — 런 자체는 PASS다 */
  .dp-failure-info { border-left-color: #484f58; }
  .dp-title-fail { color: #f85149 !important; }
  .dp-title-info { color: #8b949e !important; }
  .fd-row-info td { opacity: .62; }
  .fd-info-tag { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px;
                 background: #21262d; color: #8b949e; font-size: .62rem; font-weight: 700;
                 vertical-align: middle; white-space: nowrap; }
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

  /* SSL 인증서 만료 패널 */
  .cert-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
  .cert-top { display: flex; justify-content: space-between; align-items: baseline; }
  .cert-host { font-size: .85rem; font-weight: 700; color: #c9d1d9; }
  .cert-days { font-size: .85rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .cert-meter { position: relative; height: 8px; background: #0d1117; border: 1px solid #21262d;
                border-radius: 5px; margin-top: 9px; overflow: hidden; }
  .cert-danger { position: absolute; left: 0; top: 0; height: 100%; background: rgba(248,81,73,.20); }
  .cert-fill { position: absolute; left: 0; top: 0; height: 100%; border-radius: 5px; }
  .cert-scale { display: flex; justify-content: space-between; font-size: .66rem; color: #484f58; margin-top: 5px; }

  @media (max-width: 540px) {
    .status-hero { flex-direction: column; align-items: flex-start; gap: 12px; padding: 18px; }
    .status-aside { width: 100%; flex-direction: row; align-items: center; justify-content: space-between; }
    .status-title-row strong { font-size: 1.25rem; }
    .metric-grid { grid-template-columns: 1fr; }
    .issue-row { grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
    .issue-count { grid-column: 2; grid-row: 1; }
    .issue-dates { grid-column: 1 / -1; flex-direction: row; min-width: 0; }
    .issue-dates span { justify-content: flex-start; }
    .spark-grid { grid-template-columns: repeat(2, 1fr); }
    .perf-summary { display: none; }
    .cert-grid { grid-template-columns: 1fr; }
  }
"""

# ── SSL 인증서 패널 ───────────────────────────────────────────────────
# perf_history[run].certs 에서 최신 스냅샷을 읽는다(현재 런 우선, 없으면 인증서 정보가 있는 최근 런으로
# 폴백 — 예산 스킵/구버전 런 대비). PASS 포함 전 호스트를 미터로 표시한다.
CERT_WARN_DAYS, CERT_FAIL_DAYS, CERT_SCALE = 14, 7, 180

def _latest_certs():
    for e in [current_run] + entries:
        c = perf_history.get(e, {}).get('certs')
        if c:
            return c, e
    return [], None

def build_cert_panel():
    certs, run_key = _latest_certs()
    if not certs:
        return ''  # 인증서 데이터가 아직 없으면(구버전 런) 패널 자체를 생략
    danger_pct = CERT_WARN_DAYS / CERT_SCALE * 100
    items = ''
    for c in certs:
        host = escape(str(c.get('host', '-')))
        st   = c.get('status', 'PASS')
        days = c.get('daysLeft')
        valid = escape(str(c.get('validTo') or '-'))
        if st == 'ERROR' or days is None:
            color, dtxt, fill, sub = '#8b949e', '확인 실패', 0.0, '인증서 정보를 읽지 못함'
        else:
            color = '#f85149' if st == 'FAIL' else ('#d29922' if st == 'WARN' else '#3fb950')
            dtxt  = '만료됨' if days < 0 else f'D-{days}'
            fill  = max(0.0, min(100.0, days / CERT_SCALE * 100))
            sub   = f'만료 {valid}'
        items += (
            f'<div class="cert-item">'
            f'<div class="cert-top"><span class="cert-host">{host}</span>'
            f'<span class="cert-days" style="color:{color}">{dtxt}</span></div>'
            f'<div class="cert-meter"><div class="cert-danger" style="width:{danger_pct:.1f}%"></div>'
            f'<div class="cert-fill" style="width:{fill:.1f}%;background:{color}"></div></div>'
            f'<div class="cert-scale"><span>D-0</span><span>{sub}</span></div></div>'
        )
    stale = ''
    if run_key and run_key != current_run:
        stale = f'<span class="section-sub">기준 {escape(run_key.replace("_", " ").replace("-", ":"))}</span>'
    return (
        f'<div class="card">'
        f'<div class="section-title">SSL 인증서 만료'
        f'<span class="section-sub">경고 D-{CERT_WARN_DAYS} · 장애 D-{CERT_FAIL_DAYS}</span>{stale}</div>'
        f'<div class="cert-grid">{items}</div></div>'
    )

cert_panel_html = build_cert_panel()

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
      <span class="info-tag"><i class="info-icon">ⓘ</i> 최근 {total}개 리포트 기준 · 30분 주기 자동 실행</span>
    </div>
    <p class="header-sub">마지막 실행: {cur_display} KST</p>
  </header>

  {overview_html}

  {quality_html}

  <div class="chart-card">
    <div class="chart-header">
      <span class="section-title">서버 첫 응답(TTFB) 추이<span class="section-sub">언어별 · 최근 24회 · 3회 중앙값</span></span>
      <span class="threshold-note">위험 임계치 <span>{THRESHOLD}ms</span></span>
    </div>
    {sparklines_html}
  </div>

  {cert_panel_html}

  <div class="card">
    <div class="section-title">일별 점검 결과<span class="section-sub">최근 90일</span></div>
    <div class="heatmap-legend">
      <span class="hm-item"><span class="hm-dot" style="background:#3fb950"></span>PASS</span>
      <span class="hm-item"><span class="hm-dot" style="background:#d29922"></span>WARN 포함</span>
      <span class="hm-item"><span class="hm-dot" style="background:#f85149"></span>FAIL 포함</span>
      <span class="hm-item"><span class="hm-dot" style="background:#1c2333"></span>데이터 없음</span>
    </div>
    {heatmap_svg}
  </div>

  {'<div class="card"><div class="section-title">월별 요약' + monthly_note + '</div><div class="monthly-grid">' + monthly_cards_html + '</div></div>' if monthly_cards_html else ''}

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
function toggleIssuePreview(id, button) {{
  var panel = document.getElementById(id);
  if (!panel) return;

  var willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  var hint = button.querySelector('.issue-preview-hint');
  if (hint) hint.textContent = willOpen ? '이미지 닫기' : '이미지 보기';

  if (!willOpen || panel.dataset.loaded === 'true') return;
  panel.dataset.loaded = 'true';

  var img = panel.querySelector('.issue-preview-img');
  var loading = panel.querySelector('.issue-preview-loading');
  var error = panel.querySelector('.issue-preview-error');
  var url = button.dataset.previewUrl;
  if (!img || !url) return;

  img.onload = function() {{
    if (loading) loading.classList.add('hidden');
    if (error) error.classList.add('hidden');
    img.classList.remove('hidden');
  }};
  img.onerror = function() {{
    if (loading) loading.classList.add('hidden');
    img.classList.add('hidden');
    if (error) error.classList.remove('hidden');
  }};
  img.src = url;
}}

function filterRuns(status, btn) {{
  document.querySelectorAll('.tab-btn').forEach(function(b) {{ b.classList.remove('active'); }});
  btn.classList.add('active');
  btn.dataset.filter = status;

  if (status === 'all') {{
    // Restore default: only first month open, days collapsed, details closed
    var allRows = document.querySelectorAll('.run-row, .run-detail, .day-header, .month-header');
    allRows.forEach(function(r) {{ r.style.display = ''; }});
    // 이전 필터가 숨긴 월 헤더 복원 — 안 풀면 해당 월이 전체 탭에서 사라진 채 남는다.
    // 화살표도 접힘(▶)으로 초기화해 필터 모드의 ▼ 잔상 제거.
    document.querySelectorAll('.month-header').forEach(function(r) {{
      r.classList.remove('hidden');
      var arrow = document.getElementById('arrow-' + r.dataset.gid);
      if (arrow) arrow.textContent = '▶';
    }});
    document.querySelectorAll('.run-row, .run-detail').forEach(function(r) {{
      r.classList.add('hidden');
    }});
    document.querySelectorAll('.day-header').forEach(function(r) {{
      if (!r.classList.contains('hidden')) r.classList.add('hidden');
      var arrow = document.getElementById('arrow-' + r.dataset.gid);
      if (arrow) arrow.textContent = '▶';
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
