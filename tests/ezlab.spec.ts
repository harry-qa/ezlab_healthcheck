import { test, expect } from '@playwright/test';

test('이지랩 서비스 통합 점검 (서버 / API / UI)', async ({ page, request }) => {
  test.setTimeout(600000);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  const baseUrl = 'https://ezlab.im';
  const errorKeywords = ['점검중', '서비스 준비중', '404 not found', '500 internal', 'page not found'];
  const languages = ['ko', 'en', 'jp'];
  const visitedUrls = new Set<string>();

  type ApiRecord = { url: string; method: string; status: number; time: number; note: string };
  const apiRecords: ApiRecord[] = [];

  async function checkUrl(type: string, lang: string, url: string) {
    const cleanUrl = url.split('?')[0];
    if (visitedUrls.has(cleanUrl)) return;
    visitedUrls.add(cleanUrl);

    try {
      await page.waitForTimeout(Math.floor(Math.random() * 500) + 300);

      const startTime = Date.now();
      const res = await page.request.get(cleanUrl, { headers, timeout: 8000 });
      const responseTime = Date.now() - startTime;

      const status = res.status();
      const finalUrl = res.url();
      const isRedirect = finalUrl !== cleanUrl;

      let contentIssue = '';
      if (status === 200) {
        const body = (await res.text()).toLowerCase();
        const found = errorKeywords.find(kw => body.includes(kw.toLowerCase()));
        if (found) contentIssue = `콘텐츠 이상: "${found}" 감지`;
      }

      const isSlow = responseTime > 3000;
      const result =
        status !== 200 ? 'FAIL' :
        contentIssue   ? 'FAIL' :
        isSlow         ? 'SLOW' : 'PASS';

      const notes: string[] = [];
      if (isRedirect)   notes.push(`리다이렉트 → ${finalUrl}`);
      if (contentIssue) notes.push(contentIssue);
      if (isSlow)       notes.push(`응답 느림: ${responseTime}ms`);
      const noteStr = notes.join(' | ') || '정상';

      if (result === 'FAIL') {
        console.log(`[FAIL][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl}`);
        expect.soft(status, `[${type}][${lang}] ${noteStr} → ${cleanUrl}`).toBe(200);
      } else if (result === 'SLOW') {
        console.log(`[SLOW][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl}`);
        expect.soft(responseTime, `[${type}][${lang}] 응답 느림 (${responseTime}ms) → ${cleanUrl}`).toBeLessThan(3000);
      } else {
        console.log(`[PASS][${type}][${lang}] ${status} (${responseTime}ms)${isRedirect ? ' [REDIRECT]' : ''} ${cleanUrl}`);
      }

    } catch (e) {
      console.log(`[ERROR][${type}][${lang}] 접속 불가: ${cleanUrl}`);
      expect.soft(null, `[${type}][${lang}] 접속 불가/타임아웃 → ${cleanUrl}`).not.toBeNull();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // STEP 1: 다국어 서버 생존 확인
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 1 · 다국어 서버 생존 확인 (ko / en / jp)', async () => {
    for (const lang of languages) {
      await test.step(`[서버][${lang}] 응답 확인`, async () => {
        const serverUrl = `${baseUrl}/${lang}`;
        try {
          const startTime = Date.now();
          const res = await request.get(serverUrl, { headers });
          const responseTime = Date.now() - startTime;
          const status = res.status();

          console.log(`[${status === 200 ? 'PASS' : 'FAIL'}][${lang}] 서버 ${status} (${responseTime}ms)`);
          expect.soft(status, `상태코드 확인 (status: ${status}, url: ${serverUrl})`).toBe(200);
        } catch {
          console.log(`[ERROR][${lang}] 서버 접속 불가`);
          expect.soft(null, `접속 불가 (url: ${serverUrl})`).not.toBeNull();
        }
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 2: API 자동 수집 및 검증 (네트워크 인터셉트)
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 2 · API 자동 수집 및 검증 (네트워크 인터셉트)', async () => {

    page.on('response', async (response) => {
      const req = response.request();
      const resUrl = response.url().split('?')[0];
      const resType = req.resourceType();

      if ((resType === 'xhr' || resType === 'fetch') && resUrl.startsWith(baseUrl)) {
        const startTime = (req as any)._startTime ?? Date.now();
        const time = Date.now() - startTime;
        const status = response.status();

        const note =
          status >= 500 ? '서버 오류' :
          status === 404 ? '엔드포인트 없음' :
          status === 401 || status === 403 ? '인증 필요' :
          status >= 200 && status < 300 ? '정상' : `상태코드 ${status}`;

        if (!apiRecords.find(r => r.url === resUrl)) {
          apiRecords.push({ url: resUrl, method: req.method(), status, time, note });
        }
      }
    });

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

    await test.step(`수집된 API 검증 (총 ${apiRecords.length}건)`, async () => {
      console.log(`[INFO] 총 ${apiRecords.length}개 API 수집 완료`);

      for (const rec of apiRecords) {
        const isFail = rec.status >= 500 || rec.status === 404;
        const label = `[API][${rec.method}] ${rec.status} (${rec.time}ms) ${rec.note} → ${rec.url}`;

        if (isFail) {
          console.log(`[FAIL] ${label}`);
          expect.soft(rec.status, label).toBeLessThan(500);
        } else {
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
  // STEP 3: UI 링크 전수조사
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 3 · UI 링크 전수조사 (ko / en / jp)', async () => {
    for (const lang of languages) {
      await test.step(`[${lang}] <a> 링크 수집 및 점검`, async () => {
        const startPage = `${baseUrl}/${lang}`;
        try {
          await page.goto(startPage, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch {
          console.log(`[SKIP][${lang}] 페이지 진입 실패`);
          return;
        }

        const links = await page.locator('a').all();
        console.log(`[INFO][${lang}] 총 ${links.length}개 링크 발견`);

        for (const link of links) {
          const rawUrl = await link.getAttribute('href');
          if (!rawUrl || rawUrl.startsWith('#') || rawUrl.startsWith('javascript:')) continue;

          const url = rawUrl.startsWith('http')
            ? rawUrl
            : baseUrl + (rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl);

          await checkUrl('UI', lang, url);
        }
      });
    }
  });

  console.log(`[DONE] 전체 점검 완료 — 페이지 URL ${visitedUrls.size}개, API ${apiRecords.length}개 검사`);
});