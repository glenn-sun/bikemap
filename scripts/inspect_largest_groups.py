"""Show what the largest flagged-elevation groups actually are.

For each of the top N groups: size, street-name distribution, bbox/centroid,
facility-class mix, and a few sample edges.
"""
import json
from collections import defaultdict, Counter

g = json.load(open("public/data/routing_graph.json"))
e = g["edges"]
nodes = g["nodes"]
geoms = g["geoms"]
names = g["names"]
facilities = g["facilities"]

BIT_BRIDGE=4; BIT_TUNNEL=8; BIT_UC=64; BIT_APPROACH=128
BIT_EMB=256; BIT_CUT=512

def is_corr(f, lyr):
    if f & (BIT_BRIDGE|BIT_TUNNEL|BIT_UC|BIT_APPROACH): return True
    if lyr is not None and lyr != 0 and not (f & (BIT_BRIDGE|BIT_TUNNEL|BIT_EMB|BIT_CUT)):
        return True
    return False

def cat(f, lyr):
    if f & BIT_BRIDGE: return "bridge"
    if f & BIT_TUNNEL: return "tunnel"
    if lyr is not None and lyr != 0: return f"layered({lyr:+d})"
    if f & BIT_UC: return "untagged-crossing"
    if f & BIT_APPROACH: return "approach"
    return "?"

n = len(e["from"])

# Build flagged segments (one record per unique way-segment, keep first directed idx)
seg_repr = {}
for i in range(n):
    f, lyr = e["flags"][i], e["layer"][i]
    if not is_corr(f, lyr): continue
    key = frozenset((e["from"][i], e["to"][i]))
    if key not in seg_repr:
        seg_repr[key] = i

# Connected components (shared-node)
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

uf = UF()
for k in seg_repr: uf.add(k)
node_to = defaultdict(list)
for k in seg_repr:
    for nid in k: node_to[nid].append(k)
for nid, ss in node_to.items():
    if len(ss) < 2: continue
    first = ss[0]
    for s in ss[1:]: uf.union(first, s)
groups = defaultdict(list)
for k in seg_repr:
    groups[uf.find(k)].append(k)

ranked = sorted(groups.items(), key=lambda kv: -len(kv[1]))

print(f"Total flagged groups: {len(groups)}\n")
print(f"Top 15 by size:\n")

for root, segs in ranked[:15]:
    # Gather names, facilities, categories
    name_counts = Counter()
    fac_counts = Counter()
    cat_counts = Counter()
    layers_seen = Counter()
    xs, ys = [], []
    for k in segs:
        i = seg_repr[k]
        nm_idx = e["name"][i]
        if nm_idx is not None and 0 <= nm_idx < len(names):
            name_counts[names[nm_idx]] += 1
        else:
            name_counts["<unnamed>"] += 1
        fac_idx = e["facility"][i]
        if fac_idx is not None and 0 <= fac_idx < len(facilities):
            fac_counts[facilities[fac_idx]] += 1
        else:
            fac_counts["<none>"] += 1
        cat_counts[cat(e["flags"][i], e["layer"][i])] += 1
        if e["layer"][i] is not None: layers_seen[e["layer"][i]] += 1
        # endpoints
        for nid in k:
            xs.append(nodes["lon"][nid])
            ys.append(nodes["lat"][nid])
    cx = sum(xs)/len(xs); cy = sum(ys)/len(ys)
    bbox = (min(xs), min(ys), max(xs), max(ys))
    print(f"--- group size={len(segs)} root={root} ---")
    print(f"  centroid: {cy:.5f}, {cx:.5f}   bbox dy={bbox[3]-bbox[1]:.4f}° dx={bbox[2]-bbox[0]:.4f}°")
    print(f"  categories: {dict(cat_counts)}")
    print(f"  layer values: {dict(layers_seen) if layers_seen else 'none'}")
    print(f"  facilities: {dict(fac_counts)}")
    print(f"  top street names:")
    for nm, c in name_counts.most_common(8):
        print(f"      {c:>3}  {nm}")
    print()
