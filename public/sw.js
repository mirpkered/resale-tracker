const CACHE='resale-tracker-shell-v2';
const BASE=new URL('.',self.registration.scope).pathname;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll([BASE,`${BASE}manifest.webmanifest`,`${BASE}icons/resale-tracker-192.png`]))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method==='GET'&&url.origin===location.origin&&!url.pathname.startsWith(`${BASE}api/`)){
    event.respondWith(fetch(event.request).catch(()=>caches.match(event.request).then(hit=>hit||caches.match(BASE))));
  }
});
