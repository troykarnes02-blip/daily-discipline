  /* ---------- Roads: learn the Upstate road network by drilling routes, roads, exits and intersections ---------- */
  var RD_GOAL = 10, RD_SHOWUP = 20, RD_BONUS = 50;
  var RD_PTS = [2, 5, 10];                    // missed, hard, got it
  var RD_GAP = [0, 1, 3, 7, 16, 35];          // days until the next look, by box 0-5
  var RD_RANKS = [[0, 'Tourist'], [300, 'Local'], [900, 'Commuter'], [2000, 'Delivery Driver'], [4000, 'Cab Driver'], [8000, 'Dispatcher'], [15000, 'Navigator']];
  var RD_KINDS = { trip: 'Routes', road: 'Roads', exit: 'Exits', scene: 'Where am I' };
  var RD_MODES = [['all', 'Mix'], ['commute', 'My commute'], ['trip', 'Routes'], ['road', 'Roads'], ['exit', 'Exits'], ['scene', 'Where am I']];
  var RD_AXES = [['N-S', 'North / South'], ['E-W', 'East / West'], ['NE-SW', 'NE / SW'], ['NW-SE', 'NW / SE']];
  var CARD8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var DIRW = { N: 'north', NE: 'northeast', E: 'east', SE: 'southeast', S: 'south', SW: 'southwest', W: 'west', NW: 'northwest' };
  var rcards = {};     // card id -> { id, box, due, seen, miss, last }
  var rdays = {};      // date -> { date, n, pts, ok }
  var rdData = null, rdState = 'idle', rdMode = 'all', rdS = null, rdSearch = '';

  function cleanRCard(id, o) {
    if (!o || typeof o !== 'object' || !/^[a-z][0-9a-f]{7}$/.test(id)) return null;
    var box = Math.round(Number(o.box)), seen = Math.round(Number(o.seen)), miss = Math.round(Number(o.miss));
    var ok = /^\d{4}-\d{2}-\d{2}$/;
    return { id: id, box: box >= 0 && box <= 5 ? box : 0, due: ok.test(o.due || '') ? o.due : '', seen: seen > 0 ? seen : 1, miss: miss > 0 ? miss : 0, last: ok.test(o.last || '') ? o.last : '' };
  }
  function cleanRDay(id, o) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(id) || !o || typeof o !== 'object') return null;
    var n = Math.round(Number(o.n)), p = Math.round(Number(o.pts));
    return { date: id, n: n > 0 ? Math.min(n, 5000) : 0, pts: p > 0 ? Math.min(p, 500000) : 0, ok: !!o.ok };
  }

  /* data pack: loaded the first time the tab or a drill opens */
  function rdLoad() {
    if (rdData || rdState === 'loading') return;
    if (window.DD_ROADS) { rdPrep(window.DD_ROADS); return; }
    rdState = 'loading';
    var s = document.createElement('script');
    s.src = 'roads-data.js?b=' + encodeURIComponent(APP_BUILD);
    s.onload = function () { if (window.DD_ROADS) rdPrep(window.DD_ROADS); else { rdState = 'error'; } renderAll(); if (rdS && rdS.waiting) { rdS.waiting = false; rdStart(rdS.mode); } };
    s.onerror = function () { rdState = 'error'; renderAll(); };
    document.head.appendChild(s);
  }
  function rdDec(flat) {
    var out = [], la = 0, lo = 0;
    for (var i = 0; i < flat.length; i += 2) { la += flat[i]; lo += flat[i + 1]; out.push([la / 1e4, lo / 1e4]); }
    return out;
  }
  function rdKm(a, b) { return Math.hypot((a[0] - b[0]) * 111.32, (a[1] - b[1]) * 111.32 * Math.cos(a[0] * Math.PI / 180)); }
  function rdBear(a, b) { return (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 360; }
  function rdC8(b) { return CARD8[Math.floor((((b % 360) + 360) % 360 + 22.5) / 45) % 8]; }
  function rdPrep(D) {
    var cards = [], byId = {};
    function add(c) { cards.push(c); byId[c.id] = c; }
    D.roads.forEach(function (r) { add({ id: r.id, kind: 'road', tier: r.t, d: r }); });
    D.routes.forEach(function (r) { add({ id: r.id, kind: 'road', tier: r.t, d: r, isRoute: true }); });
    D.exits.forEach(function (e) { add({ id: e.id, kind: 'exit', tier: 2, d: e }); });
    D.trips.forEach(function (t) {
      var big = function (i) { return i !== null && D.places[i] && D.places[i][5] >= 5000; };
      var home = t.a === 'Home' || t.b === 'Home' || t.a === 'Work' || t.b === 'Work';
      add({ id: t.id, kind: 'trip', tier: home ? 1 : (big(t.ai) && big(t.bi) ? 2 : 3), d: t });
    });
    D.scenes.forEach(function (s) {
      var near = Math.min(rdKm(s.p, D.home), rdKm(s.p, D.work)) < 10;
      add({ id: s.id, kind: 'scene', tier: near ? 1 : 3, d: s });
    });
    D.cards = cards; D.byId = byId; D.bl = null;
    rdData = D; rdState = 'ready';
  }
  function rdBase() {
    if (!rdData.bl) {
      rdData.bl = rdData.base.map(function (b) {
        var pts = rdDec(b[1]), a = 99, z = -99, c = 999, d = -999;
        pts.forEach(function (p) { if (p[0] < a) a = p[0]; if (p[0] > z) z = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; });
        return { c: b[0], pts: pts, b: [a, z, c, d] };
      });
      rdData.cln = rdData.cl.map(rdDec);
    }
    return rdData.bl;
  }

  /* ---------- scheduling ---------- */
  function rdToday() { return dkey(new Date()); }
  function rdOpenTiers() {
    // for each kind, the highest tier that may be introduced: a tier opens when 80% of the one below has been seen
    var by = {};
    rdData.cards.forEach(function (c) {
      var k = by[c.kind] = by[c.kind] || {};
      var t = k[c.tier] = k[c.tier] || { n: 0, s: 0 };
      t.n++; if (rcards[c.id]) t.s++;
    });
    var open = {};
    Object.keys(by).forEach(function (k) {
      var tiers = Object.keys(by[k]).map(Number).sort(), o = tiers[0];
      for (var i = 0; i < tiers.length; i++) {
        o = tiers[i];
        var t = by[k][tiers[i]];
        if (t.s / t.n < 0.8) break;
      }
      open[k] = o;
    });
    return open;
  }
  function rdHash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rdBuild(mode, size) {
    var tk = rdToday(), open = rdOpenTiers(), cards = rdData.cards;
    var allow = function (c) {
      if (mode === 'all') return true;
      if (mode === 'commute') return c.kind === 'trip' ? (c.d.a === 'Home' || c.d.b === 'Home' || c.d.a === 'Work' || c.d.b === 'Work') : (c.kind === 'scene' && c.tier === 1);
      return c.kind === mode;
    };
    var due = cards.filter(function (c) { var s = rcards[c.id]; return allow(c) && s && s.due <= tk; })
      .sort(function (a, b) { var x = rcards[a.id], y = rcards[b.id]; return x.due < y.due ? -1 : x.due > y.due ? 1 : x.box - y.box; });
    var fresh = {};
    cards.forEach(function (c) {
      if (!allow(c) || rcards[c.id]) return;
      if (mode !== 'commute' && c.tier > (open[c.kind] || 1)) return;
      (fresh[c.kind] = fresh[c.kind] || []).push(c);
    });
    Object.keys(fresh).forEach(function (k) {
      fresh[k].sort(function (a, b) { return a.tier - b.tier || (rdHash(a.id + tk) - rdHash(b.id + tk)); });
    });
    var q = due.slice(0, Math.ceil(size * 0.6)), kinds = ['trip', 'road', 'scene', 'exit'].filter(function (k) { return fresh[k] && fresh[k].length; });
    var i = 0, guard = 0;
    while (q.length < size && kinds.length && guard++ < 500) {
      var k = kinds[i % kinds.length];
      if (fresh[k].length) q.push(fresh[k].shift()); else kinds.splice(kinds.indexOf(k), 1);
      i++;
    }
    for (var j = 0; q.length < size && j < due.length; j++) if (q.indexOf(due[j]) < 0) q.push(due[j]);
    return q;
  }

  /* ---------- model ---------- */
  function rdModel() {
    var tk = rdToday(), yest = dkey(addDays(new Date(), -1)), dates = Object.keys(rdays).filter(function (k) { return rdays[k].ok; }).sort();
    var run = 0, prev = null, best = 0, runAt = {}, total = 0;
    dates.forEach(function (d) {
      run = prev && dkey(addDays(fromKey(prev), 1)) === d ? run + 1 : 1; runAt[d] = run; prev = d; if (run > best) best = run;
    });
    Object.keys(rdays).forEach(function (k) { total += rdays[k].pts; });
    var cur = rdays[tk] && rdays[tk].ok ? runAt[tk] : (rdays[yest] && rdays[yest].ok ? runAt[yest] : 0);
    var wk = dkey(weekStart(new Date())), wn = 0, wp = 0;
    Object.keys(rdays).forEach(function (k) { if (dkey(weekStart(fromKey(k))) === wk) { wn += rdays[k].n; wp += rdays[k].pts; } });
    var ri = 0; RD_RANKS.forEach(function (r, i) { if (total >= r[0]) ri = i; });
    var by = {}, known = 0, seen = 0, due = 0;
    if (rdData) rdData.cards.forEach(function (c) {
      var b = by[c.kind] = by[c.kind] || { n: 0, seen: 0, known: 0 };
      b.n++;
      var s = rcards[c.id];
      if (s) { b.seen++; seen++; if (s.box >= 3) { b.known++; known++; } if (s.due <= tk) due++; }
    });
    return { tk: tk, today: rdays[tk] ? rdays[tk].n : 0, ok: !!(rdays[tk] && rdays[tk].ok), cur: cur, best: best, total: total, week: wn, weekPts: wp,
      rank: ri, by: by, known: known, seen: seen, due: due, nextRun: rdays[tk] && rdays[tk].ok ? runAt[tk] : (rdays[yest] && rdays[yest].ok ? runAt[yest] + 1 : 1) };
  }
  function rdRate(c, rating) {
    var tk = rdToday(), s = rcards[c.id] || { id: c.id, box: 0, due: '', seen: 0, miss: 0, last: '' };
    s.seen++; s.last = tk;
    if (rating === 0) { s.miss++; s.box = 0; s.due = tk; }
    else if (rating === 1) { s.box = Math.max(1, s.box); s.due = dkey(addDays(new Date(), Math.max(1, Math.round(RD_GAP[s.box] / 2)))); }
    else { s.box = Math.min(5, s.box + 1); s.due = dkey(addDays(new Date(), RD_GAP[s.box])); }
    rcards[c.id] = s;
    var m = rdModel(), d = rdays[tk] || { date: tk, n: 0, pts: 0, ok: false };
    var mult = streakMult(m.ok ? m.cur : m.cur + 1);
    var p = Math.round(RD_PTS[rating] * mult) + (d.n === 0 ? RD_SHOWUP : 0);
    d.n++;
    var hit = !d.ok && d.n >= RD_GOAL;
    if (hit) { d.ok = true; p += RD_BONUS; }
    d.pts += p; rdays[tk] = d;
    writeLocal();
    var s2 = s, d2 = d;
    persist(function (x) { return Promise.all([x.doc('roadcards/' + c.id).set(s2), x.doc('roaddays/' + tk).set(d2)]); });
    return { pts: p, hit: hit };
  }

  /* ---------- wording ---------- */
  function rdPlace(i) { return i === null || i === undefined || !rdData.places[i] ? '' : rdData.places[i][0]; }
  function rdCounty(i) { var n = rdData.counties[i]; return !n || n === 'Other' ? 'a county outside the four we cover' : n + ' County'; }
  function rdAxisOf(a) { a = ((a % 180) + 180) % 180; return a < 22.5 || a >= 157.5 ? 'N-S' : a < 67.5 ? 'NE-SW' : a < 112.5 ? 'E-W' : 'NW-SE'; }
  function rdAxisOk(pick, a) {
    var c = { 'N-S': 0, 'NE-SW': 45, 'E-W': 90, 'NW-SE': 135 }[pick];
    var d = Math.abs((((a % 180) + 180) % 180) - c); d = Math.min(d, 180 - d);
    return d <= 32.5;
  }
  function rdAxisTxt(ax) { return { 'N-S': 'north and south', 'E-W': 'east and west', 'NE-SW': 'northeast and southwest', 'NW-SE': 'northwest and southeast' }[ax]; }
  function rdTurn(t, r, x, first) {
    if (x === 'on your right') return '<span class="rd-tn">Arrive</span>';
    if (x) return '<span class="rd-tn">Exit ' + esc(x) + '</span>';
    return '<span class="rd-tn">' + ({ L: 'Left', R: 'Right', BL: 'Bear left', BR: 'Bear right', S: 'Straight', U: 'U-turn', ON: 'Ramp on', '': (first ? 'Start' : 'Then') }[t] || 'Then') + '</span>';
  }
  function ordTxt(n) { var t = n % 100; return n + (t > 10 && t < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 < 4 ? n % 10 : 0]); }
  function rdStepHTML(s, i) {
    if (s.r === 'roundabout') {
      var n = parseInt(String(s.t).slice(2), 10) || 1;
      return '<div class="rd-step"><span class="rd-tn">Roundabout</span><div>Take the <b>' + ordTxt(n) + ' exit</b></div></div>';
    }
    var main = '<b>' + esc(s.r) + '</b>' + (s.n && s.n.length ? ' <span class="rd-nm">(' + s.n.map(esc).join(' / ') + ')</span>' : '');
    var bits = [];
    if (s.d) bits.push('heading ' + DIRW[s.d]);
    if (s.m >= 0.1) bits.push(s.m.toFixed(1) + ' mi');
    if (s.x === 'on your right') bits.push('on your right');
    return '<div class="rd-step">' + rdTurn(s.t, s.r, s.x, !i) + '<div>' + main + (bits.length ? '<div class="sub">' + bits.join(' &middot; ') + '</div>' : '') + '</div></div>';
  }

  /* ---------- map ---------- */
  function rdMap(o) {
    // o: { box:[lat0,lat1,lon0,lon1], hi:[[pts]...], marks:[{p,label,kind}], base:[idx], arms:[{p,b,label}] }
    var D = rdData, bl = rdBase(), W = 340, b = o.box.slice();
    var kx = Math.cos(((b[0] + b[1]) / 2) * Math.PI / 180);
    var w = (b[3] - b[2]) * kx, h = b[1] - b[0];
    if (w < h * 0.7) { var ex = (h * 0.7 - w) / kx / 2; b[2] -= ex; b[3] += ex; w = h * 0.7; }
    if (h < w * 0.55) { var ey = (w * 0.55 - h) / 2; b[0] -= ey; b[1] += ey; h = w * 0.55; }
    var padx = w * 0.08 / kx, pady = h * 0.08; b = [b[0] - pady, b[1] + pady, b[2] - padx, b[3] + padx];
    w = (b[3] - b[2]) * kx; h = b[1] - b[0];
    var k = W / w, H = Math.round(h * k);
    var X = function (lon) { return ((lon - b[2]) * kx * k).toFixed(1); }, Y = function (lat) { return ((b[1] - lat) * k).toFixed(1); };
    var path = function (pts) { var s = ''; pts.forEach(function (p, i) { s += (i ? 'L' : 'M') + X(p[1]) + ' ' + Y(p[0]); }); return s; };
    var svg = '<svg class="rd-map" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.alt || 'Map') + '"><rect width="' + W + '" height="' + H + '" class="mbg"/>';
    rdData.cln.forEach(function (c) { svg += '<path d="' + path(c) + '" class="mcty"/>'; });
    var cls = ['mrd0', 'mrd1', 'mrd2'];
    bl.forEach(function (l) {
      if (l.b[1] < b[0] || l.b[0] > b[1] || l.b[3] < b[2] || l.b[2] > b[3]) return;
      svg += '<path d="' + path(l.pts) + '" class="' + cls[l.c] + '"/>';
    });
    (o.hiBase || []).forEach(function (i) { if (bl[i]) svg += '<path d="' + path(bl[i].pts) + '" class="mhi"/>'; });
    (o.hi || []).forEach(function (pts) { svg += '<path d="' + path(pts) + '" class="mhi"/>'; });
    var shown = 0;
    D.places.forEach(function (p) {
      if (p[4] === 'h' || shown > 12) return;
      if (p[1] < b[0] || p[1] > b[1] || p[2] < b[2] || p[2] > b[3]) return;
      if (w > 0.25 && p[4] === 'v') return;
      shown++;
      svg += '<circle cx="' + X(p[2]) + '" cy="' + Y(p[1]) + '" r="2.2" class="mtn"/><text x="' + (parseFloat(X(p[2])) + 4) + '" y="' + (parseFloat(Y(p[1])) + 3) + '" class="mtx">' + esc(p[0]) + '</text>';
    });
    (o.arms || []).forEach(function (a) {
      var len = Math.min(h, w / kx) * 0.3, rad = a.b * Math.PI / 180;
      var q = [a.p[0] + Math.cos(rad) * len, a.p[1] + Math.sin(rad) * len / kx];
      var qx = parseFloat(X(q[1])), qy = parseFloat(Y(q[0])), st = Math.sin(rad) >= 0, tx = qx + (st ? 3 : -3);
      if (a.label && st && tx > W - 80) { st = false; tx = qx - 3; }
      if (a.label && !st && tx < 80) { st = true; tx = qx + 3; }
      svg += '<path d="' + path([a.p, q]) + '" class="marm"/>' + (a.label ? '<text x="' + Math.max(4, Math.min(W - 4, tx)).toFixed(1) + '" y="' + Math.max(10, Math.min(H - 4, qy + 3)).toFixed(1) + '" class="mal" text-anchor="' + (st ? 'start' : 'end') + '">' + esc(a.label) + '</text>' : '');
    });
    (o.marks || []).forEach(function (m) {
      svg += '<circle cx="' + X(m.p[1]) + '" cy="' + Y(m.p[0]) + '" r="5" class="mk-' + (m.kind || 'p') + '"/><text x="' + (parseFloat(X(m.p[1])) + 8) + '" y="' + (parseFloat(Y(m.p[0])) + 4) + '" class="mlb">' + esc(m.label || '') + '</text>';
    });
    svg += '<g transform="translate(' + (W - 18) + ' 20)"><path d="M0 -12 L5 4 L0 1 L-5 4 Z" class="mnorth"/><text y="-15" text-anchor="middle" class="mtx">N</text></g></svg>';
    return svg;
  }
  function rdBoxOf(pts, pad) {
    var a = 99, z = -99, c = 999, d = -999;
    pts.forEach(function (p) { if (p[0] < a) a = p[0]; if (p[0] > z) z = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; });
    return [a - (pad || 0), z + (pad || 0), c - (pad || 0), d + (pad || 0)];
  }

  /* ---------- the card faces ---------- */
  function rdFacts(c) {
    var d = c.d, h = '', ax = rdAxisOf(d.a), A = rdPlace(d.ea), B = rdPlace(d.eb);
    var bdir = rdC8(d.a), adir = rdC8(d.a + 180);
    h += '<p class="rd-line">Runs <b>' + rdAxisTxt(ax) + '</b>' + (A || B ? '. The ' + DIRW[adir] + ' end is near <b>' + esc(A || 'the edge of the map') + '</b>, the ' + DIRW[bdir] + ' end near <b>' + esc(B || 'the edge of the map') + '</b>' : '') + '.</p>';
    if (c.isRoute) {
      h += '<p class="rd-line">' + (d.nm && d.nm.length ? 'Local names: <b>' + d.nm.map(esc).join(', ') + '</b>. ' : '') + 'Mostly in <b>' + d.co.map(function (i) { return esc(rdData.counties[i] === 'Other' ? 'other counties' : rdData.counties[i]); }).join(', ') + '</b>. About ' + d.l + ' mi in the area.</p>';
    } else {
      h += '<p class="rd-line">' + (d.r && d.r.length ? 'Route number: <b>' + d.r.map(esc).join(', ') + '</b>. ' : '') + 'In <b>' + esc(rdCounty(d.co)) + '</b>' + (d.nt !== null ? ', near <b>' + esc(rdPlace(d.nt)) + '</b>' : '') + '. About ' + d.l + ' mi.</p>';
    }
    if (d.x && d.x.length) h += '<p class="rd-line">Crosses, going ' + DIRW[bdir] + ': <b>' + d.x.map(esc).join('</b>, <b>') + '</b>.</p>';
    return h;
  }
  function rdRoadMap(c) {
    var d = c.d, hi = [], pts = [];
    (d.g || []).forEach(function (g) { var p = rdDec(g); hi.push(p); pts = pts.concat(p); });
    var bl = rdBase();
    (d.bi || []).forEach(function (i) { if (bl[i]) pts = pts.concat(bl[i].pts); });
    if (!pts.length && d.m) pts = [d.m];
    var box = rdBoxOf(pts, 0.01);
    // keep long roads readable: cap the window
    return rdMap({ box: box, hi: hi, hiBase: d.bi, alt: 'Map of ' + (d.n || '') });
  }
  function rdTripMap(t) {
    var line = rdDec(t.g), a = line[0], z = line[line.length - 1];
    return rdMap({ box: rdBoxOf(line, 0.012), hi: [line], marks: [{ p: a, label: t.a === 'Home' || t.a === 'Work' ? t.a : t.a, kind: 'a' }, { p: z, label: t.b, kind: 'b' }], alt: 'Route from ' + t.a + ' to ' + t.b });
  }
  function rdSceneInfo(s) {
    var D = rdData, cities = D.places.filter(function (p) { return p[4] === 'c'; }).sort(function (a, b) { return b[5] - a[5]; }).slice(0, 2), h = '';
    h += '<p class="rd-line"><b>' + esc(rdCounty(s.co)) + '</b>' + (s.nt !== null ? ', nearest town <b>' + esc(rdPlace(s.nt)) + '</b>' : '') + '.</p>';
    s.rd.forEach(function (r) {
      var parts = r[1].map(function (a) { return DIRW[a[0]] + (a[1] !== null ? ' toward ' + esc(rdPlace(a[1])) : ''); });
      h += '<p class="rd-line"><b>' + esc(r[0]) + '</b> goes ' + (parts.length ? parts.join(' and ') : 'on') + '.</p>';
    });
    var ref = cities.map(function (c) {
      var mi = rdKm(s.p, [c[1], c[2]]) * 0.621;
      return esc(c[0]) + ' is ' + Math.round(mi) + ' mi to the ' + DIRW[rdC8(rdBear(s.p, [c[1], c[2]]))];
    });
    if (ref.length) h += '<p class="rd-line">' + ref.join('. ') + '.</p>';
    return h;
  }
  function rdSceneMap(s) {
    var arms = [];
    s.rd.forEach(function (r) { r[1].forEach(function (a, ai) { arms.push({ p: s.p, b: CARD8.indexOf(a[0]) * 45, label: ai ? '' : r[0].replace(/ \(.*\)$/, '') }); }); });
    return rdMap({ box: [s.p[0] - 0.03, s.p[0] + 0.03, s.p[1] - 0.04, s.p[1] + 0.04], arms: arms, marks: [{ p: s.p, label: '', kind: 'p' }], alt: 'Intersection map' });
  }

  /* ---------- the drill ---------- */
  function rdStart(mode) {
    if (!rdData) { rdLoad(); rdS = { waiting: true, mode: mode }; rdShow(); return; }
    var m = rdModel(), size = RD_GOAL;
    if (m.ok) size = 10;
    else size = Math.max(3, RD_GOAL - m.today);
    var q = rdBuild(mode, size);
    if (!q.length) { toast('Nothing due in that mode. Try another.'); return; }
    rdS = { mode: mode, q: q, i: 0, stage: 'q', hint: 0, pick: '', right: null, done: 0, pts: 0, miss: [], got: 0, total: size, waiting: false };
    rdShow();
  }
  function rdClose() { rdS = null; $('#rd').hidden = true; $('#rd-in').innerHTML = ''; $('#rd-act').innerHTML = ''; renderAll(); }
  function rdCur() { return rdS && rdS.q ? rdS.q[rdS.i] : null; }
  function rdQuestion(c) {
    var d = c.d;
    if (c.kind === 'trip') {
      var hm = (d.a === 'Home' || d.b === 'Home' || d.a === 'Work' || d.b === 'Work');
      var nm = function (x) { return x === 'Home' ? 'Home (Hart Townes Way)' : x === 'Work' ? 'Work (Southern MEP)' : x; };
      return '<div class="rd-k">ROUTE' + (d.alt ? ' &middot; NO INTERSTATE' : '') + '</div><div class="rd-q">' + esc(nm(d.a)) + '<span class="rd-to">to</span>' + esc(nm(d.b)) + '</div><p class="rd-line">About ' + d.mi + ' mi. Say the roads in order, which way you head on each, and where you turn' + (hm ? '' : '') + '.</p>';
    }
    if (c.kind === 'road') {
      var nr = c.isRoute ? '' : (d.nt !== null ? 'near ' + rdPlace(d.nt) + ', ' : '') + rdCounty(d.co);
      return '<div class="rd-k">' + (c.isRoute ? 'ROUTE NUMBER' : 'ROAD') + '</div><div class="rd-q">' + esc(d.n) + '</div>' + (c.isRoute ? '' : (d.r && d.r.length ? '<p class="rd-line">' + d.r.map(esc).join(', ') + '</p>' : '')) + '<p class="rd-line">' + (nr ? esc(nr) + '. ' : '') + 'Which way does it run? Then name the towns at each end.</p>';
    }
    if (c.kind === 'exit') {
      return '<div class="rd-k">EXIT</div><div class="rd-q">' + esc(d.i) + '<span class="rd-to">exit</span>' + esc(d.e) + '</div><p class="rd-line">What road does it put you on, and what town is it by?</p>';
    }
    var names = d.rd.map(function (r) { return '<b>' + esc(r[0]) + '</b>'; });
    return '<div class="rd-k">WHERE AM I</div><div class="rd-q sm">' + names.join('<span class="rd-to">and</span>') + '</div><p class="rd-line">You are at this corner. Which county and nearest town? Which way does each road run, and where does it lead?</p>';
  }
  function rdAnswer(c) {
    var d = c.d, h = '';
    if (c.kind === 'trip') {
      h += '<p class="rd-line">' + (d.v ? '<span class="pill bg-elite">Verified</span> ' + esc(d.v) + '. ' : '<span class="rd-warn">Computed from map data, not checked against Apple Maps.</span> ') + d.mi + ' mi, about ' + d.min + ' min.</p>';
      h += '<div class="rd-steps">' + d.s.map(function (s, i) { return rdStepHTML(s, i); }).join('') + '</div>';
      h += rdTripMap(d);
    } else if (c.kind === 'road') {
      h += rdFacts(c) + rdRoadMap(c);
    } else if (c.kind === 'exit') {
      h += '<p class="rd-line"><b>' + esc(d.i) + ' exit ' + esc(d.e) + '</b>' + (d.x ? ' puts you on <b>' + esc(d.x) + '</b>' : '') + (d.nt !== null ? ', by <b>' + esc(rdPlace(d.nt)) + '</b>' : '') + '.</p>';
      h += rdMap({ box: [d.p[0] - 0.03, d.p[0] + 0.03, d.p[1] - 0.04, d.p[1] + 0.04], marks: [{ p: d.p, label: 'Exit ' + d.e, kind: 'p' }], alt: 'Exit map' });
    } else {
      h += rdSceneInfo(d) + rdSceneMap(d);
    }
    return h;
  }
  function rdShow() {
    var box = $('#rd'), inn = $('#rd-in'), act = $('#rd-act');
    box.hidden = false;
    if (!rdS || rdS.waiting) {
      inn.innerHTML = '<div class="rd-top"><b>ROAD DRILL</b></div><p class="lead">' + (rdState === 'error' ? 'The road data did not load. Check your connection and try again.' : 'Loading the road data...') + '</p>';
      act.innerHTML = '<button class="btn" data-action="rd-close">Close</button>';
      return;
    }
    if (rdS.i >= rdS.q.length) { rdSummary(); return; }
    var c = rdCur(), d = c.d, pct = Math.round(rdS.i / rdS.q.length * 100);
    var h = '<div class="rd-top"><span>' + (rdS.i + 1) + ' of ' + rdS.q.length + '</span><span>' + esc(RD_KINDS[c.kind]) + '</span><button class="link" data-action="rd-close">End</button></div><div class="bar"><i style="width:' + pct + '%"></i></div>';
    h += rdQuestion(c);
    var a = '';
    if (rdS.stage === 'q') {
      if (c.kind === 'trip') {
        h += '<div class="rd-steps">' + d.s.map(function (s, i) { return i < rdS.hint ? rdStepHTML(s) : ''; }).join('') + '</div>';
        a = '<button class="btn" data-action="rd-hint"' + (rdS.hint >= d.s.length ? ' disabled' : '') + '>Hint</button><button class="btn primary" data-action="rd-show">Show answer</button>';
      } else if (c.kind === 'road') {
        h += '<div class="rd-axes">' + RD_AXES.map(function (x) { return '<button class="btn" data-action="rd-axis" data-ax="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
        a = '<button class="btn primary" data-action="rd-show">Show answer</button>';
      } else a = '<button class="btn primary" data-action="rd-show">Show answer</button>';
    } else {
      if (rdS.right !== null) h += '<p class="rd-res ' + (rdS.right ? 'ok' : 'no') + '">' + (rdS.right ? 'Right, ' : 'Not quite, you picked ') + esc(rdAxisTxt(rdS.pick)) + (rdS.right ? '.' : '.') + '</p>';
      h += rdAnswer(c);
      var sug = rdS.right === true ? 2 : rdS.right === false ? 0 : (c.kind === 'trip' && rdS.hint > 0 ? 1 : -1);
      a = [['Missed', 0], ['Hard', 1], ['Got it', 2]].map(function (x) {
        return '<button class="btn' + (x[1] === sug ? ' primary' : '') + '" data-action="rd-rate" data-r="' + x[1] + '">' + x[0] + '</button>';
      }).join('');
    }
    inn.innerHTML = h; act.innerHTML = a;
    try { inn.scrollTop = 0; } catch (e) {}
  }
  function rdSummary() {
    var s = rdS, m = rdModel();
    var h = '<div class="rd-top"><b>DRILL DONE</b></div><div class="tiles3"><div class="tile"><label>Drilled</label><div class="v">' + s.done + '</div></div><div class="tile"><label>Got it</label><div class="v">' + s.got + '</div></div><div class="tile"><label>Points</label><div class="v">' + s.pts + '</div></div></div>';
    h += '<p class="lead" style="margin-top:12px">Today <b>' + m.today + '/' + RD_GOAL + '</b>' + (m.ok ? ' &middot; goal hit, streak <b>' + m.cur + '</b>' : ' &middot; ' + (RD_GOAL - m.today) + ' to go') + '.</p>';
    if (s.miss.length) h += '<h3>Missed</h3>' + s.miss.map(function (c) { return '<p class="rd-line">' + esc(rdTitle(c)) + '</p>'; }).join('');
    $('#rd-in').innerHTML = h;
    $('#rd-act').innerHTML = '<button class="btn" data-action="rd-close">Done</button><button class="btn primary" data-action="rd-again">Keep going</button>';
  }
  function rdTitle(c) {
    var d = c.d;
    if (c.kind === 'trip') return d.a + ' to ' + d.b;
    if (c.kind === 'road') return d.n;
    if (c.kind === 'exit') return d.i + ' exit ' + d.e;
    return d.rd.map(function (r) { return r[0]; }).join(' and ');
  }
  function rdAction(a, b) {
    if (a === 'rd-open') { rdLoad(); rdStart(rdMode === 'all' ? 'all' : rdMode); return true; }
    if (a === 'rd-mode') { rdMode = b.dataset.m; renderAll(); return true; }
    if (a === 'rd-close') { rdClose(); return true; }
    if (a === 'rd-again') { rdStart(rdS ? rdS.mode : 'all'); return true; }
    if (a === 'rd-hint') { if (rdS) { rdS.hint++; rdShow(); } return true; }
    if (a === 'rd-show') { if (rdS) { rdS.stage = 'a'; rdShow(); } return true; }
    if (a === 'rd-axis') {
      if (!rdS) return true;
      var c = rdCur(), pick = b.dataset.ax;
      rdS.pick = pick; rdS.right = rdAxisOk(pick, c.d.a); rdS.stage = 'a'; rdShow();
      return true;
    }
    if (a === 'rd-rate') {
      if (!rdS) return true;
      var c2 = rdCur(), r = parseInt(b.dataset.r, 10), res = rdRate(c2, r);
      rdS.done++; rdS.pts += res.pts; if (r === 2) rdS.got++;
      if (r === 0) { rdS.miss.push(c2); if (rdS.q.indexOf(c2, rdS.i + 1) < 0) rdS.q.push(c2); }
      if (res.hit) toast('Daily goal hit. +' + RD_BONUS + ' bonus.');
      rdS.i++; rdS.stage = 'q'; rdS.hint = 0; rdS.pick = ''; rdS.right = null;
      rdShow();
      return true;
    }
    if (a === 'rd-look') { rdLook(b.dataset.id); return true; }
    if (a === 'rd-search') { return true; }
    return false;
  }
  function rdLook(id) {
    var c = rdData && rdData.byId[id];
    if (!c) return;
    openModal('<h3>' + esc(rdTitle(c)).toUpperCase() + '</h3>' + (c.kind === 'trip' ? rdAnswer(c) : c.kind === 'road' ? rdFacts(c) + rdRoadMap(c) : rdAnswer(c)) + '<button class="btn" data-action="close-modal">Close</button>');
  }

  /* ---------- the tab ---------- */
  function rdHomeRow(row) {
    var m = rdModel(), main, sub, act;
    if (m.ok) { main = 'Done'; sub = m.today + ' drills &middot; ' + m.cur + '-day streak'; act = '<button class="btn" data-action="rd-open">More</button>'; }
    else if (m.today > 0) { main = m.today + ' of ' + RD_GOAL; sub = 'In progress' + (m.cur ? ' &middot; ' + m.cur + '-day streak on the line' : ''); act = '<button class="btn primary" data-action="rd-open">Drill</button>'; }
    else { main = 'Not yet'; sub = (m.cur ? m.cur + '-day streak on the line' : 'Learn the roads, ' + RD_GOAL + ' a day') + (m.due ? ' &middot; ' + m.due + ' due' : ''); act = '<button class="btn primary" data-action="rd-open">Drill</button>'; }
    return row('ROADS', main, sub, act);
  }
  function rdHitsHTML() {
    var q = rdSearch.trim().toLowerCase();
    if (!rdData || q.length < 2) return '';
    var hit = rdData.cards.filter(function (c) { return c.kind === 'road' && ((c.d.n || '').toLowerCase().indexOf(q) >= 0 || (c.d.r || []).join(' ').toLowerCase().indexOf(q) >= 0); }).slice(0, 8);
    if (!hit.length) return '<p class="note">No match.</p>';
    return '<div class="rd-hits">' + hit.map(function (c) {
      return '<button class="btn" data-action="rd-look" data-id="' + c.id + '">' + esc(c.d.n) + (c.d.r && c.d.r.length ? ' (' + esc(c.d.r[0]) + ')' : '') + (c.d.nt !== null && c.d.nt !== undefined ? ' &middot; ' + esc(rdPlace(c.d.nt)) : '') + '</button>';
    }).join('') + '</div>';
  }
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'rd-q') { rdSearch = ev.target.value; var bx = $('#rd-hits-box'); if (bx) bx.innerHTML = rdHitsHTML(); }
  });
  function renderRoads() {
    var hero = $('#roads-hero');
    if (!hero) return;
    if (tab === 'roads' && !rdData) rdLoad();
    var m = rdModel(), h = '';
    var rk = RD_RANKS[m.rank], nx = RD_RANKS[m.rank + 1];
    h += '<h2>ROAD DRILL<small>' + esc(rk[1]) + (nx ? ' &middot; ' + nfmt(nx[0] - m.total) + ' pts to ' + esc(nx[1]) : '') + '</small></h2>';
    h += '<div class="rd-count"><span class="num">' + m.today + '</span><span class="of">/ ' + RD_GOAL + ' today</span></div><div class="bar"><i style="width:' + Math.min(100, Math.round(m.today / RD_GOAL * 100)) + '%"></i></div>';
    h += '<div class="tiles3"><div class="tile"><label>Streak</label><div class="v">' + m.cur + '</div></div><div class="tile"><label>Due</label><div class="v">' + m.due + '</div></div><div class="tile"><label>Points</label><div class="v">' + nfmt(m.total) + '</div></div></div>';
    h += '<div class="chips" style="margin:12px 0">' + RD_MODES.map(function (x) { return '<button type="button" class="chip" data-action="rd-mode" data-m="' + x[0] + '" aria-pressed="' + (rdMode === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>';
    h += '<button class="btn primary" style="width:100%;min-height:54px;font-size:18px" data-action="rd-open"' + (rdState === 'error' ? ' disabled' : '') + '>' + (m.ok ? 'Keep drilling' : m.today ? 'Continue' : 'Start drill') + '</button>';
    if (rdState === 'error') h += '<p class="note">The road data did not load. Check your connection and reopen this tab.</p>';
    else if (!rdData) h += '<p class="note">Loading the road data...</p>';
    hero.innerHTML = h;

    var prog = $('#roads-prog'), ph = '<h2>WHAT YOU KNOW<small>known = got it three times</small></h2>';
    if (rdData) {
      ph += Object.keys(RD_KINDS).map(function (k) {
        var b = m.by[k] || { n: 0, seen: 0, known: 0 };
        return '<div class="rd-prog"><div class="rd-pr-h"><b>' + RD_KINDS[k] + '</b><span>' + b.known + ' known &middot; ' + b.seen + ' seen &middot; ' + b.n + ' total</span></div><div class="bar"><i style="width:' + (b.n ? Math.round(b.known / b.n * 100) : 0) + '%"></i></div></div>';
      }).join('');
      ph += '<p class="note">New cards come in rings: interstates and US highways first, then state routes, then county roads and streets. A ring opens once you have seen 80% of the one before it.</p>';
    } else ph += '<p class="note">Loading...</p>';
    prog.innerHTML = ph;

    var lg = $('#roads-log'), days = Object.keys(rdays).sort().reverse().slice(0, 7);
    lg.innerHTML = '<h2>LAST 7 DAYS<small>' + m.week + ' drills this week</small></h2>' + (days.length ? days.map(function (k) {
      var d = rdays[k];
      return '<div class="trow"><span class="lbl long">' + dateLabel(k).toUpperCase() + '</span><div class="main">' + d.n + ' drills<div class="sub">+' + d.pts + ' pts</div></div><div>' + (d.ok ? '<span class="pill bg-ontime">Goal</span>' : '') + '</div></div>';
    }).join('') : '<p class="note" style="margin:0">No drills yet. Your first one takes about two minutes.</p>');

    var lk = $('#roads-look');
    if (!(document.activeElement && document.activeElement.id === 'rd-q')) {
      lk.innerHTML = '<h2>LOOK UP A ROAD</h2><input type="text" id="rd-q" placeholder="Road or route number" value="' + esc(rdSearch) + '" autocomplete="off" autocapitalize="off"><div id="rd-hits-box">' + rdHitsHTML() + '</div>';
    }
    var ab = $('#roads-about');
    ab.innerHTML = '<p class="note" style="margin:0">Roads, routes and exits come from OpenStreetMap' + (rdData ? ' (pulled ' + esc(rdData.built) + ')' : '') + ' for Greenville and Spartanburg counties. Routes marked Verified were checked against Apple Maps. All other routes are computed from the map data, so confirm them against a live map before you rely on them. New streets that are not mapped yet are missing, including Hart Townes Way itself.</p>';
  }
