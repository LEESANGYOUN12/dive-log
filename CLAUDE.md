# CLAUDE.md

이 파일은 이 저장소에서 작업하는 Claude Code에게 주는 프로젝트 전용 지침입니다.

## 프로젝트 개요

Veton Dive Log — Amazfit/Zepp `.fit` 파일을 업로드하면 다이빙 세션을 분석해 보여주는 정적 웹앱. 빌드 과정 없음, 백엔드 없음, 모든 데이터는 브라우저 `localStorage`. 자세한 기능/구조는 `README.md` 참고.

## 필수 규칙

- **주석은 한글로 작성한다.** 사용자가 영어를 잘 못 읽기 때문에 명시적으로 요청한 사항이다. 새 코드에 주석을 달 때도 한글로 쓸 것.
- **커밋은 사용자가 명시적으로 요청했을 때만 한다.** "커밋하고 푸쉬해줘" 같은 요청이 오면 즉시 `git add`(관련 파일만) → 커밋(한글 메시지, `Co-Authored-By` 포함) → `git push` 순서로 처리한다. 요청 없이 먼저 커밋하지 않는다.
- **빌드 스텝이 없다.** `index.html`을 직접 `<script>`/`<link>`로 불러 쓰는 구조이므로 번들러·트랜스파일러를 도입하지 않는다.
- **UI는 최소한으로.** 버튼이나 기능을 새로 추가하는 데 신중할 것 — 예전에 백업/내보내기 기능을 만들었다가 "버튼만 많아지고 파일 내려받는 게 별로"라는 이유로 롤백된 적 있다. 꼭 필요한 것만 추가한다.
- **`back.html`은 건드리지 않는다.** 의도적으로 보관 중인 예전 버전 스냅샷이다.

## 코드 검증 절차[Veton_Dive_가이드_1.html](../Veton_Dive_%EA%B0%80%EC%9D%B4%EB%93%9C_1.html)

1. JS를 수정했으면 커밋 전에 `node --check js/log.js`로 문법을 확인한다.
2. UI/스타일 변경은 `npm run serve`로 로컬 서버를 띄운 뒤 브라우저에서 실제로 라이트/다크 모드, 필요하면 리스트형/박스형 둘 다 확인한다. 콘솔 에러도 확인한다.
3. 서버가 이미 떠 있는지 `netstat -ano | grep ':8000' | grep LISTENING` 등으로 먼저 확인하고, 새로 띄울 땐 `npm run serve`. 프로세스를 죽여야 할 때는 `taskkill //PID <pid> //F`처럼 **특정 PID만** 지정한다 (`taskkill /IM node.exe /F`로 전체 Node 프로세스를 죽이지 않는다).

## CSS 구조

`css/default.css` → `css/common.css` → `css/style.css` 순으로 `@import`된다.

- **`default.css`**: 리셋 + 색상 토큰(`:root`)과 다크모드 오버라이드(`:root[data-theme="dark"]`) + 반응형 `--pd`. 새 색상 토큰은 여기 추가하고, 라이트/다크 두 블록 모두에 값을 넣어야 한다.
- **`common.css`**: 헤더/메인/푸터 등 공통 레이아웃.
- **`style.css`**: 나머지 전체 컴포넌트 스타일.
- 다크모드 전용 스타일이 필요하면 `:root[data-theme="dark"] &` 같은 중첩(nesting) 문법을 쓴다(이 프로젝트는 이미 네이티브 CSS 중첩을 광범위하게 쓰고 있고 타깃 브라우저가 크롬이라 문제없다).
- 인라인 hex 색상을 새로 추가하지 말고 CSS 변수로 정의해서 참조할 것 — 예전에 세션 상세 아이콘 배지 배경이 인라인 hex라서 다크모드에서 안 바뀌는 버그가 있었다(`--icon-*` 토큰으로 해결).

## 다크 모드

- **시스템 설정(`prefers-color-scheme`)을 따라가지 않는다.** 헤더의 `#theme-toggle` 버튼으로 사용자가 직접 전환하고, `divelog:theme`에 저장한다.
- `index.html`의 `<head>` 인라인 스크립트가 `js/log.js` 로드 전에 저장된 테마를 `<html data-theme="...">`로 즉시 적용해 깜빡임(FOUC)을 막는다. 테마 관련 로직을 옮기거나 바꿀 땐 이 인라인 스크립트도 같이 확인할 것.
- 로고 이미지도 테마별로 다르다: 라이트는 `images/logo.svg`(`#6449A1`), 다크는 `images/logo-dark.svg`(`#a68dfa`). 로고 색을 바꾸면 두 파일 다 갱신해야 한다.
- `images/icon-512.png`(PWA 설치 아이콘)는 래스터 PNG라서 SVG 로고 색을 바꿔도 **자동으로 갱신되지 않는다.** 색상 테마를 바꿀 때마다 재생성이 필요한지 사용자에게 물어볼 것.

## SVG 차트 (`js/log.js`의 차트 엔진)

- 모든 차트는 고정 좌표계(`CHART_W=600, CHART_H=140`) 하나로 그리고, `preserveAspectRatio="none"`으로 실제 표시 너비에 강제로 맞춘다. **이 때문에 컨테이너 너비가 원래 비율과 많이 다르면(특히 박스형처럼 아주 좁아지면) 안의 `<text>` 라벨이 가로로만 눌려 찌그러져 보인다.** `fixMinmaxLabelScale()`이 실제 렌더링 너비 기준으로 라벨에 역보정 `transform`을 걸어서 고친다.
- `padR()`은 리스트형/박스형마다 다른 오른쪽 여백(`PAD_R.list`/`PAD_R.box`)을 돌려준다. 이 값은 차트를 **처음 펼칠 때** 지오메트리(그리드선, 선 경로, 라벨 위치)에 구워지므로, 뷰 모드를 전환하면 이미 펼쳐진 차트를 `renderInlineCharts()`로 통째로 다시 그려서 반영한다(`applyChartViewMode()` 참고). 이 재렌더링 로직을 건드릴 땐 `container._records`(재렌더용으로 보관해둔 원본 데이터)와 `_cleanupDrag`/`_cleanupSticky` 정리도 같이 신경 쓸 것.
- `depth` 모드는 다른 모드(`zero`/`normal`)와 y축 매핑이 반대다(수심 0이 위, 최대수심이 아래). 최대/최소 라벨을 다룰 때 이 차이를 깜빡하기 쉽다 — 실제로 한 번 버그였다.

## 테스트용 브라우저 자동화 팁

- `claude-in-chrome`의 `javascript_tool`로 실제 클릭 좌표 대신 DOM을 직접 조작(`document.querySelector(...).click()`, `chartViewMode = 'box'; applyChartViewMode();` 등)하면 스크롤 위치나 좌표 오차로 인한 실패를 피할 수 있다.
- 좁은 화면(모바일) 레이아웃을 확인할 때는 `resize_window`가 실제 뷰포트를 바꿔주지 않는 경우가 있었다 — 대신 `<style>`을 주입해 `html,body,.app`의 `width`를 강제로 좁혀서 재현하는 방법이 안정적이었다.
- `computer` 스크린샷/줌 호출이 가끔 `CDP sendCommand "Page.captureScreenshot" timed out` 에러나 타일이 반복되는 깨진 이미지를 반환할 때가 있다 — 즉시 같은 호출을 한 번 더 재시도하면 대부분 해결된다.
