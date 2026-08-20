// 최소 서비스워커. 캐싱이나 오프라인 지원은 하지 않고, 등록만 해서
// 안드로이드가 "홈 화면에 추가"를 완전한 PWA(WebAPK)로 설치하도록 한다 —
// 서비스워커 없이 설치하면 뒤로가기 히스토리(back stack)를 제대로
// 안 잡아주는 가벼운 "바로가기"로만 설치되는 경우가 있었다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
