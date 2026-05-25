"""Supplementary: look for real 3+ level vertical stacks.

A "stack" at a location is multiple groups with DISTINCT ranks meeting
there. Two ground-level streets crossing under a bridge are 2 ranks, not 3.
"""
import json
from collections import defaultdict, Counter
from shapely.geometry import LineString
from shapely.strtree import STRtree

g = json.load(open("public/data/routing_graph.json"))
e = g["edges"]
geoms = g["geoms"]

BIT_BRIDGE=4; BIT_TUNNEL=8; BIT_UC=64; BIT_APPROACH=128
BIT_EMB=256; BIT_CUT=512

def is_corr(f, lyr):
    if f & (BIT_BRIDGE|BIT_TUNNEL|BIT_UC|BIT_APPROACH):
        return True
    if lyr is not None and lyr != 0 and not (f & (BIT_BRIDGE|BIT_TUNNEL|BIT_EMB|BIT_CUT)):
        return True
    return False

n = len(e["from"])

# Layer-value distribution among all flagged edges (deduped by seg)
seen = set()
layer_dist = Counter()
for i in range(n):
    f, lyr = e["flags"][i], e["layer"][i]
    if not is_corr(f, lyr):
        continue
    key = frozenset((e["from"][i], e["to"][i]))
    if key in seen: continue
    seen.add(key)
    if lyr is None or lyr == 0:
        if f & BIT_BRIDGE: layer_dist["bridge-no-layer"] += 1
        elif f & BIT_TUNNEL: layer_dist["tunnel-no-layer"] += 1
        elif f & BIT_UC: layer_dist["untagged-crossing"] += 1
        elif f & BIT_APPROACH: layer_dist["approach"] += 1
    else:
        kind = "bridge" if f & BIT_BRIDGE else ("tunnel" if f & BIT_TUNNEL else "plain-layered")
        layer_dist[f"{kind} L={lyr:+d}"] += 1

print("Layer-value distribution among unique flagged segments:")
for k, v in sorted(layer_dist.items()):
    print(f"  {k:30s} {v:>5}")
print()

# Per-segment rank: bridge → layer if available else +1; tunnel → layer or -1;
# layered → layer; untagged-crossing/approach → None.
def seg_rank(f, lyr):
    if f & BIT_BRIDGE:
        return lyr if (lyr is not None and lyr > 0) else 1
    if f & BIT_TUNNEL:
        return lyr if (lyr is not None and lyr < 0) else -1
    if lyr is not None and lyr != 0:
        return lyr
    return None

# Build groups (shared-node union-find)
class UF:
    def __init__(self): self.p={}
    def add(self,x):
        if x not in self.p: self.p[x]=x
    def find(self,x):
        while self.p[x]!=x: self.p[x]=self.p[self.p[x]]; x=self.p[x]
        return x
    def union(self,a,b):
        ra,rb=self.find(a),self.find(b)
        if ra!=rb: self.p[ra]=rb

seg_keys = set()
seg_repr = {}
seg_rank_map = {}
seg_rank_count = defaultdict(Counter)  # per-seg rank only; group rank set below
for i in range(n):
    f, lyr = e["flags"][i], e["layer"][i]
    if not is_corr(f, lyr): continue
    key = frozenset((e["from"][i], e["to"][i]))
    seg_keys.add(key)
    if key not in seg_repr:
        seg_repr[key] = i

uf = UF()
for k in seg_keys: uf.add(k)
node_to = defaultdict(list)
for k in seg_keys:
    for nid in k: node_to[nid].append(k)
for nid, ss in node_to.items():
    if len(ss) < 2: continue
    first = ss[0]
    for s in ss[1:]: uf.union(first, s)

groups = defaultdict(list)
for k in seg_keys:
    groups[uf.find(k)].append(k)

# Group rank: most common segment rank within the group (ignoring None).
group_rank = {}
group_ranks_set = {}
for root, segs in groups.items():
    ranks = []
    for k in segs:
        i = seg_repr[k]
        r = seg_rank(e["flags"][i], e["layer"][i])
        if r is not None:
            ranks.append(r)
    if ranks:
        group_rank[root] = Counter(ranks).most_common(1)[0][0]
        group_ranks_set[root] = set(ranks)
    else:
        group_rank[root] = None
        group_ranks_set[root] = set()

# Distribution
print("Per-group dominant rank:")
dist = Counter(group_rank.values())
for k, v in sorted(dist.items(), key=lambda x: (x[0] is None, x[0])):
    print(f"  rank={k!s:>6}: {v:>4} groups")
print()

# Groups whose own segments span MULTIPLE distinct ranks (internal stacking)
multi_rank_groups = [(r, sorted(s)) for r, s in group_ranks_set.items() if len(s) >= 2]
print(f"Groups with ≥2 distinct internal ranks: {len(multi_rank_groups)}")
print(f"Groups with ≥3 distinct internal ranks: {sum(1 for (_,s) in multi_rank_groups if len(s)>=3)}")
print()
for r, ranks in multi_rank_groups[:10]:
    print(f"  group root={r} size={len(groups[r])} ranks={ranks}")
print()

# Crossings analysis
seg_geom = {k: LineString(geoms[e["geom"][seg_repr[k]]]) for k in seg_keys}
seg_list = list(seg_keys)
lines = [seg_geom[k] for k in seg_list]
tree = STRtree(lines)

# Collect ALL crossing points (incl. internal-to-group) tied to (group, rank).
pt_to_ranks = defaultdict(set)
pt_to_groups = defaultdict(set)
n_x = 0
for i in range(len(lines)):
    for cand in tree.query(lines[i]):
        cand = int(cand)
        if cand <= i: continue
        ka, kb = seg_list[i], seg_list[cand]
        if ka & kb: continue
        if not lines[i].intersects(lines[cand]): continue
        n_x += 1
        ra, rb = uf.find(ka), uf.find(kb)
        # Per-SEGMENT ranks (segments themselves carry the most precise info)
        ia, ib = seg_repr[ka], seg_repr[kb]
        sra = seg_rank(e["flags"][ia], e["layer"][ia])
        srb = seg_rank(e["flags"][ib], e["layer"][ib])
        # Fall back to group rank if segment rank is None (so approach edges
        # inherit their bridge's rank for stack detection).
        if sra is None: sra = group_rank[ra]
        if srb is None: srb = group_rank[rb]
        inter = lines[i].intersection(lines[cand])
        try: xy = inter.coords[0]
        except Exception: xy = (inter.centroid.x, inter.centroid.y)
        key = (round(xy[0], 4), round(xy[1], 4))
        if sra is not None: pt_to_ranks[key].add(sra)
        if srb is not None: pt_to_ranks[key].add(srb)
        pt_to_groups[key].add(ra)
        pt_to_groups[key].add(rb)

print(f"Total flagged-vs-flagged crossings: {n_x}")
print(f"Distinct crossing locations: {len(pt_to_groups)}")
print()

# Stacks of >2 elevation levels at one point
big_stacks = sorted(((pt, rs) for pt, rs in pt_to_ranks.items() if len(rs) >= 3),
                    key=lambda x: -len(x[1]))
print(f"Locations with ≥3 distinct elevation levels: {len(big_stacks)}")
for pt, rs in big_stacks[:20]:
    gs = pt_to_groups[pt]
    print(f"  {pt} ranks={sorted(rs)} groups={len(gs)}")
print()

# Also: locations where group-level distinct count ≥3 (any 3 groups meeting)
big_group_clusters = sorted(((pt, gs) for pt, gs in pt_to_groups.items() if len(gs) >= 3),
                            key=lambda x: -len(x[1]))
print(f"Locations with ≥3 distinct GROUPS meeting (regardless of rank): {len(big_group_clusters)}")
for pt, gs in big_group_clusters[:10]:
    print(f"  {pt} groups={len(gs)}")
