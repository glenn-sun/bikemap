"""Heat-equation elevation correction for flagged subgraph groups.

For each connected component of correction-flagged way-segments
(bridge / tunnel / layered / untagged-crossing / approach), where
connectivity is via shared OSM nodes:

  1. Classify nodes:
       boundary = has ≥1 unflagged incident way-segment in the FULL
                  graph (its DTM elevation is trustworthy — sits at the
                  transition from the flagged surface to normal streets,
                  or at the 200 ft polyline isoline split node).
       interior = all incident way-segments are flagged.
  2. Solve the discrete Dirichlet problem on the flagged sub-network:
       minimize Σ_edges (e_u − e_v)² / L_{uv}
       with boundary elevations fixed at their DTM values.
       Equivalent: at each interior node, weighted-average (by 1/L) of
       neighbors equals its own elevation. Linear system, symmetric
       positive-definite.
  3. Apply solution: overwrite interior node elevations. Then for each
     flagged way-segment in the group, linear-interpolate the per-vertex
     geom-elevation profile between the (now corrected) endpoint
     elevations. Recompute per-edge climb metrics analytically (linear
     profile → constant slope).

We process EVERY group with ≥1 boundary node, including groups with
internal grade-separated crossings. The heat eq is solved on graph
adjacency, not 2D geometry, so internal crossings between paths that
don't share an OSM node naturally stay separated. Where two crossing
paths DO share an OSM node elsewhere in the group (multi-level
structures with stairs / elevators / shared building entrances), the
heat eq collapses them to the same elevation in a small neighborhood
of the shared node. For bike-routing slope purposes this is
acceptable — the resulting slopes are still reasonable, and the
overall corridor reads correctly. Identifying / repairing those local
failures would be a separate refinement.

Re-run order: build_graph.py → sample_dtm.py → resolve_elevation.py.
The latter two read what the previous one wrote and overwrite the
same routing_graph.json in place.
"""
import json
import math
import sys
import time
from collections import defaultdict

import numpy as np


GRAPH_PATH = "public/data/routing_graph.json"

# Edge flag bits (matches CLAUDE.md / build_graph.py)
BIT_BRIDGE   = 4
BIT_TUNNEL   = 8
BIT_COVERED  = 16
BIT_INDOOR   = 32
BIT_UC       = 64
BIT_APPROACH = 128
BIT_EMB      = 256
BIT_CUT      = 512

STEEP_THR = 0.02  # matches cost.js + sample_dtm.py
FT_PER_M  = 3.28084


def haversine_ft(p1, p2):
    """Distance between two (lon, lat) tuples in feet."""
    R_M = 6371000.0
    lon1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lon2, lat2 = math.radians(p2[0]), math.radians(p2[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = (math.sin(dlat/2)**2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2)
    return 2 * R_M * math.asin(math.sqrt(a)) * FT_PER_M


def is_correction_target(flags, layer):
    """Same filter as analyze_elevation_groups.py."""
    if flags & (BIT_BRIDGE | BIT_TUNNEL | BIT_UC | BIT_APPROACH):
        return True
    if (layer is not None and layer != 0
        and not (flags & (BIT_BRIDGE | BIT_TUNNEL | BIT_EMB | BIT_CUT))):
        return True
    return False


class UF:
    def __init__(self):
        self.p = {}
    def add(self, x):
        if x not in self.p:
            self.p[x] = x
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def main():
    t0 = time.time()
    print("loading graph...")
    g = json.load(open(GRAPH_PATH))
    e = g["edges"]
    geoms = g["geoms"]
    geom_elevs = g["geomElevs"]
    nodes_elev = list(g["nodes"]["elev"])  # mutable copy
    n_edges = len(e["from"])
    n_nodes = len(g["nodes"]["lon"])
    print(f"  {n_nodes:,} nodes, {n_edges:,} directed edges")

    # --- Build flagged-segment table (deduped by frozenset endpoints) ---
    seg_repr = {}
    seg_len  = {}
    seg_dirs = defaultdict(list)
    seg_flag = {}
    for i in range(n_edges):
        u, v = e["from"][i], e["to"][i]
        key = frozenset((u, v))
        seg_dirs[key].append(i)
        if key not in seg_repr:
            seg_repr[key] = i
            seg_len[key]  = e["lengthFt"][i]
            seg_flag[key] = is_correction_target(e["flags"][i], e["layer"][i])
    flagged_segs = {k for k, ok in seg_flag.items() if ok}
    print(f"  {len(flagged_segs):,} flagged way-segments")

    # --- Connected groups (shared-node union-find on flagged segments) ---
    uf = UF()
    for k in flagged_segs:
        uf.add(k)
    node_to_flagged = defaultdict(list)
    for k in flagged_segs:
        for nid in k:
            node_to_flagged[nid].append(k)
    for nid, ss in node_to_flagged.items():
        if len(ss) < 2:
            continue
        a = ss[0]
        for s in ss[1:]:
            uf.union(a, s)

    groups = defaultdict(list)
    for k in flagged_segs:
        groups[uf.find(k)].append(k)
    print(f"  {len(groups):,} connected groups")

    # --- Boundary / interior nodes per group ---
    # boundary = has ≥1 unflagged incident way-segment in the full graph
    incident_segs = defaultdict(set)
    for k in seg_dirs:
        for nid in k:
            incident_segs[nid].add(k)

    group_info = {}
    for root, segs in groups.items():
        nodes_in = set()
        for s in segs:
            nodes_in.update(s)
        boundary = set()
        interior = set()
        for nid in nodes_in:
            if any(s not in flagged_segs for s in incident_segs[nid]):
                boundary.add(nid)
            else:
                interior.add(nid)
        group_info[root] = {"segs": segs, "boundary": boundary,
                            "interior": interior}

    # --- Adjacency along flagged segments only (for the heat eq) ---
    flagged_adj = defaultdict(list)
    for k in flagged_segs:
        u, v = tuple(k)
        L = seg_len[k]
        flagged_adj[u].append((v, L))
        flagged_adj[v].append((u, L))

    # --- Solve the discrete Dirichlet problem per group ---
    # Every group with ≥1 boundary node is processed. Heat eq on graph
    # adjacency naturally preserves grade separation between paths that
    # don't share an OSM node; collapses paths together near nodes they
    # do share. Accuracy at multi-level junctions is a known limitation
    # — see the module docstring.
    print("solving heat equation per group...")
    n_solved = 0
    n_skipped_no_boundary = 0
    n_singular = 0
    resolved_segs = set()

    for root in groups.keys():
        info = group_info[root]
        boundary = info["boundary"]
        interior = info["interior"]
        segs     = info["segs"]
        if not boundary:
            n_skipped_no_boundary += 1
            continue
        # No interior → trivially "resolved": geom profiles get linear-
        # interp'd between the (already trusted) boundary elevations.
        if not interior:
            resolved_segs.update(segs)
            n_solved += 1
            continue
        interior_list = list(interior)
        idx = {nid: i for i, nid in enumerate(interior_list)}
        n_int = len(interior_list)
        A = np.zeros((n_int, n_int))
        b = np.zeros(n_int)
        for i, nid in enumerate(interior_list):
            for (nb, L) in flagged_adj[nid]:
                w = 1.0 / max(L, 1e-6)
                A[i, i] += w
                if nb in idx:
                    A[i, idx[nb]] -= w
                else:
                    b[i] += w * nodes_elev[nb]
        try:
            x = np.linalg.solve(A, b)
        except np.linalg.LinAlgError:
            n_singular += 1
            continue
        for i, nid in enumerate(interior_list):
            nodes_elev[nid] = float(x[i])
        resolved_segs.update(segs)
        n_solved += 1

    print(f"  solved: {n_solved:,}  "
          f"no-boundary: {n_skipped_no_boundary:,}  "
          f"singular: {n_singular:,}")

    # --- Linear-interp geom profiles + recompute climb metrics ---
    print("rewriting geom profiles + climb metrics...")
    geom_updated = set()
    new_uphill   = list(e["uphillFt"])
    new_maxpct   = list(e["maxUphillPct"])
    new_steepft2 = list(e["steepFt2"])

    for k in resolved_segs:
        i_repr = seg_repr[k]
        gi     = e["geom"][i_repr]
        if gi in geom_updated:
            continue
        coords = geoms[gi]
        n_vtx  = len(coords)
        if n_vtx < 2:
            continue
        # Identify the geom-start / geom-end node ids by inverting geomRev.
        if e["geomRev"][i_repr]:
            n_geom_start = e["to"][i_repr]
            n_geom_end   = e["from"][i_repr]
        else:
            n_geom_start = e["from"][i_repr]
            n_geom_end   = e["to"][i_repr]
        e_start = nodes_elev[n_geom_start]
        e_end   = nodes_elev[n_geom_end]
        cum = [0.0]
        for j in range(1, n_vtx):
            cum.append(cum[-1] + haversine_ft(coords[j-1], coords[j]))
        L = cum[-1] if cum[-1] > 0 else 1.0
        new_profile = [e_start + (e_end - e_start) * (s / L) for s in cum]
        # Round to 1 decimal foot to keep JSON size reasonable.
        geom_elevs[gi] = [round(v, 1) for v in new_profile]
        geom_updated.add(gi)

    # Now update per-directed-edge metrics for every directed edge whose
    # geom got rewritten (both fwd and rev).
    for i in range(n_edges):
        gi = e["geom"][i]
        if gi not in geom_updated:
            continue
        L = e["lengthFt"][i]
        if L <= 0:
            new_uphill[i] = 0.0
            new_maxpct[i] = 0.0
            new_steepft2[i] = 0.0
            continue
        delta = nodes_elev[e["to"][i]] - nodes_elev[e["from"][i]]
        if delta > 0:
            slope = delta / L
            new_uphill[i]   = round(delta, 2)
            new_maxpct[i]   = round(slope, 4)
            over            = max(0.0, slope - STEEP_THR)
            new_steepft2[i] = round(L * over * over, 2)
        else:
            new_uphill[i]   = 0.0
            new_maxpct[i]   = 0.0
            new_steepft2[i] = 0.0

    print(f"  geoms rewritten: {len(geom_updated):,}  "
          f"(from {len(resolved_segs):,} resolved way-segments)")

    # --- Write back ---
    g["edges"]["uphillFt"]     = new_uphill
    g["edges"]["maxUphillPct"] = new_maxpct
    g["edges"]["steepFt2"]     = new_steepft2
    g["nodes"]["elev"]         = [round(v, 1) for v in nodes_elev]
    g["geomElevs"]             = geom_elevs

    print("writing graph...")
    with open(GRAPH_PATH, "w") as f:
        json.dump(g, f, separators=(",", ":"))
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    sys.exit(main() or 0)
