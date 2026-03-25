import { test } from '@playwright/test';
import * as fs from 'fs';

test('Daum 서비스 통합 점검(API 및 UI)', async ({ page, request }) => {
  // 1. 타임아웃 설정: 10분 (사람인 척 천천히 돌기 때문)
  test.setTimeout(600000); 

  const fileName = 'daum_report.csv';
  let csvContent = 'Type,URL,Status,Result,Note\n';

  // [보안 우회] 일반 크롬 브라우저 위장 헤더
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  console.log('[STEP 1] Daum 서버 상태 점검 시작');
  
  // 2. [Network] Daum 메인 서버 상태 체크
  const serverUrl = 'https://www.daum.net';
  
  try {
    const apiRes = await request.get(serverUrl, { headers: headers });
    const apiStatus = apiRes.status();

    if (apiStatus === 200) {
      console.log(`[PASS] Daum 서버 응답 정상 (Status: ${apiStatus})`);
      csvContent += `Network,${serverUrl},${apiStatus},PASS,서버 생존 확인\n`;
    } else {
      console.log(`[FAIL] Daum 서버 응답 이상 (Status: ${apiStatus})`);
      csvContent += `Network,${serverUrl},${apiStatus},FAIL,서버 불안정\n`;
    }
  } catch (e) {
    console.log(`[ERROR] Daum 서버 접속 불가`);
    csvContent += `Network,${serverUrl},Error,FAIL,접속 차단됨\n`;
  }

  console.log('[STEP 2] UI 링크 전수 조사 시작');

  // 3. [UI] Daum 메인 페이지 진입
  await page.setExtraHTTPHeaders(headers);
  await page.goto('https://www.daum.net');
  
  const links = await page.locator('a').all();
  console.log(`[INFO] 총 ${links.length}개의 링크 발견. 검사를 시작합니다...`);

  for (const link of links) {
    const url = await link.getAttribute('href');
    
    // http로 시작하는 유효한 링크만 검사
    if (url && url.startsWith('http')) {
      try {
        // [핵심] 봇 탐지 회피: 0.5초 ~ 1.5초 랜덤 대기
        const randomDelay = Math.floor(Math.random() * 1000) + 500;
        await page.waitForTimeout(randomDelay);

        // 링크 접속 요청 (타임아웃 5초)
        const res = await page.request.get(url, { 
          headers: headers,
          timeout: 5000 
        });
        
        const status = res.status();
        const result = status === 200 ? 'PASS' : 'FAIL';
        
        csvContent += `UI,${url},${status},${result},-\n`;
        
        // 진행 상황 로그 (이모티콘 없이 텍스트로만 표시)
        if (result === 'FAIL') {
            console.log(`[FAIL] 접속 실패: ${status} - ${url}`);
        } else {
            console.log(`[ING] ${status} : ${url}`);
        }

      } catch (e) {
        csvContent += `UI,${url},Error,FAIL,접속 불가/타임아웃\n`;
        // 접속 불가 로그 생략 (원하시면 주석 해제)
        // console.log(`[ERROR] 접속 불가: ${url}`);
      }
    }
  }

  // 4. 결과 파일 저장
  fs.writeFileSync(fileName, csvContent, 'utf-8');
  console.log(`[DONE] 검사 완료. ${fileName} 파일이 생성되었습니다.`);
});