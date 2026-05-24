// Shared "click-to-place" mode state.
//
// When the user clicks "Choose on map" in a route input's dropdown, the
// next map click should set that endpoint — AND the click must not also
// trigger layer popups (bike racks, signs, etc.). This module is the small
// shared bus that lets popups.js suppress when the routing UI is in mode.
//
// State:
//   null                                       — not active
//   { which: 'start' | 'end' | 'home' | 'work' }  — active for that target

let active = null;
const listeners = [];

/** True when the user is currently in click-to-place mode for some target. */
export function isChoosingOnMap() {
  return active !== null;
}

export function getMode() { return active; }

export function setMode(mode) {
  active = mode || null;
  for (const fn of listeners) fn(active);
}

export function clearMode() { setMode(null); }

/** Subscribe to mode changes. Called with the new mode value. */
export function onModeChange(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
