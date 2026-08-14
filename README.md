# Veton Dive Log

Amazfit / Zepp 워치에서 내보낸 `.fit` 파일을 업로드하면, 다이빙(프리다이빙) 세션별로 기록을 분석해서 보여주는 웹앱입니다. 빌드 과정이나 백엔드 서버 없이 정적 HTML/CSS/JS로 동작하며, `.fit` 파일 파싱부터 데이터 저장까지 전부 브라우저 안에서 처리됩니다. 홈 화면에 설치해 PWA(앱처럼 실행)로도 쓸 수 있습니다.

## 주요 기능

- **`.fit` 파일 업로드**: 드래그 앤 드롭 또는 파일 선택. 여러 파일을 한 번에 올릴 수 있고, 업로드 1건이 "세션" 하나가 됩니다.
- **자동 다이빙 분리**: 하나의 세션(워치 기록) 안에서 수심 변화를 기준으로 개별 다이빙 구간을 자동으로 나눕니다.
- **세션 목록**: 날짜별 카드로 표시되며, 연/월 필터로 좁혀볼 수 있습니다.
- **세션 상세**: 최대수심, 총 다이빙 시간, 다이빙 횟수, 평균 심박수 등 요약 + 다이빙별 표(시작 시각, 다이빙 시간, 최대수심).
- **다이빙별 인라인 차트**: 표에서 행을 클릭하면 아래에 바로 펼쳐집니다.
  - 수심 / 수직 속도 / 심박수 / 수온 4종 SVG 차트
  - 차트를 드래그(또는 터치)하면 크로스헤어로 해당 시점 값을 스크럽
  - 다이빙별 평균·최대 하강/상승 속도 서브 통계
  - **리스트형 / 박스형** 두 가지 배치로 전환 가능(하단 고정 바의 토글 버튼)
- **다크 모드**: 시스템 설정을 따라가지 않고, 헤더의 버튼으로 사용자가 직접 켜고 끕니다. 선택은 저장되어 다음 방문에도 유지됩니다.
- **세션/전체 삭제**: 세션 단위 삭제, 전체 초기화 지원.
- **PWA 설치**: 설치 가능한 브라우저에서는 "바로가기 추가" 버튼이 나타나고, 홈 화면에 설치하면 주소창 없는 standalone 모드 + 스플래시 화면으로 실행됩니다.

## 실행 방법

빌드 과정이 필요 없는 정적 파일이라, 정적 서버로 열기만 하면 됩니다.

```bash
npm run serve
```

`serve.js`가 현재 폴더를 `http://localhost:8000`에서 서빙합니다(포트는 `npm run serve` 인자로 변경 가능). 같은 Wi-Fi에 연결된 휴대폰 등 다른 기기에서 확인하려면 PC의 로컬 IP(예: `http://192.168.0.x:8000/index.html`)로 접속하세요. 모바일 브라우저에서 열어 "홈 화면에 추가"하면 PWA로 설치됩니다.

## 프로젝트 구조

```
index.html          앱 마크업 + PWA 메타태그 + 다크모드 FOUC 방지 인라인 스크립트
manifest.json        PWA 매니페스트
serve.js             빌드 없는 정적 파일 서버 (개발/로컬 확인용)
css/
  default.css         리셋 + 색상 토큰(:root, 다크모드 [data-theme="dark"]) + 반응형 --pd
  common.css          공통 레이아웃(header/main/footer)
  style.css           나머지 전체 컴포넌트 스타일 (default.css, common.css를 @import)
js/
  log.js              전체 애플리케이션 로직(아래 "코드 구성" 참고)
images/
  logo.svg            라이트모드 로고
  logo-dark.svg        다크모드 로고(같은 로고, fill 색만 다름)
  icon-512.png         PWA 아이콘(래스터 PNG, 로고 색을 바꿔도 자동으로 갱신되지 않음)
back.html             예전 버전 스냅샷(의도적으로 보관 중인 백업, 더 이상 수정하지 않음)
```

## 코드 구성 (`js/log.js`)

파일 하나에 전부 들어있으며, 위에서부터 대략 이런 순서로 구성돼 있습니다.

1. **시작 스플래시**: standalone(PWA) 실행일 때만 스플래시 표시
2. **FIT 바이너리 파서** (`FitParser` 클래스): Garmin FIT 포맷 최소 구현. Amazfit/Zepp도 이 포맷을 씁니다.
3. **레코드 추출 / 다이빙 분리** (`extractRecords`, `segmentDives`, `withDerived`)
4. **localStorage 저장소** (`LS_PREFIX = 'divelog:'`, `lsGet`/`lsSet`/`lsDel`) — 아래 "데이터 저장" 참고
5. **다크모드** (`theme`, `applyTheme`)
6. **세션 목록 / 필터** (`renderSessionList`, `getFilteredSessions`, `syncFilterSelects`)
7. **세션 상세** (`openSession`)
8. **차트 엔진**: 고정 SVG 좌표계(`CHART_W`/`CHART_H` = 600×140) 위에 `buildChartGeometry`로 좌표를 계산하고 `svgChart`로 뼈대를 그립니다. 실제 표시 너비는 CSS로만 맞추므로(`preserveAspectRatio="none"`), 리스트형/박스형처럼 너비가 크게 달라지는 상황에서는 텍스트 라벨이 가로로만 눌려 보이는 문제가 있어 `fixMinmaxLabelScale`로 역보정합니다. 뷰 모드 전환 시 이미 펼쳐진 차트는 `padR()`(리스트형/박스형 별도 여백) 기준으로 통째로 다시 그립니다.
9. **인라인 차트 렌더 / 크로스헤어 드래그** (`renderInlineCharts`, `updateInlineCrosshair`, `attachInlineDrag`)
10. **파일 업로드 처리** (`handleFiles`, `finishUpload`)
11. **PWA 설치 버튼 / 이벤트 바인딩 / 초기화**

## 데이터 저장

모든 데이터는 브라우저 `localStorage`에 `divelog:` 접두사로 저장됩니다(서버 전송 없음).

- `divelog:sessions` — 업로드(세션) 요약 목록
- `divelog:dives:<세션id>` — 해당 업로드의 다이빙 메타 목록
- `divelog:records:<다이빙id>` — 다이빙 하나의 전체 샘플 배열
- `divelog:theme` — 다크/라이트 선택
- `divelog:chartViewMode` — 리스트형/박스형 선택

세션 하나를 열 때 다른 세션들의 원본 샘플까지 같이 불러오지 않도록 이렇게 나눠 저장합니다. 브라우저 저장소이므로 **기기·브라우저를 바꾸면 데이터가 보이지 않습니다** — 로컬 파일로 직접 열기보다는 `npm run serve`(또는 GitHub Pages 등 호스팅)로 접속해서 쓰는 걸 권장합니다.

## 기술 스택

- 순수 HTML / CSS / JavaScript — 프레임워크, 번들러, 빌드 스텝 없음
- 차트는 라이브러리 없이 SVG를 직접 생성
- 폰트는 Pretendard(CDN)
- 크롬 브라우저 사용을 권장합니다(다른 브라우저에서는 일부 스타일/동작이 다를 수 있습니다)
