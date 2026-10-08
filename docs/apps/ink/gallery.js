// Four behaviours: images load when they come within a screen of the
// viewport, rise in once they are in view and drawn, enlarge on click, and
// the portraits swap which cast member the page shows. A hidden member's
// images are not rendered, so the observers fetch nothing of them until
// they are shown.
// The head script sets "live" (script runs) and "reveal" (the observer
// exists); without script the <noscript> copies show the same images, static.

const root = document.documentElement;
const deferred = [...document.querySelectorAll("main img[data-src]")];

// Idempotent: swaps the placeholder for the real file once.
function load(img) {
  const src = img.dataset.src;
  if (!src) return;
  img.src = src;
  delete img.dataset.src;
}

if (root.classList.contains("reveal")) {
  const ahead = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        ahead.unobserve(e.target);
        load(e.target);
      }
    },
    { rootMargin: "100% 0px" },
  );
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        seen.unobserve(img);
        load(img);
        // Rise once the pixels are there, so nothing fades in half-drawn.
        img
          .decode()
          .catch(() => {})
          .then(() => img.classList.add("in"));
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const img of deferred) ahead.observe(img);
  for (const img of document.querySelectorAll("main img")) seen.observe(img);
} else {
  deferred.forEach(load);
}

const box = document.querySelector(".lightbox");
const big = box.appendChild(document.createElement("img"));
big.alt = "";

document.querySelector("main").addEventListener("click", (e) => {
  const img = e.target.closest("img");
  if (!img || img.dataset.src) return;
  big.src = img.currentSrc || img.src;
  box.showModal();
});

box.addEventListener("click", () => box.close());
box.addEventListener("close", () => big.removeAttribute("src"));

const casts = [...document.querySelectorAll("main .cast")];
const faces = [...document.querySelectorAll(".cast-switch button")];

function show(member) {
  for (const c of casts) c.hidden = c.dataset.member !== member;
  for (const b of faces) b.setAttribute("aria-pressed", String(b.dataset.member === member));
}

for (const b of faces) b.addEventListener("click", () => show(b.dataset.member));
