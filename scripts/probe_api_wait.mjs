/**
 * 일회성 진단 — 현재 STEP2 대기가 API를 자르고 있는지 확인한다.
 *
 * 헬스체크 본체는 건드리지 않는다. 여기서는 같은 조건으로 페이지만 열어,
 *   [A] 현재 대기 시점(networkidle 8s + 고정 2s)까지 관측된 집합
 *   [B] navigation 시작 후 15초까지 계속 관측한 집합
 * 을 비교해 '현재 대기가 놓치는 요청·엔드포인트'를 뽑는다.
 *
 * 운영 판정·예산·크롤 범위와 무관하며, report-status.json 을 만들지 않는다.
 *
 *   HC_NET_POLICY=off|on node scripts/probe_api_wait.mjs [출력경로]
 */
import pw from 'playwright';

const { chromium } = pw;

const BASE = 'https://ezlab.im';
const LANGS = ['ko', 'en', 'jp', 'tw'];
const OBSERVE_MS = 15000;          // navigation 시작 기준 총 관찰 시간
const IDLE_TIMEOUT_MS = 8000;      // 현재 코드와 동일
const SETTLE_MS = 2000;            // 현재 코드와 동일

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OWN_HOST_RE = /^(([a-z0-9-]+\.)*ezlab\.im|([a-z0-9-]+\.)*ezdown\.kr)$/i;
const BEACON_RE = /(google-analytics\.com|analytics\.google\.com|\/g\/collect|\/collect\?|\/ccm\/collect|doubleclick\.net|googlesyndication\.com\/pagead|googleads\.g\.doubleclick|onetag\.co\.kr\/(log|collect|track))/i;

const isOwnHost = u => { try { return OWN_HOST_RE.test(new URL(u).hostname); } catch { return false; } };
const policy = (process.env.HC_NET_POLICY ?? 'on') !== 'off' ? 'on' : 'off';
const outPath = process.argv[2] ?? `probe-${policy}.json`;

const results = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();

// 헬스체크와 같은 네트워크 정책을 재현한다(beacon 차단 + 자사 식별 헤더).
if (policy === 'on') {
  await page.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if (BEACON_RE.test(url)) return route.abort('blockedbyclient').catch(() => {});
    if (isOwnHost(url)) {
      return route.continue({ headers: { ...req.headers(), 'X-Ezlab-Healthcheck': '1' } }).catch(() => {});
    }
    return route.continue().catch(() => {});
  });
}

const isApi = req => {
  const rt = req.resourceType();
  return (rt === 'xhr' || rt === 'fetch') && isOwnHost(req.url());
};

for (const lang of LANGS) {
  const events = [];          // { t, key }  — navigation 기준 상대 시각
  let navStart = 0;
  const onReq = req => {
    if (!navStart || !isApi(req)) return;
    events.push({ t: Date.now() - navStart, key: `${req.method()} ${req.url().split('?')[0]}` });
  };
  page.on('request', onReq);

  let idleOutcome = 'not-run';
  let waitEndMs = 0;
  try {
    navStart = Date.now();
    await page.goto(`${BASE}/${lang}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS })
      .then(() => { idleOutcome = 'resolved'; })
      .catch(e => { idleOutcome = /Timeout/i.test(e?.message ?? '') ? 'timeout' : 'error'; });
    await page.waitForTimeout(SETTLE_MS);
    waitEndMs = Date.now() - navStart;                 // [A] 현재 대기가 끝나는 시점
    const remain = OBSERVE_MS - waitEndMs;
    if (remain > 0) await page.waitForTimeout(remain); // [B] 15초까지 계속 관측
  } catch (e) {
    console.error(`[${policy}/${lang}] 진입 실패: ${String(e).split('\n')[0]}`);
  } finally {
    page.off('request', onReq);
  }

  const atWait = events.filter(e => e.t <= waitEndMs);
  const extra = events.filter(e => e.t > waitEndMs);
  const setWait = new Set(atWait.map(e => e.key));
  const setAll = new Set(events.map(e => e.key));
  const newEndpoints = [...setAll].filter(k => !setWait.has(k)).sort();

  results.push({
    policy, lang, idleOutcome, waitEndMs, observeMs: OBSERVE_MS,
    requestsAtWaitEnd: atWait.length,
    requestsExtra: extra.length,
    endpointsAtWaitEnd: setWait.size,
    endpointsTotal: setAll.size,
    newEndpoints,
    extraFirstMs: extra.length ? extra[0].t : null,
    extraLastMs: extra.length ? extra[extra.length - 1].t : null,
  });
  console.log(`[${policy}/${lang}] 대기종료 ${waitEndMs}ms(${idleOutcome}) · `
    + `요청 ${atWait.length}→+${extra.length} · 엔드포인트 ${setWait.size}→${setAll.size} · 신규 ${newEndpoints.length}`);
}

await browser.close();
const fs = await import('fs');
fs.writeFileSync(outPath, JSON.stringify({ policy, observeMs: OBSERVE_MS, results }, null, 2));
console.log(`저장: ${outPath}`);
