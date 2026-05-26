// Mobile bottom-sheet controller.
//
// On small screens (@media max-width: 719px), the routing/directions panel
// is a draggable bottom sheet with two snap points:
//   peek — Start/End inputs + ride-style picker visible
//   full — scrollable full directions; leaves a small map strip up top
//
// Two input surfaces are wired:
//   1. The pill bar (#sheet-handle-bar) — pointer events. Drag moves the
//      sheet; pure tap toggles peek↔full.
//   2. The scrollable content area (#left-stack) — touch events with
//      passive:false so we can call preventDefault() to override native
//      scroll when we want to drag the sheet instead. The arbitration
//      rules at touchstart-decided are:
//        - peek state, any vertical swipe → drag the sheet (peek means
//          there's no useful content scrolling — the user's gesture
//          means "expand")
//        - full state, swiping down with the nearest scrollable
//          ancestor's scrollTop === 0 → drag the sheet down
//        - full state, swiping up OR scrollTop > 0 → native scroll
//      Taps on content (no movement) never toggle the sheet — only the
//      pill does that.
//
// Implementation: pointer events for the pill (handles touch + mouse +
// stylus); touch events for the content (we need touchmove with passive:
// false to coexist with native scroll). Velocity-biased snap on release.
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
// (h3 ~22 + 2 input rows w/ margin ~66 + section bottom padding ~12).
// Section top padding is 0 on mobile (see #sheet #route-endpoints rule
// in style.css), so the content sits flush with the drag handle and
// the sheet shows ~10 px more of the map below than it used to.
// The section's CSS is stable, so a static value is simpler than
// measuring the DOM and dodges any layout-timing edge cases that
// could shift snap heights mid-flow.
//
// KEEP IN SYNC with the initial `transform: translateY(calc(100vh -
// 138px))` on `#sheet` in src/style.css. The CSS rule is what
// positions the sheet before sheet.js runs; if it doesn't match this
// value, the sheet flashes at the CSS height on load and then re-
// snaps to PEEK_HEIGHT once initSheet executes.
const PEEK_HEIGHT = 138;

// Gap (px) between the floating #app-header pill's bottom edge and the
// sheet's top when expanded to "full". Matches the 10 px gutter above
// the header so the visual rhythm reads "header — gap — sheet" with
// equal whitespace on either side of the header.
const HEADER_TO_SHEET_GAP = 10;

// Fallback for the header offset if #app-header isn't in the DOM (only
// possible during early init or in tests). Mirrors the CSS values:
// `top: 10px` + `height: 40px` = bottom at y=50 → +10 gap = 60.
const FULL_TOP_OFFSET_FALLBACK = 60;

// In standalone PWA mode the header shifts down by safe-area-inset-top,
// so we measure the actual header bottom every recompute rather than
// hard-coding. Anchoring the sheet TOP to this offset (rather than e.g.
// 92% of viewport) keeps the sheet from appearing to jump down when the
// iOS keyboard dismisses and vh grows.
function fullTopOffset() {
  const h = document.getElementById('app-header');
  if (!h) return FULL_TOP_OFFSET_FALLBACK;
  return Math.round(h.getBoundingClientRect().bottom) + HEADER_TO_SHEET_GAP;
}

// Minimum gesture distance before a content swipe is interpreted as a
// drag intent. Below this we wait — short enough to feel responsive,
// long enough that horizontal text-selection wiggles don't claim.
const DRAG_THRESHOLD_PX = 4;

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
    full: Math.max(PEEK_HEIGHT + 60, vh - fullTopOffset()),
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

// Walk up from the touch target to find the nearest ancestor (within
// the sheet) that's actually scrolling its own content. We need this
// because the directions panel sometimes becomes its own scroll
// container (`overflow-y: auto` + content overflow) while the routing
// panel doesn't scroll at all. Picking the wrong element's scrollTop
// would mis-decide the drag/scroll handoff at the top of the list.
function nearestScrollAncestor(el) {
  let cur = el;
  while (cur && cur !== sheetEl && cur !== document.body) {
    if (cur.scrollHeight - cur.clientHeight > 1) {
      const oy = window.getComputedStyle(cur).overflowY;
      if (oy === 'auto' || oy === 'scroll') return cur;
    }
    cur = cur.parentElement;
  }
  return scrollEl;
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

  // ============ Pill drag (drag + tap-toggle) ============

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
    if (Math.abs(y - startY) > DRAG_THRESHOLD_PX) moved = true;
    const totalDy = y - startY;
    let visible = startVisible - totalDy;
    const minV = snapPx.peek;
    const maxV = snapPx.full;
    if (visible < minV) visible = minV + (visible - minV) * 0.3;
    if (visible > maxV) visible = maxV + (visible - maxV) * 0.3;
    const vh = window.innerHeight || 800;
    sheetEl.style.transform = `translateY(${vh - visible}px)`;
  };

  const onPointerUp = () => {
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

  // Pill listeners (drag is intentionally limited to the pill so a tap
  // anywhere else doesn't get interpreted as a tap-toggle gesture).
  headerEl.addEventListener('pointerdown', onPointerDown);
  headerEl.addEventListener('pointermove', onPointerMove);
  headerEl.addEventListener('pointerup', onPointerUp);
  headerEl.addEventListener('pointercancel', onPointerUp);

  // ============ Content drag (touch only — coexists with native scroll) ============
  //
  // Listen on the scroll container with touchmove { passive: false } so
  // we can preventDefault and override native scrolling when the gesture
  // should drag the sheet instead. The `claimed` decision is taken once
  // per gesture (at the first move past DRAG_THRESHOLD_PX) and not
  // revisited — switching mid-gesture would feel unpredictable and the
  // browser may have already started scrolling.

  let touch = null;

  const onTouchStart = (e) => {
    if (!isMobile()) return;
    if (e.touches.length !== 1) { touch = null; return; }
    const t = e.touches[0];
    const scroller = nearestScrollAncestor(e.target);
    touch = {
      claimed: null,
      startX: t.clientX,
      startY: t.clientY,
      startVisible: snapPx[current],
      startScrollTop: scroller ? scroller.scrollTop : 0,
      scroller,
      lastY: t.clientY,
      lastT: performance.now(),
      velocity: 0,
    };
  };

  const onTouchMove = (e) => {
    if (!touch || !isMobile()) return;
    const t = e.touches[0];
    const dy = t.clientY - touch.startY;
    const dx = t.clientX - touch.startX;
    const now = performance.now();
    const dt = Math.max(1, now - touch.lastT);
    touch.velocity = (t.clientY - touch.lastY) / dt;
    touch.lastY = t.clientY;
    touch.lastT = now;

    if (touch.claimed === null) {
      if (Math.abs(dy) < DRAG_THRESHOLD_PX && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      // Predominantly horizontal swipe → don't interfere (text selection,
      // horizontal scrolling, etc.).
      if (Math.abs(dx) > Math.abs(dy)) {
        touch.claimed = 'scroll';
        return;
      }
      const goingDown = dy > 0;
      if (current === 'peek') {
        // At peek any vertical swipe drags the sheet — the user's
        // intent is "expand" (or, less commonly, rubber-band the
        // closed boundary).
        touch.claimed = 'sheet';
      } else if (current === 'full') {
        // At full, going UP is always a scroll. Going DOWN drags the
        // sheet only when the scroll container is already at the top
        // (otherwise scroll back up first, then drag once at the top).
        if (goingDown && touch.startScrollTop <= 0) {
          touch.claimed = 'sheet';
        } else {
          touch.claimed = 'scroll';
        }
      } else {
        touch.claimed = 'scroll';
      }
    }

    if (touch.claimed === 'sheet') {
      e.preventDefault();
      let visible = touch.startVisible - dy;
      const minV = snapPx.peek;
      const maxV = snapPx.full;
      if (visible < minV) visible = minV + (visible - minV) * 0.3;
      if (visible > maxV) visible = maxV + (visible - maxV) * 0.3;
      const vh = window.innerHeight || 800;
      sheetEl.style.transform = `translateY(${vh - visible}px)`;
      sheetEl.classList.add('dragging');
    }
  };

  const onTouchEnd = () => {
    if (!touch) return;
    const wasSheet = touch.claimed === 'sheet';
    const v = touch.velocity;
    touch = null;
    if (!wasSheet) return;
    sheetEl.classList.remove('dragging');
    const vh = window.innerHeight || 800;
    const m = (sheetEl.style.transform || '').match(/translateY\(([-\d.]+)px\)/);
    const ty = m ? Number(m[1]) : vh - snapPx[current];
    const visible = vh - ty;
    const snap = nearestSnap(visible, v);
    applySnap(snap, { animate: true });
  };

  // touchstart is read-only — passive is fine and faster.
  sheetEl.addEventListener('touchstart', onTouchStart, { passive: true });
  // touchmove must be non-passive so we can preventDefault to take over
  // from native scroll when claiming the gesture for the sheet.
  sheetEl.addEventListener('touchmove', onTouchMove, { passive: false });
  sheetEl.addEventListener('touchend', onTouchEnd);
  sheetEl.addEventListener('touchcancel', onTouchEnd);
}
