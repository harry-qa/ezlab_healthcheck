import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as tls from 'tls';

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
  const discoveredToolUrls = new Set<string>();

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
  type FailRecord = {
    step: string; type: string; lang: string; url: string; status: number; responseTime: number;
    symptom: string; timestamp: string; severity?: 'FAIL' | 'WARN' | 'INFO'; fingerprint?: string;
    // 진단 카드에 싣는 부가 정보 — 있으면 채우고 없으면 비운다.
    contentType?: string; contentRange?: string; netError?: string;
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
  const CRAWL_DEADLINE_MS = 7 * 60 * 1000; // STEP 3 크롤 시간 예산 (전체 10분 타임아웃 방어)
  const REPORT_SAFETY_MS  = 8.5 * 60 * 1000; // 이 시점을 넘기면 이후 반복 항목은 스킵 — 최종 리포트 저장 보장

  // 전체 test 타임아웃(10분)에 걸리면 report-status.json이 아예 안 써지고 런이 UNKNOWN으로 잡혀
  // Slack 알림까지 나간다 — 사이트는 멀쩡한데 헬스체크가 스스로 장애를 만드는 셈이다.
  // 재시도가 붙은 STEP은 최악 실행 시간이 길어지므로, 반복 루프마다 남은 예산을 확인해 자진 종료한다.
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

  // 간헐 실패 후 재시도로 회복한 항목 — 1건은 정상 범위(오리진 순간 지연)로 보고 PASS 취급,
  // 한 런에 이 개수 이상 몰리면 그때만 WARN으로 승격한다. (검사 대상이 20여 개라
  //  건당 1%대 확률만으로도 '런 하나는 반드시 걸리는' 증폭이 생기는 걸 막기 위함)
  const INTERMITTENT_WARN_THRESHOLD = 2;
  const intermittentRecoveries: FailRecord[] = [];

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  let slowCount = 0; // 느린 응답(정보성) — 런 상태(WARN)·헬스 스코어엔 반영 안 함
  let infoCount = 0; // 제3자 자원 이상(정보성) — 런 상태·헬스 스코어엔 반영 안 함, 기록만 남김
  let shotCount = 0; // 이번 런에서 실제 캡처·첨부된 화면 수 — 리포트 안내 문구를 조건부로 내기 위함
  const serverTimes: Record<string, number> = {};

  // ── 네비게이션 재시도 헬퍼 (간헐 오리진 404/5xx/타임아웃 오탐 방지) ──────────────
  // tool·login 페이지는 CloudFront 캐시 미적용(cache-control: no-store)이라 매 요청이
  // 오리진(nginx+SSR) 직격 → 순간 부하 시 데이터 페치가 타임아웃돼 간헐 404를 뱉는다.
  // (정상 200은 TTFB 0.2s대, 실패 404는 10s대로 관측됨.) 404 한 번에 즉시 FAIL 처리하면
  // 오탐이므로, 짧은 백오프로 재확인해 실제 장애(재시도해도 실패)와 간헐(회복)을 구분한다.
  // 반환: { status, responseTime, attempts, recovered, failureLog } — recovered는 2회차 이후 회복 여부.
  // failureLog에는 실패한 각 시도의 상태와 소요 시간을 남긴다. 이게 없으면 회복 기록의 증상이
  // "간헐 실패 후 회복"뿐이라, 1회차가 404였는지 타임아웃이었는지를 개발팀이 추적할 수 없다.
  // (실제로 오리진 장애는 '10초대 지연 후 404'라는 고유 시그니처를 갖는다 — 이걸 남겨야 원인이 보인다)
  async function gotoWithRetry(url: string, maxAttempts = 3) {
    let lastStatus = 0;
    let lastResponseTime = 0;
    const failureLog: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startTime = Date.now();
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        lastResponseTime = Date.now() - startTime;
        lastStatus = res?.status() ?? 0;
        if (lastStatus === 200) {
          return { status: 200, responseTime: lastResponseTime, attempts: attempt, recovered: attempt > 1, failureLog };
        }
        failureLog.push(`${attempt}회차 HTTP ${lastStatus} (${lastResponseTime}ms)`);
      } catch (e) {
        lastStatus = 0; // 타임아웃/접속 불가
        failureLog.push(`${attempt}회차 응답 없음 (${Date.now() - startTime}ms, ${(e as Error).message.split('\n')[0].slice(0, 60)})`);
      }
      if (attempt < maxAttempts) await page.waitForTimeout(1500 * attempt); // 1.5s → 3s 백오프 (오리진 회복 대기)
    }
    return { status: lastStatus, responseTime: lastResponseTime, attempts: maxAttempts, recovered: false, failureLog };
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
  async function refetchWithRetry(url: string, maxAttempts = 3) {
    let lastStatus = 0;
    let lastResponseTime = 0;
    const failureLog: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startTime = Date.now();
      try {
        const res = await page.request.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
        lastStatus = res.status();
        lastResponseTime = Date.now() - startTime;
        if (apiIsOk(lastStatus, url, 'GET')) {
          return { status: lastStatus, responseTime: lastResponseTime, attempts: attempt, recovered: attempt > 1, failureLog };
        }
        failureLog.push(`${attempt}회차 HTTP ${lastStatus} (${lastResponseTime}ms)`);
      } catch {
        lastStatus = 0;
        failureLog.push(`${attempt}회차 응답 없음 (${Date.now() - startTime}ms)`);
      }
      if (attempt < maxAttempts) await page.waitForTimeout(1500 * attempt); // 1.5s → 3s 백오프
    }
    return { status: lastStatus, responseTime: lastResponseTime, attempts: maxAttempts, recovered: false, failureLog };
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
  function diagnosticCardHtml(rec: FailRecord): string {
    const esc = (v: unknown) => String(v ?? '-')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sev = rec.severity ?? 'FAIL';
    const color = sev === 'FAIL' ? '#e5534b' : sev === 'WARN' ? '#d29922' : '#58a6ff';
    const rows: [string, unknown][] = [
      ['STEP', rec.step],
      ['유형', `${rec.type} · ${sev}`],
      ['URL', rec.url],
      ['HTTP 상태', rec.status === 0 ? '응답 없음 (0)' : rec.status],
      ['증상', rec.symptom],
      ['언어', rec.lang],
      ['감지 시각', rec.timestamp],
      ['응답 시간', rec.responseTime ? `${rec.responseTime}ms` : '-'],
      ['Content-Type', rec.contentType],
      ['Content-Range', rec.contentRange],
      ['네트워크 오류', rec.netError],
      ['실행 ID', RUN_ID],
    ];
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0d1117;
      font:14px/1.6 -apple-system,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;color:#c9d1d9">
      <div style="max-width:900px;margin:24px auto;border:1px solid #30363d;border-radius:10px;overflow:hidden">
        <div style="background:${color};color:#fff;padding:14px 20px;font-size:17px;font-weight:700">
          이지랩 헬스체크 · ${esc(sev)} 진단 카드
        </div>
        <table style="width:100%;border-collapse:collapse">
          ${rows.map(([k, v], i) => `<tr style="background:${i % 2 ? '#161b22' : '#0d1117'}">
            <td style="padding:10px 20px;color:#8b949e;white-space:nowrap;vertical-align:top;width:150px">${esc(k)}</td>
            <td style="padding:10px 20px;word-break:break-all">${esc(v)}</td></tr>`).join('')}
        </table>
        <div style="padding:10px 20px;color:#8b949e;font-size:12px;border-top:1px solid #30363d">
          화면으로 확인할 수 없는 장애(API·파일·인증서·메타 이미지·네트워크·예산)라 진단 카드로 남깁니다.
        </div>
      </div></body>`;
  }

  // 진단 카드 렌더링용 페이지 — 여러 건이 공유한다(건마다 페이지를 열면 비용이 크다).
  let diagPage: import('@playwright/test').Page | null = null;
  async function renderDiagnostic(rec: FailRecord): Promise<{ type: 'diagnostic'; path: string } | null> {
    try {
      if (!diagPage) diagPage = await page.context().newPage();
      await diagPage.setContent(diagnosticCardHtml(rec), { waitUntil: 'load', timeout: 10000 });
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

    // 내부 링크는 오리진 순간 지연(캐시 미적용 SSR 페이지의 간헐 타임아웃/5xx/404) 오탐을 막기 위해
    // 짧은 백오프로 재확인한다. 외부 링크는 WARN이라 지연 누적 방지를 위해 1회만 요청.
    // (아래 catch에서도 시도 횟수·실패 내역을 증상에 써야 하므로 try 바깥에 둔다)
    const maxAttempts = isInternal ? 3 : 1;
    const failureLog: string[] = []; // 실패한 시도의 상태·소요 시간 — 회복 기록의 원인 추적용

    try {
      await page.waitForTimeout(Math.floor(Math.random() * 500) + 300);

      let res!: Awaited<ReturnType<typeof page.request.get>>;
      let responseTime = 0;
      let attempts = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        const startTime = Date.now();
        try {
          res = await page.request.get(requestUrl, { headers, timeout: REQUEST_TIMEOUT_MS });
          responseTime = Date.now() - startTime;
          if (res.status() === 200 || attempt >= maxAttempts) break; // 성공 또는 마지막 시도 → 아래에서 판정
          failureLog.push(`${attempt}회차 HTTP ${res.status()} (${responseTime}ms)`);
        } catch (e) {
          failureLog.push(`${attempt}회차 응답 없음 (${Date.now() - startTime}ms)`);
          if (attempt >= maxAttempts) throw e; // 마지막 시도까지 실패 → 바깥 catch(접속 불가)로
        }
        await page.waitForTimeout(1500 * attempt); // 1.5s → 3s 백오프 (오리진 회복 대기)
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
        await recordIssue({ step: 'UI/링크', type, lang, url: cleanUrl, status, responseTime, symptom: noteStr, timestamp: ts });
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
      }

    } catch (e) {
      if (isInternal) {
        failCount++;
        const ts = kstNow();
        // '접속 불가'로만 적으면 실제로는 연결이 살아 있고 응답만 느렸던 경우까지 단절로 오기재된다.
        // 타임아웃 값을 명시해 '얼마를 기다렸는데 안 왔는지'를 증상에 남긴다.
        const symptom = `응답 없음 (${maxAttempts}회 시도 · 각 ${REQUEST_TIMEOUT_MS / 1000}초 대기)${failureLog.length ? ' · ' + failureLog.join(', ') : ''}`;
        console.log(`[ERROR][${type}][${lang}] ${symptom}: ${cleanUrl} @ ${ts}`);
        await recordIssue({ step: 'UI/링크', type, lang, url: cleanUrl, status: 0, responseTime: 0, symptom, timestamp: ts });
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
  await test.step('STEP 1 · 다국어 서버 생존 확인 (ko / en / jp / tw)', async () => {
    // 언어 간 연결을 재사용하는 keep-alive 에이전트 (전부 동일 호스트라 핸드셰이크 1회면 충분).
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const lang of languages) {
        // STEP1·2도 예산 가드를 둔다. 오리진 지연으로 초반 스텝이 밀리면 최종 report-status.json
        // 저장 전에 전체 타임아웃(10분)에 걸려 런이 UNKNOWN으로 잡히고 Slack 오탐이 난다 —
        // 사이트는 멀쩡한데 헬스체크가 스스로 장애를 만드는 것. 예산 초과 시 자진 종료해 리포트 저장 보장.
        if (budgetHit('STEP1·서버')) { console.log('[SKIP][서버] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
        await test.step(`[서버][${lang}] 응답 확인`, async () => {
          const serverUrl = `${baseUrl}/${lang}`;
          visitedUrls.add(serverUrl); // 최종 집계에 포함
          try {
            // 워밍업 1회(DNS/TLS·경로 캐시 비용 분리) → 본측정 3회의 중앙값을 TTFB로 채택.
            await measureTTFB(serverUrl, headers, agent);
            const samples: number[] = [];
            const statuses: number[] = [];
            for (let i = 0; i < 3; i++) {
              const r = await measureTTFB(serverUrl, headers, agent);
              statuses.push(r.status);
              samples.push(r.ttfb);
            }
            samples.sort((a, b) => a - b);
            const responseTime = samples[1]; // 3회 중앙값 (본문 다운로드 제외 TTFB)

            // 3xx(트레일링 슬래시·정규화 리다이렉트)도 서버 생존으로 간주 — https.get은
            // 리다이렉트를 안 따라가므로 200만 통과시키면 정상 사이트도 FAIL 오탐이 난다.
            // 상태는 3회 중 마지막 값만 보면 안 된다(200/200/500이면 blip을 놓치거나 500/500/200이면
            // 2번 실패를 못 본다) → 하나라도 살아있지 않으면 그 실패 상태를 대표값으로 채택.
            const alive = (s: number) => s >= 200 && s < 400;
            const badStatus = statuses.find(s => !alive(s));
            const status = badStatus ?? statuses[statuses.length - 1];
            const isAlive = badStatus === undefined;
            if (isAlive) {
              passCount++;
              serverTimes[lang] = responseTime;
              console.log(`[PASS][${lang}] 서버 ${status} (TTFB ${responseTime}ms · ${samples.join('/')})`);
            } else {
              failCount++;
              const ts = kstNow();
              console.log(`[FAIL][${lang}] 서버 ${status} (TTFB ${responseTime}ms) @ ${ts}`);
              await recordIssue({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status, responseTime, symptom: `HTTP ${status} 응답`, timestamp: ts });
            }
            expect.soft(isAlive, `서버 생존 확인 (status: ${status}, url: ${serverUrl})`).toBe(true);
          } catch {
            failCount++;
            const ts = kstNow();
            console.log(`[ERROR][${lang}] 서버 접속 불가 @ ${ts}`);
            await recordIssue({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status: 0, responseTime: 0, symptom: '접속 불가 / 타임아웃', timestamp: ts });
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

    await page.setExtraHTTPHeaders(headers);

    for (const lang of languages) {
      if (budgetHit('STEP2·API수집')) { console.log('[SKIP][API수집] 시간 예산 초과 — 이후 언어 건너뜀'); break; }
      await test.step(`[${lang}] 페이지 탐색 → API 수집`, async () => {
        const startPage = `${baseUrl}/${lang}`;
        try {
          // networkidle을 진입 조건으로 걸면 자산 하나가 안 끝날 때 20초를 통째로 날리고
          // 그 언어의 API 수집이 0건이 된다. → 진입은 domcontentloaded로 확정하고,
          // XHR을 긁어모으기 위한 안정화 대기만 별도로 짧게 준다(실패해도 그냥 진행).
          await page.goto(startPage, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2000);
          console.log(`[INFO][${lang}] 페이지 탐색 완료, API 수집 중...`);
        } catch {
          console.log(`[SKIP][${lang}] 페이지 진입 실패: ${startPage}`);
        }
      });
    }

    // STEP 2 종료 후 리스너 제거 → STEP 3 탐색에 영향 없도록
    page.off('request', onRequest);
    page.off('response', onResponse);

    await test.step(`수집된 API 검증 (총 ${apiRecords.length}건)`, async () => {
      console.log(`[INFO] 총 ${apiRecords.length}개 API 수집 완료`);

      for (const rec of apiRecords) {
        // 재확인(refetchWithRetry)은 실패 1건당 최대 ~40초까지 걸릴 수 있어, 실패 API가 몰리면
        // 이 루프만으로 전체 타임아웃을 넘길 수 있다 → 예산 초과 시 남은 재확인은 스킵(리포트 저장 보장).
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
          intermittentRecoveries.push({ step: 'STEP2·API', type: 'API', lang: '-', url: rec.url, status: rv.status, responseTime: rv.responseTime, symptom: `간헐 실패 후 회복 (최초 HTTP ${rec.status} → 재확인 ${rv.status}, ${rv.attempts}회 시도)${detail}`, timestamp: ts, severity: 'WARN' });
          continue;
        }

        failCount++;
        const ts = kstNow();
        const detail = rv
          ? ` (재확인 ${rv.attempts}회 실패${rv.failureLog.length ? ' · ' + rv.failureLog.join(', ') : ''})`
          : ' (비GET이라 재확인 생략 — 부작용 방지)';
        const finalStatus = rv ? rv.status : rec.status;
        console.log(`[FAIL] ${label}${detail} @ ${ts}`);
        await recordIssue({ step: 'STEP2·API', type: 'API', lang: '-', url: rec.url, status: finalStatus, responseTime: rec.time, symptom: `${rec.note}${detail}`, timestamp: ts });
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
  // STEP 3: UI 링크 전수조사 (내부/외부 분리)
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 3 · UI 링크 전수조사 (ko / en / jp / tw)', async () => {
    // 크롤이 시간 예산에 걸려 잘리면 '점검 안 한 링크'가 생기는데, 기존엔 조용히 끝나서
    // 리포트가 '이상 없음'으로 보였다. 잘렸다는 사실 자체를 한 번은 남긴다.
    let crawlTruncated = false;
    for (const lang of languages) {
      await test.step(`[${lang}] <a> 링크 수집 및 점검 (depth 2)`, async () => {
        const crawledPages = new Set<string>();
        const termPagesFound = new Set<string>(); // depth 무관하게 term 페이지 수집

        async function crawlPage(pageUrl: string, depth: number) {
          // 전체 test 타임아웃(10분) 전에 크롤을 자진 종료 — 크롤이 밀려 최종 리포트
          // 저장까지 못 가는 상황 방지. 예산 초과 시 남은 링크는 스킵하고 정상 종료.
          if (Date.now() - testStartTime > CRAWL_DEADLINE_MS) { crawlTruncated = true; return; }
          const cleanUrl = pageUrl.split('?')[0];
          if (crawledPages.has(cleanUrl)) return;
          crawledPages.add(cleanUrl);

          try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(500);
          } catch {
            // 기존엔 로그만 남기고 조용히 빠졌다. 그러면 진입점(depth 0)이 실패했을 때
            // 그 언어의 크롤이 통째로 사라지는데 카운터·리포트엔 흔적이 없어(미탐),
            // '점검했는데 아무 문제 없음'과 '아예 점검을 못 함'이 구분되지 않았다.
            warnCount++;
            const ts = kstNow();
            const symptom = depth === 0
              ? `크롤 진입점 렌더 실패 — [${lang}] 링크 전수조사 미실행`
              : `크롤 대상 페이지 렌더 실패 (depth ${depth}) — 하위 링크 미점검`;
            console.log(`[WARN][크롤][${lang}][depth${depth}] ${symptom}: ${pageUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP3·크롤', type: '크롤', lang, url: cleanUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' }, { visual: true, label: `실패_크롤_${lang}_depth${depth}` });
            return;
          }

          const internalToFollow: string[] = [];
          try {
            const links = await page.locator('a').all();
            console.log(`[INFO][${lang}][depth${depth}] ${pageUrl} → ${links.length}개 링크 발견`);

            for (const link of links) {
              // 링크 단위로도 예산 확인 — 링크가 많은 페이지에서 데드라인을 넘겨도
              // 페이지 진입 시점 체크만으론 못 멈추므로 여기서 끊는다.
              if (Date.now() - testStartTime > CRAWL_DEADLINE_MS) { crawlTruncated = true; break; }
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

              if (isInternal) {
                if (depth < 1) internalToFollow.push(url);
                if (url.includes('/term/')) termPagesFound.add(url.split('?')[0]);
                // trailing slash·쿼리·해시가 붙은 tool 링크도 STEP4 대상에 포함 —
                // 기존 `[^/]+$`는 /ko/tool/ezcapture/ (슬래시로 끝) 를 놓쳐 해당 다운로드 페이지가 미점검됐다.
                if (url.match(/\/(ko|en|jp|tw)\/tool\/[^/?#]+\/?($|[?#])/)) discoveredToolUrls.add(url.split('?')[0]);
              }
            }
          } catch {
            // 링크 수집이 중간에 끊기면 그 페이지의 나머지 링크는 점검되지 않은 채 넘어간다 → 기록 필요.
            warnCount++;
            const ts = kstNow();
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
          if (Date.now() - testStartTime > CRAWL_DEADLINE_MS) { crawlTruncated = true; break; } // 크롤 예산 공유
          if (crawledPages.has(termUrl)) continue;
          crawledPages.add(termUrl);
          try {
            await page.goto(termUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
            console.log(`[SKIP][${lang}][tab] term 페이지 진입 실패: ${termUrl}`);
          }
        }
      });
    }

    // 크롤이 잘렸다는 사실을 리포트에 한 번 남긴다. 이게 없으면 '점검해서 문제없음'과
    // '시간이 없어 점검을 덜 함'이 리포트에서 똑같이 초록불로 보인다.
    if (crawlTruncated) {
      warnCount++;
      const ts = kstNow();
      const symptom = `크롤 시간 예산(${CRAWL_DEADLINE_MS / 60000}분) 초과로 링크 전수조사가 중단됨 — 미점검 링크 있음`;
      console.log(`[WARN][크롤] ${symptom} @ ${ts}`);
      await recordIssue({ step: 'STEP3·크롤', type: '크롤', lang: '-', url: baseUrl, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 4: 서비스별 다운로드 링크 직접 검증 (STEP 3에서 자동 수집)
  // ══════════════════════════════════════════════════════════════════
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
        console.log(`[SKIP][다운로드] 시간 예산 초과 — 이후 항목 건너뜀 (리포트 저장 보장)`);
        break;
      }
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
            intermittentRecoveries.push({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'WARN' });
          }

          let hasDownloadLink = false;
          if (status === 200) {
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
              ? `응답 없음 (${nav.attempts}회 재시도 실패)${detail}`
              : `HTTP ${status} 응답 (${nav.attempts}회 재시도 실패)${detail}`;
            console.log(`[FAIL][다운로드][${target.name}] ${status} (${responseTime}ms, ${nav.attempts}회 시도) ${target.url} @ ${ts}`);
            await recordIssue({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom, timestamp: ts }, { visual: true, label: `실패_다운로드_${target.name}_${tlang}` });
            expect.soft(status, `[다운로드][${target.name}] 페이지 응답 실패(${nav.attempts}회 재시도) → ${target.url}`).toBe(200);
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
  // STEP 4-1: 실제 설치 파일 URL 검증
  // 기존 검사는 페이지의 a[href*=".exe"] 를 훑었는데, 다운로드가 JS 기반이라
  // 실측 0건이었다 — 검사가 도는 것처럼 보이는데 커버리지가 0인 미탐 상태였다.
  // 실제 배포 URL은 /api/tools/info 가 내려주므로 그것을 기준으로 검증한다.
  // 파일을 실제로 내려받지 않기 위해 HEAD → (막히면) 스트리밍 Range 순으로 확인한다.
  // ══════════════════════════════════════════════════════════════════
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

    console.log(`[INFO][파일] 설치 파일 ${fileUrls.size}건 수집 — HEAD/Range로 존재 확인`);
    for (const fileUrl of fileUrls) {
      if (budgetHit('STEP4-1·파일검증')) { console.log('[SKIP][파일] 시간 예산 초과 — 이후 파일 건너뜀'); break; }
      const name = fileUrl.split('/').pop() ?? fileUrl;
      let status = 0;
      let note = '';
      try {
        // HEAD는 본문을 받지 않아 안전하다 — 1차로 여기서 판정한다.
        const head = await page.request.head(fileUrl, { headers: ownHeaders, timeout: 8000 });
        status = head.status();
        if (status !== 200 && status !== 206) {
          // HEAD를 막는 CDN(405/403)일 수 있어 Range로 재확인한다. 본문 버퍼링을 피하려고
          // page.request.get이 아니라 스트리밍 프로브를 쓴다(206 아니면 헤더 시점에 연결 파기).
          const probe = await probeFileRange(fileUrl, ownHeaders);
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
        failCount++;
        const ts = kstNow();
        const symptom = status === 0
          ? `설치 파일 접근 불가${note ? ` (${note})` : ''}`
          : `설치 파일 응답 이상 (HTTP ${status})${note ? ` · ${note}` : ''}`;
        console.log(`[FAIL][파일] ${status} ${fileUrl} — ${symptom} @ ${ts}`);
        await recordIssue({ step: 'STEP4-1·파일URL', type: '파일', lang: '-', url: fileUrl, status, responseTime: 0, symptom, timestamp: ts });
        expect.soft(status === 200 || status === 206, `[파일] ${symptom} → ${fileUrl}`).toBe(true);
      }
    }
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
  type ImgResult = { status: number; contentType: string; ok: boolean; note: string; source: string };
  type ImgObs = { langs: Set<string>; metaKinds: Set<string>; results: Map<string, ImgResult> };
  const imgObservations = new Map<string, ImgObs>();
  const imgActiveVerified = new Set<string>(); // requestUrl 기준

  // 네트워크 관찰 구간 상수 — 고정하지 않으면 실행마다 lazy 이미지 커버리지가 달라진다.
  // 언어당 최대 4초(= load 3s + 안정화 1s), 4개 언어로 최대 16초 추가. 8.5분 예산 안에 든다.
  const IMG_LOAD_WAIT_MS = 3000; // load 이벤트 최대 대기
  const IMG_SETTLE_MS    = 1000; // lazy·CSS 배경 요청 흡수용 안정화

  const obsOf = (assetUrl: string): ImgObs => {
    let o = imgObservations.get(assetUrl);
    if (!o) { o = { langs: new Set(), metaKinds: new Set(), results: new Map() }; imgObservations.set(assetUrl, o); }
    return o;
  };
  const isImageContentType = (ct: string) => /^image\//i.test(ct.split(';')[0].trim());

  // 능동 검증 — requestUrl 단위로 1회만. 상태 코드뿐 아니라 Content-Type과 본문 크기까지 본다
  // (200인데 HTML/XML 오류 페이지를 주는 경우가 실재한다 — cdn의 403 응답이 application/xml 이었다).
  async function verifyImage(assetUrl: string, requestUrl: string, source: string) {
    if (imgActiveVerified.has(requestUrl)) return;
    imgActiveVerified.add(requestUrl);
    const o = obsOf(assetUrl);
    try {
      const res = await page.request.get(requestUrl, { headers: headersFor(requestUrl), timeout: 8000 });
      const status = res.status();
      const ct = String(res.headers()['content-type'] ?? '');
      let ok = false;
      let note = '';
      if (status === 200 || status === 206) {
        const cr = String(res.headers()['content-range'] ?? '');
        if (!isImageContentType(ct)) {
          note = `Content-Type 이상: ${ct || '(없음)'}`;
        } else if (status === 206 && !/^bytes\s+\d+-\d+\/\d+/i.test(cr)) {
          // 206인데 Content-Range가 없거나 형식이 깨졌으면 부분 응답으로 신뢰할 수 없다.
          note = `206인데 Content-Range 이상: "${cr || '(없음)'}"`;
        } else {
          const len = (await res.body()).length;
          if (len === 0) note = '본문 크기 0';
          else ok = true;
        }
      }
      o.results.set(requestUrl, { status, contentType: ct, ok, note, source });
    } catch (e) {
      o.results.set(requestUrl, { status: 0, contentType: '', ok: false, note: `접근 불가 / 타임아웃`, source });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // STEP 5: 언어별 핵심 콘텐츠 무결성 확인 (신규)
  // ══════════════════════════════════════════════════════════════════
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
        const netFailures: { url: string; status: number; contentType: string; note: string }[] = [];
        const onResponse = (res: import('@playwright/test').Response) => {
          const req = res.request();
          if (req.resourceType() !== 'image') return;
          const url = res.url();
          if (!isOwnHost(url)) return; // 제3자 이미지는 장애 점수에서 제외
          const st = res.status();
          // 3xx는 최종 응답에서 다시 잡히고, 304는 정상 재검증(본문 없음이 정상이라 크기·타입 검사 대상 아님)
          if (st >= 300 && st < 400) return;
          if (st === 200 || st === 206) return;
          netFailures.push({ url, status: st, contentType: String(res.headers()['content-type'] ?? ''), note: '' });
        };
        const onRequestFailed = (req: import('@playwright/test').Request) => {
          if (req.resourceType() !== 'image') return;
          if (intentionalAborts.has(req)) return; // 우리가 끊은 beacon — errorText로는 구분 불가
          const url = req.url();
          if (!isOwnHost(url)) return;
          const err = req.failure()?.errorText ?? '';
          // 브라우저가 스스로 취소한 요청(ERR_ABORTED 등)은 장애가 아니다 — 실제 네트워크 실패만 센다.
          if (!REAL_NET_FAILURE_RE.test(err)) return;
          netFailures.push({ url, status: 0, contentType: '', note: err || '연결 실패' });
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
              ? `응답 없음 (${nav.attempts}회 재시도 실패)${detail}`
              : `HTTP ${nav.status} 응답 (${nav.attempts}회 재시도 실패)${detail}`;
            console.log(`[FAIL][콘텐츠][${lang}] ${symptom} ${targetUrl} @ ${ts}`);
            await recordIssue({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: nav.status, responseTime: nav.responseTime, symptom, timestamp: ts }, { visual: true, label: `실패_콘텐츠진입_${lang}` });
            expect.soft(nav.status, `[콘텐츠][${lang}] 페이지 진입 실패 → ${targetUrl}`).toBe(200);
            return;
          }
          if (nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][콘텐츠][${lang}] 간헐 실패 후 ${nav.attempts}회차 회복${detail} ${targetUrl} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: 200, responseTime: nav.responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'WARN' });
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
            imgActiveVerified.add(fetchUrl); // 재요청 금지
            o.results.set(fetchUrl, {
              status: f.status, contentType: f.contentType, ok: false, source: 'network',
              note: f.status === 0 ? `네트워크 실패 (${f.note})` : '',
            });
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
            if (!isOwnHost(fetchUrl)) continue;
            await verifyImage(displayUrl, fetchUrl, 'meta');
          }

          // 3층: DOM <img src> — 네트워크로 요청되지 않은 지연 로딩 이미지 보완.
          const images = await page.locator('img').all();
          console.log(`[INFO][${lang}] DOM 이미지 ${images.length}개 · 메타 이미지 ${metaImgs.length}개 · 네트워크 실패 ${netFailures.length}건`);
          for (const img of images) {
            if (budgetHit('STEP5·이미지검증')) break;
            const src = await img.getAttribute('src');
            if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue;
            const { fetchUrl, displayUrl } = normalizeImageUrl(src, baseUrl);
            const o = obsOf(displayUrl);
            o.langs.add(lang);
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
          for (const f of netFailures) {
            const { fetchUrl, displayUrl } = normalizeImageUrl(f.url, baseUrl);
            const o = obsOf(displayUrl);
            o.langs.add(lang);
            imgActiveVerified.add(fetchUrl);
            o.results.set(fetchUrl, {
              status: f.status, contentType: f.contentType, ok: false, source: 'network',
              note: f.status === 0 ? `네트워크 실패 (${f.note})` : '',
            });
          }
        }
      });
    }
  });


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
      console.log(`[WARN][이미지] ${first.status} ${assetUrl} — ${symptom} @ ${ts}`);
      await recordIssue({
        step: 'STEP6·이미지', type: '이미지', lang: [...o.langs].join(',') || '-',
        url: assetUrl, status: first.status, responseTime: 0, symptom, timestamp: ts, severity: 'WARN',
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
            await recordIssue({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: nav.status, responseTime: nav.responseTime, symptom: `페이지 진입 실패 (HTTP ${nav.status}, ${nav.attempts}회 재시도)${detail}`, timestamp: ts }, { visual: true, label: `실패_로그인진입_${lang}` });
            expect.soft(nav.status, `[로그인][${lang}] 페이지 진입 실패 → ${loginUrl}`).toBe(200);
            return; // 페이지가 안 떴으면 버튼 검사 무의미
          }

          // 로그인 페이지도 tool 페이지와 같은 no-store(오리진 직격) 경로라 간헐 실패가 난다.
          // STEP 4와 동일하게 회복 건은 모아뒀다가 런 단위로 한 번에 판정한다.
          if (nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][로그인][${lang}] 간헐 실패 후 ${nav.attempts}회차 회복${detail} ${loginUrl} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 200, responseTime: nav.responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'WARN' });
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
              ? `응답 없음 (${nav.attempts}회 재시도 실패)${detail}`
              : `HTTP ${status} 응답 (${nav.attempts}회 재시도 실패)${detail}`;
            console.log(`[FAIL][이지다운][${lang}] ${symptom} ${url} @ ${ts}`);
            await recordIssue({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status, responseTime: nav.responseTime, symptom, timestamp: ts }, { visual: true, label: `실패_이지다운렌더_${lang}` });
            expect.soft(status, `[이지다운][${lang}] 페이지 진입 실패 → ${url}`).toBe(200);
            return;
          }

          if (nav.recovered) {
            const ts = kstNow();
            const detail = nav.failureLog.length ? ` · ${nav.failureLog.join(', ')}` : '';
            console.log(`[INFO][이지다운][${lang}] 간헐 실패 후 ${nav.attempts}회차 회복${detail} ${url} @ ${ts}`);
            intermittentRecoveries.push({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status: 200, responseTime: nav.responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)${detail}`, timestamp: ts, severity: 'WARN' });
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
          for (const img of imgs) {
            const src = await img.getAttribute('src');
            if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue;
            // STEP 6과 동일한 정규화 사용 — 현재 ezdown은 일반 경로만 쓰지만, Next.js 이미지로
            // 바뀌는 순간 STEP 6이 겪었던 '전량 스킵' 구멍이 여기서 재발하지 않도록 미리 통일한다.
            const { fetchUrl, displayUrl } = normalizeImageUrl(src, ezdownBase);
            if (checkedImageUrls.has(fetchUrl)) continue;
            checkedImageUrls.add(fetchUrl);
            try {
              const ir = await page.request.get(fetchUrl, { headers, timeout: 8000 });
              if (ir.status() !== 200) {
                warnCount++;
                const ts = kstNow();
                console.log(`[WARN][이지다운][이미지][${lang}] ${ir.status()} ${displayUrl}`);
                await recordIssue({ step: 'STEP8·이지다운이미지', type: '이미지', lang, url: displayUrl, status: ir.status(), responseTime: 0, symptom: `이미지 로드 실패 (${ir.status()})`, timestamp: ts, severity: 'WARN' }, { visual: true, locator: img, label: `경고_이지다운깨진이미지_${lang}` });
              }
            } catch {
              warnCount++;
              const ts = kstNow();
              console.log(`[WARN][이지다운][이미지][${lang}] 접근 불가: ${displayUrl}`);
              await recordIssue({ step: 'STEP8·이지다운이미지', type: '이미지', lang, url: displayUrl, status: 0, responseTime: 0, symptom: '이미지 접근 불가 / 타임아웃', timestamp: ts, severity: 'WARN' }, { visual: true, locator: img, label: `경고_이지다운깨진이미지_${lang}` });
            }
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
  await test.step('STEP 9 · SSL 인증서 만료 점검 (ezlab.im / ezdown.kr)', async () => {
    const CERT_FAIL_DAYS = 7;
    const CERT_WARN_DAYS = 14;
    const certHosts = ['ezlab.im', 'ezdown.kr'];
    // 만료일을 대시보드 표시용 YYYY-MM-DD로 정리 (파싱 실패 시 원문 유지)
    const fmtValid = (v: string) => { const d = new Date(v); return isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10); };
    for (const host of certHosts) {
      if (budgetHit('STEP9·인증서')) { console.log('[SKIP][인증서] 시간 예산 초과 — 이후 호스트 건너뜀'); break; }
      await test.step(`[인증서][${host}] 만료일 확인`, async () => {
        try {
          const { daysLeft, validTo } = await checkCertExpiry(host);
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
        } catch (e) {
          // 핸드셰이크 실패는 STEP 1에서 서버 장애로 이미 잡히므로 여기선 WARN으로만.
          warnCount++;
          const ts = kstNow();
          const msg = (e as Error).message || '확인 실패';
          console.log(`[WARN][인증서][${host}] 확인 실패: ${msg} @ ${ts}`);
          await recordIssue({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom: `인증서 확인 실패: ${msg}`, timestamp: ts, severity: 'WARN' });
          certResults.push({ host, daysLeft: null, validTo: '', status: 'ERROR' });
        }
      });
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
  //   재시도로 회복한 항목은 사용자에게 페이지가 정상으로 보인 케이스다. 항목별로 WARN을 매기면
  //   대상이 20여 개라 건당 1%대의 오리진 지연만으로도 런 5개 중 1개가 노란불이 된다(증폭).
  //   → 1건은 PASS 취급(정보성 기록만), 임계치 이상 몰릴 때만 '오리진 불안정'으로 WARN 1건 승격.
  await test.step('간헐 회복 종합 판정', async () => {
    if (intermittentRecoveries.length === 0) {
      console.log('[INFO][간헐] 재시도 회복 항목 없음');
      return;
    }
    const targets = [...new Set(intermittentRecoveries.map(r => r.url))].join(', ');
    if (intermittentRecoveries.length >= INTERMITTENT_WARN_THRESHOLD) {
      warnCount++;
      const ts = kstNow();
      const symptom = `오리진 간헐 불안정 — 재시도 회복 ${intermittentRecoveries.length}건 (임계치 ${INTERMITTENT_WARN_THRESHOLD}건)`;
      console.log(`[WARN][간헐] ${symptom}: ${targets} @ ${ts}`);
      // 종합 1건 + 개별 근거를 함께 남겨 개발팀이 어느 경로가 흔들렸는지 볼 수 있게 한다.
      await recordIssue({ step: '간헐·종합', type: '간헐', lang: '-', url: baseUrl, status: 200, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
      // 간헐 회복 기록도 WARN이라 증거 보장 대상이다 — 개별로 넣는다.
      for (const r of intermittentRecoveries) await recordIssue(r);
    } else {
      // 1건은 정상 범위 — 런 상태를 바꾸지 않되 추이 관찰용으로 로그만 남긴다.
      console.log(`[INFO][간헐] 재시도 회복 ${intermittentRecoveries.length}건 (임계치 ${INTERMITTENT_WARN_THRESHOLD}건 미만 → 런 상태 미반영): ${targets}`);
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
    `  ※ 간헐 회복 ${intermittentRecoveries.length}건 — ${INTERMITTENT_WARN_THRESHOLD}건 이상일 때만 WARN 승격`,
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