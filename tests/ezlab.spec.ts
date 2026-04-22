import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOT_DIR = 'test-results/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const ts = Date.now();
    const safeTitle = testInfo.title.replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
    const filePath = path.join(SCREENSHOT_DIR, `fail-${safeTitle}-${ts}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[SCREENSHOT] afterEach 실패 스크린샷: ${filePath}`);
  }
});

test('이지랩 서비스 통합 점검 (서버 / API / UI)', async ({ page, request }) => {
  test.setTimeout(600000);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  const baseUrl = 'https://ezlab.im';
  const errorKeywords = ['점검중', '서비스 준비중', '404 not found', '500 internal', 'page not found'];
  const languages = ['ko', 'en', 'jp', 'tw'];
  const visitedUrls = new Set<string>();

  // ── 각 서비스 다운로드 URL (하드코딩) ─────────────────────────────
  const downloadTargets = [
    { name: '이지캡쳐',   url: 'https://ezlab.im/ko/tool/ezcapture' },
    { name: '이지집',     url: 'https://ezlab.im/ko/tool/ezzip' },
    { name: '이지파인더', url: 'https://ezlab.im/ko/tool/ezfinder' },
    { name: '이지메모',   url: 'https://ezlab.im/ko/tool/ezmemo' },
    { name: '이지캠',     url: 'https://ezlab.im/ko/tool/ezcam' },
    { name: '이지리더',   url: 'https://ezlab.im/ko/tool/ezreader' },
    // 이지다운은 Android 전용, 별도 웹 페이지 없으므로 제외
  ];

  // ── 언어별 핵심 콘텐츠 키워드 ───────────────────────────────────
  // 실제 페이지 기준으로 확인된 키워드만 사용
  const contentKeywords: Record<string, string[]> = {
    ko: ['다운로드', '이지캡쳐', '이지집'],
    en: ['download', 'ezcapture', 'ezzip'],
    jp: ['ダウンロード', 'ezcapture', 'ezzip'],  // toLowerCase() 비교 기준으로 소문자 통일
    tw: ['下載', 'ezcapture', 'ezzip'],
  };

  type ApiRecord  = { url: string; method: string; status: number; time: number; note: string };
  type FailRecord = { step: string; type: string; lang: string; url: string; status: number; responseTime: number; symptom: string; timestamp: string };

  const apiRecords: ApiRecord[]  = [];
  const failRecords: FailRecord[] = [];

  // ── KST 타임스탬프 헬퍼 ─────────────────────────────────────────
  function kstNow() {
    return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  }

  // ── 결과 카운터 (배지용) ────────────────────────────────────────
  const testStartTime = Date.now();
  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  const serverTimes: Record<string, number> = {};

  async function checkUrl(type: string, lang: string, url: string, isInternal: boolean = true) {
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
        status !== 200 ? (isInternal ? 'FAIL' : 'WARN') :
        contentIssue   ? 'FAIL' :
        isSlow         ? 'SLOW' : 'PASS';

      const notes: string[] = [];
      if (isRedirect)   notes.push(`리다이렉트 → ${finalUrl}`);
      if (contentIssue) notes.push(contentIssue);
      if (isSlow)       notes.push(`응답 느림: ${responseTime}ms`);
      if (!isInternal)  notes.push('외부 링크');
      const noteStr = notes.join(' | ') || '정상';

      if (result === 'FAIL') {
        failCount++;
        const ts = kstNow();
        console.log(`[FAIL][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl} @ ${ts}`);
        failRecords.push({ step: 'UI/링크', type, lang, url: cleanUrl, status, responseTime, symptom: noteStr, timestamp: ts });
        expect.soft(status, `[${type}][${lang}] ${noteStr} → ${cleanUrl}`).toBe(200);
      } else if (result === 'SLOW') {
        warnCount++;
        console.log(`[SLOW][${type}][${lang}] ${status} (${responseTime}ms) ${cleanUrl}`);
        expect.soft(responseTime, `[${type}][${lang}] 응답 느림 (${responseTime}ms) → ${cleanUrl}`).toBeLessThan(3000);
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
    for (const lang of languages) {
      await test.step(`[서버][${lang}] 응답 확인`, async () => {
        const serverUrl = `${baseUrl}/${lang}`;
        visitedUrls.add(serverUrl); // 최종 집계에 포함
        try {
          const startTime = Date.now();
          const res = await request.get(serverUrl, { headers });
          const responseTime = Date.now() - startTime;
          const status = res.status();

          if (status === 200) {
            passCount++;
            serverTimes[lang] = responseTime;
            console.log(`[PASS][${lang}] 서버 ${status} (${responseTime}ms)`);
          } else {
            failCount++;
            const ts = kstNow();
            console.log(`[FAIL][${lang}] 서버 ${status} (${responseTime}ms) @ ${ts}`);
            failRecords.push({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status, responseTime, symptom: `HTTP ${status} 응답`, timestamp: ts });
          }
          expect.soft(status, `상태코드 확인 (status: ${status}, url: ${serverUrl})`).toBe(200);
        } catch {
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][${lang}] 서버 접속 불가 @ ${ts}`);
          failRecords.push({ step: 'STEP1·서버생존', type: '서버', lang, url: serverUrl, status: 0, responseTime: 0, symptom: '접속 불가 / 타임아웃', timestamp: ts });
          expect.soft(null, `접속 불가 (url: ${serverUrl})`).not.toBeNull();
        }
      });
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

        if (!apiRecords.find(r => r.url === resUrl)) {
          apiRecords.push({ url: resUrl, method: req.method(), status, time, note });
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

        async function crawlPage(pageUrl: string, depth: number) {
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

          const links = await page.locator('a').all();
          console.log(`[INFO][${lang}][depth${depth}] ${pageUrl} → ${links.length}개 링크 발견`);

          const internalToFollow: string[] = [];
          for (const link of links) {
            const rawUrl = await link.getAttribute('href');
            if (!rawUrl || rawUrl.startsWith('#') || rawUrl.startsWith('javascript:') || rawUrl.startsWith('mailto:')) continue;
            if (/\.(exe|apk|zip|dmg|msi|pkg)$/i.test(rawUrl)) continue; // 다운로드 파일 스킵

            const url = rawUrl.startsWith('http')
              ? rawUrl
              : baseUrl + (rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl);

            const isInternal = url.startsWith(baseUrl);
            await checkUrl('UI', lang, url, isInternal);

            if (isInternal && depth < 1) {
              internalToFollow.push(url);
            }
          }

          // 버튼 클릭으로 URL이 변경되는 탭 구조 감지 (term 페이지에서만)
          if (pageUrl.includes('/term/')) {
            // term 탭 버튼은 JS 로드 후 렌더링되므로 나타날 때까지 대기
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
                  if (depth < 1) internalToFollow.push(newUrl);
                  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                  await page.waitForSelector('button.flex-1', { timeout: 5000 }).catch(() => {});
                }
              } catch {
                // 클릭 불가한 버튼은 무시
              }
            }
          }

          for (const nextUrl of internalToFollow) {
            await crawlPage(nextUrl, depth + 1);
          }
        }

        await crawlPage(`${baseUrl}/${lang}`, 0);
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // STEP 4: 서비스별 다운로드 링크 직접 검증 (신규)
  // ══════════════════════════════════════════════════════════════════
  await test.step('STEP 4 · 서비스별 다운로드 페이지 직접 검증', async () => {
    for (const target of downloadTargets) {
      await test.step(`[다운로드][${target.name}]`, async () => {
        try {
          visitedUrls.add(target.url); // 최종 집계에 포함
          const startTime = Date.now();
          // page.goto 하나로 status 확인 + DOM 접근 동시에 (이중 요청 제거)
          const res = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          const responseTime = Date.now() - startTime;
          const status = res?.status() ?? 0;

          let hasDownloadLink = false;
          if (status === 200) {
            const dlLinks = await page.locator('a[href*=".exe"], a[href*=".apk"], a[href*=".zip"], a[href*="download"]').all();
            const dlButtons = await page.locator('button:has-text("다운로드"), a:has-text("다운로드"), a:has-text("Download"), a:has-text("ダウンロード"), a:has-text("下載")').all();
            hasDownloadLink = dlLinks.length > 0 || dlButtons.length > 0;
          }

          if (status !== 200) {
            failCount++;
            const ts = kstNow();
            console.log(`[FAIL][다운로드][${target.name}] ${status} (${responseTime}ms) ${target.url} @ ${ts}`);
            failRecords.push({ step: 'STEP4·다운로드', type: '다운로드', lang: 'ko', url: target.url, status, responseTime, symptom: `HTTP ${status} 응답`, timestamp: ts });
            expect.soft(status, `[다운로드][${target.name}] 페이지 응답 실패 → ${target.url}`).toBe(200);
          } else if (!hasDownloadLink) {
            warnCount++;
            const ssWarn = await page.screenshot({ fullPage: false });
            await test.info().attach(`스크린샷_다운로드_${target.name}`, { body: ssWarn, contentType: 'image/png' });
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
                  failRecords.push({ step: 'STEP4·파일URL', type: '파일', lang: 'ko', url: fileUrl, status: fileStatus, responseTime: 0, symptom: `파일 응답 이상 (${fileStatus})`, timestamp: ts });
                }
              } catch {
                warnCount++;
                console.log(`[WARN][파일][${target.name}] 파일 접근 불가: ${fileUrl}`);
              }
            }
          }
        } catch (e) {
          failCount++;
          const ts = kstNow();
          console.log(`[ERROR][다운로드][${target.name}] 접속 불가: ${target.url} @ ${ts}`);
          failRecords.push({ step: 'STEP4·다운로드', type: '다운로드', lang: 'ko', url: target.url, status: 0, responseTime: 0, symptom: '접속 불가 / 타임아웃', timestamp: ts });
          expect.soft(null, `[다운로드][${target.name}] 접속 불가/타임아웃 → ${target.url}`).not.toBeNull();
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
            const ssContent = await page.screenshot({ fullPage: false });
            await test.info().attach(`스크린샷_콘텐츠_${lang}`, { body: ssContent, contentType: 'image/png' });
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
              failRecords.push({ step: 'STEP6·이미지', type: '이미지', lang, url: cleanSrc, status: imgStatus, responseTime: 0, symptom: `이미지 로드 실패 (${imgStatus})`, timestamp: ts });
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
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

          const missing: string[] = [];
          for (const btn of buttons) {
            const count = await page.locator(`button:has-text("${btn}"), a:has-text("${btn}")`).count();
            if (count === 0) missing.push(btn);
          }

          if (missing.length > 0) {
            warnCount++;
            const ssLogin = await page.screenshot({ fullPage: false });
            await test.info().attach(`스크린샷_로그인폼_${lang}`, { body: ssLogin, contentType: 'image/png' });
            const ts = kstNow();
            console.log(`[WARN][로그인][${lang}] 버튼 미감지: ${missing.join(', ')} @ ${ts}`);
            failRecords.push({ step: 'STEP7·로그인폼', type: '로그인', lang, url: loginUrl, status: 200, responseTime: 0, symptom: `버튼 미감지: ${missing.join(', ')}`, timestamp: ts });
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
  // 최종 요약 + 배지용 JSON 저장
  // ══════════════════════════════════════════════════════════════════
  const totalCount = passCount + failCount + warnCount;
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
    `  PASS ${passCount}  /  FAIL ${failCount}  /  WARN ${warnCount}  /  TOTAL ${totalCount}`,
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
        r.type === '로그인'  ? '로그인 페이지 렌더링 확인' : '담당팀 확인 요청'
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
      `전체 결과  : PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount} / TOTAL ${totalCount}`,
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
    message: `${status} (${passCount}P/${failCount}F/${warnCount}W)`,
    color,
    lastChecked: new Date().toISOString(),
  };

  await test.info().attach('badge.json', {
    body: JSON.stringify(badgeData, null, 2),
    contentType: 'application/json'
  });

  // 인덱스 페이지 상태 배지용 파일 저장
  fs.writeFileSync('report-status.json', JSON.stringify({ status, passCount, failCount, warnCount, serverTimes }));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[DONE] 전체 점검 완료`);
  console.log(`  페이지/링크: ${visitedUrls.size}개`);
  console.log(`  API: ${apiRecords.length}개`);
  console.log(`  결과: PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount} / TOTAL ${totalCount}`);
  console.log(`  상태: ${status}`);
  console.log(`${'═'.repeat(60)}\n`);
});