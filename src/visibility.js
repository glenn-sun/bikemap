// Tiny visibility manager: each layer can belong to multiple groups; a layer
// is visible only if every group it belongs to is currently checked. This
// lets the "Under construction" toggle AND the per-category toggles both
// control the same construction-dotted layers correctly.
//
// `onChange(cb)` registers a callback invoked with the full
// `{groupName: bool}` snapshot whenever any group toggles — used by the
// persistence layer in main.js to save toggle state to localStorage.

export class VisibilityManager {
  constructor(map) {
    this.map = map;
    this.layerGroups = new Map();   // layerId -> Set<groupName>
    this.groupChecked = new Map();  // groupName -> bool
    this.changeListeners = [];
    this.initialDefaults = new Map();   // groupName -> default bool from HTML
  }

  group(name, layerIds) {
    if (!this.groupChecked.has(name)) this.groupChecked.set(name, true);
    for (const id of layerIds) {
      if (!this.layerGroups.has(id)) this.layerGroups.set(id, new Set());
      this.layerGroups.get(id).add(name);
    }
    return this;
  }

  /** Bind a checkbox to a group. If `persisted` (a {groupName: bool} map) has
   *  an entry for this group, its value overrides the checkbox's HTML default
   *  (state is restored from localStorage before the user sees the page). */
  bindCheckbox(groupName, checkboxId, persisted = null) {
    const el = document.getElementById(checkboxId);
    if (!el) {
      console.warn(`bindCheckbox: #${checkboxId} not found`);
      return this;
    }
    this.initialDefaults.set(groupName, el.checked);
    if (persisted && Object.prototype.hasOwnProperty.call(persisted, groupName)) {
      el.checked = persisted[groupName];
    }
    this.groupChecked.set(groupName, el.checked);
    el.addEventListener('change', () => {
      this.groupChecked.set(groupName, el.checked);
      this.apply();
      this._emitChange();
    });
    return this;
  }

  apply() {
    for (const [layerId, groups] of this.layerGroups) {
      if (!this.map.getLayer(layerId)) continue;
      const vis = [...groups].every((g) => this.groupChecked.get(g) !== false);
      this.map.setLayoutProperty(layerId, 'visibility', vis ? 'visible' : 'none');
    }
    return this;
  }

  /** Register a callback invoked on every checkbox change. */
  onChange(cb) {
    this.changeListeners.push(cb);
    return this;
  }

  /** Snapshot of {groupName: bool} for the groups that differ from their
   *  HTML defaults. Used by the persistence layer to keep the saved blob
   *  small (only deltas are stored). */
  diffFromDefaults() {
    const out = {};
    for (const [name, val] of this.groupChecked) {
      const def = this.initialDefaults.get(name);
      if (def !== val) out[name] = val;
    }
    return out;
  }

  _emitChange() {
    const snapshot = this.diffFromDefaults();
    for (const cb of this.changeListeners) cb(snapshot);
  }
}
