/**
 * 판정 규칙 단위 테스트 — 운영 서버를 때리지 않고 규칙만 검증한다.
 *
 * 헬스체크 본체(ezlab.spec.ts)는 실제 사이트 상태에 따라 결과가 달라져서, 판정 로직이
 * 맞는지를 그걸로 확인할 수 없다. 특히 지금 운영에 떠 있는 결함(OG 이미지 403 등)이
 * 고쳐지면 '403을 잡는지'를 확인할 방법이 사라진다 → 규칙은 여기서 고정한다.
 *
 * 본체와 규칙이 갈라지지 않도록, 아래 구현은 ezlab.spec.ts의 판정부와 동일하게 유지해야 한다.
 * (본체에서 export 하려면 test 함수 밖으로 빼야 하는데, 그 리팩터링은 별도 작업으로 둔다)
 */
import { test, expect } from '@playwright/test';

// ── ezlab.spec.ts 와 동일한 판정 규칙 ───────────────────────────────
const AUTH_GATED: { url: RegExp; methods: string[] }[] = []; // 현재 면제 대상 없음 (실측 근거는 본체 주석)
const isAuthGated = (url: string, method = 'GET') =>
  AUTH_GATED.some(r => r.url.test(url) && r.methods.includes(method.toUpperCase()));

const httpIsFail = (status: number, url: string, method = 'GET') => {
  if (status === 0) return true;
  if (status === 401 || status === 403) return !isAuthGated(url, method);
  return status < 200 || status >= 400;
};

const isImageContentType = (ct: string) => /^image\//i.test(ct.split(';')[0].trim());

/** 능동 검증 응답 하나에 대한 이미지 판정 (본체 verifyImage 와 동일 규칙) */
function judgeImage(status: number, contentType: string, contentRange: string, bodyLen: number) {
  if (status !== 200 && status !== 206) return { ok: false, note: `HTTP ${status}` };
  if (!isImageContentType(contentType)) return { ok: false, note: `Content-Type 이상: ${contentType || '(없음)'}` };
  if (status === 206 && !/^bytes\s+\d+-\d+\/\d+/i.test(contentRange)) {
    return { ok: false, note: `206인데 Content-Range 이상: "${contentRange || '(없음)'}"` };
  }
  if (bodyLen === 0) return { ok: false, note: '본문 크기 0' };
  return { ok: true, note: '' };
}

/** 설치 파일 Range 프로브 판정 (본체 STEP4-1 과 동일 규칙) */
function judgeFileProbe(probe: { status: number; contentRange: string; bytes: number; note: string }) {
  const rangeOk = /^bytes\s+0-0\/\d+/i.test(probe.contentRange);
  if (probe.status === 206 && rangeOk && probe.bytes === 1) return { status: 206, pass: true };
  if (probe.status === 206) return { status: 0, pass: false };
  return { status: probe.status, pass: probe.status === 200 };
}

const B = 'https://ezlab.im';

test.describe('HTTP 상태 판정', () => {
  const cases: [number, string, string, boolean, string][] = [
    [200, `${B}/ko`,                'GET',  false, '정상'],
    [301, `${B}/ko`,                'GET',  false, '리다이렉트'],
    [307, `${B}/ko/point`,          'GET',  false, '로그인 리다이렉트'],
    [304, `${B}/ko`,                'GET',  false, '재검증'],
    [400, `${B}/ko/tool/x`,         'GET',  true,  '잘못된 요청'],
    [404, `${B}/ko/none`,           'GET',  true,  '없음'],
    [405, `${B}/api/tools/info`,    'GET',  true,  '메서드 불가'],
    [408, `${B}/ko`,                'GET',  true,  '요청 타임아웃'],
    [429, `${B}/ko`,                'GET',  true,  '레이트리밋'],
    [500, `${B}/ko`,                'GET',  true,  '서버 오류'],
    [503, `${B}/ko`,                'GET',  true,  '서비스 불가'],
    [0,   `${B}/ko`,                'GET',  true,  '응답 없음'],
    // 401/403 전역 면제를 없앤 뒤의 기대값 — 공개 경로의 인증 오류는 장애다.
    [403, `${B}/ko/tool/ezcapture`, 'GET',  true,  '공개 페이지 403'],
    [401, `${B}/ko`,                'GET',  true,  '공개 메인 401'],
    [200, `${B}/ko/login`,          'GET',  false, '로그인 페이지는 200이 정상'],
    [403, `${B}/ko/login`,          'GET',  true,  '로그인 페이지 403은 장애 (면제 대상 아님)'],
  ];
  for (const [status, url, method, expectFail, desc] of cases) {
    test(`${status} ${url.replace(B, '')} → ${expectFail ? 'FAIL' : 'PASS'} (${desc})`, () => {
      expect(httpIsFail(status, url, method)).toBe(expectFail);
    });
  }
});

test.describe('이미지 판정', () => {
  test('200 + image/png + 본문 있음 → 정상', () => {
    expect(judgeImage(200, 'image/png', '', 1024).ok).toBe(true);
  });
  test('200 + text/html → 실패 (오류 페이지를 200으로 주는 경우)', () => {
    expect(judgeImage(200, 'text/html; charset=utf-8', '', 500).ok).toBe(false);
  });
  test('200 + application/xml → 실패 (S3 AccessDenied 본문)', () => {
    expect(judgeImage(200, 'application/xml', '', 300).ok).toBe(false);
  });
  test('200 + image/png + 본문 0 → 실패', () => {
    expect(judgeImage(200, 'image/png', '', 0).ok).toBe(false);
  });
  test('206 + 유효한 Content-Range → 정상', () => {
    expect(judgeImage(206, 'image/png', 'bytes 0-0/12345', 1).ok).toBe(true);
  });
  test('206 + Content-Range 없음 → 실패', () => {
    expect(judgeImage(206, 'image/png', '', 1).ok).toBe(false);
  });
  test('403 → 실패', () => {
    expect(judgeImage(403, 'application/xml', '', 200).ok).toBe(false);
  });
  test('404 → 실패', () => {
    expect(judgeImage(404, 'text/html', '', 100).ok).toBe(false);
  });
});

test.describe('설치 파일 Range 프로브 판정', () => {
  test('206 + bytes 0-0/N + 1바이트 수신 → 정상', () => {
    expect(judgeFileProbe({ status: 206, contentRange: 'bytes 0-0/52428800', bytes: 1, note: '' }).pass).toBe(true);
  });
  test('206 + Content-Range 없음 → 실패', () => {
    expect(judgeFileProbe({ status: 206, contentRange: '', bytes: 1, note: '' }).pass).toBe(false);
  });
  test('206 + 수신 바이트 0 → 실패 (파일 존재를 확인한 게 아님)', () => {
    expect(judgeFileProbe({ status: 206, contentRange: 'bytes 0-0/52428800', bytes: 0, note: '' }).pass).toBe(false);
  });
  test('Range 무시하고 200 → 연결 중단 후 실패 취급 안 함(200은 존재 확인)', () => {
    expect(judgeFileProbe({ status: 200, contentRange: '', bytes: 0, note: 'Range 무시(전체 응답) — 연결 중단' }).pass).toBe(true);
  });
  test('206 + 2바이트 수신 → 실패 (서버가 Range를 지키지 않음)', () => {
    expect(judgeFileProbe({ status: 206, contentRange: 'bytes 0-0/52428800', bytes: 2, note: '' }).pass).toBe(false);
  });
  test('403 → 실패', () => {
    expect(judgeFileProbe({ status: 403, contentRange: '', bytes: 0, note: '' }).pass).toBe(false);
  });
});

test.describe('네트워크 실패 판정 (requestfailed)', () => {
  // 본체 REAL_NET_FAILURE_RE 와 동일하게 유지할 것
  const REAL_NET_FAILURE_RE = /ERR_(FAILED|NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|TIMED_OUT|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|CERT_[A-Z_]+|SSL_[A-Z_]+|EMPTY_RESPONSE|CONTENT_LENGTH_MISMATCH)/i;
  const isRealFailure = (err: string) => REAL_NET_FAILURE_RE.test(err);

  const cases: [string, boolean, string][] = [
    ['net::ERR_ABORTED',                false, '브라우저가 취소 — 장애 아님 (오탐 8건의 원인이었음)'],
    ['net::ERR_FAILED',                 true,  '우리가 막은 요청은 WeakSet에서 이미 걸러짐 → 실제 실패로 인정'],
    ['net::ERR_BLOCKED_BY_CLIENT',      false, '우리가 차단한 beacon'],
    ['net::ERR_NAME_NOT_RESOLVED',      true,  'DNS 실패'],
    ['net::ERR_CONNECTION_REFUSED',     true,  '연결 거부'],
    ['net::ERR_CONNECTION_RESET',       true,  '연결 리셋'],
    ['net::ERR_TIMED_OUT',              true,  '타임아웃'],
    ['net::ERR_CERT_DATE_INVALID',      true,  '인증서 오류'],
    ['net::ERR_EMPTY_RESPONSE',         true,  '빈 응답'],
    ['',                                false, '사유 없음 — 모르는 오류는 장애로 올리지 않음'],
  ];
  for (const [err, expected, desc] of cases) {
    test(`${err || '(빈 값)'} → ${expected ? '장애' : '무시'} (${desc})`, () => {
      expect(isRealFailure(err)).toBe(expected);
    });
  }
});

test.describe('장애 지문', () => {
  type Rec = { url: string; status: number; symptom: string; type: string };
  const errorClassOf = (r: Rec): string =>
    r.status === 0 ? 'TIMEOUT' :
    r.status >= 500 ? 'HTTP_5XX' :
    r.status === 429 ? 'HTTP_429' :
    r.status === 404 ? 'HTTP_404' :
    r.status >= 400 ? 'HTTP_4XX' :
    /누락 키워드|콘텐츠 이상|렌더 실패/.test(r.symptom) ? 'CONTENT' :
    /미감지/.test(r.symptom) ? 'UI_MISSING' :
    /이미지/.test(r.type) ? 'IMAGE' : 'OTHER';
  const fingerprintOf = (r: Rec): string => {
    let key = r.url;
    try { const u = new URL(r.url); key = u.hostname + u.pathname; } catch { /* 원본 유지 */ }
    return `${key}|${errorClassOf(r)}`;
  };

  test('쿼리가 달라도 같은 지문 (파라미터로 갈라지지 않는다)', () => {
    const a = fingerprintOf({ url: `${B}/ko/tool/ezcapture?a=1`, status: 500, symptom: '', type: 'UI' });
    const b = fingerprintOf({ url: `${B}/ko/tool/ezcapture?a=2`, status: 503, symptom: '', type: 'UI' });
    expect(a).toBe(b);
    expect(a).toBe('ezlab.im/ko/tool/ezcapture|HTTP_5XX');
  });
  test('같은 URL이라도 오류 계열이 다르면 다른 지문', () => {
    const a = fingerprintOf({ url: `${B}/ko`, status: 500, symptom: '', type: 'UI' });
    const b = fingerprintOf({ url: `${B}/ko`, status: 404, symptom: '', type: 'UI' });
    expect(a).not.toBe(b);
  });
  test('콘텐츠 누락은 CONTENT 계열', () => {
    expect(fingerprintOf({ url: `${B}/ko`, status: 200, symptom: '누락 키워드: 다운로드', type: '콘텐츠' }))
      .toBe('ezlab.im/ko|CONTENT');
  });
});

// ── 증거 수집 규칙 ─────────────────────────────────────────────────
// 본체 recordIssue()/ensureEvidence() 와 동일한 규칙을 고정한다.
// 실제 스크린샷 생성은 헬스체크 런에서 검증하고(리포트의 evidenceMissing),
// 여기서는 '어떤 기록에 증거가 필요한가 / 지문당 파일을 공유하는가'를 규칙으로 확인한다.
test.describe('증거 수집 규칙', () => {
  type Rec = { severity?: 'FAIL' | 'WARN' | 'INFO'; fingerprint: string; evidencePath?: string; evidenceError?: string };

  const needsEvidence = (r: Rec) => r.severity !== 'INFO';

  /** 지문당 1장을 공유하며 모든 대상 기록에 evidencePath 를 채운다 (ensureEvidence 규칙) */
  function ensure(records: Rec[], make: (fp: string) => string | null) {
    const cache = new Map<string, string>();
    for (const r of records) {
      if (!needsEvidence(r) || r.evidencePath) continue;
      const hit = cache.get(r.fingerprint);
      if (hit) { r.evidencePath = hit; continue; }
      const made = make(r.fingerprint);
      if (made) { r.evidencePath = made; cache.set(r.fingerprint, made); }
      else r.evidenceError = '증거 생성 실패 (스크린샷·진단 카드 모두 실패)';
    }
    return records;
  }

  test('FAIL·WARN 은 증거 대상, INFO 외부 링크는 제외', () => {
    expect(needsEvidence({ severity: 'FAIL', fingerprint: 'a' })).toBe(true);
    expect(needsEvidence({ severity: 'WARN', fingerprint: 'a' })).toBe(true);
    expect(needsEvidence({ severity: undefined, fingerprint: 'a' })).toBe(true); // 미지정 = FAIL
    expect(needsEvidence({ severity: 'INFO', fingerprint: 'a' })).toBe(false);
  });

  test('동일 지문 다중 언어 기록은 증거 파일 1장을 공유', () => {
    let made = 0;
    const recs: Rec[] = ['ko', 'en', 'jp', 'tw'].map(() => ({ severity: 'WARN' as const, fingerprint: 'cdn/og.png|HTTP_4XX' }));
    ensure(recs, fp => { made++; return `shot-${fp}.png`; });
    expect(made).toBe(1);                                    // 파일은 1장만 생성
    expect(recs.every(r => !!r.evidencePath)).toBe(true);     // 기록은 전부 증거를 가리킴
    expect(new Set(recs.map(r => r.evidencePath)).size).toBe(1);
  });

  test('서로 다른 지문은 각각 증거를 만든다', () => {
    const recs: Rec[] = [
      { severity: 'FAIL', fingerprint: 'a|HTTP_5XX' },
      { severity: 'WARN', fingerprint: 'b|HTTP_4XX' },
    ];
    let made = 0;
    ensure(recs, () => { made++; return `shot-${made}.png`; });
    expect(made).toBe(2);
  });

  test('이미 증거가 있으면 다시 만들지 않는다 (발견 즉시 촬영분 보존)', () => {
    const recs: Rec[] = [{ severity: 'FAIL', fingerprint: 'a|X', evidencePath: 'page-shot.png' }];
    let made = 0;
    ensure(recs, () => { made++; return 'diag.png'; });
    expect(made).toBe(0);
    expect(recs[0].evidencePath).toBe('page-shot.png');
  });

  test('증거 생성이 실패해도 중단하지 않고 evidenceError 를 남긴다', () => {
    const recs: Rec[] = [{ severity: 'FAIL', fingerprint: 'a|X' }];
    ensure(recs, () => null);
    expect(recs[0].evidencePath).toBeUndefined();
    expect(recs[0].evidenceError).toContain('증거 생성 실패');
  });

  test('보완 후 증거 없는 FAIL·WARN 이 0건', () => {
    const recs: Rec[] = [
      { severity: 'FAIL', fingerprint: 'api|HTTP_5XX' },
      { severity: 'WARN', fingerprint: 'img|HTTP_4XX' },
      { severity: 'WARN', fingerprint: 'img|HTTP_4XX' },
      { severity: 'INFO', fingerprint: 'ext|HTTP_5XX' },
    ];
    ensure(recs, fp => `shot-${fp}.png`);
    const missing = recs.filter(r => r.severity !== 'INFO' && !r.evidencePath);
    expect(missing).toHaveLength(0);
  });
});
