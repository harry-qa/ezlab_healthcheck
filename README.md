# *이 프로젝트의 코드는 Claude AI로 작성되었습니다.

# Playwright 기반 이지랩(ezLab) 서비스 헬스 체크 자동화

[이지랩(ezLab)](https://ezlab.im) 전체 서비스를 30분 주기로 점검하는 자동화 도구입니다. 서버 생존·API·UI 링크·다운로드·콘텐츠·이미지·로그인·SSL을 4개 언어(ko/en/jp/tw)에서 한 번에 확인해 수동 점검을 대체합니다.

**대시보드** https://harry-qa.github.io/ezlab_healthcheck/ · **판정·운영 기준** [docs/상세.md](docs/상세.md)

## 점검 항목 (9단계)

| STEP | 점검 내용 |
|---|---|
| **1** · 다국어 서버 생존 | `ezlab.im/ko`, `/en`, `/jp`, `/tw` HTTP 상태 (워밍업 1회 + 본측정 3회) |
| **2** · API 자동 수집·검증 | 탐색 중 네트워크 인터셉트(XHR/Fetch)로 내부 API 수집 후 4xx/5xx 검증 |
| **3** · UI 링크 전수조사 | 내부 링크 depth 2까지 재귀 탐색. 탭 전환 페이지 감지, 다운로드·`mailto:` 제외 |
| **4** · 다운로드 페이지 | 도구 페이지(`/ko/tool/*`) 응답 상태와 다운로드 버튼 존재 |
| **4-1** · 설치 파일 URL | `/api/tools/info` 의 실제 설치 파일 URL을 HEAD 확인, 차단 CDN만 Range GET |
| **5** · 언어별 메인 페이지 | 핵심 키워드로 콘텐츠 누락 감지 + 이미지 수집 동시 수행 |
| **6** · 깨진 이미지 | OG/Twitter 메타 · 브라우저 실제 요청 · DOM `<img src>` 3계층 |
| **7** · 로그인 폼 렌더링 | 소셜/이메일 버튼 렌더 (ko: 카카오·네이버·구글·이메일 / 그 외: 구글·이메일) |
| **8** · 이지다운 정보 페이지 | 별도 도메인 `ezdown.kr` 타이틀·본문·후기·FAQ |
| **9** · SSL 인증서 만료 | `ezlab.im` / `ezdown.kr` 만료일을 TLS 핸드셰이크로 확인 |

## 실행

```bash
npm install && npx playwright install

npx playwright test                          # 전체 (헬스체크 + 판정 규칙)
npx playwright test tests/judgment.spec.ts   # 판정 규칙만 (운영 서버 무관, 수초)
python3 scripts/test_fail_streak.py          # 연속 장애 판정 규칙
npx playwright test tests/ezlab.spec.ts      # 실제 헬스체크 (운영 서버에 요청)

npx tsc --noEmit && npx playwright show-report
```

## 판정 등급

**이지랩이 고칠 수 있는 문제만 스코어에 반영**합니다.

| 등급 | 스코어 | 사례 |
|---|:---:|---|
| **FAIL** | O | 서버/API 응답 이상(404·5xx), 점검 페이지 노출, 로그인 진입 실패, 인증서 D-7 이하 |
| **WARN** | O | 이미지 로드 실패, 다운로드 버튼 미감지, 로그인 버튼 누락, 크롤 렌더 실패, 인증서 D-14 이하, 오리진 간헐 불안정 |
| **SLOW** | X | 응답 3초 초과 — 느릴 뿐 정상 응답 |
| **INFO** | X | 외부 링크(제3자 도메인) 이상, 재시도 후 회복된 간헐 실패 |

외부 링크는 이지랩이 고칠 수 없어 스코어에서 뺍니다(대시보드에 `참고 항목`으로 노출). 간헐 회복은 한 런에서 서로 다른 지문 2종 이상일 때만 `오리진 간헐 불안정` WARN 1건으로 승격합니다.

## 대시보드 지표

WARN과 FAIL을 한 산식에 넣으면 **탐지를 넓힐수록 가동률이 떨어져서**(OG 403 검사 추가 직후 8월 가동률 0% 표시) 질문 넷으로 분리했습니다. 산식은 `scripts/dashboard_metrics.py`.

| 지표 | 산식 | 메모 |
|---|---|---|
| **최근 서비스 정상률** | `가용 / (가용 + 장애)` | FAIL=장애, PASS·완주 WARN=가용, 미완주 WARN·UNKNOWN=확인 불가(분모 제외) |
| **점검 완료율** | `완주 실행 / 완주 여부를 아는 실행` | 헬스체크 자체의 건강 지표. 표본 10건 미만이면 `데이터 부족` |
| **무경고 실행률** | `PASS / (PASS+WARN+FAIL)` | 검사를 추가하면 낮아지는 것이 정상 |
| **확인이 필요한 항목** | 지문 단위 미해결 결함 수 | 완주 실행에서 2회 연속 미검출이면 해결 전환 |

이 밖에 TTFB 추이(언어별, 임계 500ms) · SSL 만료 D-day · 90일 히트맵 · 월별 가동률 도넛 · 실행 목록(cURL 재현 명령 포함)을 표시합니다. 월별 도넛은 확인 불가가 분모에서 빠져 **세그먼트 비율과 가운데 숫자가 일부러 다릅니다.**

## 자동 실행

- 스케줄 `17,47 * * * *` (30분 주기) + `workflow_dispatch`. 무료 플랜 특성상 일부 실행은 지연·누락됩니다
- 운영 이력·Pages·Slack·Issue 는 **main 정기 스케줄 실행에서만** 갱신. 수동·브랜치 실행은 아티팩트만
- 보존: 실행 목록·응답시간 500회 롤링 / 월별·90일 히트맵 영구 / 리포트 폴더 120일
- FAIL 시 GitHub Issue 자동 생성 + Slack 알림(신규·지속·복구)

## 점검 대상 서비스

| 서비스 | 설명 | 점검 URL |
|---|---|---|
| 이지캡처(ezCapture) | 화면 캡처/스크롤 캡처/이미지 편집 | `/ko/tool/ezcapture` |
| 이지집(ezZip) | 파일 압축/해제/바이러스 스캔 | `/ko/tool/ezzip` |
| 이지파인더(ezFinder) | 로컬+웹 통합 파일 검색 | `/ko/tool/ezfinder` |
| 이지메모(ezMemo) | 데스크톱 메모/일정 관리 | `/ko/tool/ezmemo` |
| 이지캠(ezCam) | 화면 녹화 | `/ko/tool/ezcam` |
| 이지리더(ezReader) | PDF 리더 | `/ko/tool/ezreader` |
| 이지다운(ezDown) | 별도 도메인 정보 페이지 | `ezdown.kr` (STEP 8) |

## 기술 스택

TypeScript · Playwright · Node.js · GitHub Actions · GitHub Pages
