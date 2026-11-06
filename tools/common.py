"""Shared loaders for the road data pack. Inputs are OpenStreetMap exports from overpass-turbo."""
import json, math, pickle, collections, os
import numpy as np

CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

def hav(a, b):
    return math.hypot((a[0]-b[0])*111320, (a[1]-b[1])*111320*math.cos(math.radians(a[0])))

def bearing(a, b):
    return (math.degrees(math.atan2((b[1]-a[1])*math.cos(math.radians(a[0])), b[0]-a[0])) + 360) % 360

def card8(b):
    return CARD[int(((b+22.5) % 360)//45)]

def axis4(b):
    """Road axis label from a bearing (direction-agnostic)."""
    b = b % 180
    if b < 22.5 or b >= 157.5: return 'N-S'
    if b < 67.5: return 'NE-SW'
    if b < 112.5: return 'E-W'
    return 'NW-SE'

def load_rings(rel):
    """Assemble outer rings of an admin boundary relation from its member ways."""
    segs = []
    for m in rel['members']:
        if m.get('type') == 'way' and m.get('role') in ('outer', '') and m.get('geometry'):
            segs.append([(g['lat'], g['lon']) for g in m['geometry']])
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]: ring += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[-1]: ring += s[::-1][1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[0]: ring = s[:-1] + ring; segs.pop(i); changed = True; break
                if s[0] == ring[0]: ring = s[::-1][:-1] + ring; segs.pop(i); changed = True; break
        rings.append(ring)
    return rings

def in_ring(lat, lon, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        yi, xi = ring[i]; yj, xj = ring[j]
        if (xi > lon) != (xj > lon) and lat < (yj - yi) * (lon - xi) / (xj - xi + 1e-12) + yi:
            inside = not inside
        j = i
    return inside


class Counties:
    """Point-in-county lookup using numpy ray casting."""
    def __init__(self, rels):
        self.names = []
        self.rings = []
        for r in rels:
            for ring in load_rings(r):
                a = np.array(ring)
                self.names.append(r['tags']['name'].replace(' County', ''))
                self.rings.append((a[:, 0], a[:, 1], a[:, 0].min(), a[:, 0].max(), a[:, 1].min(), a[:, 1].max()))

    def of(self, lat, lon):
        for nm, (y, x, y0, y1, x0, x1) in zip(self.names, self.rings):
            if lat < y0 or lat > y1 or lon < x0 or lon > x1:
                continue
            yj, xj = np.roll(y, 1), np.roll(x, 1)
            cond = ((x > lon) != (xj > lon)) & (lat < (yj - y) * (lon - x) / (xj - x + 1e-12) + y)
            if int(cond.sum()) % 2 == 1:
                return nm
        return None


def load_ways(files):
    """Merge Overpass 'out geom' exports into {way_id: compact way dict}."""
    ways = {}
    for f in files:
        for e in json.load(open(f))['elements']:
            if e['type'] != 'way':
                continue
            t = e['tags']
            ways[e['id']] = {'id': e['id'], 'nodes': e['nodes'], 'geom': [(g['lat'], g['lon']) for g in e['geometry']],
                             'hw': t.get('highway'), 'name': t.get('name'), 'ref': t.get('ref'), 'oneway': t.get('oneway'),
                             'maxspeed': t.get('maxspeed'), 'junction': t.get('junction')}
    for w in ways.values():
        w['len'] = sum(hav(w['geom'][i], w['geom'][i+1]) for i in range(len(w['geom'])-1)) / 1609.34
    return ways


def simplify(pts, tol_m):
    """Douglas-Peucker on (lat, lon) points; tolerance in meters."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    k = 111320.0
    cl = math.cos(math.radians(pts[0][0]))
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i][1] * k * cl, pts[i][0] * k
        bx, by = pts[j][1] * k * cl, pts[j][0] * k
        dx, dy = bx - ax, by - ay
        dd = dx * dx + dy * dy
        best, bi = 0.0, -1
        for m in range(i + 1, j):
            px, py = pts[m][1] * k * cl, pts[m][0] * k
            if dd == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / dd))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, bi = d, m
        if best > tol_m and bi >= 0:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, kp in zip(pts, keep) if kp]


def enc_line(pts):
    """Delta-encode a polyline as flat ints in 1e-4 degree units: [lat0, lon0, dlat, dlon, ...]."""
    out, pl, po = [], 0, 0
    for i, (la, lo) in enumerate(pts):
        a, b = round(la * 1e4), round(lo * 1e4)
        out += [a, b] if i == 0 else [a - pl, b - po]
        pl, po = a, b
    return out
