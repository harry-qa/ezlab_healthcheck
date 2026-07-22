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

test.afterEach(async ({ page }, testInfo) => {
  // STEP 전체가 하나의 test라 여기서 찍히는 건 '실패 스텝'이 아니라 런 종료 시점의 마지막 화면이다.
  // 실제 실패 순간 화면은 각 STEP에서 captureShot()으로 별도 저장하므로, 여기선 참고용 종료 상태만 남긴다.
  if (testInfo.status !== testInfo.expectedStatus) {
    const ts = Date.now();
    const safeTitle = testInfo.title.replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
    const filePath = path.join(SCREENSHOT_DIR, `run-end-state-${safeTitle}-${ts}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[SCREENSHOT] 런 종료 시점 화면(참고용): ${filePath}`);
  }
});

test('이지랩 서비스 통합 점검 (서버 / API / UI)', async ({ page, request }) => {
  test.setTimeout(600000);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  const baseUrl = 'https://ezlab.im';
  // 200 응답 '원문(res.text())'에서 잡아내는 실제 점검/장애 페이지 신호만 유지.
  // 주의: Next.js는 i18n 에러 템플릿("일시적인 오류가 발생했습니다" 등)을 정상 페이지
  // 번들에도 실어 보내므로, 일반 오류 문구를 키워드로 넣으면 전 페이지가 오탐 FAIL 난다.
  // → 점검 페이지에서만 나타나는 문구로 한정. (404/500은 HTTP status 검사에서 이미 처리)
  const errorKeywords = ['점검중', '서비스 준비중'];
  const languages = ['ko', 'en', 'jp', 'tw'];
  const visitedUrls = new Set<string>();

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

  type ApiRecord  = { url: string; method: string; status: number; time: number; note: string };
  // severity 미지정(undefined)은 FAIL로 간주 — WARN 성격의 기록에만 'WARN'을 명시한다.
  // (Slack 장애 알림이 WARN 항목을 섞어 나열하던 문제 해결: report-status.json 소비 측에서 필터)
  type FailRecord = { step: string; type: string; lang: string; url: string; status: number; responseTime: number; symptom: string; timestamp: string; severity?: 'FAIL' | 'WARN' };

  const apiRecords: ApiRecord[]  = [];
  const failRecords: FailRecord[] = [];

  // ── KST 타임스탬프 헬퍼 ─────────────────────────────────────────
  function kstNow() {
    return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  }

  // ── 결과 카운터 (배지용) ────────────────────────────────────────
  const testStartTime = Date.now();
  const CRAWL_DEADLINE_MS = 7 * 60 * 1000; // STEP 3 크롤 시간 예산 (전체 10분 타임아웃 방어)
  const REPORT_SAFETY_MS  = 8.5 * 60 * 1000; // 이 시점을 넘기면 이후 반복 항목은 스킵 — 최종 리포트 저장 보장
  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  let slowCount = 0; // 느린 응답(정보성) — 런 상태(WARN)·헬스 스코어엔 반영 안 함
  const serverTimes: Record<string, number> = {};

  // ── 네비게이션 재시도 헬퍼 (간헐 오리진 404/5xx/타임아웃 오탐 방지) ──────────────
  // tool·login 페이지는 CloudFront 캐시 미적용(cache-control: no-store)이라 매 요청이
  // 오리진(nginx+SSR) 직격 → 순간 부하 시 데이터 페치가 타임아웃돼 간헐 404를 뱉는다.
  // (정상 200은 TTFB 0.2s대, 실패 404는 10s대로 관측됨.) 404 한 번에 즉시 FAIL 처리하면
  // 오탐이므로, 짧은 백오프로 재확인해 실제 장애(재시도해도 실패)와 간헐(회복)을 구분한다.
  // 반환: { status, responseTime, attempts, recovered } — recovered는 2회차 이후 회복 여부.
  async function gotoWithRetry(url: string, maxAttempts = 3) {
    let lastStatus = 0;
    let lastResponseTime = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const startTime = Date.now();
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        lastResponseTime = Date.now() - startTime;
        lastStatus = res?.status() ?? 0;
        if (lastStatus === 200) {
          return { status: 200, responseTime: lastResponseTime, attempts: attempt, recovered: attempt > 1 };
        }
      } catch {
        lastStatus = 0; // 타임아웃/접속 불가
      }
      if (attempt < maxAttempts) await page.waitForTimeout(1500 * attempt); // 1.5s → 3s 백오프 (오리진 회복 대기)
    }
    return { status: lastStatus, responseTime: lastResponseTime, attempts: maxAttempts, recovered: false };
  }

  // ── 실패 시점 스크린샷 헬퍼 ────────────────────────────────────────
  // 기존엔 test.info().attach()만 써서 playwright-report에는 남지만 워크플로가 아티팩트로 올리는
  // test-results/screenshots/ 폴더엔 안 들어갔다(경로 불일치). 또 STEP은 전부 한 test라
  // afterEach 스크린샷은 '실패 스텝'이 아니라 런 종료 시점 마지막 화면만 찍혀 쓸모가 적었다.
  // → 실패가 난 그 자리에서 SCREENSHOT_DIR에 저장(아티팩트 반영) + 리포트에도 첨부한다.
  async function captureShot(label: string) {
    const safe = label.replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 60);
    const filePath = path.join(SCREENSHOT_DIR, `${safe}-${Date.now()}.png`);
    try {
      const buf = await page.screenshot({ path: filePath, fullPage: true });
      await test.info().attach(label, { body: buf, contentType: 'image/png' });
      console.log(`[SCREENSHOT] ${label} → ${filePath}`);
    } catch (e) {
      console.log(`[SCREENSHOT] 캡처 실패(${label}): ${(e as Error).message}`);
    }
    return filePath;
  }

  async function checkUrl(type: string, lang: string, url: string, isInternal: boolean = true) {
    const cleanUrl = url.split('?')[0];
    if (visitedUrls.has(cleanUrl)) return;
    visitedUrls.add(cleanUrl);

    // 외부 링크는 쿼리 파라미터 포함한 원본 URL로 요청 (파라미터 제거 시 의도치 않은 동작 방지)
    const requestUrl = isInternal ? cleanUrl : url;

    try {
      await page.waitForTimeout(Math.floor(Math.random() * 500) + 300);

      // 내부 링크는 오리진 순간 지연(캐시 미적용 SSR 페이지의 간헐 타임아웃/5xx/404) 오탐을 막기 위해
      // 짧은 백오프로 재확인한다. 외부 링크는 WARN이라 지연 누적 방지를 위해 1회만 요청.
      const maxAttempts = isInternal ? 3 : 1;
      let res!: Awaited<ReturnType<typeof page.request.get>>;
      let responseTime = 0;
      let attempts = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          const startTime = Date.now();
          res = await page.request.get(requestUrl, { headers, timeout: 8000 });
          responseTime = Date.now() - startTime;
          if (res.status() === 200 || attempt >= maxAttempts) break; // 성공 또는 마지막 시도 → 아래에서 판정
        } catch (e) {
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
      if (status === 200) {
        const body = (await res.text()).toLowerCase();
        const found = errorKeywords.find(kw => body.includes(kw.toLowerCase()));
        if (found) contentIssue = `콘텐츠 이상: "${found}" 감지`;
      }

      const isSlow = responseTime > 3000;
      const result =
        status !== 200 ? (isInternal ? 'FAIL' : 'WARN') :
        contentIssue   ? 'FAIL' :
        isSlow         ? 'SLOW' : 'PASS';  // 내부/외부 공통: 느림은 정보성(SLOW) — 스코어 미반영

      const notes: string[] = [];
      if (isRedirect)   notes.push(`리다이렉트 → ${finalUrl}`);
      if (contentIssue) notes.push(contentIssue);
      if (isSlow)       notes.push(`응답 느림: ${responseTime}ms`);
      if (recovered)    notes.push(`간헐 회복 (${attempts}회 시도)`);
      if (!isInternal)  notes.push('외부 링크');
      const noteStr = notes.join(' | ') || '정상';

      if (result === 'FAIL') {
        failCount++;
        const ts = kstNow();
        console.log(`[FAIL][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl} @ ${ts}`);
        failRecords.push({ step: 'UI/링크', type, lang, url: cleanUrl, status, responseTime, symptom: noteStr, timestamp: ts });
        expect.soft(status, `[${type}][${lang}] ${noteStr} → ${cleanUrl}`).toBe(200);
      } else if (result === 'SLOW') {
        slowCount++;  // 정보성 집계만 — 런 상태(WARN)/헬스 스코어를 깎지 않고 CI도 실패시키지 않음
        console.log(`[SLOW][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl}`);
      } else if (result === 'WARN') {
        warnCount++;
        console.log(`[WARN][${type}][${lang}] ${status} (${responseTime}ms) [외부링크] ${cleanUrl}`);
      } else {
        passCount++;
        console.log(`[PASS][${type}][${lang}] ${status} (${responseTime}ms)${isRedirect ? ' [REDIRECT]' : ''} ${cleanUrl}`);
      }

    } catch (e) {
      if (isInternal) {
        failCount++;
        const ts = kstNow();
        console.log(`[ERROR][${type}][${lang}] 접속 불가: ${cleanUrl} @ ${ts}`);
        failRecords.push({ step: 'UI/링크', type, lang, url: cleanUrl, status: 0, responseTime: 0, symptom: '접속 불가 / 타임아웃', timestamp: ts });
        expect.soft(null, `[${type}][${lang}] 접속 불가/타임아웃 → ${cleanUrl}`).not.toBeNull();
      } else {
        warnCount++;
        console.log(`[WARN][${type}][${lang}] 외부링크 접속 불가: ${cleanUrl}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // STEP 1: 다국어 서버 생존 확인
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 1 · 다국어 서버 생존 확인 (ko / en / jp / tw)', async () => {
    // 언어 간 연결을 재사용하는 keep-alive 에이전트 (전부 동일 호스트라 핸드셰이크 1회면 충분).
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const lang of languages) {
        await test.step(`[서버][${lang}] 응답 확인`, async () => {
          const serverUrl = `${baseUrl}/${lang}`;
          visitedUrls.add(serverUrl); // 최종 집계에 포함
          try {
            // 워밍업 1회(DNS/TLS·경로 캐시 비용 분리) → 본측정 3회의 중앙값을 TTFB로 채택.
            await measureTTFB(serverUrl, headers, agent);
            const samples: number[] = [];
            let status = 0;
            for (let i = 0; i < 3; i++) {
              const r = await measureTTFB(serverUrl, headers, agent);
              status = r.status;
              samples.push(r.ttfb);
            }
            samples.sort((a, b) => a - b);
            const responseTime = samples[1]; // 3회 중앙값 (본문 다운로드 제외 TTFB)

            // 3xx(트레일링 슬래시·정규화 리다이렉트)도 서버 생존으로 간주 — https.get은
            // 리다이렉트를 안 따라가므로 200만 통과시키면 정상 사이트도 FAIL 오탐이 난다.
            const isAlive = status >= 200 && status < 400;
            if (isAlive) {
              passCount++;
              serverTimes[lang] = responseTime;
              console.log(`[PASS][${lang}] 서버 ${status} (TTFB ${responseTime}ms · ${samples.join('/')})`);
            } else {
              failCount++;
              const ts = kstNow();
              console.log(`[FAIL][${lang}] 서버 ${status} (TTFB ${responseTime}ms) @ ${ts}`);
              failRecords.push({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status, responseTime, symptom: `HTTP ${status} 응답`, timestamp: ts });
            }
            expect.soft(isAlive, `서버 생존 확인 (status: ${status}, url: ${serverUrl})`).toBe(true);
          } catch {
            failCount++;
            const ts = kstNow();
            console.log(`[ERROR][${lang}] 서버 접속 불가 @ ${ts}`);
            failRecords.push({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status: 0, responseTime: 0, symptom: '접속 불가 / 타임아웃', timestamp: ts });
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
    const onResponse = async (response: { request: () => any; url: () => string; status: () => number }) => {
      const req = response.request();
      const resUrl = response.url().split('?')[0];
      const resType = req.resourceType();

      if ((resType === 'xhr' || resType === 'fetch') && resUrl.startsWith(baseUrl)) {
        const time = Date.now() - (requestStartTimes.get(response.url()) ?? Date.now());
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
          apiRecords.push({ url: resUrl, method: req.method(), status, time, note });
        } else if (severity(status) > severity(existing.status)) {
          existing.status = status;
          existing.method = req.method();
          existing.time   = time;
          existing.note   = note;
        }
      }
    };

    page.on('request', onRequest);
    page.on('response', onResponse);

    await page.setExtraHTTPHeaders(headers);

    for (const lang of languages) {
      await test.step(`[${lang}] 페이지 탐색 → API 수집`, async () => {
        const startPage = `${baseUrl}/${lang}`;
        try {
          await page.goto(startPage, { waitUntil: 'networkidle', timeout: 20000 });
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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
        const isFail = rec.status >= 500 || rec.status === 404;
        const label = `[API][${rec.method}] ${rec.status} (${rec.time}ms) ${rec.note} → ${rec.url}`;

        if (isFail) {
          failCount++;
          const ts = kstNow();
          console.log(`[FAIL] ${label} @ ${ts}`);
          failRecords.push({ step: 'STEP2·API', type: 'API', lang: '-', url: rec.url, status: rec.status, responseTime: rec.time, symptom: rec.note, timestamp: ts });
          if (rec.status >= 500) {
            try {
              await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
              const ssPath = path.join(SCREENSHOT_DIR, `api-fail-${rec.status}-${Date.now()}.png`);
              await page.screenshot({ path: ssPath, fullPage: true });
              console.log(`[SCREENSHOT] API 500 스크린샷: ${ssPath}`);
            } catch { /* 스크린샷 실패 시 무시 */ }
          }
          expect.soft(rec.status, label).toBeLessThan(500);
        } else {
          passCount++;
          console.log(`[PASS] ${label}`);
        }
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
    for (const lang of languages) {
      await test.step(`[${lang}] <a> 링크 수집 및 점검 (depth 2)`, async () => {
        const crawledPages = new Set<string>();
        const termPagesFound = new Set<string>(); // depth 무관하게 term 페이지 수집

        async function crawlPage(pageUrl: string, depth: number) {
          // 전체 test 타임아웃(10분) 전에 크롤을 자진 종료 — 크롤이 밀려 최종 리포트
          // 저장까지 못 가는 상황 방지. 예산 초과 시 남은 링크는 스킵하고 정상 종료.
          if (Date.now() - testStartTime > CRAWL_DEADLINE_MS) return;
          const cleanUrl = pageUrl.split('?')[0];
          if (crawledPages.has(cleanUrl)) return;
          crawledPages.add(cleanUrl);

          try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(500);
          } catch {
            console.log(`[SKIP][${lang}][depth${depth}] 페이지 진입 실패: ${pageUrl}`);
            return;
          }

          const internalToFollow: string[] = [];
          try {
            const links = await page.locator('a').all();
            console.log(`[INFO][${lang}][depth${depth}] ${pageUrl} → ${links.length}개 링크 발견`);

            for (const link of links) {
              // 링크 단위로도 예산 확인 — 링크가 많은 페이지에서 데드라인을 넘겨도
              // 페이지 진입 시점 체크만으론 못 멈추므로 여기서 끊는다.
              if (Date.now() - testStartTime > CRAWL_DEADLINE_MS) break;
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
                if (url.match(/\/(ko|en|jp|tw)\/tool\/[^/]+$/)) discoveredToolUrls.add(url.split('?')[0]);
              }
            }
          } catch {
            console.log(`[SKIP][${lang}][depth${depth}] 링크 수집 중단: ${pageUrl}`);
          }

          for (const nextUrl of internalToFollow) {
            await crawlPage(nextUrl, depth + 1);
          }
        }

        await crawlPage(`${baseUrl}/${lang}`, 0);

        // depth 무관하게 발견된 term 페이지에서 탭 버튼 클릭으로 숨겨진 URL 감지
        for (const termUrl of termPagesFound) {
          if (Date.now() - testStartTime > CRAWL_DEADLINE_MS) break; // 크롤 예산 공유
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
      if (Date.now() - testStartTime > REPORT_SAFETY_MS) {
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

          // 재시도로 회복된 항목(간헐)은 진짜 장애와 분리해 WARN(간헐)으로 기록 — 페이지는 살아있음
          if (status === 200 && nav.recovered) {
            warnCount++;
            const ts = kstNow();
            console.log(`[WARN][다운로드][${target.name}] 간헐 실패 후 ${nav.attempts}회차 회복 (${responseTime}ms) ${target.url} @ ${ts}`);
            failRecords.push({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom: `간헐 실패 후 회복 (${nav.attempts}회 시도)`, timestamp: ts, severity: 'WARN' });
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
            const symptom = status === 0
              ? `접속 불가 / 타임아웃 (${nav.attempts}회 재시도 실패)`
              : `HTTP ${status} 응답 (${nav.attempts}회 재시도 실패)`;
            console.log(`[FAIL][다운로드][${target.name}] ${status} (${responseTime}ms, ${nav.attempts}회 시도) ${target.url} @ ${ts}`);
            await captureShot(`실패_다운로드_${target.name}_${tlang}`); // 실제 장애 순간 화면 보존
            failRecords.push({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status, responseTime, symptom, timestamp: ts });
            expect.soft(status, `[다운로드][${target.name}] 페이지 응답 실패(${nav.attempts}회 재시도) → ${target.url}`).toBe(200);
          } else if (!hasDownloadLink) {
            warnCount++;
            await captureShot(`경고_다운로드버튼미감지_${target.name}`);
            console.log(`[WARN][다운로드][${target.name}] 페이지 정상이나 다운로드 버튼 미감지 ${target.url}`);
          } else {
            passCount++;
            console.log(`[PASS][다운로드][${target.name}] ${status} (${responseTime}ms) 다운로드 버튼 확인 ${target.url}`);

            // 실제 파일 URL HEAD 요청으로 파일 존재 확인
            const fileLinks = await page.locator('a[href*=".exe"], a[href*=".apk"], a[href*=".zip"]').all();
            for (const link of fileLinks) {
              const href = await link.getAttribute('href');
              if (!href) continue;
              const fileUrl = href.startsWith('http') ? href : baseUrl + href;
              try {
                const fileRes = await request.head(fileUrl, { timeout: 8000 });
                const fileStatus = fileRes.status();
                if (fileStatus === 200 || fileStatus === 206) {
                  passCount++;
                  console.log(`[PASS][파일][${target.name}] ${fileStatus} ${fileUrl}`);
                } else {
                  warnCount++;
                  const ts = kstNow();
                  console.log(`[WARN][파일][${target.name}] ${fileStatus} 파일 응답 이상 ${fileUrl}`);
                  failRecords.push({ step: 'STEP4·파일URL', type: '파일', lang: tlang, url: fileUrl, status: fileStatus, responseTime: 0, symptom: `파일 응답 이상 (${fileStatus})`, timestamp: ts, severity: 'WARN' });
                }
              } catch {
                warnCount++;
                console.log(`[WARN][파일][${target.name}] 파일 접근 불가: ${fileUrl}`);
              }
            }
          }
        } catch (e) {
          // 접속 불가/타임아웃은 gotoWithRetry가 status 0으로 위에서 처리 —
          // 여기는 DOM/파일 검증 중 발생한 예외만 잡는다.
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][다운로드][${target.name}] 검증 중 예외: ${target.url} @ ${ts}`);
          failRecords.push({ step: 'STEP4·다운로드', type: '다운로드', lang: tlang, url: target.url, status: 0, responseTime: 0, symptom: '검증 중 예외', timestamp: ts });
          expect.soft(null, `[다운로드][${target.name}] 검증 중 예외 → ${target.url}`).not.toBeNull();
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 5: 언어별 핵심 콘텐츠 무결성 확인 (신규)
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 5 · 언어별 핵심 콘텐츠 무결성 확인', async () => {
    for (const lang of languages) {
      await test.step(`[콘텐츠][${lang}] 핵심 키워드 존재 확인`, async () => {
        const targetUrl = `${baseUrl}/${lang}`;
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          const bodyText = await page.locator('body').innerText();
          const keywords = contentKeywords[lang] ?? [];
          const missingKeywords: string[] = [];

          for (const keyword of keywords) {
            if (!bodyText.toLowerCase().includes(keyword.toLowerCase())) {
              missingKeywords.push(keyword);
            }
          }

          if (missingKeywords.length > 0) {
            failCount++;
            const ts = kstNow();
            await captureShot(`실패_콘텐츠_${lang}`);
            const msg = `[콘텐츠][${lang}] 누락 키워드: ${missingKeywords.join(', ')}`;
            console.log(`[FAIL] ${msg} @ ${ts}`);
            failRecords.push({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: 200, responseTime: 0, symptom: `누락 키워드: ${missingKeywords.join(', ')}`, timestamp: ts });
            expect.soft(missingKeywords.length, msg).toBe(0);
          } else {
            passCount++;
            console.log(`[PASS][콘텐츠][${lang}] 핵심 키워드 모두 확인 (${keywords.join(', ')})`);
          }
        } catch {
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][콘텐츠][${lang}] 페이지 진입 실패: ${targetUrl} @ ${ts}`);
          failRecords.push({ step: 'STEP5·콘텐츠', type: '콘텐츠', lang, url: targetUrl, status: 0, responseTime: 0, symptom: '페이지 진입 실패', timestamp: ts });
          expect.soft(null, `[콘텐츠][${lang}] 페이지 진입 실패`).not.toBeNull();
        }
      });
    }
  });


  // ══════════════════════════════════════════════════════════════════
  // STEP 6: 깨진 이미지 감지
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 6 · 깨진 이미지 감지 (ko / en / jp / tw)', async () => {
    for (const lang of languages) {
      await test.step(`[${lang}] <img> 이미지 점검`, async () => {
        try {
          await page.goto(`${baseUrl}/${lang}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch {
          console.log(`[SKIP][${lang}] 페이지 진입 실패`);
          return;
        }

        const images = await page.locator('img').all();
        console.log(`[INFO][${lang}] 총 ${images.length}개 이미지 발견`);

        for (const img of images) {
          const src = await img.getAttribute('src');
          if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.includes('/_next/image')) continue; // Next.js 이미지 프록시는 쿼리 파라미터 필수라 스킵

          const imgUrl = src.startsWith('http') ? src : baseUrl + (src.startsWith('/') ? src : '/' + src);
          const cleanSrc = imgUrl.split('?')[0];
          if (visitedUrls.has(cleanSrc)) continue;
          visitedUrls.add(cleanSrc);

          try {
            const res = await page.request.get(cleanSrc, { headers, timeout: 8000 });
            const imgStatus = res.status();
            if (imgStatus !== 200) {
              warnCount++;
              const ts = kstNow();
              console.log(`[WARN][이미지][${lang}] ${imgStatus} 깨진 이미지: ${cleanSrc}`);
              failRecords.push({ step: 'STEP6·이미지', type: '이미지', lang, url: cleanSrc, status: imgStatus, responseTime: 0, symptom: `이미지 로드 실패 (${imgStatus})`, timestamp: ts, severity: 'WARN' });
            } else {
              passCount++;
              console.log(`[PASS][이미지][${lang}] ${imgStatus} ${cleanSrc}`);
            }
          } catch {
            warnCount++;
            console.log(`[WARN][이미지][${lang}] 접근 불가: ${cleanSrc}`);
          }
        }
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
      await test.step(`[로그인][${lang}] 버튼 존재 확인`, async () => {
        const loginUrl = `${baseUrl}/${lang}/login`;
        try {
          const nav = await gotoWithRetry(loginUrl); // 간헐 오리진 실패 재확인
          // gotoWithRetry는 예외를 삼키고 status를 반환하므로, 페이지가 안 뜬 경우(404/타임아웃)를
          // 여기서 명시적으로 FAIL 처리한다 — 안 그러면 버튼 미감지(WARN)로 격하돼 심각도가 어긋난다.
          if (nav.status !== 200) {
            failCount++;
            const ts = kstNow();
            console.log(`[ERROR][로그인][${lang}] 페이지 진입 실패: ${nav.status} (${nav.attempts}회 시도) ${loginUrl} @ ${ts}`);
            failRecords.push({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: nav.status, responseTime: nav.responseTime, symptom: `페이지 진입 실패 (HTTP ${nav.status}, ${nav.attempts}회 재시도)`, timestamp: ts });
            expect.soft(nav.status, `[로그인][${lang}] 페이지 진입 실패 → ${loginUrl}`).toBe(200);
            return; // 페이지가 안 떴으면 버튼 검사 무의미
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
            await captureShot(`경고_로그인버튼미감지_${lang}`);
            const ts = kstNow();
            console.log(`[WARN][로그인][${lang}] 버튼 미감지: ${missing.join(', ')} @ ${ts}`);
            failRecords.push({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 200, responseTime: 0, symptom: `버튼 미감지: ${missing.join(', ')}`, timestamp: ts, severity: 'WARN' });
          } else {
            passCount++;
            console.log(`[PASS][로그인][${lang}] 버튼 모두 확인: ${buttons.join(', ')}`);
          }
        } catch {
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][로그인][${lang}] 페이지 진입 실패: ${loginUrl} @ ${ts}`);
          failRecords.push({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 0, responseTime: 0, symptom: '페이지 진입 실패', timestamp: ts });
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
    const ezdownSeenImg = new Set<string>(); // 언어 간 공통 이미지 중복 fetch 방지
    console.log(`[INFO] STEP 8 이지다운 점검 대상: ${languages.map(l => `${ezdownBase}/${l}/`).join(', ')}`);
    for (const lang of languages) {
      await test.step(`[이지다운][${lang}] 렌더 / 콘텐츠 / 이미지`, async () => {
        const url = `${ezdownBase}/${lang}/`;
        try {
          const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
          const status = res?.status() ?? 0;
          visitedUrls.add(url);

          // 1) 렌더 생존 — SPA라 모든 경로가 200을 주므로 타이틀+본문으로 실제 렌더 확인
          const title    = (await page.title()) || '';
          const bodyText = await page.locator('body').innerText();
          const rendered = /ezdown|이지다운/i.test(title) && bodyText.trim().length > 300;

          if (status !== 200 || !rendered) {
            failCount++;
            const ts = kstNow();
            const symptom = status !== 200
              ? `HTTP ${status} 응답`
              : `렌더 실패 (title="${title}", 본문 ${bodyText.trim().length}자)`;
            console.log(`[FAIL][이지다운][${lang}] ${symptom} ${url} @ ${ts}`);
            failRecords.push({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status, responseTime: 0, symptom, timestamp: ts });
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
            await captureShot(`실패_이지다운콘텐츠_${lang}`);
            console.log(`[FAIL][이지다운][${lang}] 누락 키워드: ${missing.join(', ')} @ ${ts}`);
            failRecords.push({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status: 200, responseTime: 0, symptom: `누락 키워드: ${missing.join(', ')}`, timestamp: ts });
            expect.soft(missing.length, `[이지다운][${lang}] 콘텐츠 누락: ${missing.join(', ')}`).toBe(0);
          } else {
            passCount++;
            console.log(`[PASS][이지다운][${lang}] 렌더 + 콘텐츠 정상 → ${url}`);
          }

          // 3) 깨진 이미지 — DOM(lazy-load) 대신 URL fetch 상태로 판별
          const imgs = await page.locator('img').all();
          for (const img of imgs) {
            const src = await img.getAttribute('src');
            if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.includes('/_next/image')) continue;
            const imgUrl   = src.startsWith('http') ? src : ezdownBase + (src.startsWith('/') ? src : '/' + src);
            const cleanSrc = imgUrl.split('?')[0];
            if (ezdownSeenImg.has(cleanSrc)) continue;
            ezdownSeenImg.add(cleanSrc);
            try {
              const ir = await page.request.get(cleanSrc, { headers, timeout: 8000 });
              if (ir.status() !== 200) {
                warnCount++;
                const ts = kstNow();
                console.log(`[WARN][이지다운][이미지][${lang}] ${ir.status()} ${cleanSrc}`);
                failRecords.push({ step: 'STEP8·이지다운이미지', type: '이미지', lang, url: cleanSrc, status: ir.status(), responseTime: 0, symptom: `이미지 로드 실패 (${ir.status()})`, timestamp: ts, severity: 'WARN' });
              }
            } catch {
              warnCount++;
              console.log(`[WARN][이지다운][이미지][${lang}] 접근 불가: ${cleanSrc}`);
            }
          }
        } catch {
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][이지다운][${lang}] 접속/렌더 불가: ${url} @ ${ts}`);
          failRecords.push({ step: 'STEP8·이지다운', type: '이지다운', lang, url, status: 0, responseTime: 0, symptom: '접속 불가 / 타임아웃', timestamp: ts });
          expect.soft(null, `[이지다운][${lang}] 접속 불가 → ${url}`).not.toBeNull();
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
    for (const host of certHosts) {
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
            failRecords.push({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom, timestamp: ts });
            expect.soft(daysLeft, `[인증서][${host}] ${symptom}`).toBeGreaterThan(CERT_FAIL_DAYS);
          } else if (daysLeft <= CERT_WARN_DAYS) {
            warnCount++;
            const ts = kstNow();
            const symptom = `SSL 인증서 만료 임박 D-${daysLeft} (만료일 ${validTo})`;
            console.log(`[WARN][인증서][${host}] ${symptom}`);
            failRecords.push({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom, timestamp: ts, severity: 'WARN' });
          } else {
            passCount++;
            console.log(`[PASS][인증서][${host}] 만료까지 D-${daysLeft} (만료일 ${validTo})`);
          }
        } catch (e) {
          // 핸드셰이크 실패는 STEP 1에서 서버 장애로 이미 잡히므로 여기선 WARN으로만.
          warnCount++;
          const ts = kstNow();
          const msg = (e as Error).message || '확인 실패';
          console.log(`[WARN][인증서][${host}] 확인 실패: ${msg} @ ${ts}`);
          failRecords.push({ step: 'STEP9·인증서', type: '인증서', lang: '-', url: `https://${host}`, status: 0, responseTime: 0, symptom: `인증서 확인 실패: ${msg}`, timestamp: ts, severity: 'WARN' });
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // 최종 요약 + 배지용 JSON 저장
  // ══════════════════════════════════════════════════════════════════
  const totalCount = passCount + failCount + warnCount + slowCount;
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
    `  PASS ${passCount}  /  FAIL ${failCount}  /  WARN ${warnCount}  /  SLOW ${slowCount}  /  TOTAL ${totalCount}`,
    '  ※ SLOW(느린 응답)는 정보성 지표 — 헬스 스코어에 반영되지 않음',
    sep2,
    '[점검 범위]',
    `  페이지 / 링크 : ${visitedUrls.size}개`,
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

  if (failRecords.length > 0) {
    const affectedTypes = [...new Set(failRecords.map(r => r.type))].join(', ');
    summaryLines.push(sep2);
    summaryLines.push(`[장애 항목]  영향 범위: ${affectedTypes}`);
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
  if (failRecords.length > 0) {
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
        r.type === '인증서'  ? 'SSL 인증서 갱신 필요 (CA/호스팅 인증서 자동갱신 확인)' : '담당팀 확인 요청'
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
      `  영향 범위 : ${affectedTypes}`,
      sep2,
      '[장애 상세]',
      '',
      failLines,
      '',
      sep2,
      `전체 결과  : PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount} / SLOW ${slowCount} / TOTAL ${totalCount}`,
      '※ 스크린샷은 리포트 첨부 파일에서 확인하세요.',
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
    message: `${status} (${passCount}P/${failCount}F/${warnCount}W/${slowCount}S)`,
    color,
    lastChecked: new Date().toISOString(),
  };

  await test.info().attach('badge.json', {
    body: JSON.stringify(badgeData, null, 2),
    contentType: 'application/json'
  });

  // 인덱스 페이지 상태 배지용 파일 저장
  fs.writeFileSync('report-status.json', JSON.stringify({
    status, passCount, failCount, warnCount, slowCount, serverTimes,
    failures: failRecords.slice(0, 20),  // 최대 20건 보존
  }));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[DONE] 전체 점검 완료`);
  console.log(`  페이지/링크: ${visitedUrls.size}개`);
  console.log(`  API: ${apiRecords.length}개`);
  console.log(`  결과: PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount} / SLOW ${slowCount} / TOTAL ${totalCount}`);
  console.log(`  상태: ${status}`);
  console.log(`${'═'.repeat(60)}\n`);
});