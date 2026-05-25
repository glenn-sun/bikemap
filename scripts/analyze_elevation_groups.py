"""Analyze the routing graph to scope v3 elevation-correction work.

Questions:
  1) How many edges are currently flagged for elevation correction?
  2) How many connected groups (shared-node connectivity) do they form?
  3) Of these groups, how many contain an INTERNAL grade-separated crossing
     (a 2D LineString crossing between two edges in the same group)?
  4) Of the groups WITHOUT internal grade-separated crossings, how many have
     a grade-separated crossing with another group? For those, can we tell
     which group is above and which is below? Any >2 layer stacks?

Edge flags (per CLAUDE.md):
  4   = isBridge
  8   = isTunnel
  16  = isCovered
  32  = isIndoor
  64  = isUntaggedCrossing
  128 = isApproach
  256 = isEmbankment
  512 = isCutting

"Flagged for elevation correction" = edges where raw DTM is structurally
wrong or ambiguous, i.e. needs v3 work:
  - isBridge
  - isTunnel
  - layered (non-zero `layer` and not bridge/tunnel/embankment/cutting)
  - isUntaggedCrossing
  - isApproach (any source category; v3 will interpolate)

Embankment / cutting / covered / indoor by themselves are NOT in scope
(DTM is correct or irrelevant); but their approaches are. We also report
them separately so the user can re-scope if desired.
"""
import json
import sys
from collections import defaultdict, Counter

from shapely.geometry import LineString
from shapely.strtree import STRtree


GRAPH_PATH = "public/data/routing_graph.json"

BIT_BRIDGE = 4
BIT_TUNNEL = 8
BIT_COVERED = 16
BIT_INDOOR = 32
BIT_UNTAGGED_CROSSING = 64
BIT_APPROACH = 128
BIT_EMBANKMENT = 256
BIT_CUTTING = 512


def is_correction_target(flags, layer):
    """v3 correction targets: bridge/tunnel/layered/untagged-crossing/approach."""
    if flags & (BIT_BRIDGE | BIT_TUNNEL | BIT_UNTAGGED_CROSSING | BIT_APPROACH):
        return True
    # Layered without bridge/tunnel/embankment/cutting — `layer=*` alone
    # is enough to know DTM is wrong (positive layer = elevated, negative
    # = below grade) and there's no terrain reason for the offset.
    if layer is not None and layer != 0:
        if not (flags & (BIT_BRIDGE | BIT_TUNNEL | BIT_EMBANKMENT | BIT_CUTTING)):
            return True
    return False


def edge_category(flags, layer):
    """Coarse category string for reporting / layer ordering."""
    if flags & BIT_BRIDGE:
        return "bridge"
    if flags & BIT_TUNNEL:
        return "tunnel"
    if layer is not None and layer != 0:
        return f"layered({layer:+d})"
    if flags & BIT_UNTAGGED_CROSSING:
        return "untagged-crossing"
    if flags & BIT_APPROACH:
        return "approach"
    return "other"


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
    g = json.load(open(GRAPH_PATH))
    e = g["edges"]
    geoms = g["geoms"]
    n_edges = len(e["from"])
    print(f"Loaded graph: {n_edges:,} directed edges, "
          f"{len(g['nodes']['lon']):,} nodes, {len(geoms):,} geoms")
    print()

    # -----  Q1: count flagged edges  -----
    # Track at directed-edge level AND deduped way-segment level (frozenset of endpoints).
    flagged_directed = []
    flagged_seg_keys = set()
    seg_repr = {}  # key -> first directed-edge index for that segment

    by_cat = Counter()

    for i in range(n_edges):
        f = e["flags"][i]
        lyr = e["layer"][i]
        a, b = e["from"][i], e["to"][i]
        key = frozenset((a, b))
        if is_correction_target(f, lyr):
            flagged_directed.append(i)
            flagged_seg_keys.add(key)
            by_cat[edge_category(f, lyr)] += 1
        if key not in seg_repr:
            seg_repr[key] = i

    # Per-category at way-segment level (dedup fwd/rev).
    seen_seg = set()
    by_cat_seg = Counter()
    for i in flagged_directed:
        key = frozenset((e["from"][i], e["to"][i]))
        if key in seen_seg:
            continue
        seen_seg.add(key)
        by_cat_seg[edge_category(e["flags"][i], e["layer"][i])] += 1

    print("=" * 60)
    print("Q1: edges flagged for elevation correction")
    print("=" * 60)
    print(f"  directed edges:        {len(flagged_directed):,}")
    print(f"  unique way-segments:   {len(flagged_seg_keys):,}")
    print(f"  (total directed:       {n_edges:,})")
    print()
    print("  by category (directed edges, first-match priority):")
    for cat, n in by_cat.most_common():
        print(f"    {cat:20s} {n:>5,}")
    print()
    print("  by category (unique way-segments):")
    for cat, n in by_cat_seg.most_common():
        print(f"    {cat:20s} {n:>5,}")
    print()

    # Also report the related-but-out-of-scope categories for context.
    n_emb = sum(1 for i in range(n_edges) if e["flags"][i] & BIT_EMBANKMENT)
    n_cut = sum(1 for i in range(n_edges) if e["flags"][i] & BIT_CUTTING)
    n_cov = sum(1 for i in range(n_edges) if e["flags"][i] & BIT_COVERED)
    print(f"  (excluded: embankment={n_emb}, cutting={n_cut}, covered={n_cov})")
    print()

    # -----  Q2: connected components by shared-node connectivity  -----
    # Build union-find over the flagged way-segments. Two segments are in
    # the same component if they share a node (endpoint).

    # Map node -> list of segment keys touching it
    node_to_segs = defaultdict(list)
    for key in flagged_seg_keys:
        for nid in key:
            node_to_segs[nid].append(key)

    uf = UF()
    for key in flagged_seg_keys:
        uf.add(key)
    # Union segments that share any node.
    for nid, segs in node_to_segs.items():
        if len(segs) < 2:
            continue
        first = segs[0]
        for s in segs[1:]:
            uf.union(first, s)

    comp_segs = defaultdict(list)
    for key in flagged_seg_keys:
        comp_segs[uf.find(key)].append(key)

    n_comps = len(comp_segs)
    sizes = Counter(len(v) for v in comp_segs.values())
    print("=" * 60)
    print("Q2: connected groups (shared-node connectivity)")
    print("=" * 60)
    print(f"  number of groups:      {n_comps:,}")
    print(f"  size distribution (segments per group):")
    for sz, n in sorted(sizes.items()):
        print(f"    {sz:>5} segs: {n:>5,} group(s)")
    largest = max(len(v) for v in comp_segs.values())
    print(f"  largest group:         {largest} segments")
    print()

    # -----  Q3: internal grade-separated crossings within each group  -----
    # For each flagged segment, prepare a LineString. Build STRtree once,
    # then for each pair of bbox-intersecting segments, check 2D crosses
    # without a shared node, and check if both are in the same group.

    # Build per-segment LineString (use representative directed edge to fetch geom).
    seg_geom = {}
    seg_repr_idx = {}
    for key in flagged_seg_keys:
        idx = seg_repr[key]
        gi = e["geom"][idx]
        coords = geoms[gi]
        seg_geom[key] = LineString(coords)
        seg_repr_idx[key] = idx

    seg_list = list(flagged_seg_keys)
    seg_index = {k: i for i, k in enumerate(seg_list)}
    lines = [seg_geom[k] for k in seg_list]
    tree = STRtree(lines)

    # Crossings: pairs of segs that intersect in 2D, do NOT share an OSM node,
    # and the touch is not an endpoint coincidence.
    crossings = []   # list of (seg_a_key, seg_b_key)
    for i in range(len(lines)):
        for cand in tree.query(lines[i]):
            cand = int(cand)
            if cand <= i:
                continue
            ka = seg_list[i]
            kb = seg_list[cand]
            if ka & kb:  # share a node — normal junction
                continue
            if not lines[i].intersects(lines[cand]):
                continue
            # Reject coincident endpoints (graph nodes may differ but same xy).
            # Use intersects + not touches at endpoint? In our graph distinct
            # nodes ≠ same xy, so this should be safe — but log.
            inter = lines[i].intersection(lines[cand])
            if inter.is_empty:
                continue
            crossings.append((ka, kb))

    print("=" * 60)
    print("Q3: internal grade-separated crossings within a group")
    print("=" * 60)
    print(f"  total flagged-vs-flagged crossings: {len(crossings):,}")

    internal_groups = set()
    external_crossings = []  # crossings BETWEEN different groups
    for (ka, kb) in crossings:
        ra, rb = uf.find(ka), uf.find(kb)
        if ra == rb:
            internal_groups.add(ra)
        else:
            external_crossings.append((ka, kb, ra, rb))
    print(f"  groups with ≥1 internal grade-sep crossing: {len(internal_groups):,}")
    print(f"  internal crossings count: "
          f"{sum(1 for (ka,kb) in crossings if uf.find(ka)==uf.find(kb)):,}")
    print()

    # Show a few examples of internal-crossing groups (sizes, category mix)
    print("  example internal-crossing groups (up to 10):")
    for ri, root in enumerate(list(internal_groups)[:10]):
        segs = comp_segs[root]
        cats = Counter()
        for k in segs:
            idx = seg_repr_idx[k]
            cats[edge_category(e["flags"][idx], e["layer"][idx])] += 1
        print(f"    group root={root}, segs={len(segs)}, cats={dict(cats)}")
    print()

    # -----  Q4: cross-group grade-separated crossings  -----
    # Restrict to crossings where neither participant is in a group already
    # flagged as having INTERNAL crossings (per the question phrasing).

    clean_groups = set(comp_segs.keys()) - internal_groups
    cross_group_pairs = []  # (ka, kb, ra, rb)
    for (ka, kb, ra, rb) in external_crossings:
        if ra in clean_groups and rb in clean_groups:
            cross_group_pairs.append((ka, kb, ra, rb))

    print("=" * 60)
    print("Q4: cross-group grade-separated crossings (clean groups only)")
    print("=" * 60)
    print(f"  cross-group crossings (any participants): "
          f"{len(external_crossings):,}")
    print(f"  cross-group crossings (both groups clean): "
          f"{len(cross_group_pairs):,}")

    # Set of clean groups participating in at least one cross-group crossing
    clean_groups_involved = set()
    for (_, _, ra, rb) in cross_group_pairs:
        clean_groups_involved.add(ra)
        clean_groups_involved.add(rb)
    print(f"  clean groups participating in ≥1 cross-group crossing: "
          f"{len(clean_groups_involved):,}")
    print(f"  clean groups with NO crossing at all: "
          f"{len(clean_groups) - len(clean_groups_involved):,}")
    print()

    # For each crossing pair, can we tell which is above and which below?
    # Decision is per-group (since one group could intersect many others).
    # Strategy: for a group, gather all OSM signals across its segments:
    #   - has any bridge?        → group is "elevated"
    #   - has any tunnel?        → group is "below"
    #   - layered: net `layer` sign across the group (most common nonzero)
    # If two groups disagree (one bridge, one tunnel/at-grade) → ordered.
    # If only untagged-crossings/approaches → cannot infer.

    def group_signal(root):
        """Return a dict summarizing the group's elevation tagging."""
        segs = comp_segs[root]
        bridge = tunnel = untagged_cross = approach_only = 0
        layers = []
        for k in segs:
            idx = seg_repr_idx[k]
            f = e["flags"][idx]; lyr = e["layer"][idx]
            if f & BIT_BRIDGE:
                bridge += 1
            elif f & BIT_TUNNEL:
                tunnel += 1
            elif lyr is not None and lyr != 0:
                layers.append(lyr)
            elif f & BIT_UNTAGGED_CROSSING:
                untagged_cross += 1
            elif f & BIT_APPROACH:
                approach_only += 1
        if layers:
            # most common layer value
            most = Counter(layers).most_common(1)[0][0]
        else:
            most = None
        return {
            "n": len(segs), "bridge": bridge, "tunnel": tunnel,
            "layer_mode": most, "untagged_cross": untagged_cross,
            "approach": approach_only,
        }

    def group_rank(sig):
        """Return an integer 'height rank' for the group, or None if unknown.
        Higher rank = physically higher.
            bridge or layer>0 → +1+layer
            tunnel or layer<0 → -1+layer
            else (untagged/approach) → None"""
        if sig["bridge"] and not sig["tunnel"]:
            base = 1
            if sig["layer_mode"] is not None and sig["layer_mode"] > 0:
                base = max(base, sig["layer_mode"])
            return base
        if sig["tunnel"] and not sig["bridge"]:
            base = -1
            if sig["layer_mode"] is not None and sig["layer_mode"] < 0:
                base = min(base, sig["layer_mode"])
            return base
        if sig["layer_mode"] is not None and sig["layer_mode"] != 0:
            return sig["layer_mode"]
        if sig["bridge"] and sig["tunnel"]:
            return None  # mixed — shouldn't really happen at group level
        return None  # only untagged-crossing / approach

    # Build per-group signal/rank for all groups participating in any
    # clean-vs-clean crossing.
    group_info = {}
    for root in clean_groups_involved:
        sig = group_signal(root)
        group_info[root] = (sig, group_rank(sig))

    # For each crossing, can we order it?
    n_orderable = 0
    n_unknown = 0
    n_at_grade_pair = 0  # both ranks resolve to None
    for (_, _, ra, rb) in cross_group_pairs:
        rk_a = group_info[ra][1]
        rk_b = group_info[rb][1]
        if rk_a is not None and rk_b is not None and rk_a != rk_b:
            n_orderable += 1
        elif rk_a is None and rk_b is None:
            n_at_grade_pair += 1
        else:
            # one is known, the other is None
            n_orderable += 1  # we know the known side is above/below the other
    print(f"  cross-group crossings where layer order is determinable: "
          f"{n_orderable:,}")
    print(f"  cross-group crossings where neither side is tagged "
          f"(both untagged/approach-only): {n_at_grade_pair:,}")
    print()

    # -----  More than 2 layers?  -----
    # A "stack" of 3+ layers at one location: build a graph where nodes
    # are groups and edges are crossings, then look for cliques / chains
    # of 3+ groups that pairwise cross at (approximately) the same spot.
    #
    # Simpler check: any flagged-vs-flagged crossing POINT (xy) where 3+
    # distinct groups meet? Cluster crossing midpoints by ~10 ft.
    #
    # For each crossing pair we record the intersection point.
    pt_to_groups = defaultdict(set)
    # Use a coarse rounding to merge near-coincident crossings.
    for (ka, kb) in crossings:
        ra, rb = uf.find(ka), uf.find(kb)
        line_a = seg_geom[ka]
        line_b = seg_geom[kb]
        inter = line_a.intersection(line_b)
        # Extract a single representative point.
        try:
            xy = inter.coords[0]
        except (NotImplementedError, IndexError):
            xy = (inter.centroid.x, inter.centroid.y)
        # ~10 ft tolerance at Seattle ≈ 3e-5 degrees
        key = (round(xy[0], 4), round(xy[1], 4))
        pt_to_groups[key].add(ra)
        pt_to_groups[key].add(rb)

    multi_stacks = [(pt, gs) for pt, gs in pt_to_groups.items() if len(gs) >= 3]
    print(f"  crossing points with ≥3 distinct flagged groups present: "
          f"{len(multi_stacks):,}")
    if multi_stacks:
        # Report how many of these "stacks" have rank info for all parties
        for pt, gs in multi_stacks[:10]:
            ranks = []
            for r in gs:
                sig = group_signal(r)
                ranks.append((r, group_rank(sig), sig))
            print(f"    point {pt}: {len(gs)} groups")
            for (r, rk, sig) in ranks:
                print(f"      group {r}: rank={rk}, signal={sig}")
    print()

    # Sanity counters
    print("=" * 60)
    print("Sanity")
    print("=" * 60)
    print(f"  flagged segments accounted for in some group: "
          f"{sum(len(v) for v in comp_segs.values()):,} "
          f"(should equal {len(flagged_seg_keys):,})")
    print(f"  total groups checked: {n_comps:,}")
    print(f"    with internal crossings: {len(internal_groups):,}")
    print(f"    clean (no internal crossing): {n_comps - len(internal_groups):,}")
    print(f"      of which participate in cross-group crossings: "
          f"{len(clean_groups_involved):,}")


if __name__ == "__main__":
    main()
