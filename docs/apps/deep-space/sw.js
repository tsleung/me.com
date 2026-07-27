// Deep Space — minimal service worker.
//
// Its ONLY job is to satisfy the PWA installability requirement, so that an
// installed app gets navigator.storage.persist() granted and the IndexedDB
// screenshot store stops being evictable. There is deliberately no cache, no
// precache manifest, and no offline strategy — that was cut from v1 (see
// notes/deep-space/review_2026_07_26_fable.md).
//
// There is deliberately NO fetch handler either. A pass-through handler
// (`event.respondWith(fetch(event.request))`) looks like a no-op but is not:
// it routes every request back through the worker, which costs a round trip
// and breaks range and streaming requests. A worker with no fetch handler is
// still installable, which is the only thing this file is here for.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
