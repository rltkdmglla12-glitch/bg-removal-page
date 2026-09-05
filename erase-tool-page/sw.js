/**
 * WatermarkOut Service Worker — does TWO jobs:
 *
 *   1. App shell caching (offline support, instant repeat loads).
 *   2. Cross-Origin-Isolation header injection so WebAssembly can use
 *      threads + SIMD and WebGPU can run. Without this, ONNX inference
 *      falls back to single-threaded WASM (~10× slower).
 *
 * Bump CACHE_VERSION on every release — it must match APP_VERSION in
 * js/version.js (tools/check.mjs enforces this). Old caches are auto-deleted.
 * The AI model is NOT cached here — it lives in IndexedDB (see model-cache.js).
 */

const CACHE_VERSION = 'watermarkout-v1.5.0';

// Everything needed to render both pages with no network. If you add an asset
// that either HTML file references, add it here too — otherwise it 404s for
// installed-PWA users who go offline before happening to load it once.
const APP_SHELL = [
  './',
  './index.html',
  './about.html',
  './guide.html',
  './offline.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/about.css',
  './css/fonts.css',
  './js/app.js',
  './js/about.js',
  './js/upload.js',
  './js/mask.js',
  './js/inpainter.js',
  './js/watermark-detect.js',
  './js/dewatermark.js',
  './js/texturefill.js',
  './js/model-cache.js',
  './js/updates.js',
  './js/version.js',
  './js/toast.js',
  './js/debug.js',
  './js/video.js',
  './js/coi-bootstrap.js',
  './js/fs-folder.js',
  './assets/fonts/syne-variable.woff2',
  './assets/fonts/dm-mono-400.woff2',
  './assets/fonts/dm-mono-500.woff2',
  './assets/logo.svg',
  './assets/logo-icon.svg',
  './assets/hero-illustration.svg',
  './assets/social-preview.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable.png',
];

// External CDN deps
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // `cache: 'reload'` is load-bearing, not a nicety.
    //
    // A plain cache.add() goes through the browser's ordinary HTTP cache, so a
    // fresh install can quietly bake in a STALE copy of an asset — and because
    // this worker is cache-first, it then serves that stale copy until the next
    // CACHE_VERSION bump. Observed exactly that: the server had v1.3.2 while a
    // browser kept serving v1.3.1 from a worker installed moments earlier
    // against a not-yet-updated CDN edge.
    //
    // Forcing a revalidated fetch means a new cache generation always starts
    // from what the origin actually has right now.
    const fresh = (url) => cache.add(new Request(url, { cache: 'reload' }))
      .catch(() => cache.add(url).catch(err => console.warn('SW cache miss', url, err)));

    await Promise.all(APP_SHELL.map(fresh));
    await Promise.all(
      CDN_ASSETS.map(url => cache.add(url).catch(err => console.warn('SW CDN miss', url, err)))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// === Header injection (COI) helper =========================================
// rocket-register 쪽 커스텀: 이 사본은 확장프로그램의 "이미지 조정" 팝업 안 iframe으로 띄워써야 해서
// 원본의 COOP/COEP/frame-ancestors 강제 주입을 그대로 두면 iframe 안에서 아예 렌더링이 안 된다
// (frame-ancestors 'none'은 자기 자신을 어디에도 못 넣게 막는 자기방어용 헤더라 그대로 두면 임베드 불가).
// 그래서 헤더는 건드리지 않고 그대로 통과시킨다 — 대신 cross-origin-isolation이 꺼져서
// WASM은 항상 싱글스레드로 도네(속도만 조금 느려짐, 앱 자체엔 이미 있는 정상 폴백 경로).
function withCOIHeaders(response) {
  return response;
}

// === Fetch strategy =========================================================
//   - Same-origin: cache-first, then network, with COI headers either way
//   - HuggingFace model: passthrough (IndexedDB handles its own caching)
//   - CDN libs: stale-while-revalidate, with COI headers
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  const url = new URL(req.url);

  // Don't intercept the model fetch — let it stream straight to JS for IndexedDB.
  if (url.hostname.includes('huggingface.co') || url.hostname.includes('xethub.hf.co')) {
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(cacheFirstWithCOI(req));
  } else {
    event.respondWith(staleWhileRevalidateWithCOI(req));
  }
});

async function cacheFirstWithCOI(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return withCOIHeaders(cached);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return withCOIHeaders(res);
  } catch {
    // Only a page navigation should fall back to offline.html. Returning HTML
    // for a failed image/script/JSON request just produces a confusing parse
    // error instead of an honest network failure.
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./offline.html');
      if (fallback) return withCOIHeaders(fallback);
    }
    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function staleWhileRevalidateWithCOI(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  const res = cached || await networkPromise;
  return res ? withCOIHeaders(res) : new Response(null, { status: 503 });
}
