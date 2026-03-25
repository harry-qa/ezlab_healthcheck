import { test } from '@playwright/test';
import * as fs from 'fs';

test('네이버 통합 점검 (사람인 척 부드럽게 실행)', async ({ page, request }) => {
  // 전체 테스트 타임아웃 10분으로 넉넉하게 설정 (딜레이가 생겨서 오래 걸림)
  test.setTimeout(600000);

  const fileName = 'smooth_report.csv';
  let csvContent = 'Type,URL,Status,Result,Note\n';

  // [핵심] 봇 탐지 회피를 위한 헤더 설정 (일반 크롬 브라우저인 척 위장)
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  console.log('[STEP 1] API 기능 점검 시작');
  
  // API 요청 시에도 위장 헤더 사용
  const apiUrl = 'https://ac.search.naver.com/nx/ac?q=qa&con=0&ans=2&r_format=json';
  
  try {
    const apiRes = await request.get(apiUrl, { headers: headers });
    const apiStatus = apiRes.status();
    const apiData = await apiRes.json();

    if (apiStatus === 200 && apiData.items) {
      console.log(`[PASS] API 응답 정상 (Status: ${apiStatus})`);
      csvContent += `API,${apiUrl},${apiStatus},PASS,데이터 수신 성공\n`;
    } else {
      console.log(`[FAIL] API 응답 오류 (Status: ${apiStatus})`);
      csvContent += `API,${apiUrl},${apiStatus},FAIL,데이터 구조 불일치\n`;
    }
  } catch (e) {
    console.log(`[ERROR] API 통신 실패`);
    csvContent += `API,${apiUrl},Error,FAIL,통신 접속 불가\n`;
  }

  console.log('[STEP 2] UI 링크 전수 조사 시작 (천천히 실행됨)');

  // 브라우저에 헤더 설정 후 이동
  await page.setExtraHTTPHeaders(headers);
  await page.goto('https://www.naver.com');
  
  const links = await page.locator('a').all();
  console.log(`[INFO] 총 ${links.length}개의 링크 발견. 천천히 검사합니다...`);

  for (const link of links) {
    const url = await link.getAttribute('href');
    
    if (url && url.startsWith('http')) {
      try {
        // [핵심] 너무 빠르지 않게 0.5초 ~ 1.5초 사이로 랜덤하게 쉬어감
        const randomDelay = Math.floor(Math.random() * 1000) + 500;
        await page.waitForTimeout(randomDelay);

        // 링크 접속 요청 (타임아웃 5초로 연장)
        const res = await page.request.get(url, { 
          headers: headers,
          timeout: 5000 
        });
        
        const status = res.status();
        const result = status === 200 ? 'PASS' : 'FAIL';
        
        csvContent += `UI,${url},${status},${result},-\n`;
        
        // 진행 상황 로그 (성공도 보여줌)
        // console.log(`[${result}] ${status} : ${url}`); 
        
        // 실패만 보고 싶으면 아래 코드 사용
        if (result === 'FAIL') {
            console.log(`[FAIL] 접속 실패: ${status} - ${url}`);
        }

      } catch (e) {
        csvContent += `UI,${url},Error,FAIL,접속 불가/타임아웃\n`;
        // 타임아웃이나 차단된 경우 로그 출력
        // console.log(`[ERROR] 접속 불가: ${url}`);
      }
    }
  }

  fs.writeFileSync(fileName, csvContent, 'utf-8');
  console.log(`[DONE] 통합 테스트 완료. ${fileName} 파일 생성됨.`);
});