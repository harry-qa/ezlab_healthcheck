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

// ── 점검 완주(coverageComplete) 판정 ───────────────────────────────
// 본체는 truncatedSteps 가 비어 있을 때만 coverageComplete=true 로 내린다.
// 크롤 중단(crawlTruncated)은 예전에 WARN 기록만 남기고 truncatedSteps 에 들어가지 않아,
// 링크 전수조사가 통째로 잘려도 다른 STEP만 끝나면 완주로 보고되는 미탐이 있었다.
test.describe('점검 완주 판정', () => {
  const coverage = (skipped: string[]) => ({
    coverageComplete: skipped.length === 0,
    skippedSteps: skipped,
  });

  test('스킵된 STEP이 없으면 완주', () => {
    expect(coverage([]).coverageComplete).toBe(true);
  });

  test('크롤 중단은 미완주로 잡힌다 (기존 미탐)', () => {
    const c = coverage(['STEP3·크롤']);
    expect(c.coverageComplete).toBe(false);
    expect(c.skippedSteps).toContain('STEP3·크롤');
  });

  test('크롤만 잘리고 나머지 STEP이 전부 끝나도 완주가 아니다', () => {
    // on-1 에서 실제로 있었던 조합 — 크롤이 절대 7분에서 끊겼다
    expect(coverage(['STEP3·크롤']).coverageComplete).toBe(false);
  });

  // 크롤은 예산 초과 말고도 '링크를 다 못 본' 경로가 셋 있다.
  // 예전엔 렌더 실패·수집 예외가 WARN만 남기고, term 진입 실패는 WARN조차 없이 SKIP돼서
  // 실제로 링크를 놓쳤는데도 완주로 보고됐다.
  test.describe('크롤 불완전 경로', () => {
    const coverageOf = (truncated: boolean, incomplete: string[]) => {
      const steps: string[] = [];
      if (truncated) steps.push('STEP3·크롤');
      if (incomplete.length > 0) steps.push('STEP3·크롤불완전');
      return { coverageComplete: steps.length === 0, skippedSteps: steps };
    };

    test('진입점 렌더 실패 → 미완주', () => {
      expect(coverageOf(false, ['진입점렌더실패']).coverageComplete).toBe(false);
    });
    test('하위 페이지 렌더 실패 → 미완주', () => {
      expect(coverageOf(false, ['페이지렌더실패']).coverageComplete).toBe(false);
    });
    test('링크 수집 예외 → 미완주', () => {
      expect(coverageOf(false, ['링크수집예외']).coverageComplete).toBe(false);
    });
    test('term 페이지 진입 실패 → 미완주 (예전엔 조용히 SKIP)', () => {
      expect(coverageOf(false, ['term페이지진입실패']).coverageComplete).toBe(false);
    });
    test('예산 초과 없이 불완전 경로만 있어도 미완주', () => {
      const c = coverageOf(false, ['페이지렌더실패', 'term페이지진입실패']);
      expect(c.coverageComplete).toBe(false);
      expect(c.skippedSteps).toEqual(['STEP3·크롤불완전']);
    });
    test('예산 초과와 불완전이 함께면 둘 다 기록', () => {
      const c = coverageOf(true, ['링크수집예외']);
      expect(c.skippedSteps).toEqual(['STEP3·크롤', 'STEP3·크롤불완전']);
    });
    test('둘 다 없으면 완주', () => {
      expect(coverageOf(false, []).coverageComplete).toBe(true);
    });
  });

  test('예산 초과 STEP과 크롤 중단이 함께 기록된다', () => {
    const c = coverage(['STEP3·크롤', 'STEP7·로그인', 'STEP8·이지다운', 'STEP9·인증서']);
    expect(c.coverageComplete).toBe(false);
    expect(c.skippedSteps).toHaveLength(4);
  });
});

// ── STEP2 API 관측자 (순수 관측) ───────────────────────────────────
// 관측자가 기존 판정 저장소(apiRecords)를 건드리지 않는지, 언어 매핑·중복 정산 방어가
// 동작하는지를 fixture 로 검증한다. 운영 실행 결과는 네트워크 변동이 있어 하드 게이트로 쓰지 않는다.
test.describe('STEP2 API 관측자', () => {
  type Req = { url: string; method: string; type: string };
  const OWN = /^(([a-z0-9-]+\.)*ezlab\.im)$/i;

  function makeObserver() {
    const obs = new Map<string, { requests: number; responses: number; failed: number; endpoints: Set<string> }>();
    const reqLang = new Map<Req, string>();
    const of = (l: string) => {
      let o = obs.get(l);
      if (!o) { o = { requests: 0, responses: 0, failed: 0, endpoints: new Set() }; obs.set(l, o); }
      return o;
    };
    let currentLang = '';
    const isOwnApi = (r: Req) => {
      if (r.type !== 'xhr' && r.type !== 'fetch') return false;
      try { return OWN.test(new URL(r.url).hostname); } catch { return false; }
    };
    return {
      setLang: (l: string) => { currentLang = l; },
      onRequest(r: Req) {
        if (!currentLang || !isOwnApi(r)) return;
        reqLang.set(r, currentLang);
        const o = of(currentLang);
        o.requests++;
        o.endpoints.add(`${r.method} ${r.url.split('?')[0]}`);
      },
      settle(r: Req, kind: 'res' | 'fail') {
        const l = reqLang.get(r);
        if (l === undefined) return;        // 중복 정산 방어
        reqLang.delete(r);
        const o = of(l);
        if (kind === 'res') o.responses++; else o.failed++;
      },
      inFlight: (l: string) => [...reqLang.values()].filter(x => x === l).length,
      get: (l: string) => of(l),
    };
  }

  const api = (url: string, method = 'GET'): Req => ({ url, method, type: 'xhr' });

  test('요청 시작 시점의 언어로 집계된다 (늦은 응답이 다음 언어로 새지 않음)', () => {
    const ob = makeObserver();
    ob.setLang('ko');
    const r = api('https://ezlab.im/api/tools/info?locale=ko');
    ob.onRequest(r);
    ob.setLang('en');                        // 다음 언어로 넘어간 뒤
    ob.settle(r, 'res');                     // ko 요청의 응답이 도착
    expect(ob.get('ko').responses).toBe(1);
    expect(ob.get('en').responses).toBe(0);
  });

  test('같은 요청이 response·requestfailed 로 두 번 와도 한 번만 정산된다', () => {
    const ob = makeObserver();
    ob.setLang('ko');
    const r = api('https://ezlab.im/api/auth/me');
    ob.onRequest(r);
    ob.settle(r, 'res');
    ob.settle(r, 'fail');                    // 두 번째는 무시돼야 한다
    expect(ob.get('ko').responses).toBe(1);
    expect(ob.get('ko').failed).toBe(0);
  });

  test('requestfailed 도 inFlight 를 정상 정리한다', () => {
    const ob = makeObserver();
    ob.setLang('ko');
    const r = api('https://ezlab.im/api/x');
    ob.onRequest(r);
    expect(ob.inFlight('ko')).toBe(1);
    ob.settle(r, 'fail');
    expect(ob.inFlight('ko')).toBe(0);
    expect(ob.get('ko').failed).toBe(1);
  });

  test('제3자 XHR·이미지·스크립트는 무시된다', () => {
    const ob = makeObserver();
    ob.setLang('ko');
    ob.onRequest({ url: 'https://google-analytics.com/g/collect', method: 'POST', type: 'xhr' });
    ob.onRequest({ url: 'https://ezlab.im/logo.png', method: 'GET', type: 'image' });
    ob.onRequest({ url: 'https://ezlab.im/app.js', method: 'GET', type: 'script' });
    expect(ob.get('ko').requests).toBe(0);
  });

  test('엔드포인트는 METHOD + 쿼리 제거 URL 로 집계되고 상한이 없다', () => {
    const ob = makeObserver();
    ob.setLang('ko');
    for (let i = 0; i < 60; i++) ob.onRequest(api(`https://ezlab.im/api/e${i}?v=${i}`));
    ob.onRequest(api('https://ezlab.im/api/e0?v=other'));   // 같은 엔드포인트, 다른 쿼리
    ob.onRequest(api('https://ezlab.im/api/e0', 'POST'));   // 같은 URL, 다른 메서드
    expect(ob.get('ko').requests).toBe(62);
    expect(ob.get('ko').endpoints.size).toBe(61);           // 60 + POST 1, 40개 상한 없음
  });

  test('언어가 바뀐 뒤 늦게 정산된 응답은 원래 언어의 navigation 기준으로 시각을 잰다', () => {
    // 전역 기준을 쓰면 다음 언어의 navigation 시각으로 계산돼 값이 무의미해진다.
    type Obs = { navStartedAt: number; lastSettledMs: number | null };
    const obs: Record<string, Obs> = {
      ko: { navStartedAt: 1000, lastSettledMs: null },
      en: { navStartedAt: 9000, lastSettledMs: null },   // ko보다 8초 뒤에 시작
    };
    const reqLang = new Map<string, string>();
    const relTo = (o: Obs, now: number) => (o.navStartedAt ? now - o.navStartedAt : 0);

    reqLang.set('req-ko-1', 'ko');           // ko 구간에서 시작한 요청
    const settleAt = 12000;                  // en 구간으로 넘어간 뒤 도착
    const lang = reqLang.get('req-ko-1')!;
    obs[lang].lastSettledMs = relTo(obs[lang], settleAt);

    expect(lang).toBe('ko');
    expect(obs.ko.lastSettledMs).toBe(11000); // ko 기준 11초 — 전역(en) 기준이면 3000이 됐을 값
    expect(obs.en.lastSettledMs).toBeNull();
  });

  test('networkIdle 대기가 실행되지 않으면 resolved 로 남지 않는다', () => {
    // 진입 실패로 대기 자체가 안 돌면 not-run 이어야 한다 — resolved 로 두면 '정상 완료'로 오독된다.
    const initial: 'not-run' | 'resolved' | 'timeout' | 'error' = 'not-run';
    expect(initial).toBe('not-run');
    const outcomes = {
      성공:   'resolved',
      타임아웃: /Timeout/i.test('Timeout 8000ms exceeded') ? 'timeout' : 'error',
      기타오류: /Timeout/i.test('Target closed') ? 'timeout' : 'error',
    };
    expect(outcomes.성공).toBe('resolved');
    expect(outcomes.타임아웃).toBe('timeout');
    expect(outcomes.기타오류).toBe('error');
  });

  test('관측자는 판정 저장소(apiRecords)를 변경하지 않는다', () => {
    const apiRecords = [{ url: 'https://ezlab.im/api/auth/me', status: 200 }];
    const before = JSON.stringify(apiRecords);
    const ob = makeObserver();
    ob.setLang('ko');
    const r = api('https://ezlab.im/api/auth/me');
    ob.onRequest(r);
    ob.settle(r, 'res');
    expect(JSON.stringify(apiRecords)).toBe(before);        // 관측은 순수 — 저장소 불변
    expect(ob.get('ko').requests).toBe(1);
  });
});

// ── 제품 배포 플랫폼 정책 ──────────────────────────────────────────
// 모바일 전용 제품은 데스크톱 설치 파일·다운로드 버튼 검증 대상이 아니다.
// '실패'가 아니라 '검사 대상 아님'이므로 PASS 로 올리지 않고 SKIP 으로만 남긴다.
// HTTP 403 이나 .exe 확장자 같은 증상으로 일괄 무시하면 진짜 장애까지 가려지므로
// 반드시 제품 단위 정책으로만 분기한다.
test.describe('제품 배포 플랫폼 정책', () => {
  const MOBILE_ONLY = [
    { pattern: /\/tool\/ezdown(\/|$)/i, product: '이지다운',
      reason: '모바일 전용 앱(Google Play 배포) — 데스크톱 설치 파일·다운로드 버튼 검증 대상 아님' },
  ];
  const mobileOnly = (url: string) => MOBILE_ONLY.find(p => p.pattern.test(url));

  /** 설치 파일 검증 결과 등급 (STEP4-1) */
  const gradeInstaller = (url: string, status: number): 'PASS' | 'FAIL' | 'SKIP' => {
    if (mobileOnly(url)) return 'SKIP';               // 검사 자체를 하지 않는다
    return (status === 200 || status === 206) ? 'PASS' : 'FAIL';
  };
  /** 다운로드 버튼 검사 결과 등급 (STEP4) */
  const gradeButton = (url: string, pageStatus: number, hasButton: boolean): 'PASS' | 'WARN' | 'FAIL' | 'SKIP' => {
    if (pageStatus !== 200) return 'FAIL';            // 페이지 생존 검사는 정책과 무관하게 유지
    if (mobileOnly(url)) return 'SKIP';
    return hasButton ? 'PASS' : 'WARN';
  };

  const C = 'https://cdn.ezlab.im/tool';
  const P = 'https://ezlab.im/ko/tool';

  test('이지다운의 .exe 403 → FAIL 아님, 정책 SKIP', () => {
    expect(gradeInstaller(`${C}/ezdown/ezDown_Setup_home.exe`, 403)).toBe('SKIP');
    expect(gradeInstaller(`${C}/ezdown/ezDown_Setup_home.exe`, 403)).not.toBe('FAIL');
  });

  test('이지다운 다운로드 버튼 없음 → WARN 아님, 정책 SKIP', () => {
    expect(gradeButton(`${P}/ezdown`, 200, false)).toBe('SKIP');
    expect(gradeButton(`${P}/ezdown`, 200, false)).not.toBe('WARN');
  });

  test('다른 데스크톱 제품의 .exe 403 → 기존대로 FAIL', () => {
    expect(gradeInstaller(`${C}/ezcapture/ezCapture_Setup_home.exe`, 403)).toBe('FAIL');
    expect(gradeInstaller(`${C}/ezzip/ezZip_Setup_home.exe`, 403)).toBe('FAIL');
    expect(gradeButton(`${P}/ezcapture`, 200, false)).toBe('WARN');
  });

  test('정책은 제품 경로로만 판별 — 확장자·상태코드로 일괄 무시하지 않는다', () => {
    // 다른 제품 경로에 이지다운 파일명이 있어도 FAIL
    expect(gradeInstaller(`${C}/ezcapture/ezDown_Setup_home.exe`, 403)).toBe('FAIL');
  });

  test('이지다운도 페이지 생존 검사는 유지된다', () => {
    expect(gradeButton(`${P}/ezdown`, 500, false)).toBe('FAIL');
    expect(gradeButton(`${P}/ezdown`, 0, false)).toBe('FAIL');
  });
});
