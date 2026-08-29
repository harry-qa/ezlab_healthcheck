# Playwright 기반 이지랩(ezLab) 서비스 헬스 체크 자동화

[이지랩(ezLab)](https://ezlab.im) 전체 서비스를 30분 주기로 점검하는 자동화 도구입니다. 서버 생존·API·UI 링크·다운로드·콘텐츠·이미지·로그인·SSL을 4개 언어(ko/en/jp/tw)에서 9단계로 확인해 수동 점검을 대체합니다. TypeScript · Playwright · GitHub Actions · GitHub Pages.

**대시보드** https://harry-qa.github.io/ezlab_healthcheck/ · **점검 항목·판정 등급·지표 산식·운영 기준** [docs/상세.md](docs/상세.md)

## 지표 설계 판단

WARN과 FAIL을 한 산식에 넣으면 **탐지를 넓힐수록 가동률이 떨어집니다.** OG 이미지 403 검사를 추가한 직후 8월 가동률이 0%로 표시된 것이 그 사례입니다 — 검사를 하나 늘린 것이 서비스가 나빠진 것으로 읽혔습니다.

그래서 점수 하나 대신 서로 다른 질문 넷으로 분리했습니다. 서비스가 정상이었나(최근 서비스 정상률), 점검이 끝까지 돌았나(점검 완료율), 경고 없이 끝났나(무경고 실행률), 지금 열려 있는 결함이 몇 건인가(확인이 필요한 항목). 산식은 `scripts/dashboard_metrics.py`, 정의는 [docs/상세.md](docs/상세.md#대시보드-지표).

## 스코어 범위

**이지랩이 고칠 수 있는 문제만 스코어에 반영합니다.** 외부 링크(제3자 도메인) 이상처럼 이지랩이 손댈 수 없는 항목은 스코어에서 빼고 대시보드에 `참고 항목`으로만 노출합니다. 느릴 뿐 정상 응답인 경우(SLOW)도 같은 이유로 제외합니다.

## 판정 규칙 테스트

제품이 아니라 **판정 로직 자체를 테스트합니다.** 헬스체크 본체는 실제 사이트 상태에 따라 결과가 달라져서, 지금 운영에 떠 있는 결함(OG 이미지 403 등)이 고쳐지면 '그 결함을 잡는지'를 확인할 방법이 사라집니다. 그래서 규칙은 운영 서버와 무관한 테스트로 고정합니다 — `tests/judgment.spec.ts`(판정 규칙) · `scripts/test_dashboard_metrics.py`(대시보드 산식) · `scripts/test_fail_streak.py`(연속 장애).

셋 다 CI에서 헬스체크보다 **먼저** 실행하고, 여기서 실패하면 헬스체크 결과를 신뢰할 수 없으므로 즉시 중단합니다(헬스체크 본체는 `continue-on-error`).

## 점검 범위

9단계 — 다국어 서버 생존 · API 자동 수집·검증 · UI 링크 전수조사(depth 2) · 다운로드 페이지와 설치 파일 URL · 언어별 콘텐츠 · 깨진 이미지(메타·실요청·DOM 3계층) · 로그인 폼 렌더링 · 이지다운 정보 페이지 · SSL 만료. 단계별 점검 내용은 [docs/상세.md](docs/상세.md#점검-항목-9단계). 대상 서비스는 이지캡처 · 이지집 · 이지파인더 · 이지메모 · 이지캠 · 이지리더(`ezlab.im/ko/tool/*`), 이지다운(`ezdown.kr`).

## 실행

```bash
npm install && npx playwright install

npx playwright test                          # 전체 (헬스체크 + 판정 규칙)
npx playwright test tests/judgment.spec.ts   # 판정 규칙만 (운영 서버 무관, 수초)
python3 scripts/test_dashboard_metrics.py    # 대시보드 산식
python3 scripts/test_fail_streak.py          # 연속 장애 판정 규칙
npx playwright test tests/ezlab.spec.ts      # 실제 헬스체크 (운영 서버에 요청)

npx tsc --noEmit && npx playwright show-report
```

## 자동 실행

- 스케줄 `17,47 * * * *`(30분 주기) + `workflow_dispatch`. 운영 이력·Pages·Slack·Issue 는 **main 정기 스케줄 실행에서만** 갱신하고, 무료 플랜 특성상 일부 실행은 지연·누락됩니다
- FAIL 시 GitHub Issue 자동 생성 + Slack 알림(신규·지속·복구). 보존은 실행 목록·응답시간 500회 롤링 / 월별·90일 히트맵 영구 / 리포트 폴더 120일

## 개발 방식

점검 항목 선정, 판정 기준 설계, 대시보드 지표 정의는 직접 수행했고 구현에는 AI 코딩 도구를 활용했습니다.
