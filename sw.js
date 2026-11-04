// เก็บไฟล์แอปและโมเดลไว้ในเครื่อง เปิดเร็วขึ้นและใช้ได้แม้เน็ตไม่ดี
const CACHE = 'faceclock-v1';
const FILES = [
  './', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png',
  './lib/face-api.js',
  './models/tiny_face_detector_model-weights_manifest.json', './models/tiny_face_detector_model.bin',
  './models/face_landmark_68_model-weights_manifest.json', './models/face_landmark_68_model.bin',
  './models/face_recognition_model-weights_manifest.json', './models/face_recognition_model.bin'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // ไม่แคชการส่งข้อมูลไป Google
  // ไฟล์แอป: ใช้ของใหม่จากเน็ตก่อน ถ้าไม่มีเน็ตใช้ของในเครื่อง / โมเดล: ใช้ของในเครื่องก่อน
  const isModel = url.pathname.includes('/models/') || url.pathname.includes('/lib/');
  if (isModel) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  } else {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request)));
  }
});
