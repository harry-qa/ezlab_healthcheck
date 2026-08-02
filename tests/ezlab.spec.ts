import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as tls from 'tls';
import * as crypto from 'crypto';
import {
  diagnosticCardHtml,
  makeResponseBodySnippet,
  selectDiagnosticHeaders,
  type DiagnosticRecord,
} from './evidence';
import {
  LOCATOR_ATTRIBUTE_TIMEOUT_MS,
  attributeReadFailureImpact,
  readLocatorAttribute,
} from './locator-guard';

const SCREENSHOT_DIR = 'test-results/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// 서버 첫 응답 시간(TTFB) 측정 — 응답 헤더(첫 바이트) 수신까지만 재고 본문 다운로드는 제외한다.
// (기존 request.get 방식은 본문 300KB까지 다 받는 시간을 재서, 미국 러너에선 본문 다운로드 탓에
//  서버가 멀쩡해도 500ms를 넘겼다. TTFB는 서버 처리 체감에 훨씬 가깝다.)
// keepAlive 에이전트로 연결을 재사용 → 워밍업 1회 후엔 DNS/TLS 핸드셰이크 비용 없이 순수 응답만 본다.
function measureTTFB(
  url: string,
  headers: Record<string, string>,
  agent: https.Agent,
  timeoutMs = 20000,
): Promise<{ status: number; ttfb: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { headers, agent }, (res) => {
      const ttfb = Date.now() - start;          // 응답 헤더 수신 시점 = TTFB
      res.resume();                              // 본문은 버리되 소켓은 비워 keep-alive 재사용 유지
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ttfb }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// 설치 파일 존재 확인 — 본문을 받지 않고 헤더 시점에 판정하고 끊는다.
// page.request.get()은 응답 본문을 전부 버퍼링하므로, 서버가 Range를 무시하고 200을 주면
// 설치 파일 전체(수십~수백 MB)를 매 런 내려받게 된다. 그래서 raw https로 스트리밍 요청을 열고
// 206이 아니면 즉시 소켓을 파기한다. 206이어도 1바이트를 넘게 흘러들면 방어적으로 끊는다.
function probeFileRange(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000,
): Promise<{ status: number; contentRange: string; bytes: number; note: string }> {
  return new Promise(resolve => {
    let settled = false;
    const done = (r: { status: number; contentRange: string; bytes: number; note: string }) => {
      if (!settled) { settled = true; resolve(r); }
    };
    const req = https.get(url, { headers: { ...headers, Range: 'bytes=0-0' } }, res => {
      const status = res.statusCode ?? 0;
      const contentRange = String(res.headers['content-range'] ?? '');
      if (status !== 206) {
        // Range 무시(200) 또는 오류 — 본문을 받기 전에 끊는다. 전체 다운로드 방지의 핵심.
        req.destroy();
        done({ status, contentRange, bytes: 0, note: status === 200 ? 'Range 무시(전체 응답) — 연결 중단' : '' });
        return;
      }
      let bytes = 0;
      res.on('data', (c: Buffer) => { bytes += c.length; if (bytes > 4096) req.destroy(); });
      res.on('end',   () => done({ status, contentRange, bytes, note: '' }));
      res.on('error', () => done({ status, contentRange, bytes, note: '' }));
    });
    req.on('error', () => done({ status: 0, contentRange: '', bytes: 0, note: '연결 실패' }));
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ status: 0, contentRange: '', bytes: 0, note: '타임아웃' }); });
  });
}

// SSL 인증서 만료일까지 남은 일수를 잰다. TLS 핸드셰이크로 서버 인증서만 읽고 즉시 끊는다.
// 만료되면 전 서비스가 한 번에 죽으므로, 만료 전에 미리 경고(WARN)/장애(FAIL)로 띄우기 위함.
function checkCertExpiry(
  host: string,
  port = 443,
  timeoutMs = 10000,
): Promise<{ daysLeft: number; validTo: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) { reject(new Error('인증서 정보 없음')); return; }
      const validTo  = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
      resolve({ daysLeft, validTo: cert.valid_to });
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
  });
}

// (제거됨) afterEach 전체화면 캡처 — STEP이 전부 하나의 test라 '실패 스텝'이 아니라 런 종료 시점의
// 마지막 화면만 찍혔다. 실패 순간 화면은 각 STEP의 captureShot()이 이미 남기므로 중복이고,
// 원인 파악에 쓰이지 않으면서 아티팩트 용량만 차지해 걷어낸다.

// request 픽스처는 더 이상 쓰지 않는다 — 자사 요청은 식별 헤더가 붙은 page.request로 통일했다.
test('이지랩 서비스 통합 점검 (서버 / API / UI)', async ({ page }) => {
  // 전체 하드 타임아웃. 재시도 예산은 이 값이 아니라 REPORT_SAFETY_MS(510s)를 기준으로 잰다 —
  // 510~600s 구간은 증거 생성·리포트 저장 여유로 남긴다.
  test.setTimeout(600000);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  const baseUrl = 'https://ezlab.im';

  // ── 자사 도메인 판별 ────────────────────────────────────────────
  // 헬스체크 식별 헤더·비콘 차단·장애 점수 반영 여부가 모두 이 기준을 쓴다.
  // 제3자 도메인에는 식별 헤더를 보내지 않는다(우리 CI 존재를 남의 서버 로그에 남기지 않기 위함).
  const OWN_HOST_RE = /^(([a-z0-9-]+\.)*ezlab\.im|([a-z0-9-]+\.)*ezdown\.kr)$/i;
  const isOwnHost = (u: string) => { try { return OWN_HOST_RE.test(new URL(u).hostname); } catch { return false; } };

  // ── 헬스체크 요청 식별 ──────────────────────────────────────────
  // 서버 로그·APM에서 실사용자 트래픽과 헬스체크를 분리할 수 있게 한다.
  // UA는 실제 렌더 결과를 얻기 위해 Chrome으로 유지하고(봇 차단 회피), 식별은 커스텀 헤더로만 한다.
  const RUN_ID = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
    : `local-${Date.now()}`;
  // 요청에는 '상수' 헤더 하나만 보낸다. 런마다 바뀌는 실행 ID를 헤더로 실으면,
  // CloudFront 캐시 키에 요청 헤더가 포함된 설정일 경우 30분마다 캐시가 새로 갈려
  // 오리진 부하를 오히려 키운다(현재 ezlab.im의 Cache Policy가 미확정이라 위험을 감수하지 않는다).
  // 실행 ID는 report-status.json의 runId 로만 남기고, 서버 로그와는 시각으로 대조한다.
  const HC_HEADERS = { 'X-Ezlab-Healthcheck': '1' };
  // 자사 요청 전용 헤더 — 외부 링크 검증에는 headers(기본)만 쓴다.
  const ownHeaders = { ...headers, ...HC_HEADERS };
  const headersFor = (url: string) => (isOwnHost(url) ? ownHeaders : headers);

  // ── 분석·광고 수집(beacon) 차단 ─────────────────────────────────
  // 렌더 1회마다 GA4 수집·광고 전환 요청이 나가 통계가 오염된다(48런/일 × 렌더 94회).
  // GitHub 러너는 IP가 유동적이라 GA4 내부 트래픽 필터(IP 기반)로는 걸러낼 수 없다 → 발신을 막는다.
  // 1단계로 '수집 엔드포인트'만 막고 렌더에 관여하는 로더(gtag.js/gtm.js)와 SDK는 통과시킨다.
  // page.route는 page.request를 가로채지 않으므로 외부 링크 검증(STEP3)에는 영향이 없다.
  const BEACON_RE = /(google-analytics\.com|analytics\.google\.com|\/g\/collect|\/collect\?|\/ccm\/collect|doubleclick\.net|googlesyndication\.com\/pagead|googleads\.g\.doubleclick|onetag\.co\.kr\/(log|collect|track))/i;
  // 우리가 의도적으로 끊은 요청 — requestfailed에서 실제 장애와 구분한다.
  // URL Set이 아니라 Request 객체로 기록한다: 같은 URL이 나중에 실제로 실패했을 때 그걸
  // '우리가 막은 것'으로 오인하지 않기 위함. route.abort()의 errorText는 ERR_FAILED/ERR_ABORTED가
  // 섞여 나와(실측 확인) 문자열로는 구분할 수 없다.
  const intentionalAborts = new WeakSet<object>();
  let blockedBeacons = 0;

  // 네트워크 정책 토글 — 끄면 page.route 를 걸지 않는다.
  // page.route 를 걸면 Playwright의 HTTP 캐시가 꺼지므로(문서 명시), 정책 적용 전후의 요청량을
  // '같은 러너에서 연속 실행'해 비교할 수 있어야 한다 → 끄고 켤 수 있게 해 둔다.
  // 기본은 on. A/B 측정과, 운영에서 문제가 생겼을 때의 비상 해제용이다.
  //
  // off 로 꺼지는 것은 '브라우저 라우팅으로 붙이던 헤더'와 'beacon 차단'뿐이다.
  // page.request 계열(링크·이미지·API·파일 검증)은 라우팅을 타지 않으므로 off 에서도
  // ownHeaders(식별 헤더 포함)를 그대로 쓴다 — '식별 헤더 전체 해제'가 아니다.
  const NET_POLICY_ON = (process.env.HC_NET_POLICY ?? 'on') !== 'off';

  // A/B 비교용 요청 계측 — 이벤트 리스너는 수동 관찰이라 캐시에 영향을 주지 않는다(라우팅과 다름).
  // 세는 대상은 '브라우저가 낸 요청'뿐이다. page.request(링크·이미지·API·파일 Range),
  // measureTTFB(raw https), checkCertExpiry(TLS)는 브라우저를 거치지 않아 포함되지 않는다.
  // 리포트 필드명이 own/third 라 오해하기 쉬워 여기 명시한다.
  let reqOwn = 0;
  let reqThird = 0;
  page.on('request', r => { isOwnHost(r.url()) ? reqOwn++ : reqThird++; });

  // requestfailed 중 '진짜 네트워크 실패'만 장애로 본다.
  // 우리가 끊은 요청은 앞단에서 WeakSet<Request>로 이미 걸러지므로, 여기 남는 것은 브라우저가
  // 취소했거나 실제로 실패한 요청뿐이다.
  //   ERR_ABORTED : 페이지 이동·레이아웃 변경에 따른 브라우저 자체 취소 → 장애 아님
  //                 (이 필터가 없을 때 _next/image 프록시에서 실행 타이밍에 따라 오탐 8건 발생)
  //   ERR_FAILED  : 일반 실패. route.abort() 기본값과 문자열이 같지만 그건 위에서 걸러졌으므로,
  //                 여기까지 온 ERR_FAILED 는 실제 실패로 본다(미탐 방지).
  // 차단 목록이 아니라 허용 목록으로 둔다 — 모르는 오류를 장애로 올리지 않기 위함.
  const REAL_NET_FAILURE_RE = /ERR_(FAILED|NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|TIMED_OUT|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|CERT_[A-Z_]+|SSL_[A-Z_]+|EMPTY_RESPONSE|CONTENT_LENGTH_MISMATCH)/i;
  // 200 응답 '원문(res.text())'에서 잡아내는 실제 점검/장애 페이지 신호만 유지.
  // 주의: Next.js는 i18n 에러 템플릿("일시적인 오류가 발생했습니다" 등)을 정상 페이지
  // 번들에도 실어 보내므로, 일반 오류 문구를 키워드로 넣으면 전 페이지가 오탐 FAIL 난다.
  // → 점검 페이지에서만 나타나는 문구로 한정. (404/500은 HTTP status 검사에서 이미 처리)
  const errorKeywords = ['점검중', '서비스 준비중'];
  const languages = ['ko', 'en', 'jp', 'tw'];
  const visitedUrls = new Set<string>();
  // 이미지는 링크와 별도 집계 — 같은 Set에 넣으면 '페이지/링크 N개'에 이미지 수백 개가 섞여
  // 점검 범위 수치가 실제 페이지 수를 뜻하지 않게 된다. (ezlab / ezdown 이미지 공통 사용)
  const checkedImageUrls = new Set<string>();

  // ── 서비스 도구 페이지 (STEP 3 크롤링에서 자동 수집) ────────────
  // ── 제품 배포 플랫폼 정책 ────────────────────────────────────────
  // 웹 헬스체크는 데스크톱 설치 파일과 다운로드 버튼을 검증한다. 모바일 전용 제품에는
  // 애초에 해당 검사가 성립하지 않으므로 '실패'가 아니라 '검사 대상 아님'이다.
  // HTTP 403 이나 .exe 확장자 같은 '증상'으로 일괄 무시하면 진짜 장애까지 가려지므로,
  // 반드시 제품 단위 정책으로만 분기한다. 여기 없는 제품은 전부 데스크톱으로 본다.
  const MOBILE_ONLY_PRODUCTS: { pattern: RegExp; product: string; reason: string }[] = [
    {
      pattern: /\/tool\/ezdown(\/|$)/i,
      product: '이지다운',
      reason: '모바일 전용 앱(Google Play 배포) — 데스크톱 설치 파일·다운로드 버튼 검증 대상 아님',
    },
  ];
  const mobileOnly = (url: string) => MOBILE_ONLY_PRODUCTS.find(p => p.pattern.test(url));
  // 정책으로 건너뛴 항목 — PASS 로 올리지 않고 별도로 남긴다(스코어·판정에 영향 없음).
  const policySkips: { step: string; product: string; url: string; reason: string }[] = [];
  const recordPolicySkip = (step: string, product: string, url: string, reason: string) => {
    policySkips.push({ step, product, url, reason });
    console.log(`[SKIP][${step}][${product}] ${reason} — ${url}`);
  };

  const discoveredToolUrls = new Set<string>();
  // STEP5(메인 페이지 방문)에서 수집한 도구 URL — STEP4가 크롤에 의존하지 않게 하는 근거.
  // 크롤이 나중에 추가로 발견하면 그건 STEP5가 놓친 것이므로 커버리지 누락으로 기록한다.
  const toolUrlsFromMain = new Set<string>();
  const TOOL_URL_RE = /\/(ko|en|jp|tw)\/tool\/[^/?#]+\/?($|[?#])/;

  // 변경 전후 비교용 계측
  const stepTimings: { step: string; ms: number }[] = [];
  // STEP 경계에 시각만 찍고 마지막에 구간을 계산한다 — test.step 구조를 감싸지 않아 안전하다.
  const stepMarks: { step: string; at: number }[] = [];
  const stepMark = (name: string) => stepMarks.push({ step: name, at: Date.now() });
  // linksChecked 는 '고유 요청 수'가 아니라 checkUrl 호출 횟수다(중복 URL은 checkUrl 내부에서 스킵).
  // budgetMs 는 값이 채워지지 않아 항상 0이었으므로 필드 자체를 뺀다 — 잘못된 값보다 없는 편이 낫다.
  const crawlStats = { pagesCompleted: 0, linksChecked: 0, truncated: false, incomplete: [] as string[] };
  const step4Stats = { discoveredFromMain: 0, discoveredFromCrawl: 0, verified: 0, skipped: 0,
                       languagesFound: [] as string[], languagesMissing: [] as string[] };

  // ── 언어별 핵심 콘텐츠 키워드 ───────────────────────────────────
  // 실제 페이지 기준으로 확인된 키워드만 사용
  const contentKeywords: Record<string, string[]> = {
    ko: ['다운로드', '이지캡쳐', '이지집'],
    en: ['download', 'ezcapture', 'ezzip'],
    jp: ['ダウンロード', 'ezcapture', 'ezzip'],  // toLowerCase() 비교 기준으로 소문자 통일
    tw: ['下載', 'ezcapture', 'ezzip'],
  };

  // url: 쿼리 제거(중복 판정·표시용) / fetchUrl: 쿼리 포함 원본(재확인 요청용).
  // 재확인을 url(쿼리 제거)로 보내면 파라미터 필수 API가 다른 응답(400/302 등)을 주고,
  // 그게 apiIsFail이 아니라서 실제 500 장애가 '회복'으로 은폐된다 → 원본 URL로 재확인한다.
  type ApiRecord  = { url: string; fetchUrl: string; method: string; status: number; time: number; note: string };
  // severity 미지정(undefined)은 FAIL로 간주 — WARN 성격의 기록에만 'WARN'을 명시한다.
  // (Slack 장애 알림이 WARN 항목을 섞어 나열하던 문제 해결: report-status.json 소비 측에서 필터)
  // INFO = 기록은 남기되 런 상태·헬스 스코어에 반영하지 않는 정보성 등급(SLOW와 동일 취급).
  // 이지랩이 소유·수정할 수 없는 제3자 자원(외부 링크)이 여기 해당한다 — 남의 서버 장애로 우리 점수를 깎지 않는다.
  type FailRecord = DiagnosticRecord & {
    fingerprint?: string;
    // 재시도 대상(5xx·응답없음)이었지만 예산 게이트에 걸려 재시도 없이 최초 실패로 확정된 기록.
    retrySkipped?: 'budget';
    // 증거 — 모든 FAIL·WARN에 evidencePath 가 있어야 한다(INFO 외부 링크는 예외).
    evidenceType?: 'page' | 'element' | 'diagnostic';
    evidencePath?: string;
    evidenceError?: string;
  };

  // ── 장애 지문 ───────────────────────────────────────────────────
  // Slack·이슈 생성은 '연속 2런 FAIL'로 판정하는데, 그러면 서로 무관한 단발 오류 두 개가
  // 하나의 장애로 묶여 알림이 나간다. URL 경로 + 오류 계열로 지문을 만들어 리포트에 남기면
  // 소비 측(notify_slack)이 '같은 장애가 이어졌는지'를 구분할 수 있다.
  // 쿼리는 제외한다 — 같은 장애가 파라미터만 달라 다른 지문으로 갈라지는 것을 막는다.
  function errorClassOf(r: FailRecord): string {
    if (r.status === 0)   return 'TIMEOUT';
    if (r.status >= 500)  return 'HTTP_5XX';
    if (r.status === 429) return 'HTTP_429';
    if (r.status === 404) return 'HTTP_404';
    if (r.status >= 400)  return 'HTTP_4XX';
    if (/누락 키워드|콘텐츠 이상|렌더 실패/.test(r.symptom)) return 'CONTENT';
    if (/미감지/.test(r.symptom))                          return 'UI_MISSING';
    if (/이미지/.test(r.type))                             return 'IMAGE';
    return 'OTHER';
  }
  function fingerprintOf(r: FailRecord): string {
    let key = r.url;
    try { const u = new URL(r.url); key = u.hostname + u.pathname; } catch { /* 파싱 실패 시 원본 */ }
    return `${key}|${errorClassOf(r)}`;
  }

  // STEP2 대기가 API를 자르는지 확인하기 위한 순수 관측 기록 (판정에 쓰지 않는다)
  type ApiObservation = {
    lang: string;
    requests: number; responses: number; failed: number;
    endpoints: string[];                 // 'METHOD 정규화URL' 전체 집합 (상한 없음)
    firstRequestMs: number | null;       // 모든 시각은 navigationStartedAt 기준
    lastRequestMs: number | null;
    lastSettledMs: number | null;
    inFlightAtWaitEnd: number;           // 대기 종료 '시점'에 고정
    networkIdle: 'not-run' | 'resolved' | 'timeout' | 'error';  // 대기가 실행되지 않으면 not-run
    gotoMs: number; networkIdleWaitMs: number; settleWaitMs: number; totalMs: number;
    navStartedAt: number;                // 이 언어의 navigation 시작 시각 (상대 시각 계산 기준)
  };
  let apiObservation: ApiObservation[] = [];

  const apiRecords: ApiRecord[]  = [];
  const failRecords: FailRecord[] = [];
  // SSL 인증서 스냅샷 — PASS 포함 전 호스트를 담아 report-status.json에 저장한다.
  // (기존엔 WARN/FAIL만 failRecords에 남겨, 정상일 땐 만료일이 리포트에 안 실려 대시보드가 못 그렸다)
  type CertRecord = { host: string; daysLeft: number | null; validTo: string; status: 'PASS' | 'WARN' | 'FAIL' | 'ERROR' };
  const certResults: CertRecord[] = [];

  // ── KST 타임스탬프 헬퍼 ─────────────────────────────────────────
  function kstNow() {
    return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  }

  // ── 결과 카운터 (배지용) ────────────────────────────────────────
  const testStartTime = Date.now();
  // 크롤은 실행 순서상 마지막이라 '남은 예산 전부'를 쓴다. 별도 마감 상수를 두지 않고
  // 전체 안전 예산(REPORT_SAFETY_MS)에서 끝낸다 — 핵심 검사는 이미 앞에서 끝나 있다.
  const REPORT_SAFETY_MS  = 8.5 * 60 * 1000; // 이 시점을 넘기면 '신규' 반복 항목을 스킵

  // 전체 test 타임아웃(10분)에 걸리면 report-status.json이 아예 안 써지고 런이 UNKNOWN으로 잡혀
  // Slack 알림까지 나간다 — 사이트는 멀쩡한데 헬스체크가 스스로 장애를 만드는 셈이다.
  // 주의: 이 가드는 '새 작업의 시작'만 막을 뿐 진행 중인 await를 중단하지 못하므로
  // 실행시간 상한도, 리포트 저장도 보장하지 않는다(멈춘 await 하나가 전체 타임아웃까지 끌고 갈 수 있다).
  // 재시도가 이 예산을 넘겨 이어지지 않게 하는 것은 별도 게이트(retryBudgetOk)가 맡는다.
  const outOfBudget = () => Date.now() - testStartTime > REPORT_SAFETY_MS;

  // 예산 초과로 스킵된 STEP을 기록한다. 예산 가드는 UNKNOWN 오탐(전체 타임아웃)은 막지만,
  // 그 대가로 남은 검사를 '조용히' 건너뛴다 — 특히 마지막 STEP9(인증서)가 안 돌아도 리포트는
  // 초록/부분으로 보여 미탐이 된다. 크롤 truncated와 동일하게, 축소가 있었다면 마지막에 WARN 1건을 남긴다.
  const truncatedSteps = new Set<string>();
  const budgetHit = (step: string) => {
    if (!outOfBudget()) return false;
    truncatedSteps.add(step);
    return true;
  };

  // ── 응답 시간 임계값 ────────────────────────────────────────────
  // 관측 근거: 정상 응답은 TTFB 0.14~0.23s, 오리진 간헐 실패는 10.5s 뒤 404.
  // 기존 요청 타임아웃 8s는 그 10.5s보다 짧아, '느린 응답'이 '접속 불가' FAIL로 둔갑했다.
  // → 타임아웃을 12s로 올려 실패 지연을 끝까지 관측하고, 3~12s 구간은 SLOW(정보성)로 흡수한다.
  const REQUEST_TIMEOUT_MS = 12000; // 이 이상 걸리면 응답 없음으로 간주 (FAIL)
  const SLOW_MS            = 3000;  // 이 이상이면 SLOW — 정보성, 런 상태·스코어 미반영
  const VERY_SLOW_MS       = 8000;  // 이 이상이면 SLOW 중에서도 별도 표기 (장애 전조 가시화용)

  // 간헐 실패 후 재시도로 회복한 항목 — 개별 기록은 INFO(정보성)로 남기고 런 상태·스코어에 반영하지 않는다.
  // 한 런에서 '서로 다른 정규화 지문'이 이 개수 이상 회복될 때만 '오리진 불안정' 종합 WARN 1건으로 승격한다.
  // 건수가 아니라 지문 기준인 이유: 같은 경로의 blip 하나가 4개 언어에서 반복 회복되면 건수로는
  // 임계치를 넘기지만 실제로 흔들린 경로는 하나다 — 서로 다른 경로가 같이 흔들릴 때만 오리진 신호로 본다.
  const INTERMITTENT_WARN_THRESHOLD = 2; // '서로 다른 지문 수' 기준
  const intermittentRecoveries: FailRecord[] = [];

  // ── 실패 경로 재시도 정책 ────────────────────────────────────────
  // 전 요청 공통: 성공·4xx는 즉시 확정하고, 5xx·응답없음(0)만 점진 백오프(2s → 4s)로 재시도한다.
  // 전체 실행에 고정 지연을 추가하지 않는다 — 백오프는 실패한 요청 뒤에만 붙는다.
  // 예외(지연 404): 오리진 간헐 장애는 '10초대 지연 후 404'라는 실측 시그니처를 갖는다
  // (no-store 경로 오리진 직격 → 데이터 페치 타임아웃 → 404). 이 시그니처에 한해서만 404를
  // 타임아웃 계열로 취급해 재시도한다. 일반화하지 않는다 — 자사 호스트 · 멱등 GET ·
  // 응답 VERY_SLOW_MS(8s) 이상을 모두 만족해야 하며, 빠른 404·외부·비GET은 즉시 확정한다.
  const RETRY_BACKOFF_MS = [2000, 4000]; // 1회 실패 후 2s, 2회 실패 후 4s (점진)
  const retryDelayMs = (attempt: number) =>
    RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
  const shouldRetryStatus = (
    status: number,
    opts: { url: string; method?: string; responseTimeMs?: number },
  ): boolean => {
    if (status === 0 || status >= 500) return true;
    return status === 404
      && (opts.method ?? 'GET').toUpperCase() === 'GET'
      && isOwnHost(opts.url)
      && (opts.responseTimeMs ?? 0) >= VERY_SLOW_MS;
  };

  // ── 재시도 예산 게이트 ──────────────────────────────────────────
  // 재시도 '시작 전'에 [경과 + 백오프 + 요청 timeout]이 안전 예산(REPORT_SAFETY_MS, 510s) 안에
  // 끝나는지 확인한다. 부족하면 재시도를 생략하고 최초 실패로 확정하며 retrySkipped: 'budget'을 남긴다.
  //
  // 기준을 전체 타임아웃(600s)이 아니라 510s로 두는 이유: 재시도가 510s를 넘겨 이어지면 그 뒤의
  // 검사들이 예산 가드에 걸려 통째로 스킵되고 coverageComplete=false 가 된다. 510~600s 구간은
  // 증거 생성·리포트 저장 여유로 남긴다.
  //
  // 한계(중요): 이 게이트가 통제하는 것은 '재시도 경로'뿐이다. 최초 요청·스크린샷·증거 생성 같은
  // 다른 await는 통제하지 못하며, 그중 하나가 멈추면 전체 타임아웃까지 끌려가 리포트·증거 저장이
  // 실패할 수 있다. DOM 이미지 getAttribute()는 별도 2초 제한으로 방어하지만 모든 await가 그런 것은 아니다.
  // 즉 이 게이트는 '리포트 저장 보장'이 아니라 '재시도가 510s 이후까지 이어지지 않게 하는' 제한이다.
  const retryBudgetOk = (backoffMs: number, requestTimeoutMs: number) =>
    Date.now() - testStartTime + backoffMs + requestTimeoutMs <= REPORT_SAFETY_MS;

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  let slowCount = 0; // 느린 응답(정보성) — 런 상태(WARN)·헬스 스코어엔 반영 안 함
  let infoCount = 0; // 제3자 자원 이상(정보성) — 런 상태·헬스 스코어엔 반영 안 함, 기록만 남김
  let shotCount = 0; // 이번 런에서 실제 캡처·첨부된 화면 수 — 리포트 안내 문구를 조건부로 내기 위함
  const serverTimes: Record<string, number> = {};

  // ── 네비게이션 재시도 헬퍼 (간헐 오리진 5xx/타임아웃 오탐 방지) ──────────────
  // tool·login 페이지는 CloudFront 캐시 미적용(cache-control: no-store)이라 매 요청이
  // 오리진(nginx+SSR) 직격 → 순간 부하 시 데이터 페치가 타임아웃돼 간헐 실패를 뱉는다.
  // 재시도 대상은 shouldRetryStatus(5xx·응답없음 + '지연 404' 시그니처)로 한정한다 —
  // 빠른 404 등 비재시도 4xx는 1회 시도로 즉시 확정해 실행시간을 늘리지 않는다.
  // 반환: { status, responseTime, attempts, recovered, failureLog, retrySkipped }
  //   recovered    : 2회차 이후 회복 여부
  //   retrySkipped : 재시도 대상이었지만 예산 게이트에 걸려 최초 실패로 확정된 경우 'budget'
  // failureLog에는 실패한 각 시도의 상태와 소요 시간을 남긴다. 이게 없으면 회복 기록의 증상이
  // "간헐 실패 후 회복"뿐이라, 1회차가 404였는지 타임아웃이었는지를 개발팀이 추적할 수 없다.
  // (실제로 오리진 장애는 '10초대 지연 후 404'라는 고유 시그니처를 갖는다 — 이걸 남겨야 원인이 보인다)
  async function gotoWithRetry(url: string, maxAttempts = 3) {
    let lastStatus = 0;
    let lastResponseTime = 0;
    let attempts = 0;
    let retrySkipped: 'budget' | undefined;
    const failureLog: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const startTime = Date.now();
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        lastResponseTime = Date.now() - startTime;
        lastStatus = res?.status() ?? 0;
        if (lastStatus === 200) {
          return { status: 200, responseTime: lastResponseTime, attempts: attempt, recovered: attempt > 1, failureLog, retrySkipped };
        }
        failureLog.push(`${attempt}회차 HTTP ${lastStatus} (${lastResponseTime}ms)`);
        // 비재시도 계열(빠른 4xx 등)은 즉시 기존 판정으로 확정한다.
        if (!shouldRetryStatus(lastStatus, { url, responseTimeMs: lastResponseTime })) break;
      } catch (e) {
        lastStatus = 0; // 타임아웃/접속 불가 — 재시도 대상
        lastResponseTime = Date.now() - startTime;
        failureLog.push(`${attempt}회차 응답 없음 (${lastResponseTime}ms, ${(e as Error).message.split('\n')[0].slice(0, 60)})`);
      }
      if (attempt < maxAttempts) {
        const delay = retryDelayMs(attempt);
        if (!retryBudgetOk(delay, 15000)) {
          retrySkipped = 'budget';
          failureLog.push('재시도 생략(예산 부족)');
          break;
        }
        await page.waitForTimeout(delay);
      }
    }
    return { status: lastStatus, responseTime: lastResponseTime, attempts, recovered: false, failureLog, retrySkipped };
  }

  // ── HTTP 상태 판정 기준 (통합) ──────────────────────────────────
  // 기존 기준은 404·5xx만 실패로 봐서 400·405·408·429가 전부 PASS로 샜다.
  // (429 레이트리밋·400 잘못된 요청은 실제 이상 신호인데 초록으로 지나갔다)
  // → 공개 경로는 2xx·3xx만 정상으로 보고, 그 밖의 4xx·5xx·응답없음(0)은 실패로 판정한다.
  //
  // 401/403은 전역 예외로 두지 않는다. 비로그인 헬스체크가 인증 게이트를 밟는 건 정상이지만,
  // 공개 페이지가 갑자기 403을 주는 것은 실제 장애다 → '경로 + 메서드' 단위로만 허용한다.
  // 경로 묶음을 정규식으로 넓게 허용하면(예: /(login|point|mypage|...)) 실제로는 200이어야 할
  // 페이지가 403으로 망가져도 '인증 게이트'로 흡수돼 미탐이 된다.
  // → 비로그인 상태에서 401/403이 '관측된' 엔드포인트만 메서드 단위로 명시한다.
  //
  // 2026-07-31 실측 (비로그인 GET):
  //   /ko/login 200 · /en/login 200 · /api/auth/me 200   → 401/403 면제 대상 아님
  //   /ko/point 307 · /ko/mypage 307                     → 3xx라 이미 정상 판정
  //   /ko/profile·/ko/order·/ko/payment·/api/user·/api/point·/api/order 404 → 존재하지 않음
  // 현재 401/403을 정상으로 볼 엔드포인트가 하나도 없어 목록은 비어 있다.
  // 실제 런 3회에서도 ezlab.im 응답 중 401/403은 0건이었다(403은 전부 cdn 자산 결함).
  // 새로 추가할 때는 반드시 실측한 엔드포인트·메서드·기대 상태를 근거로 적는다.
  const AUTH_GATED: { url: RegExp; methods: string[]; note: string }[] = [];
  const isAuthGated = (url: string, method = 'GET') =>
    AUTH_GATED.some(r => r.url.test(url) && r.methods.includes(method.toUpperCase()));

  // 자사(내부) 자원의 실패 판정. 리포트 기록과 assert가 반드시 이 함수를 함께 써야 한다.
  const httpIsFail = (status: number, url: string, method = 'GET') => {
    if (status === 0) return true;                                  // 타임아웃·접속 불가
    if (status === 401 || status === 403) return !isAuthGated(url, method);
    return status < 200 || status >= 400;                           // 2xx·3xx만 정상
  };
  const httpIsOk = (status: number, url: string, method = 'GET') => !httpIsFail(status, url, method);

  // 하위 호환 별칭 — STEP2(API)는 수집된 엔드포인트를 그대로 검증하므로 같은 기준을 쓴다.
  const apiIsFail = (s: number, url = '', method = 'GET') => httpIsFail(s, url, method);
  const apiIsOk   = (s: number, url = '', method = 'GET') => httpIsOk(s, url, method);

  // ── GET 재확인 헬퍼 (부작용 없는 재요청으로 단발 hiccup과 실제 장애 구분) ──
  // gotoWithRetry는 브라우저 네비게이션용이라 API 엔드포인트엔 과하다. 여기선 HTTP 요청만 다시 던진다.
  // 재시도 조건·백오프·예산 게이트는 gotoWithRetry와 동일 정책(shouldRetryStatus / retryDelayMs / retryBudgetOk).
  async function refetchWithRetry(url: string, maxAttempts = 3) {
    let lastStatus = 0;
    let lastResponseTime = 0;
    let attempts = 0;
    let retrySkipped: 'budget' | undefined;
    const failureLog: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const startTime = Date.now();
      try {
        const res = await page.request.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
        lastStatus = res.status();
        lastResponseTime = Date.now() - startTime;
        if (apiIsOk(lastStatus, url, 'GET')) {
          return { status: lastStatus, responseTime: lastResponseTime, attempts: attempt, recovered: attempt > 1, failureLog, retrySkipped };
        }
        failureLog.push(`${attempt}회차 HTTP ${lastStatus} (${lastResponseTime}ms)`);
        if (!shouldRetryStatus(lastStatus, { url, responseTimeMs: lastResponseTime })) break; // 4xx 즉시 확정
      } catch {
        lastStatus = 0;
        lastResponseTime = Date.now() - startTime;
        failureLog.push(`${attempt}회차 응답 없음 (${lastResponseTime}ms)`);
      }
      if (attempt < maxAttempts) {
        const delay = retryDelayMs(attempt);
        if (!retryBudgetOk(delay, REQUEST_TIMEOUT_MS)) {
          retrySkipped = 'budget';
          failureLog.push('재시도 생략(예산 부족)');
          break;
        }
        await page.waitForTimeout(delay);
      }
    }
    return { status: lastStatus, responseTime: lastResponseTime, attempts, recovered: false, failureLog, retrySkipped };
  }

  // ══════════════════════════════════════════════════════════════════
  // 증거 수집 (모든 FAIL·WARN에 시각 증거를 보장)
  // ══════════════════════════════════════════════════════════════════
  // 예전에는 검사 항목마다 captureShot()을 직접 불렀다. 그래서 새 검사를 추가할 때 호출을
  // 빠뜨리기 쉬웠고, 실제로 API·설치 파일·SSL·OG 메타 이미지·예산 초과에는 증거가 없었다.
  // → 기록을 recordIssue() 하나로 통합하고, 그 안에서 지문 계산과 증거 확보까지 함께 처리한다.
  //   화면으로 확인되는 장애는 '발견 즉시' 그 페이지를 찍고,
  //   화면에 안 나타나는 장애(API·파일·인증서·메타 이미지·네트워크·예산)는 진단 카드로 남긴다.

  // 지문당 증거 파일 1장을 공유한다 — 같은 장애가 4개 언어에서 반복돼도 이미지는 하나면 된다.
  // 단, 기록마다 evidencePath 는 반드시 채운다(증거 없는 기록이 없어야 한다).
  const evidenceByFingerprint = new Map<string, { type: 'page' | 'element' | 'diagnostic'; path: string }>();

  const safeName = (s: string) => s.replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 70);

  async function attachToReport(label: string, filePath: string) {
    // playwright-report 에서도 장애와 증거가 직접 연결되도록 첨부한다.
    try {
      await test.info().attach(label, { path: filePath, contentType: 'image/png' });
    } catch { /* 첨부 실패가 런을 막지 않는다 */ }
  }

  // 화면으로 확인되는 장애 — 발견된 그 페이지에서 즉시 촬영한다(다른 곳으로 이동한 뒤 찍으면 안 된다).
  async function captureVisual(
    rec: FailRecord,
    opts: { locator?: import('@playwright/test').Locator; label: string },
  ): Promise<{ type: 'page' | 'element'; path: string } | null> {
    const base = path.join(SCREENSHOT_DIR, `${safeName(opts.label)}-${Date.now()}`);
    // 요소 스크린샷이 가능하면 그것과 전체 페이지를 함께 남긴다 — 요소만 있으면 맥락을 잃는다.
    if (opts.locator) {
      const elPath = `${base}-element.png`;
      try {
        await opts.locator.first().screenshot({ path: elPath, timeout: 5000 });
        await attachToReport(`${opts.label} (요소)`, elPath);
        shotCount++;
        try {
          const pgPath = `${base}-page.png`;
          await page.screenshot({ path: pgPath, fullPage: true });
          await attachToReport(`${opts.label} (전체)`, pgPath);
          shotCount++; // 요소·전체를 각각 남기므로 첨부 파일 수와 일치시킨다
        } catch { /* 전체 화면 실패는 무시 — 요소 증거는 이미 확보 */ }
        return { type: 'element', path: elPath };
      } catch { /* 요소 촬영 실패 시 아래 전체 화면으로 폴백 */ }
    }
    const pgPath = `${base}-page.png`;
    try {
      await page.screenshot({ path: pgPath, fullPage: true });
      await attachToReport(opts.label, pgPath);
      shotCount++;
      return { type: 'page', path: pgPath };
    } catch {
      return null;
    }
  }

  // 화면에 나타나지 않는 장애용 진단 카드.
  // 운영 페이지를 이동시키면 안 되므로 별도 페이지에서 setContent()로 렌더한다(네트워크 요청 없음).
  // 진단 카드 렌더링용 페이지 — 여러 건이 공유한다(건마다 페이지를 열면 비용이 크다).
  let diagPage: import('@playwright/test').Page | null = null;
  async function renderDiagnostic(rec: FailRecord): Promise<{ type: 'diagnostic'; path: string } | null> {
    try {
      if (!diagPage) diagPage = await page.context().newPage();
      await diagPage.setContent(diagnosticCardHtml(rec, RUN_ID), { waitUntil: 'load', timeout: 10000 });
      const label = `진단_${rec.type}_${rec.status}_${safeName(rec.url).slice(0, 40)}`;
      const filePath = path.join(SCREENSHOT_DIR, `diag-${safeName(label)}-${Date.now()}.png`);
      await diagPage.screenshot({ path: filePath, fullPage: true });
      await attachToReport(label, filePath);
      shotCount++;
      return { type: 'diagnostic', path: filePath };
    } catch {
      return null;
    }
  }

  // ── 장애 기록 단일 진입점 ────────────────────────────────────────
  // await recordIssue()를 직접 부르지 말고 반드시 이 함수를 쓴다.
  // 지문 계산 · 증거 확보 · evidencePath 저장 · 촬영 실패 처리를 한 곳에서 보장한다.
  async function recordIssue(
    rec: FailRecord,
    evidence?: { visual?: true; locator?: import('@playwright/test').Locator; label?: string },
  ) {
    rec.fingerprint = fingerprintOf(rec);
    failRecords.push(rec); // ← 유일하게 직접 push 하는 곳. 다른 모든 기록 지점은 이 함수를 거친다.

    // 외부 링크(INFO)는 이지랩이 고칠 수 없는 제3자 자원이라 증거 이미지 필수 대상에서 뺀다.
    if (rec.severity === 'INFO') return;

    const cached = evidenceByFingerprint.get(rec.fingerprint);
    if (cached) { rec.evidenceType = cached.type; rec.evidencePath = cached.path; return; }

    // 화면 증거는 '발견 즉시' 찍어야 의미가 있다. 진단 카드는 내용이 시점에 의존하지 않으므로
    // 최종 보완 단계(ensureEvidence)에서 한 번에 만든다 — 페이지 생성 비용을 아끼기 위함.
    if (evidence?.visual) {
      const shot = await captureVisual(rec, {
        locator: evidence.locator,
        label: evidence.label ?? `${rec.severity ?? 'FAIL'}_${rec.type}_${rec.lang}`,
      });
      if (shot) {
        rec.evidenceType = shot.type;
        rec.evidencePath = shot.path;
        evidenceByFingerprint.set(rec.fingerprint, shot);
      }
      // 실패하면 evidencePath 가 비고, ensureEvidence 가 진단 카드로 보완한다.
    }
  }

  // ── 증거 선점 ────────────────────────────────────────────────────
  // 이미지처럼 '발견은 페이지에서, 판정은 집계 단계에서' 이뤄지는 항목이 있다.
  // 집계 시점엔 이미 다른 페이지로 이동한 뒤라 그때 찍으면 맥락이 사라진다.
  // → 발견한 그 자리에서 미리 찍어 지문에 걸어두면, 나중에 recordIssue 가 그대로 집어 쓴다.
  async function stashVisualEvidence(
    provisional: FailRecord,
    locator: import('@playwright/test').Locator | undefined,
    label: string,
  ) {
    const fp = fingerprintOf(provisional);
    if (evidenceByFingerprint.has(fp)) return;
    const shot = await captureVisual(provisional, { locator, label });
    if (shot) evidenceByFingerprint.set(fp, shot);
  }

  // ── 최종 보완: 증거 없는 FAIL·WARN이 남지 않게 한다 ──────────────
  // 리포트 저장 직전에 호출한다. 증거 생성이 실패해도 런을 중단하지 않고 evidenceError만 남긴다.
  async function ensureEvidence() {
    const targets = failRecords.filter(r => r.severity !== 'INFO' && !r.evidencePath);
    if (!targets.length) {
      console.log('[INFO][증거] 모든 FAIL·WARN에 증거가 연결되어 있습니다');
      return;
    }
    console.log(`[INFO][증거] 증거 없는 기록 ${targets.length}건 — 진단 카드 생성`);
    for (const rec of targets) {
      const fp = rec.fingerprint ?? fingerprintOf(rec);
      const cached = evidenceByFingerprint.get(fp);
      if (cached) { rec.evidenceType = cached.type; rec.evidencePath = cached.path; continue; }
      const made = await renderDiagnostic(rec);
      if (made) {
        rec.evidenceType = made.type;
        rec.evidencePath = made.path;
        evidenceByFingerprint.set(fp, made);
      } else {
        rec.evidenceError = '증거 생성 실패 (스크린샷·진단 카드 모두 실패)';
        console.log(`[WARN][증거] ${rec.evidenceError}: ${rec.url}`);
      }
    }
    if (diagPage) { await diagPage.close().catch(() => {}); diagPage = null; }
    const missing = failRecords.filter(r => r.severity !== 'INFO' && !r.evidencePath).length;
    console.log(`[INFO][증거] 보완 완료 — 증거 없는 FAIL·WARN ${missing}건`);
  }

  async function checkUrl(type: string, lang: string, url: string, isInternal: boolean = true) {
    const cleanUrl = url.split('?')[0];
    if (visitedUrls.has(cleanUrl)) return;
    visitedUrls.add(cleanUrl);

    // 내부/외부 공통으로 쿼리 파라미터 포함 원본 URL로 요청한다.
    // 내부 링크에서 쿼리를 떼면(과거 동작) /ko/tool/view?id=123 이 /ko/tool/view 로 요청돼
    // 파라미터 필수 페이지가 404/500을 내며 오탐 FAIL이 났다 → STEP2 fetchUrl 처리와 동일하게 원본 유지.
    // (dedup·표시는 cleanUrl 유지)
    const requestUrl = url;

    // 내부 링크는 오리진 순간 지연(캐시 미적용 SSR 페이지의 간헐 타임아웃/5xx) 오탐을 막기 위해
    // 실패 시에만 점진 백오프로 재확인한다. 외부 링크는 INFO라 지연 누적 방지를 위해 1회만 요청.
    // (아래 catch에서도 시도 횟수·실패 내역을 증상에 써야 하므로 try 바깥에 둔다)
    const maxAttempts = isInternal ? 3 : 1;
    const failureLog: string[] = []; // 실패한 시도의 상태·소요 시간 — 회복 기록의 원인 추적용
    let attempts = 0;
    let retrySkipped: 'budget' | undefined;

    try {
      // 요청 간격 제어(오리진 예의 대기) — 재시도 백오프와 무관한 기존 크롤 속도 제한. 그대로 유지한다.
      await page.waitForTimeout(Math.floor(Math.random() * 500) + 300);

      let res!: Awaited<ReturnType<typeof page.request.get>>;
      let responseTime = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        const startTime = Date.now();
        let threwErr: unknown = null;
        try {
          res = await page.request.get(requestUrl, { headers, timeout: REQUEST_TIMEOUT_MS });
          responseTime = Date.now() - startTime;
          if (res.status() === 200 || attempt >= maxAttempts) break; // 성공 또는 마지막 시도 → 아래에서 판정
          failureLog.push(`${attempt}회차 HTTP ${res.status()} (${responseTime}ms)`);
          // 비재시도 계열(빠른 4xx 등)은 즉시 기존 판정으로 확정 — 지연 404 시그니처만 재시도.
          if (!shouldRetryStatus(res.status(), { url: requestUrl, responseTimeMs: responseTime })) break;
        } catch (e) {
          threwErr = e;
          failureLog.push(`${attempt}회차 응답 없음 (${Date.now() - startTime}ms)`);
          if (attempt >= maxAttempts) throw e; // 마지막 시도까지 실패 → 바깥 catch(접속 불가)로
        }
        const delay = retryDelayMs(attempt);
        if (!retryBudgetOk(delay, REQUEST_TIMEOUT_MS)) {
          retrySkipped = 'budget';
          failureLog.push('재시도 생략(예산 부족)');
          if (threwErr) throw threwErr; // 응답 자체가 없던 실패는 바깥 catch(접속 불가)로 확정
          break;
        }
        await page.waitForTimeout(delay);
      }

      const status = res.status();
      const finalUrl = res.url();
      const recovered = attempts > 1 && status === 200; // 재시도로 회복된 간헐 케이스
      // 요청한 URL(외부 링크는 쿼리 포함 원본)과 비교 — cleanUrl과 비교하면 쿼리가 있는
      // 외부 링크가 리다이렉트 없이도 전부 [REDIRECT]로 오표기된다.
      const isRedirect = finalUrl !== requestUrl;

      let contentIssue = '';
      // 콘텐츠(점검중) 스캔은 내부 링크에만 적용한다. 외부 링크는 이지랩 소유가 아니라 정책상 WARN까지만인데,
      // contentIssue는 200이어도 FAIL로 승격시켜(아래 result) 외부 파트너/스토어 페이지에 '점검중' 문구가
      // 있으면 이지랩 장애로 오탐 + Slack·이슈까지 울렸다 → 내부일 때만 검사해 외부=WARN 정책을 지킨다.
      if (status === 200 && isInternal) {
        // 원문 그대로 스캔하면 인라인 <script>/<style>에 실린 i18n JSON 번들(점검 문구 포함)까지
        // 걸려 정상 페이지가 전량 오탐 FAIL 날 수 있다(STEP5/8은 innerText만 봄). 스크립트·스타일
        // 블록을 걷어내 '실제 렌더될 마크업'에 가깝게 만든 뒤 검사한다.
        const body = (await res.text())
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .toLowerCase();
        const found = errorKeywords.find(kw => body.includes(kw.toLowerCase()));
        if (found) contentIssue = `콘텐츠 이상: "${found}" 감지`;
      }

      const isSlow = responseTime > SLOW_MS;
      // 내부 링크 판정은 httpIsFail 하나로 통일한다 — 2xx·3xx만 정상, 그 외 4xx·5xx는 실패.
      // 401/403은 전역 면제가 아니라 AUTH_GATED 경로에서만 정상으로 본다(공개 페이지의 403은 장애).
      const authGated = (status === 401 || status === 403) && isAuthGated(requestUrl, 'GET');
      // 외부 링크 이상은 INFO(정보성) — 이지랩이 소유·수정할 수 없는 제3자 서버라 헬스 스코어에서 뺀다.
      // (abr.ge 등 외부 도메인의 500/504가 이지랩 점수를 깎던 문제. 링크 유효성 기록 자체는 그대로 남는다)
      // 외부는 2xx·3xx면 정상, 그 밖은 INFO로 기록만 남긴다.
      const externalOk = status >= 200 && status < 400;
      const result =
        status !== 200 ? (isInternal ? (httpIsFail(status, requestUrl, 'GET') ? 'FAIL' : 'PASS')
                                     : (externalOk ? 'PASS' : 'INFO')) :
        contentIssue   ? 'FAIL' :
        isSlow         ? 'SLOW' : 'PASS';  // 내부/외부 공통: 느림은 정보성(SLOW) — 스코어 미반영

      const notes: string[] = [];
      if (isRedirect)   notes.push(`리다이렉트 → ${finalUrl}`);
      // 200이 아닌데 PASS로 흡수된 경우(401/403 등)는 로그에서 '정상'으로만 보이지 않도록 근거를 남긴다.
      if (status !== 200 && result === 'PASS') notes.push(`HTTP ${status}${authGated ? ' (인증 게이트 — 정상)' : ' (비장애 상태코드)'}`);
      if (contentIssue) notes.push(contentIssue);
      // 3~12s는 SLOW로 흡수하되, 8s를 넘는 건 오리진 장애 전조라 로그에서 눈에 띄게 구분한다.
      if (isSlow)       notes.push(`${responseTime > VERY_SLOW_MS ? '응답 매우 느림' : '응답 느림'}: ${responseTime}ms`);
      if (recovered)    notes.push(`간헐 회복 (${attempts}회 시도${failureLog.length ? ' · ' + failureLog.join(', ') : ''})`);
      if (!isInternal)  notes.push('외부 링크');
      const noteStr = notes.join(' | ') || '정상';

      if (result === 'FAIL') {
        failCount++;
        const ts = kstNow();
        console.log(`[FAIL][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl} @ ${ts}`);
        await recordIssue({ step: 'UI/링크', type, lang, url: cleanUrl, status, responseTime, symptom: noteStr, timestamp: ts, retrySkipped });
        // status가 아니라 '판정 결과'를 단언한다. status로 단언하면 HTTP 200인데 점검 페이지가
        // 내려온 경우(contentIssue)에 리포트는 FAIL인데 assert는 통과해, CI가 초록불이 되는
        // 정합성 구멍이 생긴다.
        expect.soft(status === 200 && !contentIssue, `[${type}][${lang}] ${noteStr} → ${cleanUrl}`).toBe(true);
      } else if (result === 'SLOW') {
        slowCount++;  // 정보성 집계만 — 런 상태(WARN)/헬스 스코어를 깎지 않고 CI도 실패시키지 않음
        console.log(`[SLOW][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl}`);
      } else if (result === 'INFO') {
        // 스코어엔 안 넣되 기록은 반드시 남긴다 — 외부 링크가 죽은 게 이지랩 장애는 아니어도
        // 사용자는 깨진 링크를 밟게 되므로, 링크를 교체·제거할 근거는 대시보드에 남아야 한다.
        infoCount++;
        const ts = kstNow();
        console.log(`[INFO][${type}][${lang}] ${status} (${responseTime}ms) [외부링크 · 스코어 미반영] ${cleanUrl}`);
        await recordIssue({ step: 'UI/링크', type: '외부링크', lang, url: cleanUrl, status, responseTime, symptom: `외부 링크 응답 이상 (HTTP ${status})`, timestamp: ts, severity: 'INFO' });
      } else {
        passCount++;
        console.log(`[PASS][${type}][${lang}] ${status} (${responseTime}ms)${isRedirect ? ' [REDIRECT]' : ''} ${cleanUrl}`);
        if (recovered) {
          // 회복은 INFO로 남기고, 서로 다른 지문이 임계치 이상일 때만 종합 판정에서 WARN 승격된다.
          intermittentRecoveries.push({ step: 'STEP3·UI링크', type, lang, url: cleanUrl, status: 200, responseTime, symptom: `간헐 실패 후 회복 (${attempts}회 시도${failureLog.length ? ' · ' + failureLog.join(', ') : ''})`, timestamp: kstNow(), severity: 'INFO' });
        }
      }

    } catch (e) {
      if (isInternal) {
        failCount++;
        const ts = kstNow();
        // '접속 불가'로만 적으면 실제로는 연결이 살아 있고 응답만 느렸던 경우까지 단절로 오기재된다.
        // 타임아웃 값을 명시해 '얼마를 기다렸는데 안 왔는지'를 증상에 남긴다.
        const symptom = `응답 없음 (${attempts}회 시도 · 각 ${REQUEST_TIMEOUT_MS / 1000}초 대기)${failureLog.length ? ' · ' + failureLog.join(', ') : ''}`;
        console.log(`[ERROR][${type}][${lang}] ${symptom}: ${cleanUrl} @ ${ts}`);
        await recordIssue({ step: 'UI/링크', type, lang, url: cleanUrl, status: 0, responseTime: 0, symptom, timestamp: ts, retrySkipped });
        expect.soft(null, `[${type}][${lang}] ${symptom} → ${cleanUrl}`).not.toBeNull();
      } else {
        // 외부 도메인 접속 불가도 위 응답 이상과 동일하게 INFO — 제3자 서버 상태는 스코어에 반영하지 않는다.
        infoCount++;
        const ts = kstNow();
        console.log(`[INFO][${type}][${lang}] 외부링크 접속 불가 (스코어 미반영): ${cleanUrl}`);
        await recordIssue({ step: 'UI/링크', type: '외부링크', lang, url: cleanUrl, status: 0, responseTime: 0, symptom: '외부 링크 접속 불가 / 타임아웃', timestamp: ts, severity: 'INFO' });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 네트워크 정책 설치 — 모든 브라우저 네비게이션보다 먼저 걸어야 한다.
  // (1) 자사 요청에만 헬스체크 식별 헤더 부착 — setExtraHTTPHeaders는 호스트 구분이 안 돼
  //     제3자에게도 헤더가 새므로 쓰지 않는다.
  // (2) 분석·광고 수집 beacon 차단 — 차단한 Request는 intentionalAborts에 기록해
  //     STEP6의 requestfailed 판정에서 실제 장애와 구분한다.
  // ══════════════════════════════════════════════════════════════════
  if (!NET_POLICY_ON) {
    console.log('[INFO][네트워크정책] HC_NET_POLICY=off — 브라우저 라우팅 헤더·beacon 차단을 적용하지 않습니다 (A/B 비교용).'
              + ' page.request·raw HTTPS 계열의 식별 헤더는 유지됩니다.');
  }
  if (NET_POLICY_ON) await page.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if (BEACON_RE.test(url)) {
      intentionalAborts.add(req);
      blockedBeacons++;
      await route.abort('blockedbyclient').catch(() => {}); // 로그 가독성용 — 제외 근거는 WeakSet
      return;
    }
    if (isOwnHost(url)) {
      await route.continue({ headers: { ...req.headers(), ...HC_HEADERS } }).catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 1: 다국어 서버 생존 확인
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 1');
  await test.step('STEP 1 · 다국어 서버 생존 확인 (ko / en / jp / tw)', async () => {
    // 언어 간 연결을 재사용하는 keep-alive 에이전트 (전부 동일 호스트라 핸드셰이크 1회면 충분).
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const lang of languages) {
        // STEP1·2도 예산 가드를 둔다. 오리진 지연으로 초반 스텝이 밀리면 최종 report-status.json
        // 저장 전에 전체 타임아웃(10분)에 걸려 런이 UNKNOWN으로 잡히고 Slack 오탐이 난다 —
        // 사이트는 멀쩡한데 헬스체크가 스스로 장애를 만드는 것. 예산 초과 시 자진 종료해 리포트 저장 여유를 남긴다.
        if (budgetHit('STEP1·서버')) { console.log('[SKIP][서버] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
        await test.step(`[서버][${lang}] 응답 확인`, async () => {
          const serverUrl = `${baseUrl}/${lang}`;
          visitedUrls.add(serverUrl); // 최종 집계에 포함
          // 3xx(트레일링 슬래시·정규화 리다이렉트)도 서버 생존으로 간주 — https.get은
          // 리다이렉트를 안 따라가므로 200만 통과시키면 정상 사이트도 FAIL 오탐이 난다.
          const alive = (s: number) => s >= 200 && s < 400;
          try {
            // 워밍업 1회(DNS/TLS·경로 캐시 비용 분리) — 실패해도 판정에서 제외하고 본측정으로만 판단한다.
            // (예전엔 워밍업 예외가 catch로 떨어져 그 언어 전체가 FAIL 났다 — 워밍업은 연결 캐시가
            //  목적이라 결과 자체가 판정 근거가 아니다)
            let warmupFailed = false;
            try { await measureTTFB(serverUrl, headers, agent); }
            catch { warmupFailed = true; console.log(`[INFO][${lang}] 워밍업 실패 — 판정 제외, 본측정 결과로 판단`); }

            // 본측정 3회 — 5xx·응답없음 샘플만 2초 후 1회 재측정한다(4xx는 즉시 확정).
            // 확정 실패(재시도 후에도 살아있지 않음)가 나오면 남은 샘플을 돌리지 않고 끊는다.
            // 어차피 아래 판정이 '하나라도 죽어 있으면 FAIL'이라 결과가 바뀌지 않는데,
            // 전면 장애일 때 언어당 최악 3샘플×(20s+2s+20s)로 STEP1이 전체 예산을 먹어치운다.
            const samples: number[] = [];
            const statuses: number[] = [];
            const sampleLog: string[] = [];
            let sampleRecovered = false;
            let retrySkipped: 'budget' | undefined;
            for (let i = 0; i < 3; i++) {
              let r: { status: number; ttfb: number };
              try { r = await measureTTFB(serverUrl, headers, agent); }
              catch { r = { status: 0, ttfb: 0 }; } // 예외는 응답없음(0) 샘플로 수렴 — 재시도 판정 일원화
              if (!alive(r.status) && shouldRetryStatus(r.status, { url: serverUrl, responseTimeMs: r.ttfb })) {
                sampleLog.push(`${i + 1}차 ${r.status === 0 ? '응답 없음' : `HTTP ${r.status}`}`);
                const delay = retryDelayMs(1);
                if (!retryBudgetOk(delay, 20000)) { // measureTTFB 기본 타임아웃 20s
                  retrySkipped = 'budget';
                  sampleLog.push('재시도 생략(예산 부족)');
                } else {
                  await page.waitForTimeout(delay);
                  try {
                    const r2 = await measureTTFB(serverUrl, headers, agent);
                    if (alive(r2.status)) sampleRecovered = true;
                    r = r2;
                  } catch { r = { status: 0, ttfb: 0 }; }
                }
              }
              statuses.push(r.status);
              samples.push(r.ttfb);
              if (!alive(r.status)) {
                if (i < 2) sampleLog.push(`확정 실패 — 남은 ${2 - i}회 측정 생략`);
                break;
              }
            }
            samples.sort((a, b) => a - b);
            // 중앙값 — 조기 종료로 샘플이 3개 미만일 수 있어 길이에 맞춰 고른다(빈 배열 방어 포함).
            const responseTime = samples.length ? samples[Math.floor((samples.length - 1) / 2)] : 0;

            // 상태는 3회 중 마지막 값만 보면 안 된다(200/200/500이면 blip을 놓치거나 500/500/200이면
            // 2번 실패를 못 본다) → 하나라도 살아있지 않으면 그 실패 상태를 대표값으로 채택.
            const badStatus = statuses.find(s => !alive(s));
            const status = badStatus ?? statuses[statuses.length - 1];
            const isAlive = badStatus === undefined;
            const detail = sampleLog.length ? ` · ${sampleLog.join(', ')}` : '';
            if (isAlive) {
              passCount++;
              serverTimes[lang] = responseTime;
              console.log(`[PASS][${lang}] 서버 ${status} (TTFB ${responseTime}ms · ${samples.join('/')})${warmupFailed ? ' · 워밍업 실패(판정 제외)' : ''}${detail}`);
              if (sampleRecovered) {
                intermittentRecoveries.push({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status: 200, responseTime, symptom: `본측정 간헐 실패 후 재측정 회복${detail}`, timestamp: kstNow(), severity: 'INFO' });
              }
            } else {
              failCount++;
              const ts = kstNow();
              const symptom = status === 0 ? `접속 불가 / 타임아웃${detail}` : `HTTP ${status} 응답${detail}`;
              console.log(`[FAIL][${lang}] 서버 ${status} (TTFB ${responseTime}ms) ${symptom} @ ${ts}`);
              await recordIssue({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status, responseTime, symptom, timestamp: ts, retrySkipped });
            }
            expect.soft(isAlive, `서버 생존 확인 (status: ${status}, url: ${serverUrl})`).toBe(true);
          } catch {
            // 본측정 예외는 위에서 status 0 샘플로 흡수된다 — 여기 남는 건 예기치 못한 오류뿐.
            failCount++;
            const ts = kstNow();
            console.log(`[ERROR][${lang}] 서버 점검 중 예외 @ ${ts}`);
            await recordIssue({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status: 0, responseTime: 0, symptom: '점검 중 예외', timestamp: ts });
            expect.soft(null, `접속 불가 (url: ${serverUrl})`).not.toBeNull();
          }
        });
      }
    } finally {
      agent.destroy();
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 2: API 자동 수집 및 검증 (네트워크 인터셉트)
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 2');
  await test.step('STEP 2 · API 자동 수집 및 검증 (네트워크 인터셉트)', async () => {

    // request 시작 시간을 Map으로 정확히 추적 (_startTime private 접근 제거)
    const requestStartTimes = new Map<string, number>();
    const onRequest = (req: { url: () => string }) => {
      requestStartTimes.set(req.url(), Date.now());
    };
    const onResponse = (response: { request: () => any; url: () => string; status: () => number }) => {
      const req = response.request();
      const fullUrl = response.url();          // 쿼리 포함 원본 — 재확인 요청에 사용
      const resUrl = fullUrl.split('?')[0];    // 쿼리 제거 — 중복 판정·리포트 표시용
      const resType = req.resourceType();

      if ((resType === 'xhr' || resType === 'fetch') && resUrl.startsWith(baseUrl)) {
        // onRequest는 req.url()로 시작시간을 저장한다. 리다이렉트가 있으면 response.url()(최종 URL)은
        // 그 키와 달라 조회가 빗나가 time이 0ms로 기록됐다 → 이 응답을 만든 요청 URL(req.url())로 조회.
        const time = Date.now() - (requestStartTimes.get(req.url()) ?? Date.now());
        const status = response.status();

        const note =
          status >= 500 ? '서버 오류' :
          status === 404 ? '엔드포인트 없음' :
          status === 401 || status === 403 ? '인증 필요' :
          status >= 200 && status < 300 ? '정상' : `상태코드 ${status}`;

        // 같은 엔드포인트가 언어별로 여러 번 호출되면 더 심각한 상태를 우선 보존 —
        // 먼저 도착한 200이 나중의 500/404를 가리지 않도록.
        const severity = (s: number) => (s >= 500 ? 3 : s === 404 ? 2 : s < 200 || s >= 400 ? 1 : 0);
        const existing = apiRecords.find(r => r.url === resUrl);
        if (!existing) {
          apiRecords.push({ url: resUrl, fetchUrl: fullUrl, method: req.method(), status, time, note });
        } else if (severity(status) > severity(existing.status)) {
          existing.status   = status;
          existing.method   = req.method();
          existing.time     = time;
          existing.note     = note;
          existing.fetchUrl = fullUrl;   // 더 심각한 상태를 만든 요청의 원본 URL(쿼리 포함)로 갱신
        }
      }
    };

    page.on('request', onRequest);
    page.on('response', onResponse);

    // ── 순수 관측자 (판정에 영향 없음) ───────────────────────────────
    // 현재 대기(networkidle 8s + 고정 2s)가 API를 자르고 있는지 확인할 근거를 모은다.
    // apiRecords 는 쿼리를 뗀 URL로 중복 제거하므로 '원시 요청 수'와 직접 비교할 수 없다
    // → 언어별 원시 건수와 METHOD+정규화 URL 집합을 따로 기록한다.
    //
    // 한계(중요): 대기가 끝나면 다음 언어로 넘어가므로 '아직 시작조차 안 한' 지연 API는
    // 이 계측으로 발견할 수 없다. 이 수치로 '안 잘렸다'를 결론지어선 안 된다.
    const apiObs = new Map<string, ApiObservation>();
    const obsOfLang = (lang: string): ApiObservation => {
      let o = apiObs.get(lang);
      if (!o) {
        o = { lang, requests: 0, responses: 0, failed: 0, endpoints: [],
              firstRequestMs: null, lastRequestMs: null, lastSettledMs: null,
              inFlightAtWaitEnd: 0, networkIdle: 'not-run',
              gotoMs: 0, networkIdleWaitMs: 0, settleWaitMs: 0, totalMs: 0, navStartedAt: 0 };
        apiObs.set(lang, o);
      }
      return o;
    };
    // 요청 '시작 시점'의 언어를 기억한다 — 다음 언어로 넘어간 뒤 도착한 응답도 원래 언어에 집계.
    const reqLang = new Map<import('@playwright/test').Request, string>();
    const endpointSet = new Map<string, Set<string>>();   // lang → 'METHOD 정규화URL'
    let currentLang = '';
    let navigationStartedAt = 0;                          // 모든 상대 시각의 기준점

    const isOwnApi = (req: import('@playwright/test').Request) => {
      const rt = req.resourceType();
      return (rt === 'xhr' || rt === 'fetch') && isOwnHost(req.url());
    };
    // 상대 시각은 반드시 '그 요청이 시작된 언어'의 navigation 기준으로 잰다.
    // 전역 기준을 쓰면 다음 언어로 넘어간 뒤 도착한 응답의 lastSettledMs 가 새 기준으로 계산돼
    // 음수에 가깝거나 의미 없는 값이 된다.
    const relTo = (o: ApiObservation) => (o.navStartedAt ? Date.now() - o.navStartedAt : 0);

    const observeReq = (req: import('@playwright/test').Request) => {
      if (!currentLang || !isOwnApi(req)) return;
      reqLang.set(req, currentLang);
      const o = obsOfLang(currentLang);
      o.requests++;
      const t = relTo(o);
      if (o.firstRequestMs === null) o.firstRequestMs = t;
      o.lastRequestMs = t;
      if (!endpointSet.has(currentLang)) endpointSet.set(currentLang, new Set());
      endpointSet.get(currentLang)!.add(`${req.method()} ${req.url().split('?')[0]}`);
    };
    // 같은 Request 로 response 와 requestfailed 가 겹쳐 들어와도 중복 정산되지 않는다 —
    // Map 에서 지우면서 정산하므로 두 번째 호출은 조용히 무시된다.
    const settle = (req: import('@playwright/test').Request, kind: 'res' | 'fail') => {
      const lang = reqLang.get(req);
      if (lang === undefined) return;
      reqLang.delete(req);
      const o = obsOfLang(lang);
      if (kind === 'res') o.responses++; else o.failed++;
      o.lastSettledMs = relTo(o);   // 전역이 아니라 '요청이 시작된 언어'의 기준
    };
    const observeRes  = (res: import('@playwright/test').Response) => settle(res.request(), 'res');
    const observeFail = (req: import('@playwright/test').Request) => settle(req, 'fail');

    page.on('request', observeReq);
    page.on('response', observeRes);
    page.on('requestfailed', observeFail);

    await page.setExtraHTTPHeaders(headers);

    for (const lang of languages) {
      if (budgetHit('STEP2·API수집')) { console.log('[SKIP][API수집] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
      await test.step(`[${lang}] 페이지 탐색 → API 수집`, async () => {
        const startPage = `${baseUrl}/${lang}`;
        currentLang = lang;
        const o = obsOfLang(lang);
        try {
          // networkidle을 진입 조건으로 걸면 자산 하나가 안 끝날 때 20초를 통째로 날리고
          // 그 언어의 API 수집이 0건이 된다. → 진입은 domcontentloaded로 확정하고,
          // XHR을 긁어모으기 위한 안정화 대기만 별도로 짧게 준다(실패해도 그냥 진행).
          // (대기 구조·시간은 변경하지 않는다 — 아래 시각 기록은 계측일 뿐이다)
          const tNav = Date.now();
          navigationStartedAt = tNav;
          o.navStartedAt = tNav;
          await page.goto(startPage, { waitUntil: 'domcontentloaded', timeout: 20000 });
          o.gotoMs = Date.now() - tNav;
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          const tIdle = Date.now();
          // 예외를 전부 timeout 으로 뭉치지 않는다 — 타임아웃과 그 밖의 오류를 구분해 기록한다.
          await page.waitForLoadState('networkidle', { timeout: 8000 })
            .then(() => { o.networkIdle = 'resolved'; })
            .catch((e: Error) => { o.networkIdle = /Timeout/i.test(e?.message ?? '') ? 'timeout' : 'error'; });
          o.networkIdleWaitMs = Date.now() - tIdle;
          const tSettle = Date.now();
          await page.waitForTimeout(2000);
          o.settleWaitMs = Date.now() - tSettle;
          // 대기 종료 '시점'의 미응답 수를 고정한다(이후 늦게 도착하는 응답은 카운터에만 반영).
          o.inFlightAtWaitEnd = [...reqLang.values()].filter(l => l === lang).length;
          o.totalMs = Date.now() - tNav;
          console.log(`[INFO][${lang}] 페이지 탐색 완료, API 수집 중... `
            + `(goto ${o.gotoMs}ms · idle ${o.networkIdleWaitMs}ms/${o.networkIdle} · 고정 ${o.settleWaitMs}ms `
            + `· 요청 ${o.requests} 응답 ${o.responses} 실패 ${o.failed} 미응답 ${o.inFlightAtWaitEnd})`);
        } catch {
          o.totalMs = navigationStartedAt ? Date.now() - navigationStartedAt : 0;
          console.log(`[SKIP][${lang}] 페이지 진입 실패: ${startPage}`);
        }
      });
    }

    // STEP 2 종료 후 리스너 제거 → STEP 3 탐색에 영향 없도록
    page.off('request', onRequest);
    page.off('response', onResponse);
    // 관측자도 여기서만 뗀다 — 언어별로 붙였다 떼면 늦게 도착한 응답이 유실된다.
    currentLang = '';
    page.off('request', observeReq);
    page.off('response', observeRes);
    page.off('requestfailed', observeFail);
    for (const [lang, set] of endpointSet) obsOfLang(lang).endpoints = [...set].sort();
    apiObservation = [...apiObs.values()];

    await test.step(`수집된 API 검증 (총 ${apiRecords.length}건)`, async () => {
      console.log(`[INFO] 총 ${apiRecords.length}개 API 수집 완료`);

      for (const rec of apiRecords) {
        // 재확인(refetchWithRetry)은 5xx·타임아웃 1건당 최대 ~42초(12s×3 + 백오프 2+4s)까지 걸릴 수 있어, 실패 API가 몰리면
        // 이 루프만으로 전체 타임아웃을 넘길 수 있다 → 예산 초과 시 남은 재확인은 스킵(리포트 저장 여유 확보).
        if (budgetHit('STEP2·API검증')) { console.log('[SKIP][API검증] 시간 예산 초과 — 이후 API 재확인 건너뜀'); break; }
        const label = `[API][${rec.method}] ${rec.status} (${rec.time}ms) ${rec.note} → ${rec.url}`;

        if (!apiIsFail(rec.status, rec.fetchUrl, rec.method)) {
          passCount++;
          console.log(`[PASS] ${label}`);
          continue;
        }

        // 인터셉트로 한 번 관측한 실패를 그대로 확정하면, 오리진 단발 hiccup 하나가 런 전체를
        // FAIL로 만든다. (실측: /tw/contact/faq 가 7초 지연 후 502 → 직후 10회 재요청은 전부 200)
        // 다른 STEP은 전부 재시도를 거치는데 여기만 즉시 확정이라 판정 기준도 어긋났다.
        // → 부작용 없는 GET만 재확인한다. POST/PUT 등은 재생하면 데이터가 생길 수 있어 금지.
        const rv = rec.method === 'GET' ? await refetchWithRetry(rec.fetchUrl) : null;

        if (rv && apiIsOk(rv.status, rec.fetchUrl, rec.method)) {
          passCount++;
          const ts = kstNow();
          const detail = rv.failureLog.length ? ` · ${rv.failureLog.join(', ')}` : '';
          console.log(`[INFO][API] 간헐 실패 후 ${rv.attempts}회차 회복 (HTTP ${rv.status})${detail} → ${rec.url}`);
          intermittentRecoveries.push({ step: 'STEP2·API', type: 'API', lang: '-', url: rec.url, status: rv.status, responseTime: rv.responseTime, symptom: `간헐 실패 후 회복 (최초 HTTP ${rec.status} → 재확인 ${rv.status}, ${rv.attempts}회 시도)${detail}`, timestamp: ts, severity: 'INFO' });
          continue;
        }

        failCount++;
        const ts = kstNow();
        const detail = rv
          ? ` (재확인 ${rv.attempts}회 실패${rv.failureLog.length ? ' · ' + rv.failureLog.join(', ') : ''})`
          : ' (비GET이라 재확인 생략 — 부작용 방지)';
        const finalStatus = rv ? rv.status : rec.status;
        console.log(`[FAIL] ${label}${detail} @ ${ts}`);
        await recordIssue({ step: 'STEP2·API', type: 'API', lang: '-', url: rec.url, status: finalStatus, responseTime: rec.time, symptom: `${rec.note}${detail}`, timestamp: ts, retrySkipped: rv?.retrySkipped });
        // (제거됨) 여기서 page.goto 후 수동 스크린샷을 남겼는데, evidencePath·리포트 첨부·shotCount
        // 어디에도 연결되지 않는 고아 파일이었고 운영 페이지를 이동시키기까지 했다.
        // API 오류는 화면으로 확인되지 않으므로 진단 카드(ensureEvidence)로 남긴다.
        // toBeLessThan(500)으로 단언하면 404는 통과해버려, 리포트엔 FAIL인데 CI는 초록이 된다.
        // apiIsFail(finalStatus).toBe(false)로 단언하면 status 0(타임아웃)까지 통과한다(apiIsFail(0)=false).
        // → 리포트의 실패 판정(apiIsOk)과 완전히 동일한 기준으로 단언한다.
        expect.soft(apiIsOk(finalStatus, rec.fetchUrl, rec.method), `${label}${detail}`).toBe(true);
      }

      const summary = apiRecords
        .map(r => `${r.method.padEnd(6)} ${String(r.status).padEnd(4)} ${r.time.toString().padStart(5)}ms  ${r.note.padEnd(12)} ${r.url}`)
        .join('\n');
      await test.info().attach('API 수집 결과', {
        body: `METHOD STATUS   TIME  NOTE         URL\n${'-'.repeat(80)}\n${summary || '수집된 API 없음'}`,
        contentType: 'text/plain'
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 6: 깨진 이미지 감지
  // ══════════════════════════════════════════════════════════════════
  // 이미지 URL 정규화 — Next.js 이미지 프록시(/_next/image?url=...&w=..&q=..)는 쿼리가 곧
  // 이미지 식별자라, 쿼리를 떼면 400이 나고 어떤 이미지인지도 알 수 없다.
  // 기존 코드는 쿼리를 뗀 뒤 400이 나니까 이 형태를 통째로 스킵했고, 그 결과 ezlab.im의
  // 이미지가 4개 언어 440개 전부 스킵돼 STEP 6이 실질적으로 아무것도 점검하지 않았다.
  // → 프록시 URL은 쿼리를 유지해 요청하고, 중복 판정 키도 쿼리를 포함한다.
  //   리포트에는 프록시 주소 대신 실제 원본 자산 경로를 보여줘 어떤 이미지가 깨졌는지 바로 알게 한다.
  function normalizeImageUrl(src: string, origin: string) {
    // 프로토콜 상대(//cdn/img.png)는 startsWith('http')엔 안 걸리고 startsWith('/')엔 걸려
    // origin + '//cdn/img.png' = 'https://ezlab.im//cdn/img.png'로 깨졌다 → https: 스킴을 붙인다.
    const abs = src.startsWith('http') ? src
      : src.startsWith('//') ? 'https:' + src
      : origin + (src.startsWith('/') ? src : '/' + src);
    const isProxy = abs.includes('/_next/image');
    const fetchUrl = isProxy ? abs : abs.split('?')[0];
    let displayUrl = fetchUrl;
    if (isProxy) {
      try { displayUrl = new URL(abs).searchParams.get('url') ?? fetchUrl; } catch { /* 파싱 실패 시 원본 유지 */ }
    }
    return { fetchUrl, displayUrl };
  }

  // ── 이미지 점검 저장소 (3계층 공유) ────────────────────────────
  // meta / network / DOM 세 경로가 같은 저장소를 쓴다. 계층마다 따로 요청하면
  // 같은 이미지를 중복 요청하고 WARN도 중복으로 쌓이며 집계 수치가 어긋난다.
  //   assetIdentityUrl : 원본 자산 식별자 — 리포트 집계 키
  //   requestUrl       : 실제 요청한 URL — 판정·능동 검증 완료 여부의 키
  // Next 이미지 프록시는 폭(w=32/w=3840)마다 URL이 달라 특정 폭만 실패할 수 있으므로,
  // 검증 완료 여부를 원본 단위로 잡으면 실패를 놓친다 → requestUrl 단위로 관리한다.
  type ImgResult = {
    status: number;
    contentType: string;
    contentRange: string;
    ok: boolean;
    note: string;
    source: string;
    responseHeaders: Record<string, string>;
    responseBodySnippet?: string;
    responseBodyBytes?: number;
    netError?: string;
  };
  type ImgObs = {
    langs: Set<string>;
    metaKinds: Set<string>;
    referencePages: Set<string>;
    results: Map<string, ImgResult>;
  };
  const imgObservations = new Map<string, ImgObs>();
  const imgActiveVerified = new Set<string>(); // requestUrl 기준

  // 네트워크 관찰 구간 상수 — 고정하지 않으면 실행마다 lazy 이미지 커버리지가 달라진다.
  // 언어당 최대 4초(= load 3s + 안정화 1s), 4개 언어로 최대 16초 추가. 8.5분 예산 안에 든다.
  const IMG_LOAD_WAIT_MS = 3000; // load 이벤트 최대 대기
  const IMG_SETTLE_MS    = 1000; // lazy·CSS 배경 요청 흡수용 안정화

  const obsOf = (assetUrl: string): ImgObs => {
    let o = imgObservations.get(assetUrl);
    if (!o) {
      o = { langs: new Set(), metaKinds: new Set(), referencePages: new Set(), results: new Map() };
      imgObservations.set(assetUrl, o);
    }
    return o;
  };
  const isImageContentType = (ct: string) => /^image\//i.test(ct.split(';')[0].trim());

  // 단건 요청 + 판정 — 상태 코드뿐 아니라 Content-Type과 본문 크기까지 본다
  // (200인데 HTML/XML 오류 페이지를 주는 경우가 실재한다 — cdn의 403 응답이 application/xml 이었다).
  async function fetchImageOnce(requestUrl: string, source: string): Promise<ImgResult> {
    try {
      const res = await page.request.get(requestUrl, { headers: headersFor(requestUrl), timeout: 8000 });
      const status = res.status();
      const rawHeaders = res.headers();
      const ct = String(rawHeaders['content-type'] ?? '');
      const cr = String(rawHeaders['content-range'] ?? '');
      const body = await res.body();
      const responseHeaders = selectDiagnosticHeaders(rawHeaders);
      let ok = false;
      let note = '';
      if (status === 200 || status === 206) {
        if (!isImageContentType(ct)) {
          note = `Content-Type 이상: ${ct || '(없음)'}`;
        } else if (status === 206 && !/^bytes\s+\d+-\d+\/\d+/i.test(cr)) {
          // 206인데 Content-Range가 없거나 형식이 깨졌으면 부분 응답으로 신뢰할 수 없다.
          note = `206인데 Content-Range 이상: "${cr || '(없음)'}"`;
        } else {
          if (body.length === 0) note = '본문 크기 0';
          else ok = true;
        }
      }
      return {
        status,
        contentType: ct,
        contentRange: cr,
        ok,
        note,
        source,
        responseHeaders,
        responseBodySnippet: ok ? undefined : makeResponseBodySnippet(body, ct, status),
        responseBodyBytes: body.length,
      };
    } catch (error) {
      const netError = (error as Error).message.split('\n')[0].slice(0, 240);
      return {
        status: 0,
        contentType: '',
        contentRange: '',
        ok: false,
        note: '접근 불가 / 타임아웃',
        source,
        responseHeaders: {},
        netError,
      };
    }
  }

  // 능동 검증 — requestUrl 단위로 1회만. 이미지 프록시의 간헐 504·타임아웃 오탐을 막기 위해
  // 5xx·응답없음(0)만 2초 후 1회 재시도한다. 4xx(권한·존재)와 정상 응답의 Content-Type·본문
  // 이상은 재시도로 달라지지 않으므로 즉시 확정한다.
  async function verifyImage(assetUrl: string, requestUrl: string, source: string) {
    if (imgActiveVerified.has(requestUrl)) return;
    imgActiveVerified.add(requestUrl);
    const o = obsOf(assetUrl);
    let result = await fetchImageOnce(requestUrl, source);
    if (!result.ok && shouldRetryStatus(result.status, { url: requestUrl })) {
      const delay = retryDelayMs(1);
      if (!retryBudgetOk(delay, 8000)) {
        result.note = (result.note ? result.note + ' · ' : '') + '재시도 생략(예산 부족)';
      } else {
        await page.waitForTimeout(delay);
        const first = result;
        result = await fetchImageOnce(requestUrl, source);
        if (result.ok) {
          intermittentRecoveries.push({
            step: 'STEP6·이미지', type: '이미지', lang: [...o.langs].join(',') || '-', url: assetUrl,
            status: 200, responseTime: 0,
            symptom: `이미지 간헐 실패 후 재시도 회복 (최초 ${first.status === 0 ? '응답 없음' : `HTTP ${first.status}`})`,
            timestamp: kstNow(), severity: 'INFO',
          });
        }
      }
    }
    o.results.set(requestUrl, result);
  }

  // 네트워크 관측으로 실패가 잡힌 이미지의 능동 재검 — 회복하면 결과를 정상으로 교체하고 INFO를 남긴다.
  // 재검도 실패하면 '관측된 최초 실패'를 그대로 확정한다(능동 재검의 오류보다 원인에 가깝다).
  async function recheckImage(assetUrl: string, requestUrl: string, lang: string, firstStatus: number) {
    const second = await fetchImageOnce(requestUrl, 'network-recheck');
    if (!second.ok) return;
    obsOf(assetUrl).results.set(requestUrl, second);
    intermittentRecoveries.push({
      step: 'STEP6·이미지', type: '이미지', lang, url: assetUrl, status: 200, responseTime: 0,
      symptom: `이미지 간헐 실패 후 재검 회복 (최초 ${firstStatus === 0 ? '응답 없음' : `HTTP ${firstStatus}`})`,
      timestamp: kstNow(), severity: 'INFO',
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // STEP 5: 언어별 핵심 콘텐츠 무결성 확인 (신규)
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 5');
  await test.step('STEP 5 · 언어별 메인 페이지 통합 점검 (콘텐츠 + 이미지)', async () => {
    for (const lang of languages) {
      if (budgetHit('STEP5·콘텐츠')) { console.log('[SKIP][콘텐츠] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
      await test.step(`[메인][${lang}] 콘텐츠 키워드 + 이미지 점검`, async () => {
        const targetUrl = `${baseUrl}/${lang}`;
        const MIN_BODY_LEN = 200; // 렌더 완료 판정 기준 (본문이 채워졌는지)

        // 메인 페이지는 예전에 STEP2·STEP3·STEP5·STEP6이 각각 렌더해 언어당 4번 방문했다.
        // 렌더 1회가 자사 요청 100건대라 낭비가 커서, 콘텐츠와 이미지를 한 방문으로 합친다.
        // (로그인·도구 페이지는 URL이 달라 합치지 않는다)
        //
        // 네트워크 이미지 감시 핸들러는 반드시 진입 전에 붙이고, 관찰이 끝나면 이 핸들러만 제거한다.
        // 두 핸들러 모두 동기 기록만 하므로 별도 flush가 필요 없다.
        const netFailures: {
          url: string;
          status: number;
          contentType: string;
          contentRange: string;
          note: string;
          responseHeaders: Record<string, string>;
          netError?: string;
        }[] = [];
        const onResponse = (res: import('@playwright/test').Response) => {
          const req = res.request();
          if (req.resourceType() !== 'image') return;
          const url = res.url();
          if (!isOwnHost(url)) return; // 제3자 이미지는 장애 점수에서 제외
          const st = res.status();
          // 3xx는 최종 응답에서 다시 잡히고, 304는 정상 재검증(본문 없음이 정상이라 크기·타입 검사 대상 아님)
          if (st >= 300 && st < 400) return;
          if (st === 200 || st === 206) return;
          const rawHeaders = res.headers();
          netFailures.push({
            url,
            status: st,
            contentType: String(rawHeaders['content-type'] ?? ''),
            contentRange: String(rawHeaders['content-range'] ?? ''),
            note: '',
            responseHeaders: selectDiagnosticHeaders(rawHeaders),
          });
        };
        const onRequestFailed = (req: import('@playwright/test').Request) => {
          if (req.resourceType() !== 'image') return;
          if (intentionalAborts.has(req)) return; // 우리가 끊은 beacon — errorText로는 구분 불가
          const url = req.url();
          if (!isOwnHost(url)) return;
          const err = req.failure()?.errorText ?? '';
          // 브라우저가 스스로 취소한 요청(ERR_ABORTED 등)은 장애가 아니다 — 실제 네트워크 실패만 센다.
          if (!REAL_NET_FAILURE_RE.test(err)) return;
          netFailures.push({
            url,
            status: 0,
            contentType: '',
            contentRange: '',
            note: err || '연결 실패',
            responseHeaders: {},
            netError: err || '연결 실패',
          });
        };
        page.on('response', onResponse);
        page.on('requestfailed', onRequestFailed);

        try {
          // STEP8과 동일한 견고성: 기존엔 domcontentloaded 직후 즉시 innerText를 읽어, 순간 오리진
          // hiccup이나 느린 하이드레이션에 키워드가 아직 없어 오탐 FAIL이 났다(다른 스텝은 재시도를 쓰는데
          // 여기만 예외였다). → 재시도 진입 + 본문 렌더 폴링 대기 후 판정한다.
          const nav = await gotoWithRetry(targetUrl);
          if (nav.status !== 200) {
            failCount++;
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            const symptom = nav.status === 0
              ? `응답 없음 (${nav.attempts}회 시도)${detail}`
              : `HTTP ${nav.status} 응답 (${nav.attempts}회 시도)${detail}`;
            console.log(`[FAIL][콘텐츠][${lang}] ${symptom} ${targetUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: nav.status, responseTime: nav.responseTime, symptom, timestamp: ts, retrySkipped: nav.retrySkipped }, { visual: true, label: `실패_콘텐츠진입_${lang}` });
            expect.soft(nav.status, `[콘텐츠][${lang}] 페이지 진입 실패 → ${targetUrl}`).toBe(200);
            return;
          }
          if (nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][콘텐츠][${lang}] 간헐 실패 후 ${nav.attempts}회차 회복${detail} ${targetUrl} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: 200, responseTime: nav.responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'INFO' });
          }

          // 네트워크 idle 대신 본문이 채워졌는지만 폴링해 SSR/하이드레이션 타이밍 오탐을 방지
          await page.waitForFunction(
            (min) => (document.body?.innerText.trim().length ?? 0) > min,
            MIN_BODY_LEN,
            { timeout: 15000 },
          ).catch(() => { /* 최종 판정은 아래 키워드 검사에 맡긴다 */ });

          const bodyText = await page.locator('body').innerText();
          const keywords = contentKeywords[lang] ?? [];
          const missingKeywords = keywords.filter(k => !bodyText.toLowerCase().includes(k.toLowerCase()));

          if (missingKeywords.length > 0) {
            failCount++;
            const ts = kstNow();
            const msg = `[콘텐츠][${lang}] 누락 키워드: ${missingKeywords.join(', ')}`;
            console.log(`[FAIL] ${msg} @ ${ts}`);
            await recordIssue({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: 200, responseTime: 0, symptom: `누락 키워드: ${missingKeywords.join(', ')}`, timestamp: ts }, { visual: true, label: `실패_콘텐츠_${lang}` });
            expect.soft(missingKeywords.length, msg).toBe(0);
          } else {
            passCount++;
            console.log(`[PASS][콘텐츠][${lang}] 핵심 키워드 모두 확인 (${keywords.join(', ')})`);
          }

          // ── 이미지 수집 (같은 방문에서 이어서) ──
          // lazy·CSS 배경 요청까지 잡히도록 고정 구간만큼 관찰한다.
          // networkidle은 쓰지 않는다 — 자산 하나가 안 끝나면 타임아웃까지 통째로 날린다.
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForLoadState('load', { timeout: IMG_LOAD_WAIT_MS }).catch(() => {});
          await page.waitForTimeout(IMG_SETTLE_MS);

          // 2층 결과를 '능동 검증보다 먼저' 반영한다. 나중에 처리하면 이미 404를 관측한 이미지를
          // 메타·DOM 단계에서 다시 요청하게 된다(중복 요청). 또 관측 URL을 그대로 키로 쓰면
          // Next 이미지 프록시 실패가 원본 자산과 별개 항목이 돼 WARN이 중복된다
          // → normalizeImageUrl로 원본 식별자를 뽑아 같은 자산에 병합한다.
          for (const f of netFailures) {
            const { fetchUrl, displayUrl } = normalizeImageUrl(f.url, baseUrl);
            const o = obsOf(displayUrl);
            o.langs.add(lang);
            o.referencePages.add(targetUrl);
            imgActiveVerified.add(fetchUrl); // 재요청 금지
            o.results.set(fetchUrl, {
              status: f.status,
              contentType: f.contentType,
              contentRange: f.contentRange,
              ok: false,
              source: 'network',
              note: f.status === 0 ? `네트워크 실패 (${f.note})` : '',
              responseHeaders: f.responseHeaders,
              netError: f.netError,
            });
          }

          // 관측 실패 중 5xx·응답없음(0)만 능동 재검한다 — 이미지 프록시 간헐 504·타임아웃 오탐 방지.
          // 4xx는 재시도로 달라지지 않으므로 즉시 확정. 백오프는 건별이 아니라 공통 1회만 준다 —
          // 실패가 몰린 런에서 건마다 2초씩 기다리면 대기만 수십 초가 되기 때문.
          const recheckTargets = netFailures.filter(f => f.status === 0 || f.status >= 500);
          if (recheckTargets.length > 0) {
            if (!retryBudgetOk(retryDelayMs(1), 8000)) {
              for (const f of recheckTargets) {
                const { fetchUrl, displayUrl } = normalizeImageUrl(f.url, baseUrl);
                const r = obsOf(displayUrl).results.get(fetchUrl);
                if (r && !r.ok) r.note = (r.note ? r.note + ' · ' : '') + '재시도 생략(예산 부족)';
              }
            } else {
              await page.waitForTimeout(retryDelayMs(1));
              for (const f of recheckTargets) {
                if (!retryBudgetOk(0, 8000)) break; // 남은 건은 최초 실패로 확정
                const { fetchUrl, displayUrl } = normalizeImageUrl(f.url, baseUrl);
                await recheckImage(displayUrl, fetchUrl, lang, f.status);
              }
            }
          }
          netFailures.length = 0; // finally 에서 중복 반영되지 않도록 비운다

          // 1층: OG / Twitter 메타 이미지 — DOM <img>에 안 잡혀 기존 검사가 통째로 놓치던 경로.
          const metaImgs = await page.locator('meta[property="og:image"], meta[name="twitter:image"]').evaluateAll(
            els => els.map(e => ({
              kind: e.getAttribute('property') ?? e.getAttribute('name') ?? 'meta',
              url:  e.getAttribute('content') ?? '',
            })),
          );
          for (const m of metaImgs) {
            if (!m.url || m.url.startsWith('data:')) continue;
            const { fetchUrl, displayUrl } = normalizeImageUrl(m.url, baseUrl);
            const o = obsOf(displayUrl);
            o.langs.add(lang);
            o.metaKinds.add(m.kind);
            o.referencePages.add(targetUrl);
            if (!isOwnHost(fetchUrl)) continue;
            await verifyImage(displayUrl, fetchUrl, 'meta');
          }

          // 도구 페이지 URL 수집 — 추가 렌더 없이 이 방문의 DOM에서 그대로 뽑는다.
          // 예전엔 STEP3 크롤이 채워서 STEP4가 크롤 완주에 묶여 있었다. 크롤이 잘리면
          // 다운로드 점검이 통째로 날아가므로, 핵심 검사를 크롤보다 앞에 둘 수 있게 여기서 모은다.
          const toolHrefs = await page.locator('a[href]').evaluateAll(
            els => els.map(e => (e as HTMLAnchorElement).href).filter(Boolean),
          );
          for (const href of toolHrefs) {
            if (!href.startsWith(baseUrl) || !TOOL_URL_RE.test(href)) continue;
            const tool = href.split('?')[0];
            toolUrlsFromMain.add(tool);
            discoveredToolUrls.add(tool);
          }

          // 3층: DOM <img src> — 네트워크로 요청되지 않은 지연 로딩 이미지 보완.
          const images = await page.locator('img').all();
          console.log(`[INFO][${lang}] DOM 이미지 ${images.length}개 · 메타 이미지 ${metaImgs.length}개 · 네트워크 실패 ${netFailures.length}건`);
          const domReadErrors: string[] = [];
          let domReadFailureCount = 0;
          let domImagesUnverified = 0;
          for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
            if (budgetHit('STEP5·이미지검증')) break;
            const img = images[imageIndex];
            const srcRead = await readLocatorAttribute(img, 'src');
            if (srcRead.ok === false) {
              domReadFailureCount++;
              const impact = attributeReadFailureImpact(images.length, imageIndex, srcRead.timedOut);
              domImagesUnverified += impact.unverified;
              if (domReadErrors.length < 10) {
                domReadErrors.push(
                  `이미지 ${imageIndex + 1}/${images.length} · ${srcRead.timedOut ? '타임아웃' : '읽기 오류'} · ${srcRead.error}`,
                );
              }
              // 브라우저 채널이 응답하지 않는 상태에서 나머지 locator를 계속 읽으면
              // 이미지 수 × timeout 만큼 다시 지연된다. 이 언어의 DOM 이미지 검증만 중단하고
              // 다음 언어·후속 STEP으로 넘어간다. 비타임아웃(요소 detach 등)은 해당 요소만 건너뛴다.
              if (impact.stop) break;
              continue;
            }
            const src = srcRead.value;
            if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue;
            const { fetchUrl, displayUrl } = normalizeImageUrl(src, baseUrl);
            const o = obsOf(displayUrl);
            o.langs.add(lang);
            o.referencePages.add(targetUrl);
            if (!isOwnHost(fetchUrl)) continue;
            await verifyImage(displayUrl, fetchUrl, 'dom');
            // 판정은 STEP6 집계에서 나지만 그때는 이미 다른 페이지로 이동한 뒤다.
            // 실패한 이미지는 '발견한 이 페이지'에서 요소+전체 화면을 미리 찍어 지문에 걸어둔다.
            const dr = obsOf(displayUrl).results.get(fetchUrl);
            if (dr && !dr.ok) {
              await stashVisualEvidence(
                { step: 'STEP6·이미지', type: '이미지', lang, url: displayUrl, status: dr.status,
                  responseTime: 0, symptom: '', timestamp: kstNow(), severity: 'WARN' },
                img, `경고_깨진이미지_${lang}`);
            }
          }
          if (domReadErrors.length > 0) {
            warnCount++;
            truncatedSteps.add('STEP5·이미지DOM수집');
            const ts = kstNow();
            const symptom = `DOM 이미지 속성 읽기 실패 ${domReadFailureCount}건 — 미검증 ${domImagesUnverified}/${images.length}개 (호출 제한 ${LOCATOR_ATTRIBUTE_TIMEOUT_MS}ms)`;
            console.log(`[WARN][콘텐츠][${lang}] ${symptom} ${targetUrl} @ ${ts}`);
            await recordIssue({
              step: 'STEP5·이미지검증', type: '이미지', lang, url: targetUrl, status: 0,
              responseTime: 0, symptom, timestamp: ts, severity: 'WARN',
              diagnosticDetails: domReadErrors,
            });
          }
        } catch (e) {
          failCount++;
          const ts = kstNow();
          const symptom = `점검 중 예외: ${(e as Error).message.split('\n')[0].slice(0, 120)}`;
          console.log(`[ERROR][콘텐츠][${lang}] ${symptom} ${targetUrl} @ ${ts}`);
          await recordIssue({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: 0, responseTime: 0, symptom, timestamp: ts });
          expect.soft(null, `[콘텐츠][${lang}] ${symptom}`).not.toBeNull();
        } finally {
          // 진입 실패로 조기 return 하는 경로가 있어 반드시 finally에서 해제한다 —
          // 남겨두면 STEP7·8의 네트워크가 이 언어의 관측에 섞인다.
          page.off('response', onResponse);
          page.off('requestfailed', onRequestFailed);
          // 정상 경로에서는 위에서 이미 비웠다. 여기 남아 있다면 진입 실패·예외로 조기 이탈한
          // 경우이므로, 관측된 실패를 유실하지 않도록 같은 규칙으로 반영한다.
          // (예외 이탈 경로라 능동 재검은 하지 않는다 — 관측 그대로 확정)
          for (const f of netFailures) {
            const { fetchUrl, displayUrl } = normalizeImageUrl(f.url, baseUrl);
            const o = obsOf(displayUrl);
            o.langs.add(lang);
            o.referencePages.add(targetUrl);
            imgActiveVerified.add(fetchUrl);
            o.results.set(fetchUrl, {
              status: f.status,
              contentType: f.contentType,
              contentRange: f.contentRange,
              ok: false,
              source: 'network',
              note: f.status === 0 ? `네트워크 실패 (${f.note})` : '',
              responseHeaders: f.responseHeaders,
              netError: f.netError,
            });
          }
        }
      });
    }
  });


  // ── STEP5 도구 URL 수집 커버리지 판정 ────────────────────────────
  // STEP4가 이 결과에 의존하므로, 여기서 놓치면 다운로드 점검이 조용히 축소된다.
  stepMark('STEP 5-1');
  await test.step('STEP 5-1 · 도구 페이지 수집 커버리지', async () => {
    step4Stats.discoveredFromMain = toolUrlsFromMain.size;
    const found = new Set<string>();
    for (const u of toolUrlsFromMain) {
      const m = u.match(/\/(ko|en|jp|tw)\/tool\//);
      if (m) found.add(m[1]);
    }
    step4Stats.languagesFound = [...found].sort();
    step4Stats.languagesMissing = languages.filter(l => !found.has(l));

    if (toolUrlsFromMain.size === 0) {
      warnCount++;
      truncatedSteps.add('STEP5·도구수집');
      const ts = kstNow();
      const symptom = '메인 페이지에서 도구 페이지 URL을 한 건도 수집하지 못함 — 다운로드 점검 커버리지 0';
      console.log(`[WARN][도구수집] ${symptom} @ ${ts}`);
      await recordIssue({ step: 'STEP5·도구수집', type: '다운로드', lang: '-', url: baseUrl,
                          status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
    } else if (step4Stats.languagesMissing.length > 0) {
      warnCount++;
      truncatedSteps.add('STEP5·도구수집·언어누락');
      const ts = kstNow();
      const symptom = `도구 페이지가 일부 언어에서 발견되지 않음 — 누락: ${step4Stats.languagesMissing.join(', ')} (발견 ${toolUrlsFromMain.size}건)`;
      console.log(`[WARN][도구수집] ${symptom} @ ${ts}`);
      await recordIssue({ step: 'STEP5·도구수집', type: '다운로드', lang: step4Stats.languagesMissing.join(','),
                          url: baseUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
    } else {
      console.log(`[INFO][도구수집] 도구 페이지 ${toolUrlsFromMain.size}건 수집 (언어: ${step4Stats.languagesFound.join(', ')})`);
    }
  });

  stepMark('STEP 6');
  await test.step('STEP 6 · 이미지 판정 집계', async () => {
    // 수집은 STEP5의 메인 페이지 방문에서 이미 끝났다(방문 통합). 여기서는 자산 단위로만 판정한다.
    // ── 자산 단위 최종 판정 ──
    // 하위 requestUrl 중 하나라도 확정 실패면 자산 WARN. 기록은 자산 1건으로 묶고
    // 참조 언어·메타 종류·실패한 요청 URL을 증상에 담는다(언어별로 WARN을 복제하지 않는다).
    for (const [assetUrl, o] of imgObservations) {
      if (o.results.size === 0) continue; // 관측만 되고 검증 대상이 아니었던 자산(제3자 등)
      checkedImageUrls.add(assetUrl);
      const failed = [...o.results.entries()].filter(([, r]) => !r.ok);
      if (failed.length === 0) {
        passCount++;
        console.log(`[PASS][이미지] ${assetUrl}`);
        continue;
      }
      warnCount++;
      const ts = kstNow();
      const [firstUrl, first] = failed[0];
      const where = [
        o.metaKinds.size ? `사용처: ${[...o.metaKinds].join(', ')}` : '',
        o.langs.size ? `참조 언어: ${[...o.langs].join(', ')}` : '',
        failed.length > 1 ? `실패한 요청 ${failed.length}건` : '',
        firstUrl !== assetUrl ? `요청 URL: ${firstUrl}` : '',
      ].filter(Boolean).join(' · ');
      const symptom = first.status === 0
        ? `이미지 접근 불가${first.note ? ` (${first.note})` : ''}${where ? ` — ${where}` : ''}`
        : `이미지 로드 실패 (HTTP ${first.status})${first.note ? ` · ${first.note}` : ''}${where ? ` — ${where}` : ''}`;
      const diagnosticDetails = failed.map(([requestUrl, result]) => [
        `[${result.source}] ${requestUrl}`,
        result.status === 0 ? '응답 없음' : `HTTP ${result.status}`,
        result.contentType ? `Content-Type ${result.contentType}` : '',
        result.note,
      ].filter(Boolean).join(' · '));
      console.log(`[WARN][이미지] ${first.status} ${assetUrl} — ${symptom} @ ${ts}`);
      await recordIssue({
        step: 'STEP6·이미지', type: '이미지', lang: [...o.langs].join(',') || '-',
        url: assetUrl, status: first.status, responseTime: 0, symptom, timestamp: ts, severity: 'WARN',
        contentType: first.contentType || undefined,
        contentRange: first.contentRange || undefined,
        netError: first.netError,
        responseHeaders: first.responseHeaders,
        responseBodySnippet: first.responseBodySnippet,
        responseBodyBytes: first.responseBodyBytes,
        referencePages: [...o.referencePages].sort(),
        diagnosticDetails,
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 7: 로그인 폼 렌더링 확인
  // ══════════════════════════════════════════════════════════════════
  // ko: 카카오, 네이버, 구글, 이메일로 로그인, 계정찾기
  // en/jp/tw: 구글, 이메일로 시작하기, 계정찾기
  const loginChecks: { lang: string; buttons: string[] }[] = [
    { lang: 'ko', buttons: ['카카오', '네이버', '구글', '이메일'] },
    { lang: 'en', buttons: ['Login with Google', 'Start with email'] },
    { lang: 'jp', buttons: ['Googleでログイン', 'メールで始める'] },
    { lang: 'tw', buttons: ['使用 Google 登入', '使用電子郵件開始'] },
  ];

  stepMark('STEP 7');
  await test.step('STEP 7 · 로그인 폼 렌더링 확인 (언어별)', async () => {
    for (const { lang, buttons } of loginChecks) {
      if (budgetHit('STEP7·로그인')) { console.log('[SKIP][로그인] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
      await test.step(`[로그인][${lang}] 버튼 존재 확인`, async () => {
        const loginUrl = `${baseUrl}/${lang}/login`;
        try {
          const nav = await gotoWithRetry(loginUrl); // 간헐 오리진 실패 재확인
          // gotoWithRetry는 예외를 삼키고 status를 반환하므로, 페이지가 안 뜬 경우(404/타임아웃)를
          // 여기서 명시적으로 FAIL 처리한다 — 안 그러면 버튼 미감지(WARN)로 격하돼 심각도가 어긋난다.
          if (nav.status !== 200) {
            failCount++;
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[ERROR][로그인][${lang}] 페이지 진입 실패: ${nav.status} (${nav.attempts}회 시도)${detail} ${loginUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: nav.status, responseTime: nav.responseTime, symptom: `페이지 진입 실패 (HTTP ${nav.status}, ${nav.attempts}회 시도)${detail}`, timestamp: ts, retrySkipped: nav.retrySkipped }, { visual: true, label: `실패_로그인진입_${lang}` });
            expect.soft(nav.status, `[로그인][${lang}] 페이지 진입 실패 → ${loginUrl}`).toBe(200);
            return; // 페이지가 안 떴으면 버튼 검사 무의미
          }

          // 로그인 페이지도 tool 페이지와 같은 no-store(오리진 직격) 경로라 간헐 실패가 난다.
          // STEP 4와 동일하게 회복 건은 모아뒀다가 런 단위로 한 번에 판정한다.
          if (nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][로그인][${lang}] 간헐 실패 후 ${nav.attempts}회차 회복${detail} ${loginUrl} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 200, responseTime: nav.responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'INFO' });
          }

          const missing: string[] = [];
          for (const btn of buttons) {
            // 버튼이 <button>/<a>가 아니라 [role=button]·btn-class <div>로 렌더되거나,
            // 하이드레이션 직후 SSR 콘텐츠가 잠깐 스켈레톤으로 교체되는 타이밍 오탐을 막기 위해
            // 셀렉터를 넓히고 최대 4초까지 등장을 대기한 뒤 판정한다.
            const escaped = btn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const loc = page.locator('button, a, [role="button"], [class*="btn" i]')
              .filter({ hasText: new RegExp(escaped, 'i') });
            try {
              await loc.first().waitFor({ state: 'visible', timeout: 4000 });
            } catch { /* 최종 판정은 아래 count로 */ }
            if (await loc.count() === 0) missing.push(btn);
          }

          if (missing.length > 0) {
            warnCount++;
            const ts = kstNow();
            console.log(`[WARN][로그인][${lang}] 버튼 미감지: ${missing.join(', ')} @ ${ts}`);
            await recordIssue({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 200, responseTime: 0, symptom: `버튼 미감지: ${missing.join(', ')}`, timestamp: ts, severity: 'WARN' }, { visual: true, label: `경고_로그인버튼미감지_${lang}` });
          } else {
            passCount++;
            console.log(`[PASS][로그인][${lang}] 버튼 모두 확인: ${buttons.join(', ')}`);
          }
        } catch {
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][로그인][${lang}] 페이지 진입 실패: ${loginUrl} @ ${ts}`);
          await recordIssue({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 0, responseTime: 0, symptom: '페이지 진입 실패', timestamp: ts });
          expect.soft(null, `[로그인][${lang}] 페이지 진입 실패`).not.toBeNull();
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 8: 이지다운(ezdown.kr) 정보 페이지 점검 — 별도 도메인
  //   다운로드 기능 페이지가 아니라 '앱 소개 + 사용 후기 + FAQ' 정보성 페이지.
  //   SPA(Next.js)라 단순 HTTP 200으론 부족 → 렌더 후 타이틀/본문/콘텐츠 검증.
  //   언어 체계는 이지랩과 동일(ko/en/jp/tw). CHN 토글은 /tw/ 로 매핑됨.
  // ══════════════════════════════════════════════════════════════════
  const ezdownBase = 'https://ezdown.kr';
  const ezdownKeywords: Record<string, string[]> = {
    ko: ['자주 묻는 질문', '유튜브'],
    en: ['Frequently Asked Questions', 'YouTube'],
    jp: ['よくある質問', 'YouTube'],
    tw: ['使用評價', 'YouTube'],
  };

  stepMark('STEP 8');
  await test.step('STEP 8 · 이지다운(ezdown.kr) 정보 페이지 점검', async () => {
    console.log(`[INFO] STEP 8 이지다운 점검 대상: ${languages.map(l => `${ezdownBase}/${l}/`).join(', ')}`);
    for (const lang of languages) {
      if (budgetHit('STEP8·이지다운')) { console.log('[SKIP][이지다운] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
      await test.step(`[이지다운][${lang}] 렌더 / 콘텐츠 / 이미지`, async () => {
        const url = `${ezdownBase}/${lang}/`;
        const MIN_BODY_LEN = 300; // 렌더 완료 판정 기준 (실측: ko 1436자 / en 2569자 / jp 1365자 / tw 1117자)
        try {
          // 기존엔 waitUntil:'networkidle'을 썼는데, 이 페이지는 자산 요청이 74~76개라
          // 그중 하나만 안 끝나도 networkidle이 영영 오지 않는다 → 20초 타임아웃 → catch로 떨어져
          // 실제로는 0.2초에 다 뜬 페이지가 '접속 불가'로 오기재됐다. (7/22·6/7 FAIL이 이 패턴)
          // → 다른 STEP과 동일하게 domcontentloaded + 재시도로 진입하고,
          //   판정에 필요한 조건(본문 렌더)만 직접 기다린다.
          const nav = await gotoWithRetry(url);
          const status = nav.status;
          visitedUrls.add(url);

          if (status !== 200) {
            failCount++;
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            const symptom = status === 0
              ? `응답 없음 (${nav.attempts}회 시도)${detail}`
              : `HTTP ${status} 응답 (${nav.attempts}회 시도)${detail}`;
            console.log(`[FAIL][이지다운][${lang}] ${symptom} ${url} @ ${ts}`);
            await recordIssue({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status, responseTime: nav.responseTime, symptom, timestamp: ts, retrySkipped: nav.retrySkipped }, { visual: true, label: `실패_이지다운렌더_${lang}` });
            expect.soft(status, `[이지다운][${lang}] 페이지 진입 실패 → ${url}`).toBe(200);
            return;
          }

          if (nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][이지다운][${lang}] 간헐 실패 후 ${nav.attempts}회차 회복${detail} ${url} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status: 200, responseTime: nav.responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'INFO' });
          }

          // 1) 렌더 생존 — SPA라 DOM 로드 직후엔 본문이 비어 있다.
          //    전체 네트워크가 잠잠해지길 기다리는 대신 '본문이 채워졌는지'만 폴링해서 기다린다.
          await page.waitForFunction(
            (min) => (document.body?.innerText.trim().length ?? 0) > min,
            MIN_BODY_LEN,
            { timeout: 15000 },
          ).catch(() => { /* 최종 판정은 아래 rendered 검사에 맡긴다 */ });

          const title    = (await page.title()) || '';
          const bodyText = await page.locator('body').innerText();
          const rendered = /ezdown|이지다운/i.test(title) && bodyText.trim().length > MIN_BODY_LEN;

          if (!rendered) {
            failCount++;
            const ts = kstNow();
            const symptom = `렌더 실패 (title="${title}", 본문 ${bodyText.trim().length}자 · 기준 ${MIN_BODY_LEN}자)`;
            console.log(`[FAIL][이지다운][${lang}] ${symptom} ${url} @ ${ts}`);
            await recordIssue({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status, responseTime: nav.responseTime, symptom, timestamp: ts }, { visual: true, label: `실패_이지다운렌더_${lang}` });
            expect.soft(rendered, `[이지다운][${lang}] 렌더 실패 → ${url}`).toBe(true);
            return;
          }

          // 2) 핵심 콘텐츠(후기 / FAQ 섹션) 키워드 존재 확인
          const kws     = ezdownKeywords[lang] ?? [];
          const lower   = bodyText.toLowerCase();
          const missing = kws.filter(k => !lower.includes(k.toLowerCase()));
          if (missing.length > 0) {
            failCount++;
            const ts = kstNow();
            console.log(`[FAIL][이지다운][${lang}] 누락 키워드: ${missing.join(', ')} @ ${ts}`);
            await recordIssue({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status: 200, responseTime: 0, symptom: `누락 키워드: ${missing.join(', ')}`, timestamp: ts }, { visual: true, label: `실패_이지다운콘텐츠_${lang}` });
            expect.soft(missing.length, `[이지다운][${lang}] 콘텐츠 누락: ${missing.join(', ')}`).toBe(0);
          } else {
            passCount++;
            console.log(`[PASS][이지다운][${lang}] 렌더 + 콘텐츠 정상 → ${url}`);
          }

          // 3) 깨진 이미지 — DOM(lazy-load) 대신 URL fetch 상태로 판별
          const imgs = await page.locator('img').all();
          const domReadErrors: string[] = [];
          let domReadFailureCount = 0;
          let domImagesUnverified = 0;
          for (let imageIndex = 0; imageIndex < imgs.length; imageIndex++) {
            const img = imgs[imageIndex];
            const srcRead = await readLocatorAttribute(img, 'src');
            if (srcRead.ok === false) {
              domReadFailureCount++;
              const impact = attributeReadFailureImpact(imgs.length, imageIndex, srcRead.timedOut);
              domImagesUnverified += impact.unverified;
              if (domReadErrors.length < 10) {
                domReadErrors.push(
                  `이미지 ${imageIndex + 1}/${imgs.length} · ${srcRead.timedOut ? '타임아웃' : '읽기 오류'} · ${srcRead.error}`,
                );
              }
              if (impact.stop) break;
              continue;
            }
            const src = srcRead.value;
            if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue;
            // STEP 6과 동일한 정규화 사용 — 현재 ezdown은 일반 경로만 쓰지만, Next.js 이미지로
            // 바뀌는 순간 STEP 6이 겪었던 '전량 스킵' 구멍이 여기서 재발하지 않도록 미리 통일한다.
            const { fetchUrl, displayUrl } = normalizeImageUrl(src, ezdownBase);
            if (checkedImageUrls.has(fetchUrl)) continue;
            checkedImageUrls.add(fetchUrl);
            // 상태 조회 1회 — 예외(타임아웃·접속 불가)는 status 0으로 수렴시켜 재시도 판정을 일원화한다.
            const getImgStatus = async () => {
              try { return (await page.request.get(fetchUrl, { headers, timeout: 8000 })).status(); }
              catch { return 0; }
            };
            let st = await getImgStatus();
            const firstSt = st;
            let imgRetrySkipped: 'budget' | undefined;
            // 5xx·응답없음(0)만 2초 후 1회 재시도 — 4xx는 즉시 확정 (STEP6 능동 검증과 동일 정책).
            if (st !== 200 && shouldRetryStatus(st, { url: fetchUrl })) {
              const delay = retryDelayMs(1);
              if (!retryBudgetOk(delay, 8000)) {
                imgRetrySkipped = 'budget';
              } else {
                await page.waitForTimeout(delay);
                st = await getImgStatus();
                if (st === 200) {
                  intermittentRecoveries.push({ step: 'STEP8·이지다운이미지', type: '이미지', lang, url: displayUrl, status: 200, responseTime: 0, symptom: `이미지 간헐 실패 후 재시도 회복 (최초 ${firstSt === 0 ? '응답 없음' : `HTTP ${firstSt}`})`, timestamp: kstNow(), severity: 'INFO' });
                }
              }
            }
            if (st !== 200) {
              warnCount++;
              const ts = kstNow();
              const suffix = imgRetrySkipped ? ' · 재시도 생략(예산 부족)' : '';
              const symptom = st === 0 ? `이미지 접근 불가 / 타임아웃${suffix}` : `이미지 로드 실패 (${st})${suffix}`;
              console.log(`[WARN][이지다운][이미지][${lang}] ${st === 0 ? '접근 불가' : st} ${displayUrl}`);
              await recordIssue({ step: 'STEP8·이지다운이미지', type: '이미지', lang, url: displayUrl, status: st, responseTime: 0, symptom, timestamp: ts, severity: 'WARN', retrySkipped: imgRetrySkipped }, { visual: true, locator: img, label: `경고_이지다운깨진이미지_${lang}` });
            }
          }
          if (domReadErrors.length > 0) {
            warnCount++;
            truncatedSteps.add('STEP8·이미지DOM수집');
            const ts = kstNow();
            const symptom = `DOM 이미지 속성 읽기 실패 ${domReadFailureCount}건 — 미검증 ${domImagesUnverified}/${imgs.length}개 (호출 제한 ${LOCATOR_ATTRIBUTE_TIMEOUT_MS}ms)`;
            console.log(`[WARN][이지다운][이미지][${lang}] ${symptom} ${url} @ ${ts}`);
            await recordIssue({
              step: 'STEP8·이지다운이미지', type: '이미지', lang, url, status: 0,
              responseTime: 0, symptom, timestamp: ts, severity: 'WARN',
              diagnosticDetails: domReadErrors,
            });
          }
        } catch (e) {
          // 진입 실패(404/타임아웃)는 위 gotoWithRetry가 status로 처리하므로,
          // 여기 남는 건 렌더 판정·이미지 점검 중 발생한 예외뿐이다. 증상을 뭉뚱그려
          // '접속 불가'로 적으면 원인이 사라지므로 실제 예외 메시지를 남긴다.
          failCount++;
          const ts = kstNow();
          const symptom = `점검 중 예외: ${(e as Error).message.split('\n')[0].slice(0, 120)}`;
          console.log(`[ERROR][이지다운][${lang}] ${symptom} ${url} @ ${ts}`);
          await recordIssue({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status: 0, responseTime: 0, symptom, timestamp: ts });
          expect.soft(null, `[이지다운][${lang}] ${symptom} → ${url}`).not.toBeNull();
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 9: SSL 인증서 만료 점검 (ezlab.im / ezdown.kr)
  //   만료되면 전 서비스가 동시에 죽으므로 사전 경고가 목적.
  //   D-7 이하: FAIL(Slack·이슈로 알림 — 자동갱신이 안 됐다는 신호)
  //   D-14 이하: WARN(대시보드 조기 경고)  /  만료됨: FAIL
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 9');
  await test.step('STEP 9 · SSL 인증서 만료 점검 (ezlab.im / ezdown.kr)', async () => {
    const CERT_FAIL_DAYS = 7;
    const CERT_WARN_DAYS = 14;
    const certHosts = ['ezlab.im', 'ezdown.kr'];
    // 만료일을 대시보드 표시용 YYYY-MM-DD로 정리 (파싱 실패 시 원문 유지)
    const fmtValid = (v: string) => { const d = new Date(v); return isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10); };
    for (const host of certHosts) {
      if (budgetHit('STEP9·인증서')) { console.log('[SKIP][인증서] 시간 예산 초과 — 이후 호스트 건너뜀'); break; }
      await test.step(`[인증서][${host}] 만료일 확인`, async () => {
        // 재시도는 '순수 연결 타임아웃'에만 1회 — 만료·호스트 불일치·검증 실패는 재시도로
        // 달라지지 않는 확정 상태라 즉시 판정한다(재시도하면 진짜 만료 신호만 늦게 뜬다).
        const isConnTimeout = (m: string) => /^timeout$|ETIMEDOUT/i.test(m);
        let certInfo: { daysLeft: number; validTo: string } | null = null;
        let lastMsg = '';
        let certAttempts = 1;
        let certRetrySkipped: 'budget' | undefined;
        try { certInfo = await checkCertExpiry(host); }
        catch (e) {
          lastMsg = (e as Error).message || '확인 실패';
          if (isConnTimeout(lastMsg)) {
            const delay = retryDelayMs(1);
            if (!retryBudgetOk(delay, 10000)) { // checkCertExpiry 기본 타임아웃 10s
              certRetrySkipped = 'budget';
            } else {
              await page.waitForTimeout(delay);
              certAttempts = 2;
              try { certInfo = await checkCertExpiry(host); }
              catch (e2) { lastMsg = (e2 as Error).message || '확인 실패'; }
            }
          }
        }
        if (!certInfo) {
          // 핸드셰이크 실패는 STEP 1에서 서버 장애로 이미 잡히므로 여기선 WARN으로만.
          warnCount++;
          const ts = kstNow();
          const suffix = certRetrySkipped ? ' · 재시도 생략(예산 부족)' : certAttempts > 1 ? ' (2회 시도)' : '';
          console.log(`[WARN][인증서][${host}] 확인 실패: ${lastMsg}${suffix} @ ${ts}`);
          await recordIssue({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom: `인증서 확인 실패: ${lastMsg}${suffix}`, timestamp: ts, severity: 'WARN', retrySkipped: certRetrySkipped });
          certResults.push({ host, daysLeft: null, validTo: '', status: 'ERROR' });
          return;
        }
        if (certAttempts > 1) {
          intermittentRecoveries.push({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 200, responseTime: 0, symptom: '연결 타임아웃 후 재시도 회복', timestamp: kstNow(), severity: 'INFO' });
        }
        {
          const { daysLeft, validTo } = certInfo;
          if (daysLeft < 0 || daysLeft <= CERT_FAIL_DAYS) {
            failCount++;
            const ts = kstNow();
            const symptom = daysLeft < 0
              ? `SSL 인증서 만료됨 (만료일 ${validTo})`
              : `SSL 인증서 만료 임박 D-${daysLeft} (만료일 ${validTo}) — 자동갱신 확인 필요`;
            console.log(`[FAIL][인증서][${host}] ${symptom} @ ${ts}`);
            await recordIssue({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom, timestamp: ts });
            certResults.push({ host, daysLeft, validTo: fmtValid(validTo), status: 'FAIL' });
            expect.soft(daysLeft, `[인증서][${host}] ${symptom}`).toBeGreaterThan(CERT_FAIL_DAYS);
          } else if (daysLeft <= CERT_WARN_DAYS) {
            warnCount++;
            const ts = kstNow();
            const symptom = `SSL 인증서 만료 임박 D-${daysLeft} (만료일 ${validTo})`;
            console.log(`[WARN][인증서][${host}] ${symptom}`);
            await recordIssue({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
            certResults.push({ host, daysLeft, validTo: fmtValid(validTo), status: 'WARN' });
          } else {
            passCount++;
            console.log(`[PASS][인증서][${host}] 만료까지 D-${daysLeft} (만료일 ${validTo})`);
            certResults.push({ host, daysLeft, validTo: fmtValid(validTo), status: 'PASS' });
          }
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 4-1: 실제 설치 파일 URL 검증
  // 기존 검사는 페이지의 a[href*=".exe"] 를 훑었는데, 다운로드가 JS 기반이라
  // 실측 0건이었다 — 검사가 도는 것처럼 보이는데 커버리지가 0인 미탐 상태였다.
  // 실제 배포 URL은 /api/tools/info 가 내려주므로 그것을 기준으로 검증한다.
  // 파일을 실제로 내려받지 않기 위해 HEAD → (막히면) 스트리밍 Range 순으로 확인한다.
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 4-1');

  await test.step('STEP 4-1 · 설치 파일 URL 검증', async () => {
    const fileUrls = new Set<string>();
    for (const lang of languages) {
      if (budgetHit('STEP4-1·파일수집')) { console.log('[SKIP][파일] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
      const infoUrl = `${baseUrl}/api/tools/info?locale=${lang}`;
      try {
        const res = await page.request.get(infoUrl, { headers: ownHeaders, timeout: REQUEST_TIMEOUT_MS });
        if (!httpIsOk(res.status(), infoUrl, 'GET')) {
          warnCount++;
          const ts = kstNow();
          console.log(`[WARN][파일][${lang}] 도구 정보 API 응답 이상 (${res.status()}) ${infoUrl}`);
          await recordIssue({ step: 'STEP4-1·파일URL', type: '파일', lang, url: infoUrl, status: res.status(), responseTime: 0, symptom: `설치 파일 목록 API 응답 이상 (HTTP ${res.status()}) — 파일 검증 불가`, timestamp: ts, severity: 'WARN' });
          continue;
        }
        const body = await res.text();
        for (const m of body.matchAll(/https:\/\/[^"'\\\s]+?\.(?:exe|apk|zip|dmg|msi|pkg)/gi)) fileUrls.add(m[0]);
      } catch {
        warnCount++;
        const ts = kstNow();
        console.log(`[WARN][파일][${lang}] 도구 정보 API 접근 불가 ${infoUrl}`);
        await recordIssue({ step: 'STEP4-1·파일URL', type: '파일', lang, url: infoUrl, status: 0, responseTime: 0, symptom: '설치 파일 목록 API 접근 불가 — 파일 검증 불가', timestamp: ts, severity: 'WARN' });
      }
    }

    // 커버리지 0을 조용히 통과시키지 않는다 — 이게 기존 미탐의 본질이었다.
    if (fileUrls.size === 0) {
      warnCount++;
      const ts = kstNow();
      const symptom = '설치 파일 URL을 한 건도 수집하지 못함 — 파일 서버 점검 커버리지 0';
      console.log(`[WARN][파일] ${symptom} @ ${ts}`);
      await recordIssue({ step: 'STEP4-1·파일URL', type: '파일', lang: '-', url: `${baseUrl}/api/tools/info`, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
      return;
    }

    // 모바일 전용 제품은 데스크톱 설치 파일 검증 대상이 아니다 — 검사 전에 걸러 SKIP 으로 남긴다.
    for (const fileUrl of [...fileUrls]) {
      const m = mobileOnly(fileUrl);
      if (m) {
        fileUrls.delete(fileUrl);
        recordPolicySkip('STEP4-1·파일URL', m.product, fileUrl, m.reason);
      }
    }
    console.log(`[INFO][파일] 설치 파일 ${fileUrls.size}건 수집 — HEAD/Range로 존재 확인`);
    for (const fileUrl of fileUrls) {
      if (budgetHit('STEP4-1·파일검증')) { console.log('[SKIP][파일] 시간 예산 초과 — 이후 파일 건너뜀'); break; }
      const name = fileUrl.split('/').pop() ?? fileUrl;
      let status = 0;
      let note = '';
      let fileRetrySkipped: 'budget' | undefined;
      try {
        // HEAD는 본문을 받지 않아 안전하다 — 1차로 여기서 판정한다.
        const head = await page.request.head(fileUrl, { headers: ownHeaders, timeout: 8000 });
        status = head.status();
        if (status !== 200 && status !== 206) {
          // HEAD를 막는 CDN(405/403)일 수 있어 Range로 재확인한다. 본문 버퍼링을 피하려고
          // page.request.get이 아니라 스트리밍 프로브를 쓴다(206 아니면 헤더 시점에 연결 파기).
          let probe = await probeFileRange(fileUrl, ownHeaders);
          // Range 프로브에 한해 5xx·응답없음(0)만 2초 후 1회 재시도 — 4xx(권한·존재)는 즉시 확정.
          if (probe.status === 0 || probe.status >= 500) {
            const delay = retryDelayMs(1);
            if (!retryBudgetOk(delay, 8000)) {
              fileRetrySkipped = 'budget';
              probe = { ...probe, note: (probe.note ? probe.note + ' · ' : '') + '재시도 생략(예산 부족)' };
            } else {
              await page.waitForTimeout(delay);
              const firstProbe = probe;
              probe = await probeFileRange(fileUrl, ownHeaders);
              if (probe.status === 206 || probe.status === 200) {
                intermittentRecoveries.push({ step: 'STEP4-1·파일URL', type: '파일', lang: '-', url: fileUrl, status: probe.status, responseTime: 0, symptom: `파일 Range 간헐 실패 후 재시도 회복 (최초 ${firstProbe.status === 0 ? '응답 없음' : `HTTP ${firstProbe.status}`})`, timestamp: kstNow(), severity: 'INFO' });
              }
            }
          }
          const rangeOk = /^bytes\s+0-0\/\d+/i.test(probe.contentRange);
          // bytes=0-0 은 정확히 1바이트가 와야 한다. 2바이트 이상이면 서버가 Range를 제대로
          // 지키지 않은 것이라 '앞 1바이트만 받았다'는 전제가 깨진다 → 정상으로 보지 않는다.
          if (probe.status === 206 && rangeOk && probe.bytes === 1) {
            status = 206;
            note = 'Range 확인 (1B 수신)';
          } else if (probe.status === 206) {
            // 206인데 Content-Range가 깨졌거나 수신량이 1바이트가 아니면 파일 존재를 확인한 게 아니다.
            status = 0;
            note = !rangeOk ? `Content-Range 형식 이상: "${probe.contentRange || '(없음)'}"`
                            : `206이지만 수신 바이트 ${probe.bytes} (1바이트 기대)`;
          } else {
            status = probe.status;
            note = probe.note;
          }
        }
      } catch (e) {
        status = 0;
        note = (e as Error).message.split('\n')[0].slice(0, 60);
      }

      if (status === 200 || status === 206) {
        passCount++;
        console.log(`[PASS][파일] ${status} ${name}${note ? ` (${note})` : ''}`);
      } else {
        // 설치 파일을 못 받는 것은 다운로드 기능 자체가 죽은 것 — WARN이 아니라 FAIL.
        // (모바일 전용 제품은 위에서 이미 제외됐다)
        failCount++;
        const ts = kstNow();
        const symptom = status === 0
          ? `설치 파일 접근 불가${note ? ` (${note})` : ''}`
          : `설치 파일 응답 이상 (HTTP ${status})${note ? ` · ${note}` : ''}`;
        console.log(`[FAIL][파일] ${status} ${fileUrl} — ${symptom} @ ${ts}`);
        await recordIssue({ step: 'STEP4-1·파일URL', type: '파일', lang: '-', url: fileUrl, status, responseTime: 0, symptom, timestamp: ts, retrySkipped: fileRetrySkipped });
        expect.soft(status === 200 || status === 206, `[파일] ${symptom} → ${fileUrl}`).toBe(true);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 4: 서비스별 다운로드 링크 직접 검증 (STEP 3에서 자동 수집)
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 4');
  await test.step('STEP 4 · 서비스별 다운로드 페이지 직접 검증', async () => {
    const toolTargets = [...discoveredToolUrls].map(url => ({
      name: url.split('/').pop() ?? url,
      url,
    }));
    console.log(`[INFO] STEP 4 대상 서비스 페이지 ${toolTargets.length}개 자동 수집: ${toolTargets.map(t => t.name).join(', ')}`);
    for (const target of toolTargets) {
      // 4개 언어 확장으로 대상이 최대 24개 — 사이트가 느린 날 전체 타임아웃(10분)을 넘겨
      // 최종 리포트 저장이 날아가지 않도록, 안전 시점 이후엔 남은 항목을 스킵한다.
      if (budgetHit('STEP4·다운로드')) {
        step4Stats.skipped = toolTargets.length - step4Stats.verified;
        console.log(`[SKIP][다운로드] 시간 예산 초과 — 이후 ${step4Stats.skipped}건 건너뜀 (리포트 저장 여유 확보)`);
        break;
      }
      step4Stats.verified++;
      await test.step(`[다운로드][${target.name}]`, async () => {
        const tlang = target.url.match(/\/(ko|en|jp|tw)\//)?.[1] ?? 'ko'; // URL에서 언어 추출 (ko 고정 제거)
        try {
          visitedUrls.add(target.url); // 최종 집계에 포함
          // 간헐 오리진 404/타임아웃 오탐 방지: 실패 시 짧은 백오프로 재확인 후 판정
          const nav = await gotoWithRetry(target.url);
          const responseTime = nav.responseTime;
          const status = nav.status;

          // 재시도로 회복된 항목(간헐)은 페이지가 살아있으므로 즉시 WARN을 매기지 않는다.
          // STEP 3(checkUrl)은 같은 상황을 PASS + 메모로 처리하는데 여기만 WARN이면 판정이 어긋나고,
          // 무엇보다 대상이 20여 개라 건당 1%대 확률만으로도 런 5개 중 1개가 노란불이 된다.
          // → 일단 모아두고, 한 런에 임계치 이상 몰릴 때만 아래 '간헐 회복 종합 판정'에서 WARN 승격.
          if (status === 200 && nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][다운로드][${target.name}] 간헐 실패 후 ${nav.attempts}회차 회복 (${responseTime}ms)${detail} ${target.url} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'INFO' });
          }

          // 모바일 전용 제품은 다운로드 버튼 검사 대상이 아니다.
          // 페이지 생존(status) 검사는 그대로 두고, 버튼 검사만 건너뛴다.
          const mobilePolicy = mobileOnly(target.url);
          let hasDownloadLink = false;
          if (status === 200 && !mobilePolicy) {
            const dlLinks = await page.locator('a[href*=".exe"], a[href*=".apk"], a[href*=".zip"], a[href*="download"]').all();
            // 다운로드 CTA가 언어별로 <button>/<a>가 아니라 btn-class <div> 등으로 렌더되는 경우가 있어
            // (ko는 <button>, en/jp/tw는 다른 요소) 요소 종류를 넓히고 텍스트를 정규식으로 매칭 — 오탐 방지.
            const dlButtons = await page.locator('button, a, [role="button"], [class*="btn" i], [class*="download" i]')
              .filter({ hasText: /다운로드|download|ダウンロード|下載/i }).all();
            hasDownloadLink = dlLinks.length > 0 || dlButtons.length > 0;
          }

          if (status !== 200) {
            failCount++;
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            const symptom = status === 0
              ? `응답 없음 (${nav.attempts}회 시도)${detail}`
              : `HTTP ${status} 응답 (${nav.attempts}회 시도)${detail}`;
            console.log(`[FAIL][다운로드][${target.name}] ${status} (${responseTime}ms, ${nav.attempts}회 시도) ${target.url} @ ${ts}`);
            await recordIssue({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom, timestamp: ts, retrySkipped: nav.retrySkipped }, { visual: true, label: `실패_다운로드_${target.name}_${tlang}` });
            expect.soft(status, `[다운로드][${target.name}] 페이지 응답 실패(${nav.attempts}회 시도) → ${target.url}`).toBe(200);
          } else if (mobilePolicy) {
            // PASS 로 올리지 않는다 — 검사한 적이 없으므로 SKIP 으로만 남긴다.
            recordPolicySkip('STEP4·다운로드', mobilePolicy.product, target.url, mobilePolicy.reason);
          } else if (!hasDownloadLink) {
            warnCount++;
            const ts = kstNow();
            console.log(`[WARN][다운로드][${target.name}] 페이지 정상이나 다운로드 버튼 미감지 ${target.url}`);
            await recordIssue({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom: '페이지는 정상이나 다운로드 버튼 미감지', timestamp: ts, severity: 'WARN' }, { visual: true, label: `경고_다운로드버튼미감지_${target.name}` });
          } else {
            passCount++;
            console.log(`[PASS][다운로드][${target.name}] ${status} (${responseTime}ms) 다운로드 버튼 확인 ${target.url}`);

            // 파일 URL은 STEP4 뒤에서 한 번에 검증한다 — 다운로드가 JS 기반이라
            // 페이지의 <a href>로는 하나도 못 찾았고(실측 0건), 실제 URL은 /api/tools/info 가 준다.
          }
        } catch (e) {
          // 접속 불가/타임아웃은 gotoWithRetry가 status 0으로 위에서 처리 —
          // 여기는 DOM/파일 검증 중 발생한 예외만 잡는다.
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][다운로드][${target.name}] 검증 중 예외: ${target.url} @ ${ts}`);
          await recordIssue({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status: 0, responseTime: 0, symptom: '검증 중 예외', timestamp: ts });
          expect.soft(null, `[다운로드][${target.name}] 검증 중 예외 → ${target.url}`).not.toBeNull();
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 3: UI 링크 전수조사 (내부/외부 분리)
  // ══════════════════════════════════════════════════════════════════
  stepMark('STEP 3');
  await test.step('STEP 3 · UI 링크 전수조사 (ko / en / jp / tw)', async () => {
    // 크롤이 시간 예산에 걸려 잘리면 '점검 안 한 링크'가 생기는데, 기존엔 조용히 끝나서
    // 리포트가 '이상 없음'으로 보였다. 잘렸다는 사실 자체를 한 번은 남긴다.
    let crawlTruncated = false;
    // 예산 초과(truncated) 말고도 크롤이 '링크를 다 못 본' 경로가 셋 더 있다.
    // 렌더 실패 · 링크 수집 예외 · term 페이지 진입 실패. 예전엔 WARN만 남기거나(앞 둘)
    // 조용히 SKIP 해서(term), 실제로 링크를 놓쳤는데도 coverageComplete=true 가 됐다.
    const crawlIncomplete = new Set<string>();
    for (const lang of languages) {
      await test.step(`[${lang}] <a> 링크 수집 및 점검 (depth 2)`, async () => {
        const crawledPages = new Set<string>();
        const termPagesFound = new Set<string>(); // depth 무관하게 term 페이지 수집

        async function crawlPage(pageUrl: string, depth: number) {
          // 전체 test 타임아웃(10분) 전에 크롤을 자진 종료 — 크롤이 밀려 최종 리포트
          // 저장까지 못 가는 상황 방지. 예산 초과 시 남은 링크는 스킵하고 정상 종료.
          if (outOfBudget()) { crawlTruncated = true; return; }
          const cleanUrl = pageUrl.split('?')[0];
          if (crawledPages.has(cleanUrl)) return;
          crawledPages.add(cleanUrl);

          let navAttempts = 1;
          let navRetrySkipped: 'budget' | undefined;
          try {
            try {
              await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch (navErr) {
              // 크롤 네비 실패는 2초 후 1회만 재시도 — 회복하면 INFO, 재실패는 기존 WARN 그대로.
              const delay = retryDelayMs(1);
              if (!retryBudgetOk(delay, 15000)) { navRetrySkipped = 'budget'; throw navErr; }
              await page.waitForTimeout(delay);
              navAttempts = 2;
              await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); // 재실패 → 바깥 catch
              intermittentRecoveries.push({ step: 'STEP3·크롤', type: '크롤', lang, url: cleanUrl, status: 200, responseTime: 0, symptom: '크롤 네비 간헐 실패 후 재시도 회복 (2회 시도)', timestamp: kstNow(), severity: 'INFO' });
            }
            crawlStats.pagesCompleted++;
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(500);
          } catch {
            // 기존엔 로그만 남기고 조용히 빠졌다. 그러면 진입점(depth 0)이 실패했을 때
            // 그 언어의 크롤이 통째로 사라지는데 카운터·리포트엔 흔적이 없어(미탐),
            // '점검했는데 아무 문제 없음'과 '아예 점검을 못 함'이 구분되지 않았다.
            warnCount++;
            const ts = kstNow();
            crawlIncomplete.add(depth === 0 ? '진입점렌더실패' : '페이지렌더실패');
            const suffix = navRetrySkipped ? ' · 재시도 생략(예산 부족)' : navAttempts > 1 ? ' (2회 시도)' : '';
            const symptom = (depth === 0
              ? `크롤 진입점 렌더 실패 — [${lang}] 링크 전수조사 미실행`
              : `크롤 대상 페이지 렌더 실패 (depth ${depth}) — 하위 링크 미점검`) + suffix;
            console.log(`[WARN][크롤][${lang}][depth${depth}] ${symptom}: ${pageUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP3·크롤', type: '크롤', lang, url: cleanUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN', retrySkipped: navRetrySkipped }, { visual: true, label: `실패_크롤_${lang}_depth${depth}` });
            return;
          }

          const internalToFollow: string[] = [];
          try {
            const links = await page.locator('a').all();
            console.log(`[INFO][${lang}][depth${depth}] ${pageUrl} → ${links.length}개 링크 발견`);

            for (const link of links) {
              // 링크 단위로도 예산 확인 — 링크가 많은 페이지에서 데드라인을 넘겨도
              // 페이지 진입 시점 체크만으론 못 멈추므로 여기서 끊는다.
              if (outOfBudget()) { crawlTruncated = true; break; }
              const rawUrl = await link.getAttribute('href');
              if (!rawUrl || rawUrl.startsWith('#') || rawUrl.startsWith('javascript:') || rawUrl.startsWith('mailto:')) continue;
              if (/\.(exe|apk|zip|dmg|msi|pkg)$/i.test(rawUrl)) continue; // 다운로드 파일 스킵

              // 현재 페이지 기준으로 상대경로를 정확히 해석 — 루트 기준 강제 결합 시
              // href="sub/page" 류가 잘못된 URL이 되어 404 오탐이 날 수 있다.
              const parsed = (() => { try { return new URL(rawUrl, pageUrl); } catch { return null; } })();
              if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) continue; // tel: 등 비HTTP 스킴 스킵
              parsed.hash = ''; // #fragment만 다른 동일 페이지 중복 점검 방지
              const url = parsed.href;

              const isInternal = parsed.origin === baseUrl;
              await checkUrl('UI', lang, url, isInternal);
              crawlStats.linksChecked++;

              if (isInternal) {
                if (depth < 1) internalToFollow.push(url);
                if (url.includes('/term/')) termPagesFound.add(url.split('?')[0]);
                // trailing slash·쿼리·해시가 붙은 tool 링크도 STEP4 대상에 포함 —
                // 기존 `[^/]+$`는 /ko/tool/ezcapture/ (슬래시로 끝) 를 놓쳐 해당 다운로드 페이지가 미점검됐다.
                if (TOOL_URL_RE.test(url)) {
                  const tool = url.split('?')[0];
                  // STEP4는 이미 STEP5 수집분으로 끝났다. 여기서 새로 나오면 STEP5가 놓친 것이다.
                  if (!toolUrlsFromMain.has(tool)) step4Stats.discoveredFromCrawl++;
                  discoveredToolUrls.add(tool);
                }
              }
            }
          } catch {
            // 링크 수집이 중간에 끊기면 그 페이지의 나머지 링크는 점검되지 않은 채 넘어간다 → 기록 필요.
            warnCount++;
            const ts = kstNow();
            crawlIncomplete.add('링크수집예외');
            const symptom = '링크 수집 중 예외 — 해당 페이지의 잔여 링크 미점검';
            console.log(`[WARN][크롤][${lang}][depth${depth}] ${symptom}: ${pageUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP3·크롤', type: '크롤', lang, url: cleanUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' }, { visual: true, label: `실패_크롤_${lang}_depth${depth}` });
          }

          for (const nextUrl of internalToFollow) {
            await crawlPage(nextUrl, depth + 1);
          }
        }

        await crawlPage(`${baseUrl}/${lang}`, 0);

        // depth 무관하게 발견된 term 페이지에서 탭 버튼 클릭으로 숨겨진 URL 감지
        for (const termUrl of termPagesFound) {
          if (outOfBudget()) { crawlTruncated = true; break; } // 크롤 예산 공유
          if (crawledPages.has(termUrl)) continue;
          crawledPages.add(termUrl);
          let termAttempts = 1;
          let termRetrySkipped: 'budget' | undefined;
          try {
            try {
              await page.goto(termUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch (navErr) {
              // 크롤 본체와 동일 — 네비 실패는 2초 후 1회만 재시도.
              const delay = retryDelayMs(1);
              if (!retryBudgetOk(delay, 15000)) { termRetrySkipped = 'budget'; throw navErr; }
              await page.waitForTimeout(delay);
              termAttempts = 2;
              await page.goto(termUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              intermittentRecoveries.push({ step: 'STEP3·크롤', type: '크롤', lang, url: termUrl, status: 200, responseTime: 0, symptom: 'term 페이지 간헐 실패 후 재시도 회복 (2회 시도)', timestamp: kstNow(), severity: 'INFO' });
            }
            await page.waitForSelector('button.flex-1', { timeout: 5000 }).catch(() => {});
            const tabCount = await page.locator('button.flex-1').count();
            for (let i = 0; i < tabCount; i++) {
              try {
                const currentUrl = page.url().split('?')[0];
                await page.locator('button.flex-1').nth(i).click({ timeout: 3000 });
                await page.waitForTimeout(500);
                const newUrl = page.url().split('?')[0];
                if (newUrl !== currentUrl && newUrl.startsWith(baseUrl)) {
                  console.log(`[INFO][${lang}][tab] 버튼 클릭으로 발견된 URL: ${newUrl}`);
                  await checkUrl('UI', lang, newUrl, true);
                  await page.goto(termUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                  await page.waitForSelector('button.flex-1', { timeout: 5000 }).catch(() => {});
                }
              } catch {
                // 클릭 불가한 버튼은 무시
              }
            }
          } catch {
            // 조용히 넘기면 term 탭에 숨은 링크를 통째로 못 본 채 '이상 없음'이 된다.
            warnCount++;
            crawlIncomplete.add('term페이지진입실패');
            const ts = kstNow();
            const suffix = termRetrySkipped ? ' · 재시도 생략(예산 부족)' : termAttempts > 1 ? ' (2회 시도)' : '';
            const symptom = `term 페이지 진입 실패 — 탭으로 전환되는 숨은 링크 미점검${suffix}`;
            console.log(`[WARN][${lang}][tab] ${symptom}: ${termUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP3·크롤', type: '크롤', lang, url: termUrl,
                                status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN', retrySkipped: termRetrySkipped });
          }
        }
      });
    }

    // 크롤이 잘렸다는 사실을 리포트에 한 번 남긴다. 이게 없으면 '점검해서 문제없음'과
    // '시간이 없어 점검을 덜 함'이 리포트에서 똑같이 초록불로 보인다.
    crawlStats.truncated = crawlTruncated;
    crawlStats.incomplete = [...crawlIncomplete].sort();
    // 예산 초과가 아니어도 링크를 다 못 봤으면 완주가 아니다.
    if (crawlIncomplete.size > 0) truncatedSteps.add('STEP3·크롤불완전');
    // STEP4는 STEP5 수집분으로 이미 끝났다. 크롤이 뒤늦게 도구 URL을 더 찾아냈다면
    // 그만큼 다운로드 점검이 축소된 것이므로 커버리지 누락으로 남긴다.
    if (step4Stats.discoveredFromCrawl > 0) {
      warnCount++;
      truncatedSteps.add('STEP4·도구URL누락');
      const ts = kstNow();
      const symptom = `크롤이 도구 페이지 ${step4Stats.discoveredFromCrawl}건을 추가 발견 — STEP5 수집에서 누락돼 다운로드 점검을 못 받음`;
      console.log(`[WARN][도구수집] ${symptom} @ ${ts}`);
      await recordIssue({ step: 'STEP4·도구URL', type: '다운로드', lang: '-', url: baseUrl,
                          status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
    }
    if (step4Stats.skipped > 0) truncatedSteps.add('STEP4·미검증');
    if (crawlTruncated) {
      warnCount++;
      // 크롤 중단도 '점검이 축소된' 것이므로 반드시 미완주로 잡아야 한다.
      // 예전엔 WARN 기록만 남기고 truncatedSteps 에 넣지 않아, 크롤이 통째로 잘려도
      // 다른 STEP만 끝나면 coverageComplete=true 로 보고됐다(미탐).
      truncatedSteps.add('STEP3·크롤');
      const ts = kstNow();
      const symptom = `전체 시간 예산(${REPORT_SAFETY_MS / 60000}분) 초과로 링크 전수조사가 중단됨 — 미점검 링크 있음`;
      console.log(`[WARN][크롤] ${symptom} @ ${ts}`);
      await recordIssue({ step: 'STEP3·크롤', type: '크롤', lang: '-', url: baseUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // 예산 축소 종합 판정 — 예산 초과로 스킵된 STEP이 있으면 WARN 1건 (크롤 truncated와 동일 패턴)
  // ══════════════════════════════════════════════════════════════════
  //   예산 가드는 전체 타임아웃(UNKNOWN 오탐)은 막지만 남은 검사를 조용히 건너뛴다. 특히 마지막
  //   STEP9(인증서)가 안 돌아도 리포트가 초록/부분으로 보여 미탐이 된다 → 축소 사실을 한 번은 남긴다.
  await test.step('예산 축소 종합 판정', async () => {
    if (truncatedSteps.size === 0) {
      console.log('[INFO][예산] 예산 초과로 스킵된 STEP 없음 — 전체 점검 완주');
      return;
    }
    warnCount++;
    const ts = kstNow();
    const steps = [...truncatedSteps].join(', ');
    const symptom = `시간 예산(${REPORT_SAFETY_MS / 60000}분) 초과로 일부 점검이 스킵됨 — 미점검: ${steps}`;
    console.log(`[WARN][예산] ${symptom} @ ${ts}`);
    await recordIssue({ step: '예산·종합', type: '예산', lang: '-', url: baseUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
  });

  // ══════════════════════════════════════════════════════════════════
  // 간헐 회복 종합 판정 — 런 단위로 한 번만
  // ══════════════════════════════════════════════════════════════════
  //   재시도로 회복한 항목은 사용자에게 페이지가 정상으로 보인 케이스다. 개별 기록은 항상
  //   INFO(정보성)로 남겨 런 상태·스코어에 반영하지 않고, '서로 다른 정규화 지문'이 임계치
  //   이상 회복됐을 때만 '오리진 불안정' 종합 WARN 1건으로 승격한다. 같은 경로가 여러 언어에서
  //   반복 회복돼도 지문은 하나이므로 단일 경로 blip이 임계치를 넘기는 오탐이 없다.
  await test.step('간헐 회복 종합 판정', async () => {
    if (intermittentRecoveries.length === 0) {
      console.log('[INFO][간헐] 재시도 회복 항목 없음');
      return;
    }
    // 개별 회복은 항상 INFO로 기록한다 — INFO는 증거 이미지 의무 대상이 아니다(recordIssue 규칙).
    for (const r of intermittentRecoveries) await recordIssue(r);
    const recoveryFingerprints = new Set(intermittentRecoveries.map(r => r.fingerprint ?? fingerprintOf(r)));
    const targets = [...new Set(intermittentRecoveries.map(r => r.url))].join(', ');
    const recoveryDetails = intermittentRecoveries.map((recovery, index) => [
      `[${index + 1}] ${recovery.step} · ${recovery.lang}`,
      recovery.url,
      recovery.symptom,
    ].join('\n'));
    if (recoveryFingerprints.size >= INTERMITTENT_WARN_THRESHOLD) {
      warnCount++;
      const ts = kstNow();
      const symptom = `오리진 간헐 불안정 — 재시도 회복 ${intermittentRecoveries.length}건 · 지문 ${recoveryFingerprints.size}종 (임계 ${INTERMITTENT_WARN_THRESHOLD}종)`;
      console.log(`[WARN][간헐] ${symptom}: ${targets} @ ${ts}`);
      // 종합 1건(WARN) + 개별 근거(INFO)를 함께 남겨 개발팀이 어느 경로가 흔들렸는지 볼 수 있게 한다.
      await recordIssue({
        step: '간헐·종합', type: '간헐', lang: '-', url: baseUrl, status: 200, responseTime: 0,
        symptom, timestamp: ts, severity: 'WARN', diagnosticDetails: recoveryDetails,
      });
    } else {
      // 지문 1종은 정상 범위(단일 경로 순간 지연) — 런 상태를 바꾸지 않되 추이 관찰용으로 로그만 남긴다.
      console.log(`[INFO][간헐] 재시도 회복 ${intermittentRecoveries.length}건 · 지문 ${recoveryFingerprints.size}종 (임계 ${INTERMITTENT_WARN_THRESHOLD}종 미만 → 런 상태 미반영): ${targets}`);
    }
    await test.info().attach('간헐 회복 내역', {
      body: intermittentRecoveries
        .map((r, i) => `[${i + 1}] ${r.step} | ${r.lang} | ${r.timestamp}\n     ${r.url}\n     ${r.symptom}`)
        .join('\n\n'),
      contentType: 'text/plain; charset=utf-8',
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 최종 요약 + 배지용 JSON 저장
  // ══════════════════════════════════════════════════════════════════
  const totalCount = passCount + failCount + warnCount + slowCount + infoCount;
  // STEP 구간 계산 — 마지막 STEP은 여기까지를 소요로 본다.
  stepMark('종료');
  for (let i = 0; i < stepMarks.length - 1; i++) {
    stepTimings.push({ step: stepMarks[i].step, ms: stepMarks[i + 1].at - stepMarks[i].at });
  }

  // 증거 보완은 요약·장애 리포트를 만들기 '전'에 끝내야 한다.
  // 뒤에서 돌리면 리포트가 shotCount를 0으로 읽어 '캡처된 화면이 없습니다'라고 적은 뒤에
  // 실제 진단 카드가 생성돼, 리포트 내용과 아티팩트가 어긋난다.
  await ensureEvidence();

  const status = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'PASS';
  const color = failCount > 0 ? 'red' : warnCount > 0 ? 'yellow' : 'brightgreen';
  const checkTime = kstNow();

  const duration  = Math.round((Date.now() - testStartTime) / 1000);
  const sep       = '═'.repeat(64);
  const sep2      = '─'.repeat(64);

  // ── 전체 점검 요약 (항상 첨부) ─────────────────────────────────
  const summaryLines = [
    sep,
    '이지랩 헬스체크 · 전체 점검 요약',
    `실행 시각 : ${checkTime} (KST)`,
    `소요 시간 : ${duration}초`,
    sep2,
    '[전체 결과]',
    `  PASS ${passCount}  /  FAIL ${failCount}  /  WARN ${warnCount}  /  SLOW ${slowCount}  /  INFO ${infoCount}  /  TOTAL ${totalCount}`,
    `  ※ SLOW(${SLOW_MS / 1000}초 초과 응답)는 정보성 지표 — 헬스 스코어에 반영되지 않음`,
    `  ※ INFO(외부 링크 등 제3자 자원 이상)도 정보성 지표 — 헬스 스코어에 반영되지 않음`,
    `  ※ 간헐 회복 ${intermittentRecoveries.length}건(INFO) — 서로 다른 지문 ${INTERMITTENT_WARN_THRESHOLD}종 이상일 때만 종합 WARN 승격`,
    sep2,
    '[점검 범위]',
    `  페이지 / 링크 : ${visitedUrls.size}개`,
    `  이미지        : ${checkedImageUrls.size}개`,
    `  API           : ${apiRecords.length}개`,
    sep2,
    '[STEP별 상태]',
    `  STEP 1 · 서버 생존 확인 (ko/en/jp/tw)`,
    `  STEP 2 · API 자동 수집 및 검증 (${apiRecords.length}건)`,
    `  STEP 3 · UI 링크 전수조사`,
    `  STEP 4 · 다운로드 페이지 + 실제 파일 URL 검증`,
    `  STEP 5 · 언어별 핵심 콘텐츠 무결성 확인`,
    `  STEP 6 · 깨진 이미지 감지`,
    `  STEP 7 · 언어별 로그인 버튼 렌더링 확인`,
    `  STEP 8 · 이지다운(ezdown.kr) 정보 페이지 점검`,
    `  STEP 9 · SSL 인증서 만료 점검 (ezlab.im / ezdown.kr)`,
  ];

  // 스코어에 반영되는 기록(FAIL/WARN)과 정보성 기록(INFO)을 구분한다.
  // 전건이 INFO면 런은 PASS인데 제목만 '장애 항목'이라 리포트를 읽는 사람이 장애로 오해한다.
  const scoredRecords = failRecords.filter(r => r.severity !== 'INFO');

  if (failRecords.length > 0) {
    const affectedTypes = [...new Set(failRecords.map(r => r.type))].join(', ');
    summaryLines.push(sep2);
    summaryLines.push(
      scoredRecords.length > 0
        ? `[장애 항목]  영향 범위: ${affectedTypes}`
        : `[참고 항목]  스코어 미반영(외부 자원)  ·  영향 범위: ${affectedTypes}`
    );
    failRecords.forEach((r, i) => {
      summaryLines.push('');
      summaryLines.push(`  [${i + 1}] ${r.step}  |  ${r.type}  |  언어: ${r.lang}`);
      summaryLines.push(`       발생 시각 : ${r.timestamp}`);
      summaryLines.push(`       URL       : ${r.url}`);
      summaryLines.push(`       상태코드  : ${r.status === 0 ? '응답 없음 (타임아웃)' : String(r.status)}`);
      summaryLines.push(`       응답 시간 : ${r.responseTime === 0 ? '-' : r.responseTime + 'ms'}`);
      summaryLines.push(`       증상      : ${r.symptom}`);
      summaryLines.push(`       기대값    : HTTP 200 OK`);
    });
  }

  summaryLines.push(sep);

  await test.info().attach('전체 점검 요약', {
    body: summaryLines.join('\n'),
    contentType: 'text/plain; charset=utf-8'
  });

  // ── 장애 리포트 (FAIL/WARN 있을 때 개발팀 전달용) ───────────────
  // INFO만 있는 런(외부 링크만 이상)은 이지랩 장애가 아니므로 개발팀 전달용 리포트를 만들지 않는다.
  // 기록 자체는 위 '전체 점검 요약'의 [참고 항목]과 대시보드에 남는다.
  if (scoredRecords.length > 0) {
    const affectedTypes = [...new Set(failRecords.map(r => r.type))].join(', ');
    const failLines = failRecords.map((r, i) => [
      `[${i + 1}] ${r.step}  |  유형: ${r.type}  |  언어: ${r.lang}`,
      `    발생 시각 : ${r.timestamp}`,
      `    URL       : ${r.url}`,
      `    상태코드  : ${r.status === 0 ? '응답 없음 (타임아웃)' : String(r.status)}`,
      `    응답 시간 : ${r.responseTime === 0 ? '-' : r.responseTime + 'ms'}`,
      `    증상      : ${r.symptom}`,
      `    기대값    : HTTP 200 OK`,
      `    조치 필요 : ${
        r.type === '서버'    ? '서버/인프라 팀 확인 요청' :
        r.type === 'API'     ? '백엔드 팀 확인 요청' :
        r.type === '다운로드' ? '다운로드 링크 및 파일 서버 확인' :
        r.type === '파일'    ? '파일 서버 / CDN 확인' :
        r.type === '콘텐츠'  ? '프론트엔드 배포 확인' :
        r.type === '이미지'  ? '이미지 서버 / CDN 확인' :
        r.type === '로그인'  ? '로그인 페이지 렌더링 확인' :
        r.type === '이지다운' ? '이지다운 사이트(ezdown.kr) 확인' :
        r.type === '외부링크' ? '외부 서비스 상태 — 이지랩 장애 아님 (링크 유효성만 확인)' :
        r.type === '크롤'    ? '점검 범위 축소됨 — 해당 페이지 렌더 상태 확인 필요' :
        r.type === '간헐'    ? '오리진(nginx+SSR) 확인 — no-store 경로라 CDN 캐시 없이 매 요청 직격' :
        r.type === '인증서'  ? 'SSL 인증서 갱신 필요 (CA/호스팅 인증서 자동갱신 확인)' :
        r.type === '예산'    ? '점검 시간 초과로 일부 STEP 미실행 — 러너 부하/사이트 지연 확인 (스킵된 STEP 재점검 권장)' : '담당팀 확인 요청'
      }`,
    ].join('\n')).join('\n\n');

    const incidentReport = [
      sep,
      '이지랩 헬스체크 · 장애 리포트  ※ 개발팀 전달용',
      `실행 시각  : ${checkTime} (KST)`,
      `소요 시간  : ${duration}초`,
      sep2,
      '[장애 요약]',
      `  총 FAIL   : ${failCount}건`,
      `  총 WARN   : ${warnCount}건`,
      `  총 INFO   : ${infoCount}건 (외부 자원 — 스코어 미반영)`,
      `  영향 범위 : ${affectedTypes}`,
      sep2,
      '[장애 상세]',
      '',
      failLines,
      '',
      sep2,
      `전체 결과  : PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount} / SLOW ${slowCount} / INFO ${infoCount} / TOTAL ${totalCount}`,
      shotCount > 0
        ? `※ 실패/경고 시점 화면 ${shotCount}건이 이 리포트 첨부 파일에 있습니다.`
        : '※ 이번 런은 캡처된 화면이 없습니다 (인증서·외부링크 등 열린 페이지가 없는 네트워크성 경고).',
      sep,
    ].join('\n');

    await test.info().attach('장애 리포트 (개발팀 전달용)', {
      body: incidentReport,
      contentType: 'text/plain; charset=utf-8'
    });
  }

  const badgeData = {
    schemaVersion: 1,
    label: '헬스체크',
    message: `${status} (${passCount}P/${failCount}F/${warnCount}W/${slowCount}S/${infoCount}I)`,
    color,
    lastChecked: new Date().toISOString(),
  };

  await test.info().attach('badge.json', {
    body: JSON.stringify(badgeData, null, 2),
    contentType: 'application/json'
  });

  // 인덱스 페이지 상태 배지용 파일 저장
  // 최대 20건 보존 — WARN/INFO가 많은 런에서 FAIL이 잘려 Slack 장애 알림 목록이 비지 않도록
  // 심각도 순(FAIL → WARN → INFO)으로 정렬해 잘림이 항상 낮은 등급부터 일어나게 한다.
  // 지문은 기록 지점마다 넣지 않고 여기서 일괄 계산한다 — 계산 규칙이 한 곳에만 있어야
  // 소비 측(notify_slack)과 어긋나지 않는다.
  for (const r of failRecords) r.fingerprint ??= fingerprintOf(r);
  const orderedFailures = [
    ...failRecords.filter(f => f.severity !== 'WARN' && f.severity !== 'INFO'),
    ...failRecords.filter(f => f.severity === 'WARN'),
    ...failRecords.filter(f => f.severity === 'INFO'),
  ];
  // 연속 실패 판정용 — FAIL 등급의 지문만, 중복 제거해 정렬.
  const failFingerprints = [...new Set(
    failRecords.filter(f => f.severity !== 'WARN' && f.severity !== 'INFO').map(f => f.fingerprint as string),
  )].sort();

  // 관측 전수 집합은 별도 아티팩트로 남긴다 — 커버리지 비교에는 목록 전체가 필요하다.
  // 경로는 test-results/ 아래(이미 gitignore 대상)라 저장소를 더럽히지 않는다.
  const API_OBS_PATH = path.join('test-results', 'api-observation.json');
  // 다이제스트는 두 종류로 나눈다.
  //   fileDigest      : 파일 전체 무결성 — 아티팩트가 온전한지 확인용
  //   endpointsDigest : 엔드포인트 집합만 — 런 간 '커버리지가 같은가' 비교용
  //                     (시각·건수가 달라도 집합이 같으면 같은 값이 나와야 한다)
  let apiObservationDigest = '';
  let apiEndpointsDigest = '';
  try {
    const payload = JSON.stringify({ runId: RUN_ID, netPolicy: NET_POLICY_ON ? 'on' : 'off', observations: apiObservation }, null, 2);
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(API_OBS_PATH, payload);
    apiObservationDigest = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
    const epCanon = JSON.stringify(
      [...apiObservation].sort((a, b) => a.lang.localeCompare(b.lang))
        .map(o => [o.lang, [...o.endpoints].sort()]),
    );
    apiEndpointsDigest = crypto.createHash('sha256').update(epCanon).digest('hex').slice(0, 16);
    await test.info().attach('STEP2 API 관측 (전수)', { path: API_OBS_PATH, contentType: 'application/json' }).catch(() => {});
  } catch (e) {
    console.log(`[WARN][관측] ${API_OBS_PATH} 기록 실패: ${(e as Error).message.split('\n')[0]}`);
  }

  fs.writeFileSync('report-status.json', JSON.stringify({
    status, passCount, failCount, warnCount, slowCount, infoCount, serverTimes,
    // 시간 예산으로 일부 STEP을 건너뛰었으면 이 런의 PASS는 '전 항목 정상'을 뜻하지 않는다.
    // 상태(WARN)만으로는 소비 측이 그 구분을 할 수 없어 구조화 필드로 함께 내린다.
    coverageComplete: truncatedSteps.size === 0,
    skippedSteps: [...truncatedSteps],
    failFingerprints,
    runId: RUN_ID,
    // 변경 전후 요청량 A/B 비교용 계측 — 같은 러너에서 HC_NET_POLICY 를 바꿔 연속 실행해 비교한다.
    netPolicy: NET_POLICY_ON ? 'on' : 'off',
    // STEP2 대기 계측 — 순수 관측값이며 판정에 쓰지 않는다.
    // endpoints 전체 목록은 용량이 커질 수 있어 report-status.json 에는 요약만 싣고,
    // 전수 집합은 별도 파일(api-observation.json)과 해시로 남긴다.
    apiObservation: apiObservation.map(o => ({
      ...o, endpoints: undefined, uniqueEndpoints: o.endpoints.length,
    })),
    apiObservationDigest,
    apiEndpointsDigest,
    // 변경 전후 비교용 계측 — 핵심 검사 우선·크롤 마지막 재배치의 효과 추적
    stepTimings,
    crawlStats,
    step4Stats,
    // 제품 플랫폼 정책으로 건너뛴 검사 — PASS 가 아니라 '검사 대상 아님'이다.
    policySkips,
    // 증거 없는 FAIL·WARN 이 0건이어야 한다(INFO 외부 링크는 대상 아님).
    evidenceMissing: failRecords.filter(f => f.severity !== 'INFO' && !f.evidencePath).length,
    // own/third 는 '브라우저가 낸 요청'만 센다(page.request·raw https·TLS 제외).
    requestCounts: { own: reqOwn, third: reqThird, blockedBeacons, scope: 'browser-only' },
    durationSec: Math.round((Date.now() - testStartTime) / 1000),
    certs: certResults,
    failures: orderedFailures.slice(0, 20),
  }));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[DONE] 전체 점검 완료`);
  console.log(`  실행 ID: ${RUN_ID} · 네트워크 정책: ${NET_POLICY_ON ? 'on' : 'off'} · 차단한 beacon: ${blockedBeacons}건`);
  console.log(`  브라우저 요청: 자사 ${reqOwn} / 제3자 ${reqThird} (page.request·TTFB·인증서 요청 미포함)`);
  console.log(`  도구 페이지: 메인 수집 ${step4Stats.discoveredFromMain} · 검증 ${step4Stats.verified}`
    + ` · 미검증 ${step4Stats.skipped} · 크롤 추가발견 ${step4Stats.discoveredFromCrawl}`
    + ` · 언어 ${step4Stats.languagesFound.join(',') || '-'}${step4Stats.languagesMissing.length ? ` (누락 ${step4Stats.languagesMissing.join(',')})` : ''}`);
  if (policySkips.length) {
    console.log(`  정책 제외: ${policySkips.length}건 — ${[...new Set(policySkips.map(p => `${p.product}(${p.step})`))].join(', ')}`);
  }
  console.log(`  크롤: 완료 페이지 ${crawlStats.pagesCompleted} · 링크 검증 ${crawlStats.linksChecked} · 중단 ${crawlStats.truncated}`);
  {
    const need = failRecords.filter(f => f.severity !== 'INFO');
    const miss = need.filter(f => !f.evidencePath).length;
    const byType = need.reduce((a, f) => { a[f.evidenceType ?? '없음'] = (a[f.evidenceType ?? '없음'] ?? 0) + 1; return a; }, {} as Record<string, number>);
    console.log(`  증거: 대상 ${need.length}건 · 누락 ${miss}건 · ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`);
  }
  console.log(`  점검 완주: ${truncatedSteps.size === 0 ? '예' : `아니오 (미점검: ${[...truncatedSteps].join(', ')})`}`);
  console.log(`  페이지/링크: ${visitedUrls.size}개`);
  console.log(`  이미지: ${checkedImageUrls.size}개`);
  console.log(`  API: ${apiRecords.length}개`);
  console.log(`  결과: PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount} / SLOW ${slowCount} / INFO ${infoCount} / TOTAL ${totalCount}`);
  console.log(`  상태: ${status}`);
  console.log(`${'═'.repeat(60)}\n`);
});
