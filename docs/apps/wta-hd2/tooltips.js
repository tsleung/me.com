// Lightweight tooltip popover for any element that carries a `data-help`
// attribute. Behavior:
//   - mouseenter / focusin → show floating popover
//   - mouseleave / focusout → hide (unless pinned)
//   - click → pin (stays until next outside click or Esc)
//   - Esc / outside click / scroll → unpin + hide
// One shared popover element; positioned below the source, flipped above
// if it would clip the viewport, clamped horizontally to stay on-screen.

let pop = null;
let pinned = null;
let pinnedAt = 0;
let globalsBound = false;
const PIN_GRACE_MS = 250;

function ensurePop() {
  if (pop) return pop;
  pop = document.createElement("div");
  pop.className = "tooltip-pop";
  pop.setAttribute("role", "tooltip");
  pop.hidden = true;
  document.body.appendChild(pop);
  return pop;
}

function showFor(el) {
  const text = el?.dataset?.help;
  if (!text) return;
  const p = ensurePop();
  p.textContent = text;
  p.hidden = false;
  // Reset position so measurement is accurate
  p.style.left = "0px";
  p.style.top = "0px";
  const r = el.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  const margin = 8;
  let x = r.left + r.width / 2 - pr.width / 2;
  let y = r.bottom + margin;
  if (y + pr.height > window.innerHeight - 8) y = r.top - pr.height - margin;
  x = Math.max(8, Math.min(window.innerWidth - pr.width - 8, x));
  p.style.left = `${Math.round(x)}px`;
  p.style.top = `${Math.round(y)}px`;
}

function hide() {
  if (pop) pop.hidden = true;
}

function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  document.addEventListener("click", () => {
    // Ignore the synthetic click that <label for="..."> dispatches on its
    // for-target right after we just pinned the tooltip.
    if (pinned && performance.now() - pinnedAt < PIN_GRACE_MS) return;
    pinned = null;
    hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { pinned = null; hide(); }
  });
  window.addEventListener("scroll", () => { pinned = null; hide(); }, true);
  window.addEventListener("resize", () => { pinned = null; hide(); });
}

export function mountTooltips(root = document) {
  bindGlobals();
  const els = root.querySelectorAll("[data-help]");
  els.forEach((el) => {
    if (el.dataset.tooltipBound === "1") return;
    el.dataset.tooltipBound = "1";
    el.classList.add("has-help");
    if (!el.hasAttribute("tabindex") && el.tagName !== "BUTTON" && el.tagName !== "INPUT") {
      el.setAttribute("tabindex", "0");
    }
    el.addEventListener("mouseenter", () => { if (!pinned) showFor(el); });
    el.addEventListener("mouseleave", () => { if (!pinned) hide(); });
    el.addEventListener("focusin", () => { if (!pinned) showFor(el); });
    el.addEventListener("focusout", () => { if (!pinned) hide(); });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pinned === el) { pinned = null; hide(); }
      else { pinned = el; pinnedAt = performance.now(); showFor(el); }
    });
  });
}
