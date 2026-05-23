// Tiny visibility manager: each layer can belong to multiple groups; a layer
// is visible only if every group it belongs to is currently checked. This
// lets the "Under construction" toggle AND the per-category toggles both
// control the same construction-dotted layers correctly.

export class VisibilityManager {
  constructor(map) {
    this.map = map;
    this.layerGroups = new Map();   // layerId -> Set<groupName>
    this.groupChecked = new Map();  // groupName -> bool
  }

  group(name, layerIds) {
    if (!this.groupChecked.has(name)) this.groupChecked.set(name, true);
    for (const id of layerIds) {
      if (!this.layerGroups.has(id)) this.layerGroups.set(id, new Set());
      this.layerGroups.get(id).add(name);
    }
    return this;
  }

  bindCheckbox(groupName, checkboxId) {
    const el = document.getElementById(checkboxId);
    if (!el) {
      console.warn(`bindCheckbox: #${checkboxId} not found`);
      return this;
    }
    this.groupChecked.set(groupName, el.checked);
    el.addEventListener('change', () => {
      this.groupChecked.set(groupName, el.checked);
      this.apply();
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
}
