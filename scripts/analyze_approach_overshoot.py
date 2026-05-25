"""How much approach 'overshoot' exists today?

For every directed edge currently flagged as approach, look at the
graph-walk distance from the nearest tagged source to BOTH of its
endpoints. The edge is currently flagged iff min(dA, dB) <= 200 ft.

Define overshoot = max(dA, dB) - 200 ft, clipped at 0 (length of the
edge that arc-length-truly extends past the 200 ft cutoff). Sum that
across all flagged edges to estimate how much length the approach
layer currently covers BEYOND the literal 200 ft polyline radius.

Also count how many edges are 'partial' — would become a split-segment
under the proposed cutoff (one endpoint <=200, other >200).
"""
import heapq
import json
from collections import Counter, defaultdict

GRAPH = "public/data/routing_graph.json"
MAX_FT = 200.0

g = json.load(open(GRAPH))
e = g["edges"]
nodes = g["nodes"]
n_edges = len(e["from"])

BIT_BRIDGE=4; BIT_TUNNEL=8; BIT_COVERED=16; BIT_INDOOR=32
BIT_UC=64; BIT_APPROACH=128; BIT_EMB=256; BIT_CUT=512

# Tagged = bridge / tunnel / covered / indoor / non-zero-layer / embankment / cutting
# (matches build_graph.py's _source_category)
def src_cat(i):
    f = e["flags"][i]; lyr = e["layer"][i]
    if f & BIT_BRIDGE: return "bridge"
    if f & BIT_TUNNEL: return "tunnel"
    if lyr is not None and lyr != 0: return "layered"
    if f & BIT_EMB: return "embankment"
    if f & BIT_CUT: return "cutting"
    if f & BIT_COVERED: return "covered"
    if f & BIT_INDOOR: return "indoor"
    return None

# Replicate multi-source Dijkstra at node granularity.
adj = defaultdict(list)
for i in range(n_edges):
    L = e["lengthFt"][i]
    adj[e["from"][i]].append((e["to"][i], L))
    adj[e["to"][i]].append((e["from"][i], L))

heap = []
for i in range(n_edges):
    if src_cat(i) is None: continue
    for n in (e["from"][i], e["to"][i]):
        heapq.heappush(heap, (0.0, n))
node_dist = {}
while heap:
    d, n = heapq.heappop(heap)
    if d > MAX_FT: continue
    if n in node_dist and node_dist[n] <= d: continue
    node_dist[n] = d
    for nb, L in adj[n]:
        nd = d + L
        if nd <= MAX_FT and (nb not in node_dist or node_dist[nb] > nd):
            heapq.heappush(heap, (nd, nb))

# Count approach edges + their classification
n_full_in = 0       # both endpoints <= 200
n_partial = 0       # one endpoint <= 200, other > 200
total_overshoot_ft = 0.0
partial_lengths = []
edge_full_lengths = []

# Track edges with no in-range endpoint at all — shouldn't be flagged
# under either policy but let's check
n_neither = 0

# Iterate ONLY over edges currently flagged as approach.
seen_seg = set()
for i in range(n_edges):
    if not (e["flags"][i] & BIT_APPROACH): continue
    # dedupe by way-segment
    key = frozenset((e["from"][i], e["to"][i]))
    if key in seen_seg: continue
    seen_seg.add(key)

    fa, fb = e["from"][i], e["to"][i]
    da = node_dist.get(fa, float("inf"))
    db = node_dist.get(fb, float("inf"))
    L = e["lengthFt"][i]
    if da <= MAX_FT and db <= MAX_FT:
        n_full_in += 1
        edge_full_lengths.append(L)
    elif da <= MAX_FT or db <= MAX_FT:
        n_partial += 1
        partial_lengths.append(L)
        d_in = min(da, db)
        # Reachable polyline distance into this edge from the close end
        # is min(L, 200 - d_in). The "overshoot" is what we'd lose if we
        # cut at exactly 200 ft.
        reach = min(L, MAX_FT - d_in)
        total_overshoot_ft += (L - reach)
    else:
        n_neither += 1

# Edge-length distribution for the partials (these would be split).
def histogram(vals, bins):
    out = Counter()
    for v in vals:
        for hi in bins:
            if v <= hi:
                out[hi] += 1
                break
        else:
            out[f">{bins[-1]}"] += 1
    return out

print(f"Approach unique way-segments examined: "
      f"{n_full_in + n_partial + n_neither:,}")
print(f"  both endpoints within 200 ft (fully inside): {n_full_in:,}")
print(f"  one endpoint outside (would be SPLIT):       {n_partial:,}")
print(f"  both endpoints outside (shouldn't happen):   {n_neither:,}")
print()
print(f"  total polyline length we'd 'trim' under the split policy: "
      f"{total_overshoot_ft:,.0f} ft "
      f"({total_overshoot_ft/5280:.2f} mi)")
print()

bins = [25, 50, 100, 150, 200, 300, 500, 1000]
print("Length distribution of partials (the ones that would be cut):")
h = histogram(partial_lengths, bins)
for b in bins + [f">{bins[-1]}"]:
    print(f"  <= {b!s:>5} ft : {h.get(b,0):>4}")
print()

print("Length distribution of fully-inside approach segments (no cut):")
h = histogram(edge_full_lengths, bins)
for b in bins + [f">{bins[-1]}"]:
    print(f"  <= {b!s:>5} ft : {h.get(b,0):>4}")
print()

# Also: how many of the "partial" edges are >400 ft? These are the ones
# where the current policy most overshoots (an entire long block flagged
# because of one endpoint).
big_partials = sum(1 for L in partial_lengths if L > 400)
huge_partials = sum(1 for L in partial_lengths if L > 1000)
print(f"  partial edges >400 ft:  {big_partials} "
      f"(these contribute most overshoot)")
print(f"  partial edges >1000 ft: {huge_partials} (the worst cases)")
