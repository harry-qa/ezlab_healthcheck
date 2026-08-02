export type DiagnosticSeverity = 'FAIL' | 'WARN' | 'INFO';

export type DiagnosticRecord = {
  step: string;
  type: string;
  lang: string;
  url: string;
  status: number;
  responseTime: number;
  symptom: string;
  timestamp: string;
  severity?: DiagnosticSeverity;
  contentType?: string;
  contentRange?: string;
  netError?: string;
  responseHeaders?: Record<string, string>;
  responseBodySnippet?: string;
  responseBodyBytes?: number;
  referencePages?: string[];
  diagnosticDetails?: string[];
};

export const DIAGNOSTIC_HEADER_NAMES = [
  'content-type',
  'server',
  'via',
  'x-cache',
  'x-amz-cf-pop',
  'x-amz-cf-id',
  'content-length',
  'cache-control',
  'age',
  'date',
] as const;

/** 응답 헤더 전체를 노출하지 않고 장애 원인 분석에 필요한 항목만 남긴다. */
export function selectDiagnosticHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return Object.fromEntries(
    DIAGNOSTIC_HEADER_NAMES
      .map(name => [name, normalized.get(name) ?? ''] as const)
      .filter(([, value]) => value.length > 0),
  );
}

/**
 * 오류 응답의 텍스트 본문만 짧게 남긴다. 이미지 바이너리는 카드에 싣지 않는다.
 * APIResponse는 이미 본문을 버퍼링하므로 이 함수는 추가 네트워크 요청을 만들지 않는다.
 */
export function makeResponseBodySnippet(
  body: Buffer,
  contentType: string,
  status: number,
  limit = 360,
): string | undefined {
  if (body.length === 0) return undefined;
  const head = body.subarray(0, Math.min(body.length, limit * 4)).toString('utf8');
  const type = contentType.toLowerCase();
  const looksTextual = /(^text\/|json|xml|html|javascript|x-www-form-urlencoded|problem\+)/.test(type)
    || (status >= 400 && /^\s*[<{[]/.test(head));
  if (!looksTextual) return undefined;

  const cleaned = head
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  const clipped = cleaned.slice(0, limit);
  return clipped + (cleaned.length > limit || body.length > Buffer.byteLength(head) ? '…' : '');
}

export function diagnosticCardHtml(rec: DiagnosticRecord, runId: string): string {
  const esc = (value: unknown) => String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const severity = rec.severity ?? 'FAIL';
  const color = severity === 'FAIL' ? '#e5534b' : severity === 'WARN' ? '#d29922' : '#58a6ff';
  const headerBlock = Object.entries(rec.responseHeaders ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const requiredRows: [string, unknown][] = [
    ['STEP', rec.step],
    ['유형', `${rec.type} · ${severity}`],
    ['URL', rec.url],
    ['HTTP 상태', rec.status === 0 ? '응답 없음 (0)' : rec.status],
    ['증상', rec.symptom],
    ['언어', rec.lang],
    ['감지 시각', rec.timestamp],
    ['응답 시간', rec.responseTime ? `${rec.responseTime}ms` : '-'],
  ];
  const optionalCandidates: [string, unknown][] = [
    ['참조 페이지', rec.referencePages?.join('\n')],
    ['Content-Type', rec.contentType],
    ['Content-Range', rec.contentRange],
    ['응답 크기', typeof rec.responseBodyBytes === 'number' ? `${rec.responseBodyBytes} bytes` : undefined],
    ['응답 헤더', headerBlock || undefined],
    ['응답 본문 발췌', rec.responseBodySnippet],
    ['상세 내역', rec.diagnosticDetails?.join('\n\n')],
    ['네트워크 오류', rec.netError],
  ];
  const optionalRows = optionalCandidates
    .filter(([, value]) => value !== undefined && value !== null && value !== '');
  const rows = [...requiredRows, ...optionalRows, ['실행 ID', runId] as [string, unknown]];

  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0d1117;
    font:14px/1.6 -apple-system,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;color:#c9d1d9">
    <div style="max-width:980px;margin:24px auto;border:1px solid #30363d;border-radius:10px;overflow:hidden">
      <div style="background:${color};color:#fff;padding:14px 20px;font-size:17px;font-weight:700">
        이지랩 헬스체크 · ${esc(severity)} 진단 카드
      </div>
      <table style="width:100%;border-collapse:collapse">
        ${rows.map(([key, value], index) => `<tr style="background:${index % 2 ? '#161b22' : '#0d1117'}">
          <td style="padding:10px 20px;color:#8b949e;white-space:nowrap;vertical-align:top;width:150px">${esc(key)}</td>
          <td style="padding:10px 20px;word-break:break-word;white-space:pre-wrap">${esc(value)}</td></tr>`).join('')}
      </table>
      <div style="padding:10px 20px;color:#8b949e;font-size:12px;border-top:1px solid #30363d">
        화면으로 확인할 수 없는 장애는 요청 시점에 수집한 응답 정보와 함께 진단 카드로 남깁니다.
      </div>
    </div></body>`;
}
