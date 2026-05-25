// Mobile bottom-sheet controller.
//
// On small screens (@media max-width: 719px), the routing/directions panel
// is a draggable bottom sheet with two snap points:
//   peek — Start/End inputs + ride-style picker visible
//   full — scrollable full directions; leaves a small map strip up top
//
// Implementation: pointer events only (handles touch + mouse + stylus).
// Velocity-biased snap on release. Pure tap on the drag bar toggles
// peek ↔ full. Inner scroll inside #left-stack wins over sheet drag when
// scrollTop > 0.
//
// The sheet uses `position: fixed; height: 100vh; transform: translateY()`
// to slide vertically. To prevent the bottom of long step lists from
// being cut off, we set #left-stack's max-height to the *visible* portion
// of the sheet (snap - handle height) when snapping. Otherwise the inner
// scroll container thinks it has full sheet height and can't expose all
// content past the off-screen portion.
//
// On desktop the controller no-ops and the sheet renders as a static
// top-left panel via CSS.

const SNAPS = ['peek', 'full'];
// Drag-handle row height — matches the CSS `#sheet-handle-bar` mobile
// rule. Used to size the inner scroll area so all content remains
// reachable when scrolled.
const HANDLE_HEIGHT = 26;

// Static peek height: drag handle (26) + Directions section content
// (h3 ~22 + 2 input rows w/ margin ~66 + section padding ~22) +
// a small buffer. The section's CSS is stable, so a static value is
// simpler than measuring the DOM and dodges any layout-timing edge
// cases that could shift snap heights mid-flow.
//
// KEEP IN SYNC with the initial `transform: translateY(calc(100vh -
// 148px))` on `#sheet` in src/style.css. The CSS rule is what
// positions the sheet before sheet.js runs; if it doesn't match this
// value, the sheet flashes at the CSS height on load and then re-
// snaps to PEEK_HEIGHT once initSheet executes.
const PEEK_HEIGHT = 148;

// Top offset of the sheet when at "full" snap — leaves this many px
// of map strip visible above the sheet. Anchoring the sheet TOP to a
// fixed offset (rather than e.g. 92% of viewport) keeps the sheet
// from appearing to jump down when the iOS keyboard dismisses and
// vh grows.
const FULL_TOP_OFFSET = 44;

// Resolved at init time. Heights are pixels from the *bottom* of the
// viewport — i.e. the height of the visible sheet at each snap.
let snapPx = { peek: PEEK_HEIGHT, full: 0 };
let current = 'peek';
let sheetEl = null;
let headerEl = null;
let scrollEl = null;

function computeSnaps() {
  const vh = window.innerHeight || 800;
  snapPx = {
    peek: PEEK_HEIGHT,
    // Floor of (PEEK_HEIGHT + 60) so we never compute a full smaller
    // than peek on very short viewports (tiny in-app browsers etc).
    full: Math.max(PEEK_HEIGHT + 60, vh - FULL_TOP_OFFSET),
  };
}

function applySnap(name, { animate = true } = {}) {
  if (!sheetEl) return;
  if (!SNAPS.includes(name)) return;
  current = name;
  const vh = window.innerHeight || 800;
  const ty = vh - snapPx[name];
  sheetEl.classList.toggle('dragging', !animate);
  sheetEl.style.transform = `translateY(${ty}px)`;
  sheetEl.dataset.snap = name;
  // Constrain the inner scroll container to the actual visible portion
  // of the sheet so all content can be reached.
  if (scrollEl) {
    scrollEl.style.maxHeight = `${snapPx[name] - HANDLE_HEIGHT}px`;
  }
}

function nearestSnap(visiblePx, velocity) {
  // velocity: px/ms, positive = moving down (closing); negative = moving up
  // (opening). If a strong gesture, bias toward direction of motion.
  const sorted = SNAPS
    .map((k) => ({ k, v: snapPx[k] }))
    .sort((a, b) => a.v - b.v);
  if (Math.abs(velocity) > 0.5) {
    for (let i = 0; i < sorted.length - 1; i++) {
      if (visiblePx >= sorted[i].v && visiblePx <= sorted[i + 1].v) {
        return velocity < 0 ? sorted[i + 1].k : sorted[i].k;
      }
    }
  }
  let best = sorted[0].k;
  let bestDist = Infinity;
  for (const { k, v } of sorted) {
    const d = Math.abs(v - visiblePx);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best;
}

function isMobile() {
  return window.matchMedia('(max-width: 719px)').matches;
}

export function snapSheet(name) {
  if (!isMobile()) return;
  // Legacy callers may still pass 'half'; map to 'full'.
  if (name === 'half') name = 'full';
  applySnap(name, { animate: true });
}

export function currentSnap() {
  return current;
}

export function initSheet() {
  sheetEl = document.getElementById('sheet');
  headerEl = document.getElementById('sheet-handle-bar');
  if (!sheetEl || !headerEl) return;
  scrollEl = sheetEl.querySelector('#left-stack');
  if (scrollEl) scrollEl.classList.add('sheet-scroll');

  computeSnaps();

  const mq = window.matchMedia('(max-width: 719px)');
  const activate = () => {
    computeSnaps();
    if (isMobile()) {
      applySnap(current, { animate: false });
    } else {
      // Clear inline overrides so desktop CSS takes back over.
      sheetEl.style.transform = '';
      sheetEl.dataset.snap = '';
      if (scrollEl) scrollEl.style.maxHeight = '';
    }
  };
  activate();
  mq.addEventListener?.('change', activate);
  window.addEventListener('resize', activate);

  // Drag state.
  let dragging = false;
  let startY = 0;
  let startVisible = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let moved = false;
  let pointerId = null;

  const onPointerDown = (e) => {
    if (!isMobile()) return;
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    moved = false;
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    startVisible = snapPx[current];
    try { headerEl.setPointerCapture?.(pointerId); } catch {}
    sheetEl.classList.add('dragging');
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const y = e.clientY;
    const dy = y - lastY;
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    velocity = dy / dt;
    lastY = y;
    lastT = now;
    if (Math.abs(y - startY) > 4) moved = true;
    const totalDy = y - startY;
    let visible = startVisible - totalDy;
    const minV = snapPx.peek;
    const maxV = snapPx.full;
    if (visible < minV) visible = minV + (visible - minV) * 0.3;
    if (visible > maxV) visible = maxV + (visible - maxV) * 0.3;
    const vh = window.innerHeight || 800;
    sheetEl.style.transform = `translateY(${vh - visible}px)`;
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { headerEl.releasePointerCapture?.(pointerId); } catch {}
    pointerId = null;
    sheetEl.classList.remove('dragging');
    if (!moved) {
      // Tap → toggle peek ↔ full.
      const i = SNAPS.indexOf(current);
      const next = SNAPS[(i + 1) % SNAPS.length];
      applySnap(next, { animate: true });
      return;
    }
    const vh = window.innerHeight || 800;
    const m = (sheetEl.style.transform || '').match(/translateY\(([-\d.]+)px\)/);
    const ty = m ? Number(m[1]) : vh - snapPx[current];
    const visible = vh - ty;
    const snap = nearestSnap(visible, velocity);
    applySnap(snap, { animate: true });
  };

  // Drag is intentionally limited to the pill handle ONLY — taps on
  // the sheet content (dropdown rows, inputs, buttons, step list)
  // must not be interpreted as sheet gestures. Previously the inner
  // #left-stack also received pointer events, which made a tap on a
  // dropdown row register as a "tap with no move" → toggle peek↔full
  // (visible bug: tapping "Choose on map" snapped the sheet to full
  // immediately, because the tap-toggle fired right after
  // beginChooseOnMap's snapSheet('peek')). The pill is the
  // single source of truth for sheet gestures.
  headerEl.addEventListener('pointerdown', onPointerDown);
  headerEl.addEventListener('pointermove', onPointerMove);
  headerEl.addEventListener('pointerup', onPointerUp);
  headerEl.addEventListener('pointercancel', onPointerUp);
}
