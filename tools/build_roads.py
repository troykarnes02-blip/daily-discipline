#!/usr/bin/env python3
"""Build roads-data.js for the Roads tab from OpenStreetMap exports.

Usage: python3 tools/build_roads.py EXPORT_DIR_OR_LIST OUT.js
Inputs (see tools/README.md): road exports (out geom), places+exits export, county boundary export.
"""
import sys, json, math, collections, heapq, random, os, re, time, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *

RANK = {'motorway': 0, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4, 'unclassified': 5, 'residential': 6}
SPD = {'motorway': 65, 'motorway_link': 40, 'trunk': 55, 'trunk_link': 35, 'primary': 45, 'primary_link': 30, 'secondary': 40,
       'secondary_link': 30, 'tertiary': 35, 'tertiary_link': 25, 'unclassified': 30, 'residential': 25}
HOME = (34.7842005, -82.1087456)   # Hart Townes Way, Woodruff (listing coordinates; street is not in OSM yet)
WORK_NODE_ROADS = ('Antioch Church Road', 'Augusta Arbor Way')

def fmt_ref(r):
    r = r.strip()
    m = re.match(r'^(I|US|SC)\s+(\d+[A-Z]?)(.*)$', r)
    if not m: return r
    pre, num, rest = m.groups()
    base = ('I-' if pre == 'I' else pre + ' ') + num
    rest = rest.strip()
    return base + (' ' + rest.upper() if rest else '')

def way_refs(w):
    return [fmt_ref(r) for r in (w['ref'] or '').split(';') if r.strip()]

def way_label(w):
    rs = way_refs(w)
    n = w['name']
    if n and rs: return n + ' (' + rs[0] + ')'
    return n or (rs[0] if rs else 'unnamed')

def main(files, places_file, county_file, out):
    t0 = time.time()
    ways = load_ways(files)
    print('ways', len(ways))
    counties = Counties(json.load(open(county_file))['elements'])
    cnames = ['Greenville', 'Spartanburg', 'Laurens', 'Anderson']
    def cidx(lat, lon):
        c = counties.of(lat, lon)
        return cnames.index(c) if c in cnames else 4

    # ---------- places ----------
    pl = json.load(open(places_file))['elements']
    placenodes = [e for e in pl if e['type'] == 'node' and 'place' in e['tags'] and e['tags'].get('name')]
    tmap = {'city': 'c', 'town': 't', 'village': 'v', 'hamlet': 'h', 'suburb': 's'}
    places = []
    for e in placenodes:
        places.append({'n': e['tags']['name'], 'lat': e['lat'], 'lon': e['lon'], 'ty': tmap[e['tags']['place']],
                       'co': cidx(e['lat'], e['lon']), 'pop': int(e['tags'].get('population', '0') or 0)})
    places.sort(key=lambda p: (-p['pop'], p['n']))
    print('places', len(places))
    big_places = [p for p in places if p['ty'] in 'ctvs']
    def near_place(lat, lon, pool=None, maxmi=8):
        best, bd = None, 1e18
        for i, p in enumerate(pool or places):
            d = hav((lat, lon), (p['lat'], p['lon']))
            if d < bd: best, bd = i, d
        return best if bd / 1609.34 <= maxmi else None
    pidx = {id(p): i for i, p in enumerate(places)}
    def near_idx(lat, lon, big=False):
        """Nearest real place (city/town/village/suburb) within 12 mi; else a hamlet within 2 mi."""
        best, bd, hb, hd = None, 1e18, None, 1e18
        for i, p in enumerate(places):
            d = hav((lat, lon), (p['lat'], p['lon']))
            if p['ty'] == 'h':
                if d < hd: hb, hd = i, d
            elif d < bd: best, bd = i, d
        if best is not None and bd / 1609.34 <= 12: return best
        if hb is not None and hd / 1609.34 <= 2: return hb
        return None

    # ---------- node index ----------
    coord, node_ways = {}, collections.defaultdict(list)
    for w in ways.values():
        for n, g in zip(w['nodes'], w['geom']):
            coord[n] = g
            node_ways[n].append(w)

    # ---------- entities ----------
    def entity(ws, key_label, kind):
        pts, wts = [], []
        for w in ws:
            for i in range(len(w['geom']) - 1):
                a, b = w['geom'][i], w['geom'][i+1]
                pts.append(((a[0]+b[0])/2, (a[1]+b[1])/2)); wts.append(hav(a, b))
        P = np.array(pts); Wt = np.array(wts)
        if Wt.sum() == 0: return None
        lat0 = P[:, 0].mean(); kx = math.cos(math.radians(lat0))
        X = np.column_stack(((P[:, 1]) * kx, P[:, 0]))
        mu = (X * Wt[:, None]).sum(0) / Wt.sum()
        C = np.cov((X - mu).T, aweights=Wt)
        vals, vecs = np.linalg.eigh(C)
        v = vecs[:, 1]                      # major axis (x=east, y=north)
        if v[0] < 0 or (abs(v[0]) < 1e-9 and v[1] < 0): v = -v   # point eastward (or northward)
        if abs(v[0]) < 0.38 and v[1] < 0: v = -v                  # near N-S: point north
        proj = (X - mu) @ v
        lo, hi = int(proj.argmin()), int(proj.argmax())
        A = (P[lo, 0], P[lo, 1]); B = (P[hi, 0], P[hi, 1])
        ax = (math.degrees(math.atan2(v[0], v[1])) + 360) % 180
        mid = (float(mu[1]), float(mu[0] / 1.0)) if False else (float((P[:, 0] * Wt).sum() / Wt.sum()), float((P[:, 1] * Wt).sum() / Wt.sum()))
        return {'axis': ax, 'A': A, 'B': B, 'mid': mid, 'v': v, 'mu': mu, 'kx': kx, 'len': float(Wt.sum()) / 1609.34}

    named = collections.defaultdict(list)
    refgroups = collections.defaultdict(list)
    for w in ways.values():
        if (w['hw'] or '').endswith('_link'): continue
        if w['name']: named[w['name']].append(w)
        for r in way_refs(w): refgroups[r].append(w)

    # components of same-named ways (merged when pieces end within 250 m of each other)
    comps = []
    for nm, ws in named.items():
        p = {}
        def g(x):
            while p.setdefault(x, x) != x: p[x] = p[p[x]]; x = p[x]
            return x
        for w in ws:
            for a in w['nodes'][1:]: p[g(a)] = g(w['nodes'][0])
        grp = collections.defaultdict(list)
        for w in ws: grp[g(w['nodes'][0])].append(w)
        parts = list(grp.values())
        if len(parts) > 1:
            pp = list(range(len(parts)))
            def gp(x):
                while pp[x] != x: pp[x] = pp[pp[x]]; x = pp[x]
                return x
            ends = [[g_ for w in v for g_ in (w['geom'][0], w['geom'][-1])] for v in parts]
            for i in range(len(parts)):
                for j in range(i + 1, len(parts)):
                    if gp(i) != gp(j) and any(hav(a, b) < 250 for a in ends[i] for b in ends[j]):
                        pp[gp(i)] = gp(j)
            merged = collections.defaultdict(list)
            for i, v in enumerate(parts): merged[gp(i)] += v
            parts = list(merged.values())
        for v in parts:
            L = sum(w['len'] for w in v) / (2 if all(w['oneway'] == 'yes' for w in v) else 1)
            comps.append((nm, v, L))

    def best_rank(v): return min(RANK.get(w['hw'], 7) for w in v)
    # which road keys are 'notable' crossings
    def keep_named(nm, v, L):
        r = best_rank(v)
        if r < 6: return L >= 1.0
        return L >= 1.5

    ent_named = [(nm, v, L) for nm, v, L in comps if keep_named(nm, v, L)]
    ent_refs = [(r, v, sum(w['len'] for w in v) / (2 if all(w['oneway'] == 'yes' for w in v) else 1)) for r, v in refgroups.items()]
    ent_refs = [e for e in ent_refs if e[2] >= 3 and not e[0].endswith(' ALTERNATE')]
    print('entities: named', len(ent_named), 'refs', len(ent_refs))

    # crossing index: node -> set of labels (named ways only)
    node_labels = collections.defaultdict(dict)
    for w in ways.values():
        if (w['hw'] or '').endswith('_link') or not (w['name'] or w['ref']): continue
        lab = way_label(w)
        for n in w['nodes']:
            node_labels[n][lab] = min(RANK.get(w['hw'], 7), node_labels[n].get(lab, 9))

    def orient(e, ws, own_labels):
        """Crossings along the axis from A to B, plus end towns."""
        v, mu, kx = e['v'], e['mu'], e['kx']
        found = {}
        for w in ws:
            for n, g in zip(w['nodes'], w['geom']):
                labs = node_labels.get(n)
                if not labs or len(labs) < 2: continue
                x = np.array([g[1] * kx, g[0]])
                t = float((x - mu) @ v)
                for lab, rk in labs.items():
                    if lab in own_labels: continue
                    if rk > 5: continue
                    if lab not in found or found[lab][0] > rk: found[lab] = (rk, t)
        base = {}
        for lab, (rk, t) in sorted(found.items(), key=lambda kv: (kv[1][0], kv[1][1])):
            b = re.sub(r' \(.*\)$', '', lab)
            if b not in base or ('(' in lab and '(' not in base[b][0]): base[b] = (lab, rk, t)
        cand = sorted(base.values(), key=lambda c: (c[1], c[2]))[:7]
        cand.sort(key=lambda c: c[2])
        return [c[0] for c in cand]

    def class_of(ws, refs):
        r = best_rank(ws)
        if any(x.startswith('I-') for x in refs): return 'I'
        if any(x.startswith('US ') for x in refs): return 'U'
        if any(x.startswith('SC ') for x in refs): return 'S'
        if r <= 3: return 'M'
        if r <= 5: return 'C'
        return 'L'
    TIER = {'I': 1, 'U': 1, 'S': 2, 'M': 3, 'C': 3, 'L': 4}

    roads = []
    for nm, v, L in ent_named:
        e = entity(v, nm, 'N')
        if not e: continue
        refs = sorted({r for w in v for r in way_refs(w)})
        cl = class_of(v, refs)
        tier = TIER[cl]
        if cl == 'C' and L < 2: tier = 4
        if cl == 'M' and L < 2: tier = 4
        own = {way_label(w) for w in v}
        roads.append({'n': nm, 'r': refs[:3], 'c': cl, 't': tier, 'a': int(round(e['axis'])) % 180, 'l': round(e['len'], 1),
                      'co': cidx(*e['mid']), 'nt': near_idx(*e['mid']), 'ea': near_idx(*e['A']), 'eb': near_idx(*e['B']),
                      'x': orient(e, v, own), '_mid': e['mid'], '_ws': v})
    roads.sort(key=lambda r: (r['t'], -r['l'], r['n']))
    for i, r in enumerate(roads): r['i'] = i

    routes = []
    for rf, v, L in ent_refs:
        e = entity(v, rf, 'R')
        if not e: continue
        names = collections.Counter()
        for w in v:
            if w['name']: names[w['name']] += w['len']
        own = {rf} | {way_label(w) for w in v}
        cl = 'I' if rf.startswith('I-') else 'U' if rf.startswith('US ') else 'S'
        # counties along the route
        cos = collections.Counter(cidx(*g) for w in v[::max(1, len(v)//40)] for g in w['geom'][:1])
        routes.append({'n': rf, 'c': cl, 't': 1 if cl in 'IU' else 2, 'a': int(round(e['axis'])) % 180, 'l': round(e['len']),
                       'ea': near_idx(*e['A']), 'eb': near_idx(*e['B']), 'co': [c for c, _ in cos.most_common(3)],
                       'nm': [n for n, _ in names.most_common(4)], 'x': orient(e, v, own), '_ws': v})
    routes.sort(key=lambda r: (r['t'], -r['l'], r['n']))
    print('roads', len(roads), 'tiers', collections.Counter(r['t'] for r in roads), 'route entities', len(routes))
    print('time', round(time.time() - t0))
    return dict(places_file=places_file, ways=ways, places=places, roads=roads, routes=routes, coord=coord, node_ways=node_ways, counties=counties,
                cnames=cnames, cidx=cidx, near_idx=near_idx, big_places=big_places, pl=pl)



# ====================================================================================
# Routes, exits, intersections, basemap
# ====================================================================================
def turn_code(bin_, bout):
    d = ((bout - bin_ + 540) % 360) - 180
    a = abs(d)
    if a < 25: return 'S'
    side = 'R' if d > 0 else 'L'
    if a < 65: return 'B' + side
    if a < 150: return side
    return 'U'

def build_graph(ways, coord):
    adj = collections.defaultdict(list)
    for w in ways.values():
        ow, hw = w['oneway'], w['hw']
        if ow is None and hw in ('motorway', 'motorway_link'): ow = 'yes'
        if w['junction'] == 'roundabout': ow = 'yes'
        ns = w['nodes']
        mph = SPD.get(hw, 30)
        try:
            if w['maxspeed'] and 'mph' in w['maxspeed']: mph = int(w['maxspeed'].split()[0])
        except Exception: pass
        pen = 0.3 if (hw or '').endswith('_link') else 0
        for i in range(len(ns) - 1):
            a, b = ns[i], ns[i+1]
            d = hav(coord[a], coord[b])
            cost = d / (mph * 0.447) + pen
            if ow in (None, 'no', 'yes', '1', 'true'): adj[a].append((b, cost, d, w['id'], 'm' if hw == 'motorway' else ''))
            if ow in (None, 'no', '-1'): adj[b].append((a, cost, d, w['id'], 'm' if hw == 'motorway' else ''))
    return adj

def dijkstra(adj, src, ban_motorway=False):
    dist, prev = {src: 0.0}, {}
    pq = [(0.0, src)]
    while pq:
        c, u = heapq.heappop(pq)
        if c > dist.get(u, 1e18): continue
        for v, cost, d, wid, m in adj.get(u, ()):
            nc = c + cost * (400 if (ban_motorway and m) else 1)
            if nc < dist.get(v, 1e18):
                dist[v] = nc; prev[v] = (u, wid, d); heapq.heappush(pq, (nc, v))
    return dist, prev

def path_to(prev, src, dst):
    out, u = [], dst
    while u != src:
        if u not in prev: return None
        p, wid, d = prev[u]
        out.append((p, u, wid, d)); u = p
    out.reverse()
    return out

def departs(w2, n):
    """True if traffic can leave node n along way w2."""
    ow = w2['oneway']
    if ow in ('yes', '1', 'true'): return w2['nodes'][0] == n
    if ow == '-1': return w2['nodes'][-1] == n
    return True

def ref_key(r, n):
    """Route key used to merge consecutive pieces of the same route: 'SC 146', 'US 276', 'I-385'."""
    if r: return r
    m = re.search(r'Highway (\d+)$', n or '')
    return ('#' + m.group(1)) if m else None

def steps_from_path(path, ways, coord, exitref, node_ways):
    """Group edges into driving steps with direction, miles, turn and exit number."""
    groups = []
    for (a, b, wid, d) in path:
        w = ways[wid]
        link = (w['hw'] or '').endswith('_link')
        rf = way_refs(w)
        ref = rf[0] if rf else None
        lab = 'ramp' if link else (w['name'] or '') + '|' + (ref or '')
        rb = w['junction'] == 'roundabout'
        if groups and groups[-1]['lab'] == lab and groups[-1]['rb'] == rb:
            g = groups[-1]; g['edges'].append((a, b)); g['m'] += d
        else:
            groups.append({'lab': lab, 'rb': rb, 'hw': w['hw'], 'name': w['name'], 'ref': ref, 'edges': [(a, b)], 'm': d})
    steps, pending_exit, entered_by_ramp = [], '', False
    for gi, g in enumerate(groups):
        prevg = groups[gi - 1] if gi else None
        if g['lab'] == 'ramp':
            if prevg and prevg['hw'] in ('motorway', 'trunk'):
                n = g['edges'][0][0]
                pending_exit = exitref.get(n, '') or exitref.get(prevg['edges'][-1][1], '')
            else:
                entered_by_ramp = True
            continue
        first, last = g['edges'][0], g['edges'][-1]
        t = ''
        if prevg:
            pe = prevg['edges'][-1]
            bi = bearing(coord[pe[0]], coord[pe[1]]); bo = bearing(coord[first[0]], coord[first[1]])
            t = turn_code(bi, bo)
            if prevg['hw'] in ('motorway', 'trunk') and not pending_exit:
                pending_exit = exitref.get(first[0], '')
        if g['rb']:
            nodes = [first[0]] + [e[1] for e in g['edges']]
            cnt = 0
            for n in nodes[1:]:
                if any(w2['junction'] != 'roundabout' and departs(w2, n) for w2 in node_ways[n]): cnt += 1
            steps.append({'r': 'roundabout', 'n': [], 'd': '', 'm': 0, 't': 'RB%d' % max(1, cnt), 'x': '', '_k': None})
            continue
        a0, a1 = coord[first[0]], coord[last[1]]
        disp = hav(a0, a1)
        b = bearing(coord[first[0]], coord[first[1]]) if disp < 0.4 * g['m'] else bearing(a0, a1)
        if entered_by_ramp: t = 'ON'
        steps.append({'r': g['ref'] or g['name'] or 'unnamed road', 'n': [g['name']] if (g['ref'] and g['name']) else [], 'd': card8(b),
                      'm': g['m'] / 1609.34, 't': t, 'x': pending_exit, '_k': ref_key(g['ref'], g['name']),
                      '_a0': a0, '_a1': a1, '_b': b})
        pending_exit, entered_by_ramp = '', False
    # merge consecutive pieces of the same route (name changes along one highway)
    out = []
    for st in steps:
        pv = out[-1] if out else None
        k = st.get('_k')
        same = pv and k and pv.get('_k') and (k == pv['_k'] or (k.startswith('#') and pv['_k'].endswith(k[1:])) or (pv['_k'].startswith('#') and k.endswith(pv['_k'][1:])))
        if same and st['t'] in ('S', '', 'BL', 'BR'):
            pv['m'] += st['m']
            for nm in st['n']:
                if nm not in pv['n']: pv['n'].append(nm)
            if re.match(r'^(I-|US |SC )', st['r']) and not re.match(r'^(I-|US |SC )', pv['r']):
                if pv['r'] not in pv['n']: pv['n'].insert(0, pv['r'])
                pv['r'] = st['r']
            elif st['r'] != pv['r'] and st['r'] not in pv['n'] and not re.match(r'^(I-|US |SC )', st['r']):
                pv['n'].append(st['r'])
            pv['_a1'] = st['_a1']
        else:
            out.append(st)
    res = []
    for st in out:
        if st['r'] == 'roundabout':
            res.append({'r': 'roundabout', 'n': [], 'd': '', 'm': 0, 't': st['t'], 'x': ''}); continue
        disp = hav(st['_a0'], st['_a1'])
        d = card8(bearing(st['_a0'], st['_a1'])) if disp > 0.4 * st['m'] * 1609.34 else st['d']
        res.append({'r': st['r'], 'n': st['n'][:3], 'd': d, 'm': round(st['m'], 1), 't': st['t'], 'x': st['x']})
    # drop slivers (very short connector pieces) unless they carry a turn that matters
    res = [r for i, r in enumerate(res) if not (r['r'] != 'roundabout' and r['m'] < 0.05 and r['x'] == '' and 0 < i < len(res) - 1)]
    return res

def finish(ctx, out):
    ways, places, coord, node_ways, counties = ctx['ways'], ctx['places'], ctx['coord'], ctx['node_ways'], ctx['counties']
    near_idx, cidx = ctx['near_idx'], ctx['cidx']
    t0 = time.time()
    # ---------- exits ----------
    exitref = {}
    for e in ctx['pl']:
        if e['type'] == 'node' and e['tags'].get('highway') == 'motorway_junction' and e['tags'].get('ref') and e['id'] in coord:
            exitref[e['id']] = e['tags']['ref']
    exits = {}
    for n, ref in exitref.items():
        mw = [w for w in node_ways[n] if w['hw'] in ('motorway', 'trunk')]
        isr = [r for w in mw for r in way_refs(w) if r.startswith('I-')]
        if not isr: continue
        inter = isr[0]
        cross = None
        for lw in [w for w in node_ways[n] if (w['hw'] or '').endswith('_link')]:
            for endn in (lw['nodes'][0], lw['nodes'][-1]):
                if endn == n: continue
                cands = [w for w in node_ways[endn] if w['hw'] in RANK and RANK[w['hw']] <= 5 and w['hw'] not in ('motorway',) and w['id'] != lw['id']]
                if cands:
                    cands.sort(key=lambda w: RANK[w['hw']])
                    cross = way_label(cands[0]); break
            if cross: break
        key = (inter, ref, cross)
        if key not in exits:
            lat, lon = coord[n]
            exits[key] = {'i': inter, 'e': ref, 'x': cross or '', 'nt': near_idx(lat, lon), 'p': [round(lat, 4), round(lon, 4)]}
    exits = sorted(exits.values(), key=lambda e: (e['i'], float(re.sub(r'\D', '', e['e']) or 0), e['e']))
    print('exits', len(exits))

    # ---------- anchors ----------
    cand = [n for n, wl in node_ways.items() if any(w['hw'] in RANK and 1 <= RANK[w['hw']] <= 3 for w in wl)]
    cand_ll = np.array([coord[n] for n in cand])
    def snap(lat, lon, maxm=2500):
        d = np.hypot((cand_ll[:, 0] - lat) * 111320, (cand_ll[:, 1] - lon) * 111320 * math.cos(math.radians(lat)))
        i = int(d.argmin())
        return cand[i] if d[i] <= maxm else None
    anchors = []
    for i, p in enumerate(places):
        if p['ty'] in 'ctvs' and p['co'] < 4:
            nd = snap(p['lat'], p['lon'])
            if nd: anchors.append({'name': p['n'], 'node': nd, 'pi': i, 'll': (p['lat'], p['lon'])})
    # home: nearest SC 101 node to the listing coordinates
    sc101 = [n for n, wl in node_ways.items() if any('SC 101' in way_refs(w) for w in wl)]
    home = min(sc101, key=lambda n: hav(coord[n], HOME))
    wset = [n for n, wl in node_ways.items() if {w['name'] for w in wl} >= set(WORK_NODE_ROADS)]
    work = wset[0]
    print('home node', coord[home], 'work node', coord[work])
    anchors = [{'name': 'Home', 'node': home, 'pi': None, 'll': coord[home], 'special': 'H'},
               {'name': 'Work', 'node': work, 'pi': None, 'll': coord[work], 'special': 'W'}] + anchors
    print('anchors', len(anchors))
    adj = build_graph(ways, coord)
    rnd = random.Random(7)
    # pair selection
    pairs = set()
    for ai, a in enumerate(anchors):
        dd = []
        for bi, b in enumerate(anchors):
            if bi == ai: continue
            d = hav(a['ll'], b['ll']) / 1609.34
            if 4 <= d <= 40: dd.append((d, bi))
        dd.sort()
        picks = [bi for _, bi in dd[:3]] + rnd.sample([bi for _, bi in dd[3:]], min(4, max(0, len(dd) - 3)))
        if a.get('special'): picks = [bi for _, bi in dd]
        for bi in picks: pairs.add((ai, bi))
    # always cover the big places with each other, so the main corridors are all drilled
    top = [i for i, a in enumerate(anchors) if a.get('pi') is not None and places[a['pi']]['pop'] >= 5000]
    for i in top:
        for j in top:
            if i < j and 4 <= hav(anchors[i]['ll'], anchors[j]['ll']) / 1609.34 <= 45: pairs.add((i, j))
    # both directions for Home/Work pairs only; others once (lower index drives)
    final = set()
    for ai, bi in pairs:
        if anchors[ai].get('special') or anchors[bi].get('special'): final.add((ai, bi)); final.add((bi, ai))
        else: final.add((min(ai, bi), max(ai, bi)))
    print('pairs', len(final))
    by_src = collections.defaultdict(list)
    for ai, bi in final: by_src[ai].append(bi)
    routes = []
    for ai, targets in by_src.items():
        dist, prev = dijkstra(adj, anchors[ai]['node'])
        for bi in targets:
            path = path_to(prev, anchors[ai]['node'], anchors[bi]['node'])
            if not path: continue
            routes.append(make_route(ctx, anchors, ai, bi, path, dist[anchors[bi]['node']], exitref, False))
    # no-interstate alternate for Home <-> Work
    for (ai, bi) in ((0, 1), (1, 0)):
        dist, prev = dijkstra(adj, anchors[ai]['node'], ban_motorway=True)
        path = path_to(prev, anchors[ai]['node'], anchors[bi]['node'])
        if path:
            r = make_route(ctx, anchors, ai, bi, path, dist[anchors[bi]['node']] / 1.0, exitref, True)
            routes.append(r)
    print('routes', len(routes), 'time', round(time.time() - t0))
    return exits, anchors, routes, exitref, adj

def make_route(ctx, anchors, ai, bi, path, cost, exitref, alt):
    ways, coord, node_ways = ctx['ways'], ctx['coord'], ctx['node_ways']
    steps = steps_from_path(path, ways, coord, exitref, node_ways)
    mi = sum(d for _, _, _, d in path) / 1609.34
    pts = [coord[path[0][0]]] + [coord[b] for _, b, _, _ in path]
    line = simplify(pts, 40)
    a, b = anchors[ai], anchors[bi]
    note = ''
    if a.get('special') == 'H' and steps:
        steps[0]['t'] = 'L'            # confirmed in Apple Maps: left out of Hart Townes Way onto SC 101
        steps.insert(0, {'r': 'Hart Townes Way', 'n': [], 'd': '', 'm': 0.1, 't': '', 'x': ''})
    if a.get('special') == 'W' and steps:
        steps[0]['t'] = 'L'
        steps.insert(0, {'r': 'Augusta Arbor Way', 'n': [], 'd': 'N', 'm': 0.2, 't': '', 'x': ''})
        steps.insert(0, {'r': 'Office park drive', 'n': [], 'd': '', 'm': 0.1, 't': '', 'x': ''})
    if b.get('special') == 'H':
        steps.append({'r': 'Hart Townes Way', 'n': [], 'd': '', 'm': 0.1, 't': 'R', 'x': ''})
    if b.get('special') == 'W' and steps:
        last = steps[-1]
        if last['r'] == 'Antioch Church Road' and last['d'] == 'E':
            steps.append({'r': 'Augusta Arbor Way', 'n': [], 'd': 'S', 'm': 0.2, 't': 'R', 'x': ''})
            steps.append({'r': 'Office park drive', 'n': [], 'd': '', 'm': 0.1, 't': 'L', 'x': ''})
            steps.append({'r': 'Southern MEP', 'n': [], 'd': '', 'm': 0.0, 't': 'L', 'x': 'on your right'})
        else:
            steps.append({'r': 'Augusta Arbor Way', 'n': [], 'd': '', 'm': 0.2, 't': '', 'x': ''})
    if {a.get('special'), b.get('special')} == {'H', 'W'} and not alt and a.get('special') == 'H':
        note = 'Matches Apple Maps (Nov 5, 2026)'
    return {'a': a['name'], 'b': b['name'], 'ai': a['pi'], 'bi': b['pi'], 'mi': round(mi, 1), 'min': round(cost / 60),
            's': steps, 'g': enc_line(line), 'alt': alt, 'v': note}


def build_scenes(ctx, anchors):
    """Intersections for the 'Where am I' drill."""
    ways, coord, node_ways, places = ctx['ways'], ctx['coord'], ctx['node_ways'], ctx['places']
    near_idx, cidx = ctx['near_idx'], ctx['cidx']
    notable = {(r['n']) for r in ctx['roads']} | {r['n'] for r in ctx['routes']}
    big = [(i, p) for i, p in enumerate(places) if p['ty'] in 'ctvs']
    def toward(lat, lon, b):
        best, bs = None, 9e9
        for i, p in big:
            d = hav((lat, lon), (p['lat'], p['lon'])) / 1609.34
            if d < 1.5 or d > 20: continue
            ang = abs(((bearing((lat, lon), (p['lat'], p['lon'])) - b + 540) % 360) - 180)
            if ang > 30: continue
            sc = ang / 25 + d / 10 - (0.5 if p['ty'] in 'ct' else 0)
            if sc < bs: best, bs = i, sc
        return best
    cands = []
    for n, wl in node_ways.items():
        ws = [w for w in wl if w['hw'] in RANK and RANK[w['hw']] <= 5 and (w['name'] or w['ref'])]
        labs = {}
        for w in ws:
            labs.setdefault(way_label(w), w)
        if len(labs) < 2: continue
        # need >= 3 arms
        arms = 0
        for w in ws:
            i = w['nodes'].index(n)
            arms += (i > 0) + (i < len(w['nodes']) - 1)
        if arms < 3: continue
        score = sum(7 - RANK[w['hw']] for w in labs.values()) + sum(2 for l in labs if re.sub(r' \(.*\)$', '', l) in notable)
        cands.append((score, n, labs))
    cands.sort(key=lambda c: -c[0])
    cell, keep = {}, []
    for score, n, labs in cands:
        lat, lon = coord[n]
        key = (int(lat / 0.012), int(lon / 0.012))
        if key in cell: continue
        cell[key] = 1; keep.append((score, n, labs))
    chosen = keep[:520]
    # always include intersections near Home and Work
    for a in anchors[:2]:
        for score, n, labs in keep[520:]:
            if hav(coord[n], a['ll']) < 4500 and score >= 8 and len(chosen) < 620: chosen.append((score, n, labs))
    scenes = []
    for score, n, labs in chosen:
        lat, lon = coord[n]
        rd = []
        for lab, w in labs.items():
            arms = []
            for w2 in [x for x in node_ways[n] if way_label(x) == lab and x['hw'] in RANK]:
                i = w2['nodes'].index(n)
                for j in ((i - 1, i + 1)):
                    if 0 <= j < len(w2['nodes']):
                        # look ~60 m along for a stable bearing
                        k, tot = j, hav(coord[n], coord[w2['nodes'][j]])
                        step = 1 if j > i else -1
                        while tot < 60 and 0 <= k + step < len(w2['nodes']):
                            tot += hav(coord[w2['nodes'][k]], coord[w2['nodes'][k + step]]); k += step
                        b = bearing(coord[n], coord[w2['nodes'][k]])
                        if all(abs(((b - x[0] + 540) % 360) - 180) > 25 for x in arms): arms.append((b, None))
            arms = [(b, toward(lat, lon, b)) for b, _ in arms][:2]
            rd.append([lab, [[card8(b), t] for b, t in arms]])
        rd.sort(key=lambda r: r[0])
        scenes.append({'p': [round(lat, 4), round(lon, 4)], 'co': cidx(lat, lon), 'nt': near_idx(lat, lon), 'rd': rd[:4]})
    return scenes

def basemap(ctx):
    """Simplified interstates, highways and county lines for the answer maps."""
    ways = ctx['ways']
    lines, bmap = [], {}
    for w in ways.values():
        r = RANK.get(w['hw'], 9)
        if r > 3 or (w['hw'] or '').endswith('_link'): continue
        g = simplify(w['geom'], 60)
        if len(g) < 2: continue
        bmap[w['id']] = len(lines)
        lines.append([0 if r <= 1 else 1 if r == 2 else 2, enc_line(g)])
    cl = []
    for nm, (y, x, *_r) in zip(ctx['counties'].names, ctx['counties'].rings):
        pts = simplify(list(zip(y.tolist(), x.tolist())), 150)
        cl.append(enc_line(pts))
    return lines, cl, bmap

def sid(prefix, *parts):
    return prefix + hashlib.md5('|'.join(str(x) for x in parts).encode()).hexdigest()[:7]

def write_pack(ctx, out_path):
    exits, anchors, routes, exitref, adj = finish(ctx, out_path)
    scenes = build_scenes(ctx, anchors)
    lines, clines, bmap = basemap(ctx)
    places = [[p['n'], round(p['lat'], 4), round(p['lon'], 4), p['co'], p['ty'], p['pop']] for p in ctx['places']]
    roads, rents = ctx['roads'], ctx['routes']
    for r in roads:
        ws = r.pop('_ws')
        r['id'] = sid('d', r['n'], '%.2f,%.2f' % r['_mid'])
        r['m'] = [round(r['_mid'][0], 4), round(r['_mid'][1], 4)]
        r['bi'] = [bmap[w['id']] for w in ws if w['id'] in bmap]
        r['g'] = [enc_line(simplify(w['geom'], 100)) for w in ws if w['id'] not in bmap][:90]
    for r in rents:
        ws = r.pop('_ws')
        r['id'] = sid('f', r['n'])
        r['bi'] = [bmap[w['id']] for w in ws if w['id'] in bmap]
    for t in routes: t['id'] = sid('t', t['a'], t['b'], t['alt'])
    for sc in scenes: sc['id'] = sid('s', sc['p'][0], sc['p'][1])
    for e in exits: e['id'] = sid('e', e['i'], e['e'], e['x'])
    def clean(r):
        return {k: v for k, v in r.items() if not k.startswith('_')}
    pack = {'v': 1, 'built': time.strftime('%Y-%m-%d'), 'counties': ctx['cnames'] + ['Other'],
            'places': places, 'roads': [clean(r) for r in roads], 'routes': [clean(r) for r in rents],
            'exits': exits, 'trips': routes, 'scenes': scenes, 'base': lines, 'cl': clines,
            'home': [round(HOME[0], 4), round(HOME[1], 4)], 'work': [round(anchors[1]['ll'][0], 4), round(anchors[1]['ll'][1], 4)]}
    txt = json.dumps(pack, separators=(',', ':'), ensure_ascii=False)
    with open(out_path, 'w') as f:
        f.write('window.DD_ROADS=' + txt + ';\n')
    sizes = {k: len(json.dumps(v, separators=(',', ':'))) // 1000 for k, v in pack.items()}
    print('wrote', out_path, round(len(txt) / 1e6, 2), 'MB; KB by part:', sizes)

if __name__ == '__main__':
    import glob
    d = sys.argv[1]
    files = sorted(glob.glob(os.path.join(d, 'roads_*.json')))
    ctx = main(files, os.path.join(d, 'places.json'), os.path.join(d, 'counties.json'), sys.argv[2])
    write_pack(ctx, sys.argv[2])
