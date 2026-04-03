# *이 프로젝트의 코드는 Claude AI로 작성되었습니다.

# Playwright 기반 이지랩(ezLab) 서비스 헬스 체크 자동화

본 프로젝트는 [이지랩(ezLab)](https://ezlab.im) 서비스의 배포 후 안정성을 신속하게 검증하기 위해 구축된 하이브리드 자동화 도구입니다.

## 1. 개요

이지랩 전체 서비스(이지캡쳐, 이지집, 이지파인더, 이지메모, 이지캠, 이지리더)를 대상으로 서버 생존, API 응답, UI 링크 연결, 다운로드 페이지, 콘텐츠 무결성을 다국어(ko/en/jp) 환경에서 통합 점검합니다. 기존의 수동 점검 방식에서 벗어나 QA 공수를 절감하고 배포 품질을 확보하는 것을 목적으로 합니다.

## 2. 점검 항목 (5단계)

### STEP 1 · 다국어 서버 생존 확인
- `ezlab.im/ko`, `/en`, `/jp` 각 언어별 메인 페이지의 HTTP 상태 코드를 확인하여 서버 생존 여부를 즉각 판별합니다.

### STEP 2 · API 자동 수집 및 검증
- 각 언어 페이지를 탐색하면서 네트워크 인터셉트(XHR/Fetch)를 통해 내부 API 호출을 자동 수집하고, 상태 코드(4xx/5xx)를 검증합니다.

### STEP 3 · UI 링크 전수조사
- 페이지 내 모든 `<a>` 태그를 수집하여 내부/외부 링크를 분리하고, 링크 깨짐(404, 500 등) 여부를 자동으로 전수 조사합니다.
- 응답 3초 초과 시 SLOW로 분류하며, 콘텐츠 내 에러 키워드("점검중", "404 not found" 등)도 감지합니다.

### STEP 4 · 서비스별 다운로드 페이지 직접 검증
- 각 서비스(이지캡쳐~이지리더)의 개별 다운로드 페이지에 직접 진입하여 페이지 응답 상태와 다운로드 버튼(.exe/.apk/.zip) 존재 여부를 확인합니다.

### STEP 5 · 언어별 핵심 콘텐츠 무결성 확인
- 언어별 메인 페이지에서 핵심 키워드(ko: "다운로드", "이지캡쳐" 등 / en: "download", "ezcapture" 등 / jp: "ダウンロード" 등)의 존재 여부를 검증하여 콘텐츠 누락을 감지합니다.

## 3. 주요 특징

- **다국어 통합 점검**: 한국어, 영어, 일본어 3개 언어를 단일 테스트에서 순회
- **하이브리드 검증**: 서버 응답 + API 인터셉트 + UI 링크 크롤링 + 콘텐츠 검증을 한 번에 수행
- **WAF 회피**: 일반 브라우저와 동일한 `User-Agent` 헤더 적용 및 랜덤 딜레이(300ms~800ms) 로직 구현
- **자동 리포팅**: 테스트 결과를 PASS/FAIL/WARN 카운터로 집계하고 `badge.json`으로 출력
- **멀티 브라우저**: Playwright의 chromium/firefox/webkit 엔진에서 실행 가능

## 4. 기술 스택

- **Language**: TypeScript
- **Framework**: Playwright
- **Runtime**: Node.js
- **CI/CD**: GitHub Actions
- **Report Hosting**: GitHub Pages

## 5. 실행 방법

```bash
# 의존성 설치
npm install

# Playwright 브라우저 설치
npx playwright install

# 테스트 실행
npx playwright test

# HTML 리포트 확인
npx playwright show-report
```

## 6. 리포트 확인

GitHub Pages를 통해 누적 리포트를 확인할 수 있습니다.

👉 https://harry-qa.github.io/playwright-health-check/

## 7. 점검 대상 서비스

| 서비스 | 설명 | 점검 URL |
|--------|------|----------|
| 이지캡쳐(ezCapture) | 화면 캡쳐/스크롤 캡쳐/이미지 편집 | `/ko/tool/ezcapture` |
| 이지집(ezZip) | 파일 압축/해제/바이러스 스캔 | `/ko/tool/ezzip` |
| 이지파인더(ezFinder) | 로컬+웹 통합 파일 검색 | `/ko/tool/ezfinder` |
| 이지메모(ezMemo) | 데스크톱 메모/일정 관리 | `/ko/tool/ezmemo` |
| 이지캠(ezCam) | 화면 녹화 | `/ko/tool/ezcam` |
| 이지리더(ezReader) | PDF 리더 | `/ko/tool/ezreader` |

> 이지다운(ezDown)은 Android 전용으로 별도 웹 페이지가 없어 점검 대상에서 제외됩니다.
