const CACHE_NAME = 'arummanis-pos-v40';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11.10.8/dist/sweetalert2.all.min.js',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

self.addEventListener('install', event => {
    self.skipWaiting(); // Memaksa service worker baru langsung aktif setelah diinstall
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(ASSETS_TO_CACHE);
            })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim()) // Langsung mengontrol halaman tanpa menunggu reload halaman
    );
});

self.addEventListener('fetch', event => {
    // Jangan cache request ke Google Apps Script / API
    if (event.request.url.includes('script.google.com')) {
        return;
    }

    // Strategi: Network-First (Coba ambil dari internet dulu agar update langsung terasa, fallback ke cache jika offline)
    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // Simpan ke cache jika request GET, sukses, dan protokol HTTP/HTTPS
                if (event.request.method === 'GET' && event.request.url.startsWith('http') && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Jika gagal koneksi (offline), ambil dari cache
                return caches.match(event.request);
            })
    );
});
