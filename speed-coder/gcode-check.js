// ============================================================
// SYNTAX CHECK ENGINE
// gcode-check.js — Haas G-code syntax corrector (pure JS, no DOM) plus the
// Haas alarm reference. Exposes window.GcodeCheck. The Syntax Check window in
// index.html is the only user of it.
// ============================================================
(function () {
function buildGroups(def) {
  const m = new Map();
  for (const k of Object.keys(def)) def[k].forEach(c => m.set(c, k));
  for (let c = 110; c <= 129; c++) m.set(c, 'wcs');
  m.set(154, 'wcs');
  return m;
}
const MILL_G = buildGroups({
  motion: [0, 1, 2, 3], plane: [17, 18, 19], dist: [90, 91], units: [20, 21],
  comp: [40, 41, 42], tlc: [43, 44, 49],
  cycle: [73, 74, 76, 77, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89],
  retract: [98, 99], wcs: [54, 55, 56, 57, 58, 59], feedm: [94, 95]
});
const LATHE_G = buildGroups({
  motion: [0, 1, 2, 3, 32, 90, 92, 94], plane: [17, 18, 19], units: [20, 21],
  comp: [40, 41, 42], css: [96, 97], feedm: [98, 99], wcs: [54, 55, 56, 57, 58, 59],
  cycle: [80, 81, 82, 83, 84, 85, 86, 87, 88, 89]
});
const MILL_CYCLES = [73, 74, 76, 77, 81, 82, 83, 84, 85, 86, 87, 88, 89];
const MILL_NM = [4, 9, 10, 28, 29, 31, 35, 36, 37, 47, 52, 53, 60, 65, 70, 71, 72, 92];
const LATHE_NM = [4, 9, 10, 28, 29, 31, 50, 52, 53, 65];
const LATHE_FEED_MOTION = [1, 2, 3, 32, 90, 92, 94];
const LATHE_CYCLES_NM = [70, 71, 72, 73, 74, 75, 76];

const pad2 = n => String(Math.trunc(n)).padStart(2, '0');
const trimNum = (n, d) => String(parseFloat(n.toFixed(d)));
/* value in program units -> "x in (y mm)" : inches first, metric in parentheses */
function dual(val, units) {
  const inch = units === 21 ? val / 25.4 : val;
  const mm = units === 21 ? val : val * 25.4;
  return trimNum(inch, 5) + ' in (' + trimNum(mm, 4) + ' mm)';
}

function parseBlock(raw, i) {
  const b = { i, raw, words: [], g: [], m: [], opaque: false, percent: false, empty: false,
    parenErr: null, leftover: '', commentOnly: false, mask: '' };
  const trimmed = raw.trim();
  if (trimmed === '') { b.empty = true; return b; }
  if (trimmed === '%') { b.percent = true; return b; }
  let mask = '', depth = 0, maxDepth = 0, unmatched = false;
  for (const ch of raw) {
    if (ch === '(') { depth++; maxDepth = Math.max(maxDepth, depth); mask += ' '; continue; }
    if (ch === ')') { if (depth === 0) unmatched = true; else depth--; mask += ' '; continue; }
    mask += depth > 0 ? ' ' : ch;
  }
  if (maxDepth > 1) b.parenErr = 'nested';
  else if (depth !== 0) b.parenErr = 'unbalanced';
  else if (unmatched) b.parenErr = 'unmatched';
  b.mask = mask.toUpperCase();
  b.commentOnly = b.mask.trim() === '';
  if (b.commentOnly) return b;
  if (/^\s*\/?\s*(?:N\d+\s*)?(?:#|IF\b|WHILE\b|GOTO\b|END\d|DO\d)/.test(b.mask) || b.mask.indexOf('=') !== -1) {
    b.opaque = true; return b;
  }
  const re = /([A-Z])\s*(\[[^\]]*\]|#\d+|[-+]?(?:\d+\.?\d*|\.\d+))/g;
  let m, rest = b.mask.split('');
  while ((m = re.exec(b.mask)) !== null) {
    const text = m[2], expr = text[0] === '[' || text[0] === '#';
    const w = { letter: m[1], text, expr, val: expr ? NaN : parseFloat(text),
      hasDot: !expr && text.indexOf('.') !== -1, start: m.index, end: m.index + m[0].length };
    b.words.push(w);
    for (let k = w.start; k < w.end; k++) rest[k] = ' ';
    if (w.letter === 'G' && !expr) b.g.push(w.val);
    if (w.letter === 'M' && !expr) b.m.push(w.val);
  }
  b.leftover = rest.join('').replace(/[\s\/*,]/g, '');
  return b;
}

function editLine(b, edits) {
  let s = b.raw;
  edits.slice().sort((a, c) => c.start - a.start).forEach(e => { s = s.slice(0, e.start) + e.text + s.slice(e.end); });
  return s;
}
function appendTo(b, txt) {
  const idx = b.raw.indexOf('(');
  if (idx === -1) return b.raw.replace(/\s+$/, '') + ' ' + txt;
  return b.raw.slice(0, idx).replace(/\s+$/, '') + ' ' + txt + ' ' + b.raw.slice(idx);
}
function prefixTo(b, txt) {
  const n = b.words.find(w => w.letter === 'N');
  if (n) return b.raw.slice(0, n.end) + ' ' + txt + b.raw.slice(n.end);
  const lead = b.raw.match(/^\s*\/?\s*/)[0].length;
  return b.raw.slice(0, lead) + txt + ' ' + b.raw.slice(lead);
}
function removeWords(b, ws) {
  let s = editLine(b, ws.map(w => ({ start: w.start, end: w.end, text: '' })));
  return s.replace(/[ \t]{2,}/g, ' ').replace(/^\s+(?=\S)/, m => m).replace(/\s+$/, '');
}

/* ----- fix operations ----- */
function applyOps(lines, ops) {
  const order = { insertAfter: 0, replace: 1, insertBefore: 2 };
  const sorted = ops.slice().sort((a, b) => b.at - a.at || order[a.op] - order[b.op]);
  const out = lines.map((t, k) => ({ t, changed: false, from: k }));
  for (const o of sorted) {
    if (o.op === 'replace') out[o.at] = { t: o.text, changed: true, from: out[o.at].from };
    else if (o.op === 'insertBefore') out.splice(o.at, 0, ...o.lines.map(t => ({ t, changed: true, from: null })));
    else if (o.op === 'insertAfter') out.splice(o.at + 1, 0, ...o.lines.map(t => ({ t, changed: true, from: null })));
  }
  return out;
}
function tokenDiff(x, y) {
  const A = x.split(/(\s+)/).filter(s => s !== ''), B = y.split(/(\s+)/).filter(s => s !== '');
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const sa = [], sb = []; let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { sa.push({ t: A[i], d: false }); sb.push({ t: B[j], d: false }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { sa.push({ t: A[i], d: !/^\s+$/.test(A[i]) }); i++; }
    else { sb.push({ t: B[j], d: !/^\s+$/.test(B[j]) }); j++; }
  }
  for (; i < A.length; i++) sa.push({ t: A[i], d: !/^\s+$/.test(A[i]) });
  for (; j < B.length; j++) sb.push({ t: B[j], d: !/^\s+$/.test(B[j]) });
  return { a: sa, b: sb };
}
function previewFix(lines, fix) {
  const ats = fix.ops.map(o => o.at);
  const lo = Math.max(0, Math.min(...ats) - 1), hi = Math.min(lines.length - 1, Math.max(...ats) + 1);
  const out = applyOps(lines, fix.ops);
  const delta = out.length - lines.length;
  const before = [], after = [];
  for (let k = lo; k <= hi; k++) before.push({ n: k + 1, t: lines[k], changed: false });
  for (let k = lo; k <= hi + delta; k++) if (out[k]) after.push({ n: k + 1, t: out[k].t, changed: out[k].changed, from: out[k].from });
  after.forEach(a => {
    if (!a.changed) return;
    const b = a.from !== null ? before.find(r => r.n === a.from + 1) : null;
    if (b) { const d = tokenDiff(b.t, a.t); b.segs = d.a; a.segs = d.b; }
    else a.segs = [{ t: a.t, d: true }];
  });
  return { before, after };
}

/* ----- G71/G72 contour monotonic check (Haas alarms 602, 603, 604) ----- */
function arcGeom(arc) {
  let cz, cr;
  if (arc.I !== null || arc.K !== null) { cz = arc.z0 + (arc.K || 0); cr = arc.r0 + (arc.I || 0); }
  else if (arc.R !== null) {
    const dx = arc.z1 - arc.z0, dy = arc.r1 - arc.r0, d = Math.hypot(dx, dy);
    if (d === 0) return null;
    const rad = Math.abs(arc.R);
    if (rad < d / 2 - 1e-9) return null;
    const h = Math.sqrt(Math.max(0, rad * rad - d * d / 4));
    const rn = [dy / d, -dx / d];
    const sgn = (arc.cw ? 1 : -1) * (arc.R > 0 ? 1 : -1);
    cz = arc.z0 + dx / 2 + rn[0] * h * sgn; cr = arc.r0 + dy / 2 + rn[1] * h * sgn;
  } else return null;
  return { cz, cr };
}
function arcHasExtreme(arc, extremes) {
  const g = arcGeom(arc); if (!g) return false;
  const TAU = Math.PI * 2, mod = v => ((v % TAU) + TAU) % TAU;
  const a0 = Math.atan2(arc.r0 - g.cr, arc.z0 - g.cz), a1 = Math.atan2(arc.r1 - g.cr, arc.z1 - g.cz);
  let sweep = arc.cw ? mod(a0 - a1) : mod(a1 - a0);
  if (sweep < 1e-9) sweep = TAU;
  const eps = 1e-6;
  return extremes.some(e => { const t = arc.cw ? mod(a0 - e) : mod(e - a0); return t > eps && t < sweep - eps; });
}
function contourViolations(blocks, a, b, sx, sz, cyc) {
  if (sx === null || sz === null) return null;
  let x = sx, z = sz, motion = 0;
  const verts = []; let typeII = null;
  const val = (bl, L) => { const w = bl.words.find(q => q.letter === L); return w && !w.expr ? w.val : null; };
  for (let k = a; k <= b; k++) {
    const bl = blocks[k];
    if (bl.empty || bl.percent || bl.commentOnly || bl.opaque) continue;
    const m = bl.g.filter(c => [0, 1, 2, 3].includes(c)).pop(); if (m !== undefined) motion = m;
    const X = val(bl, 'X'), U = val(bl, 'U'), Z = val(bl, 'Z'), W = val(bl, 'W');
    let nx = x, nz = z;
    if (X !== null) nx = X; else if (U !== null) nx = x + U;
    if (Z !== null) nz = Z; else if (W !== null) nz = z + W;
    if (typeII === null) typeII = (X !== null || U !== null) && (Z !== null || W !== null);
    if (nx === x && nz === z) continue;
    const arc = (motion === 2 || motion === 3) ? { z0: z, r0: x / 2, z1: nz, r1: nx / 2, I: val(bl, 'I'), K: val(bl, 'K'), R: val(bl, 'R'), cw: motion === 2 } : null;
    verts.push({ x: nx, z: nz, line: k, arc });
    x = nx; z = nz;
  }
  const out = [];
  if (verts.length < 2) return { out, typeII: !!typeII };
  const checkZ = !(cyc === 72 && typeII), checkX = !(cyc === 71 && typeII);
  const eps = 1e-4;
  [['x', checkX, 'E-MONO-X'], ['z', checkZ, 'E-MONO-Z']].forEach(([ax, on, id]) => {
    if (!on) return;
    let dir = 0;
    for (let k = 1; k < verts.length; k++) {
      const d = verts[k][ax] - verts[k - 1][ax];
      if (Math.abs(d) <= eps) continue;
      const s = d > 0 ? 1 : -1;
      if (dir === 0) dir = s;
      else if (s !== dir) { out.push({ id, line: verts[k].line, axis: ax.toUpperCase() }); break; }
    }
  });
  verts.forEach(v => {
    if (!v.arc) return;
    const ex = [];
    if (checkZ) ex.push(0, Math.PI);
    if (checkX) ex.push(Math.PI / 2, 3 * Math.PI / 2);
    if (ex.length && arcHasExtreme(v.arc, ex)) out.push({ id: 'E-MONO-ARC', line: v.line });
  });
  return { out, typeII: !!typeII };
}

/* ----- main analysis ----- */
function analyze(text, opts) {
  const o = Object.assign({ machine: 'mill', maxRpm: 8100 }, opts || {});
  const lathe = o.machine === 'lathe';
  const GR = lathe ? LATHE_G : MILL_G;
  const NM = lathe ? LATHE_NM : MILL_NM;
  const lines = text.split(/\r?\n/);
  const blocks = lines.map((r, i) => parseBlock(r, i));
  const issues = [], seen = new Set();
  const add = (i, sev, id, title, msg, fix, hint) => {
    const k = i + '|' + id; if (seen.has(k)) return; seen.add(k);
    if (fix) fix.preview = previewFix(lines, fix);
    issues.push({ line: i + 1, idx: i, sev, id, title, msg, fix: fix || null, hint: hint || '' });
  };
  const R = (i, txt, auto, label) => ({ auto, label: label || 'Edit line', ops: [{ op: 'replace', at: i, text: txt }] });
  const IB = (i, ls, auto, label) => ({ auto, label: label || 'Insert line', ops: [{ op: 'insertBefore', at: i, lines: [].concat(ls) }] });
  const IA = (i, ls, auto, label) => ({ auto, label: label || 'Insert line', ops: [{ op: 'insertAfter', at: i, lines: [].concat(ls) }] });

  /* pre-pass */
  const nMap = new Map(), oNums = new Set();
  let firstIdx = -1, lastIdx = -1;
  blocks.forEach(b => {
    if (b.empty) return;
    if (firstIdx < 0) firstIdx = b.i;
    lastIdx = b.i;
    b.words.forEach(w => {
      if (w.letter === 'N' && !w.expr && !nMap.has(w.val)) nMap.set(w.val, b.i);
      if (w.letter === 'O' && !w.expr) oNums.add(w.val);
    });
  });

  const st = {
    units: null, abs: true, plane: lathe ? 18 : 17, motion: null, comp: 40,
    tlc: 49, needTLC: false, tlcReported: false, cycle: 80, wcs: null,
    spindle: 0, s: null, f: null, fMode: lathe ? 99 : 94, fModeExplicit: false,
    tool: null, pendingTool: null, css: 97, g50: null,
    x: null, y: null, z: null, retracted: false, seenMotion: false, seenToolChange: false,
    seenG: new Set(), firstMotionDone: false, ended: false, endReported: false,
    lastContour: null, hasEnd: false, endIdx: -1, cycleActiveLine: -1
  };
  const U = () => st.units || 20;

  for (const b of blocks) {
    if (b.empty || b.percent) continue;
    const i = b.i;
    if (b.parenErr) {
      const msgs = {
        nested: 'Nested parentheses in a comment. Haas does not allow a ( ) comment inside another ( ).',
        unbalanced: 'A comment is opened with ( but never closed with ).',
        unmatched: 'A closing ) appears with no matching (.'
      };
      let fx = null;
      if (b.parenErr === 'unbalanced') fx = R(i, b.raw.replace(/\s+$/, '') + ')', true, 'Close the comment');
      add(i, 'error', 'E-SYN-01', 'Comment parentheses are broken', msgs[b.parenErr], fx,
        'Remove the inner or stray parenthesis.');
    }
    if (b.commentOnly || b.opaque) continue;

    /* after-end code */
    if (st.ended) {
      if (b.words.some(w => w.letter === 'O')) { st.ended = false; st.endReported = false; }
      else if (!st.endReported) {
        st.endReported = true;
        add(i, 'warning', 'W-END-02', 'Code after program end',
          'This block follows M30/M02 and will never run in the main program (a new O-number starts a subprogram).', null,
          'Delete it, or start a new program with its own O number.');
      }
    }
    const has = L => b.words.find(w => w.letter === L);
    const wv = L => { const w = has(L); return w ? w.val : null; };
    const g = b.g, m = b.m;
    const gHas = n => g.includes(n);

    /* --- syntax --- */
    if (b.leftover) {
      const typo = b.words.find(w => w.letter === 'O' && w.start > 0 && /[A-Z]/.test(b.mask[w.start - 1]));
      let fx = null;
      if (typo) {
        fx = R(i, b.raw.slice(0, typo.start) + '0' + b.raw.slice(typo.start + 1), true, 'Replace letter O with zero');
      }
      add(i, 'error', 'E-SYN-02', 'Letter without a number',
        'Found "' + b.leftover + '" with no value after it. ' + (typo ? 'The letter O was likely typed instead of the digit 0 (for example G O1 instead of G01).' : 'Every address letter needs a number.'),
        fx, 'Add the missing number or remove the stray letter.');
    }
    const cnt = {};
    b.words.forEach(w => { if (w.letter !== 'G' && w.letter !== 'M') cnt[w.letter] = (cnt[w.letter] || 0) + 1; });
    const dups = Object.keys(cnt).filter(k => cnt[k] > 1);
    if (dups.length) add(i, 'error', 'E-SYN-03', 'Repeated address word',
      dups.join(', ') + ' appears more than once in this block. Haas rejects or ignores one of them.', null,
      'Keep a single ' + dups[0] + ' word per block.');
    const grp = {};
    g.forEach(c => { const k = GR.get(c); if (k) { (grp[k] = grp[k] || new Set()).add(c); } });
    Object.keys(grp).forEach(k => {
      if (grp[k].size > 1) add(i, 'error', 'E-SYN-04', 'Conflicting G codes',
        'G' + [...grp[k]].map(pad2).join(' and G') + ' are in the same modal group (' + k + '). Only one can be active per block.', null,
        'Split them into two blocks or keep only the one you need.');
    });
    if (m.length > 1) {
      const mw = b.words.filter(w => w.letter === 'M');
      const keep = mw[0];
      const extra = mw.slice(1);
      const first = removeWords(b, extra);
      const fx = { auto: true, label: 'Split M codes into separate lines', ops: [{ op: 'replace', at: i, text: first },
        { op: 'insertAfter', at: i, lines: extra.map(w => 'M' + pad2(w.val)) }] };
      add(i, 'error', 'E-SYN-05', 'More than one M code in a block',
        'Haas allows only one M code per block (' + mw.map(w => 'M' + pad2(w.val)).join(', ') + ' found).', fx);
    }

    /* --- numbers --- */
    const axisLetters = lathe ? ['X', 'Z', 'U', 'W', 'I', 'K'] : ['X', 'Y', 'Z', 'I', 'J', 'K'];
    const isArcBlock = gHas(2) || gHas(3);
    const cycNow = !lathe ? g.filter(c => MILL_CYCLES.includes(c)).pop() : null;
    const decimalLetters = axisLetters.slice();
    if (isArcBlock) decimalLetters.push('R');
    if (!lathe) { ['A', 'B', 'C'].forEach(l => decimalLetters.push(l)); if (cycNow || st.cycle !== 80) decimalLetters.push('Q'); }
    const noDot = b.words.filter(w => !w.expr && !w.hasDot && /^[-+]?\d+$/.test(w.text) && w.val !== 0 && decimalLetters.includes(w.letter));
    if (noDot.length) {
      const w0 = noDot[0];
      const rot = ['A', 'B', 'C'].includes(w0.letter);
      const small = rot ? w0.val * 0.001 : w0.val * (U() === 21 ? 0.001 : 0.0001);
      const msg = noDot.map(w => w.letter + w.text).join(', ') + (noDot.length > 1 ? ' have' : ' has') +
        ' no decimal point. Haas reads ' + w0.letter + w0.text + ' as ' + (rot ? trimNum(small, 4) + ' deg' : dual(small, U())) +
        ', not ' + (rot ? w0.val + ' deg' : dual(w0.val, U())) + '.';
      const fx = R(i, editLine(b, noDot.map(w => ({ start: w.end, end: w.end, text: '.' }))), true, 'Add decimal points');
      add(i, 'warning', 'W-NUM-01', 'Missing decimal point', msg, fx);
    }
    const prec = U() === 21 ? 3 : 4;
    const longDec = b.words.filter(w => !w.expr && w.hasDot && 'XYZIJKRUW'.includes(w.letter) && (w.text.split('.')[1] || '').length > prec);
    if (longDec.length) {
      const fx = R(i, editLine(b, longDec.map(w => ({ start: w.start, end: w.end,
        text: w.letter + trimNum(w.val, prec) }))), true, 'Round to control resolution');
      add(i, 'info', 'I-NUM-02', 'More decimals than the control uses',
        longDec.map(w => w.letter + w.text).join(', ') + ' has more than ' + prec + ' decimal places. Haas resolution is ' +
        dual(U() === 21 ? 0.001 : 0.0001, U()) + ', so the extra digits are rounded.', fx);
    }
    if (U() !== 21 && !gHas(10)) {
      const limit = lathe ? 80 : 150;
      const big = b.words.find(w => !w.expr && 'XYZUWIJKR'.includes(w.letter) && Math.abs(w.val) > limit && !gHas(53));
      if (big) add(i, 'warning', 'W-UNI-02', 'Value looks like millimetres in inch mode',
        big.letter + big.text + ' is ' + dual(big.val, 20) + ' while G20 (inch) is active, beyond normal machine travel.', null,
        'If this program is metric, put G21 before the first move; otherwise divide the value by 25.4.');
    }

    /* --- units / modal state (pre-motion) --- */
    ['G20', 'G21'].forEach(() => { });
    if (gHas(20) || gHas(21)) {
      const nu = gHas(21) ? 21 : 20;
      if (st.units !== null && st.units !== nu && st.seenMotion)
        add(i, 'warning', 'W-UNI-03', 'Units changed mid-program',
          'Switching to G' + nu + ' after motion has started. Existing offsets and feeds keep their old units.', null,
          'Set G20 or G21 once, at the top of the program.');
      st.units = nu;
    }
    if (!lathe) {
      if (gHas(90)) st.abs = true;
      if (gHas(91)) st.abs = false;
      if (gHas(17)) st.plane = 17; if (gHas(18)) st.plane = 18; if (gHas(19)) st.plane = 19;
    } else {
      if (gHas(17)) st.plane = 17; if (gHas(18)) st.plane = 18; if (gHas(19)) st.plane = 19;
    }
    g.forEach(c => st.seenG.add(c));
    if (g.some(c => GR.get(c) === 'wcs')) st.wcs = g.find(c => GR.get(c) === 'wcs');
    if (gHas(98) || gHas(99)) {
      if (lathe) { st.fMode = gHas(98) ? 98 : 99; st.fModeExplicit = true; }
    }
    if (lathe) {
      if (gHas(96)) st.css = 96;
      if (gHas(97)) st.css = 97;
      if (gHas(96) && st.g50 === null) {
        add(i, 'error', 'E-CSS-01', 'G96 without a G50 speed clamp',
          'Constant surface speed raises RPM as the diameter shrinks. Without G50 S the spindle can climb toward the machine maximum near the centerline.',
          IB(i, 'G50 S' + o.maxRpm, true, 'Add G50 clamp from your Max RPM setting'));
      }
    }
    const isG50 = lathe && gHas(50) && has('S');
    if (isG50) st.g50 = wv('S');

    /* --- spindle speed value --- */
    const sw = has('S');
    if (sw && !sw.expr) {
      const rpmMode = !lathe || st.css !== 96 || isG50;
      if (rpmMode && sw.val > o.maxRpm) {
        add(i, 'warning', 'W-SPN-03', 'Spindle speed above your limit',
          'S' + sw.text + ' exceeds the Max RPM you set (' + o.maxRpm + ' rpm).',
          R(i, editLine(b, [{ start: sw.start, end: sw.end, text: 'S' + o.maxRpm }]), true, 'Limit S to ' + o.maxRpm));
      }
    }

    /* --- program-start safety (first motion) --- */
    const nonModalBlock = g.some(c => NM.includes(c));
    const motNew = g.filter(c => (lathe ? LATHE_FEED_MOTION.concat([0]) : [0, 1, 2, 3]).includes(c)).pop();
    const nmCycle = lathe ? g.filter(c => LATHE_CYCLES_NM.includes(c)).pop() : null;
    const lcycNew = lathe ? g.filter(c => [81, 82, 83, 84, 85, 86, 87, 88, 89].includes(c)).pop() : null;
    const axisWords = b.words.filter(w => (lathe ? 'XZUW' : 'XYZ').includes(w.letter));
    const hasMotionIntent = !nonModalBlock && (motNew !== undefined || cycNow || lcycNew || nmCycle || (axisWords.length && (st.motion !== null || st.cycle !== 80)));

    if (motNew !== undefined) { st.motion = motNew; if (!lathe && st.cycle !== 80 && !cycNow) st.cycle = 80; }
    if (!lathe && gHas(80)) st.cycle = 80;
    if (lathe && gHas(80)) st.cycle = 80;
    const cycNew = lathe ? lcycNew : cycNow;
    const cycleStart = cycNew !== undefined && cycNew !== null && cycNew !== st.cycle;
    if (cycNew) { st.cycle = cycNew; st.motion = null; st.cycleActiveLine = i; }

    const isCycleExec = st.cycle !== 80 && !nonModalBlock && (axisWords.length > 0 || cycNew);
    const execMotion = !isCycleExec && !nonModalBlock && axisWords.length > 0 ? st.motion : null;
    const feedMotion = !nonModalBlock && (
      (lathe ? LATHE_FEED_MOTION : [1, 2, 3]).includes(execMotion) || isCycleExec || !!nmCycle);
    const rapidMotion = !nonModalBlock && execMotion === 0;

    if (hasMotionIntent && !st.firstMotionDone && (axisWords.length || cycNew || nmCycle)) {
      st.firstMotionDone = true;
      if (st.units === null) {
        add(i, 'warning', 'W-UNI-01', 'No G20/G21 before the first move',
          'Without G20 (inch) or G21 (metric) the control uses whatever dimensioning mode was last active (Setting 9), so the same numbers can mean inches or millimetres.',
          IB(i, 'G20', true, 'Add G20 (inch)'));
      }
      if (!lathe && st.wcs === null) {
        add(i, 'error', 'E-WCS-01', 'No work offset selected',
          'The first move runs with no G54-G59 (or G110-G129) in the program. The control uses the last active offset, which may be the wrong part zero.',
          R(i, prefixTo(b, 'G54'), true, 'Add G54 to this block'));
      }
      const need = lathe ? [40, 80, 97, 99] : [90, 17, 40, 80].concat(st.seenToolChange ? [] : [49]);
      const missing = need.filter(c => !st.seenG.has(c));
      if (missing.length) {
        add(i, 'info', 'I-SAFE-01', 'No safe start line',
          'Before the first move, consider cancelling leftover modal states: ' + missing.map(c => 'G' + pad2(c)).join(' ') + ' not set earlier in the program.',
          IB(i, missing.map(c => 'G' + pad2(c)).join(' '), true, 'Insert safe start line'));
      }
    }

    /* --- MILL specific --- */
    if (!lathe) {
      /* G28 absolute */
      if (gHas(28) && st.abs && axisWords.length && !gHas(91)) {
        const axes = axisWords.map(w => w.letter + '0.').join(' ');
        add(i, 'warning', 'W-G28-01', 'G28 in absolute mode',
          'In G90 the machine first moves to the listed point, then to home. G28 Z0 would plunge to work Z0 before returning.',
          { auto: true, label: 'Use G91 G28 and restore G90', ops: [{ op: 'replace', at: i, text: 'G91 G28 ' + axes }, { op: 'insertAfter', at: i, lines: ['G90'] }] });
      }
      if (gHas(28) || (gHas(53) && has('Z'))) { st.retracted = true; st.z = null; }
      else if (axisWords.length && !nonModalBlock) st.retracted = false;

      /* tool length comp */
      if (gHas(43) || gHas(44)) {
        const hw = has('H');
        if (!hw) {
          const fx = st.tool !== null ? R(i, appendTo(b, 'H' + pad2(st.tool)), true, 'Add H' + pad2(st.tool)) : null;
          add(i, 'error', 'E-TLC-01', 'G43 without an H offset',
            'G43 needs an H word that selects the tool length offset.', fx, 'Add H with the offset number, usually the same as the tool number.');
        } else if (hw.val === 0) {
          add(i, 'warning', 'W-TLC-06', 'G43 H00 cancels length comp', 'H00 turns tool length compensation off, which is the same as G49.', null,
            'Use the real offset number, or write G49 if you meant to cancel.');
        } else if (st.tool !== null && hw.val !== st.tool) {
          add(i, 'warning', 'W-TLC-02', 'H number does not match the tool',
            'H' + hw.text + ' is used with T' + st.tool + '. Haas does not link H to T on its own, so this reads a different length offset unless intended. With Setting 15 (H & T code agreement) on, the control can raise alarm 332.',
            R(i, editLine(b, [{ start: hw.start, end: hw.end, text: 'H' + pad2(st.tool) }]), true, 'Change H to ' + pad2(st.tool)));
        }
        if (!has('Z')) add(i, 'info', 'I-TLC-03', 'G43 without a Z move',
          'Length compensation takes effect on the next Z move. Putting Z in the same block (G43 H01 Z0.1) applies it right away.', null,
          'Add the clearance Z to this block.');
        st.tlc = 43; st.needTLC = false; st.tlcReported = false;
      }
      if (gHas(49)) st.tlc = 49;

      /* Z target without G43 */
      const zMove = !nonModalBlock && (has('Z') && (st.motion !== null || st.cycle !== 80 || cycNew) || isCycleExec && st.cycle !== 80);
      if (zMove && !gHas(43) && !gHas(44) && (st.tlc !== 43 || st.needTLC) && !st.tlcReported) {
        st.tlcReported = true;
        const fx = st.tool !== null ? R(i, prefixTo(b, 'G43 H' + pad2(st.tool)), true, 'Add G43 H' + pad2(st.tool) + ' to this block') : null;
        add(i, 'error', 'E-TLC-04', st.needTLC ? 'No G43 after tool change' : 'Z move without tool length comp',
          (st.needTLC ? 'A tool change happened but G43 H was not issued again. ' : 'No G43 is active. ') +
          'Z values are measured from the spindle gauge line instead of the tool tip, which risks a crash.', fx,
          'Add G43 H## (matching the tool) before this Z move.');
      }

      /* cutter comp */
      if (gHas(41) || gHas(42)) {
        const code = gHas(41) ? 41 : 42;
        if (!has('D')) add(i, 'error', 'E-CC-01', 'Cutter comp without a D offset',
          'G' + code + ' needs a D word that selects the cutter radius/wear offset.',
          st.tool !== null ? R(i, appendTo(b, 'D' + pad2(st.tool)), false, 'Add D' + pad2(st.tool)) : null,
          'Add D with the offset number, usually the tool number.');
        if (isArcBlock || (st.motion >= 2 && st.motion <= 3 && motNew === undefined))
          add(i, 'error', 'E-CC-02', 'Cutter comp started on an arc',
            'G' + code + ' must be turned on during a straight G00 or G01 move, not on G02/G03.', null, 'Add a short linear lead-in move and start comp there.');
        if (!has('X') && !has('Y'))
          add(i, 'warning', 'W-CC-03', 'Cutter comp with no XY move',
            'G' + code + ' needs an X or Y move in the same block to engage.', null, 'Add the lead-in X/Y target to this block.');
        if (st.comp !== 40 && st.comp !== code)
          add(i, 'warning', 'W-CC-04', 'Comp side changed without G40',
            'Switching straight from G' + st.comp + ' to G' + code + ' can produce a gouge.', IB(i, 'G40', true, 'Cancel comp first'));
        st.comp = code;
      }
      if (gHas(40)) {
        if (isArcBlock) add(i, 'error', 'E-CC-05', 'Cutter comp cancelled on an arc',
          'G40 must be cancelled during a straight G00 or G01 move.', null, 'Cancel comp on a linear move after the arc.');
        st.comp = 40;
      }

      /* arcs */
      if (isArcBlock && !nonModalBlock && (has('X') || has('Y') || has('Z') || has('I') || has('J') || has('K') || has('R'))) {
        const hasR = !!has('R'), I = has('I'), J = has('J'), K = has('K');
        const need = st.plane === 17 ? [I, J] : st.plane === 18 ? [I, K] : [J, K];
        const hasOff = !!(I || J || K);
        if (!hasR && !hasOff) add(i, 'error', 'E-ARC-01', 'Arc has no center or radius',
          'G02/G03 needs either I/J/K (center offsets) or R (radius).', null,
          'Add ' + (st.plane === 17 ? 'I and J' : st.plane === 18 ? 'I and K' : 'J and K') + ', or an R value.');
        if (hasR && hasOff) add(i, 'error', 'E-ARC-02', 'Arc uses both R and I/J/K',
          'Use R or I/J/K, not both. Haas alarms when both are given.',
          R(i, removeWords(b, ['R'].map(() => has('R'))), false, 'Remove R and keep I/J/K'), 'Keep only one form.');
        const bad = st.plane === 17 ? K : st.plane === 18 ? J : I;
        if (bad) add(i, 'error', 'E-ARC-03', 'Wrong arc offset for the active plane',
          bad.letter + ' is not used in the G' + st.plane + ' plane.', null,
          'Use ' + (st.plane === 17 ? 'I and J' : st.plane === 18 ? 'I and K' : 'J and K') + ' with G' + st.plane + '.');
        if (hasR && st.plane === 17 && !has('X') && !has('Y'))
          add(i, 'error', 'E-ARC-04', 'Full circle with R',
            'A circle that ends where it starts cannot be defined with R. Use I/J instead.', null, 'Replace R with I and J.');
        if (!hasR && st.plane === 17 && st.x !== null && st.y !== null && st.abs) {
          const ex = has('X') ? has('X').val : st.x, ey = has('Y') ? has('Y').val : st.y;
          const iv = I ? I.val : 0, jv = J ? J.val : 0;
          if ([ex, ey, iv, jv].every(Number.isFinite)) {
            const cx = st.x + iv, cy = st.y + jv;
            const r1 = Math.hypot(iv, jv), r2 = Math.hypot(ex - cx, ey - cy);
            const tol = U() === 21 ? 0.013 : 0.0005;
            if (Math.abs(r1 - r2) > tol && r1 > 0) {
              const k = r1 / r2, px = cx + (ex - cx) * k, py = cy + (ey - cy) * k;
              const dp = U() === 21 ? 3 : 4;
              const edits = [];
              if (has('X')) edits.push({ start: has('X').start, end: has('X').end, text: 'X' + trimNum(px, dp) });
              if (has('Y')) edits.push({ start: has('Y').start, end: has('Y').end, text: 'Y' + trimNum(py, dp) });
              add(i, 'warning', 'W-ARC-05', 'Arc start and end are on different radii',
                'Radius from the start point is ' + dual(r1, U()) + ' but the end point is ' + dual(r2, U()) + ' from the center. Haas may alarm or cut a spiral.',
                edits.length ? R(i, editLine(b, edits), false, 'Project the end point onto the arc') : null,
                'Check the I/J values or the end point.');
            }
          }
        }
      }

      /* canned cycles */
      if (cycNew) {
        const z = has('Z'), r = has('R'), q = has('Q');
        if (cycleStart && !z) add(i, 'error', 'E-CAN-01', 'Canned cycle without Z depth',
          'G' + pad2(cycNew) + ' needs a Z depth on the block that starts the cycle.',
          R(i, appendTo(b, 'Z-0.5'), false, 'Add a Z depth (example value)'), 'Add the hole bottom as Z, for example Z-0.5.');
        if ((cycNew === 73 || cycNew === 83) && !q && !has('I'))
          add(i, 'info', 'I-CAN-02', 'Peck cycle without Q',
            'G' + cycNew + ' has no Q peck depth, so Haas falls back to a control setting (Setting 22 on most controls).',
            R(i, appendTo(b, 'Q0.125'), false, 'Add Q (example value)'), 'Set Q so the peck depth is intentional.');
        if (z && r && st.abs && Number.isFinite(z.val) && Number.isFinite(r.val) && r.val <= z.val)
          add(i, 'warning', 'W-CAN-03', 'R plane at or below hole bottom',
            'R' + r.text + ' is not above Z' + z.text + ' in absolute mode, so the cycle has no clearance to feed down.', null,
            'Make R a small positive distance above the part, for example R0.1.');
        if ((cycNew === 84 || cycNew === 74) && st.s && (has('F') || st.f)) {
          const F = has('F') ? has('F').val : st.f;
          if (Number.isFinite(F) && F > 0) {
            const tpi = st.s / F;
            add(i, 'info', 'I-CAN-04', 'Tapping feed check',
              'F' + F + ' at S' + st.s + ' gives ' + trimNum(F / st.s, 5) + ' in/rev (' + trimNum(F / st.s * 25.4, 4) + ' mm/rev), about ' + trimNum(tpi, 2) + ' threads per inch. Confirm that matches the tap.', null,
              'Tapping feed = spindle RPM divided by threads per inch.');
          }
        }
      }
      if (!nonModalBlock && (cycNew || (isCycleExec && axisWords.length))) st.z = null;
    }

    /* --- LATHE specific --- */
    if (lathe) {
      if (gHas(43) || gHas(44) || gHas(49))
        add(i, 'warning', 'W-LCODE-01', 'Mill code on a lathe',
          'G43/G44/G49 (tool length comp) are not used on a Haas lathe. Tool offsets come from the T word (Txxyy).', null,
          'Remove it and call the offset with T, for example T0101.');
      if (gHas(90) && !axisWords.length && !has('F') && !has('I')) {
        const gw = b.words.find(w => w.letter === 'G' && w.val === 90);
        add(i, 'warning', 'W-LG90-01', 'G90 is a turning cycle on a Haas lathe',
          'On a Haas lathe G90 is the O.D./I.D. turning cycle, not absolute mode. X/Z are absolute by default and U/W are incremental.',
          R(i, removeWords(b, [gw]), true, 'Remove G90'), 'Use U and W for incremental moves.');
      }
      if (gHas(91)) add(i, 'info', 'I-LG91-01', 'G91 is not a standard Haas lathe code',
        'Incremental moves on a Haas lathe use U and W instead of G91.', null, 'Replace X/Z with U/W for incremental moves.');
      if (m.includes(6) || m.includes(16)) add(i, 'info', 'I-LM06-01', 'M06 is not used on a Haas lathe',
        'The turret changes tools from the T word (Txxyy) alone.', null, 'Remove M06 and keep the T code.');

      /* tool change */
      const tw = has('T');
      if (tw && !tw.expr) {
        const digits = tw.text.replace(/\D/g, '').length;
        const tool = digits >= 3 ? Math.floor(tw.val / 100) : tw.val;
        if (digits < 3) add(i, 'warning', 'W-LTL-01', 'Lathe tool call is not Txxyy',
          'Haas lathes expect tool and offset together as Txxyy (T0101 = tool 1, offset 1). T' + tw.text + ' may select the wrong offset.',
          R(i, editLine(b, [{ start: tw.start, end: tw.end, text: 'T' + pad2(tw.val) + pad2(tw.val) }]), false, 'Use T' + pad2(tw.val) + pad2(tw.val)),
          'Use the four-digit form.');
        if (st.seenMotion && !st.retracted && st.tool !== null && tool !== st.tool)
          add(i, 'warning', 'W-LTC-01', 'Turret indexes without a retract',
            'The previous tool was cutting near the part when this T call indexes the turret. A long tool can hit the chuck, part or tailstock.',
            IB(i, ['G53 G00 X0.', 'G53 G00 Z0.'], false, 'Retract to machine home first'),
            'Move X and then Z to a safe tool-change position before the T call.');
        if (st.comp !== 40) add(i, 'warning', 'W-LTC-02', 'Nose comp active at tool change',
          'G' + st.comp + ' is still active when the turret changes tools.', IB(i, 'G40', true, 'Cancel comp first'));
        if (st.tool !== tool) st.tool = tool;
      }
      if (gHas(28) || gHas(53)) st.retracted = true;
      else if (axisWords.length && !nonModalBlock) st.retracted = false;

      /* comp on arc */
      if (gHas(41) || gHas(42)) {
        if (isArcBlock) add(i, 'error', 'E-CC-02', 'Nose comp started on an arc',
          'G41/G42 must start on a straight G00/G01 move.', null, 'Add a short linear approach move.');
        st.comp = gHas(41) ? 41 : 42;
      }
      if (gHas(40)) st.comp = 40;

      /* arcs */
      if (isArcBlock) {
        const hasR = !!has('R'), hasOff = !!(has('I') || has('K'));
        if (!hasR && !hasOff) add(i, 'error', 'E-ARC-01', 'Arc has no center or radius',
          'G02/G03 needs I and K (center offsets) or an R radius.', null, 'Add I/K or R.');
        if (hasR && hasOff) add(i, 'error', 'E-ARC-02', 'Arc uses both R and I/K',
          'Use R or I/K, not both.', null, 'Keep only one form.');
      }

      /* threading */
      const thread = execMotion === 32 || execMotion === 92 || nmCycle === 76;
      if (thread) {
        if (st.css === 96) add(i, 'error', 'E-THR-01', 'Threading in constant surface speed',
          'Thread passes must stay in sync with a fixed spindle speed. G96 changes RPM during the cut and ruins the lead.',
          IB(i, 'G97 S800', false, 'Switch to G97 and set an RPM (example)'),
          'Use G97 and give a fixed RPM before the thread.');
        if (st.fMode === 98) add(i, 'error', 'E-THR-02', 'Threading in feed per minute',
          'Thread lead is entered as F in inches per revolution (' + 'mm/rev' + ' in metric), so G98 gives the wrong lead.',
          IB(i, 'G99', true, 'Insert G99'));
      }

      /* feed units sanity */
      const fw = has('F');
      if (fw && !fw.expr && (feedMotion || execMotion !== null)) {
        if (st.fMode === 98 && st.fModeExplicit && fw.val < 1)
          add(i, 'warning', 'W-FED-03', 'Tiny feed in feed per minute',
            'F' + fw.text + ' in G98 is ' + dual(fw.val, U()) + ' per minute. That looks like an inches-per-rev value.', null,
            'Use G99 for feed per revolution, or raise F.');
        if (st.fMode === 99 && fw.val >= 1)
          add(i, 'warning', 'W-FED-04', 'Very large feed per revolution',
            'F' + fw.text + ' in G99 means ' + dual(fw.val, U()) + ' per spindle turn. Check for a missing decimal point, for example F.01.', null,
            'Typical turning feeds are small fractions such as F.005 to F.02.');
      }

      /* contour labels */
      if ([70, 71, 72, 73].includes(nmCycle) && has('P') && has('Q')) {
        const p = has('P').val, q = has('Q').val;
        if (!nMap.has(p) || !nMap.has(q))
          add(i, 'error', 'E-CYC-01', 'Contour block not found',
            'G' + nmCycle + ' points to N' + p + ' to N' + q + ' but ' + [!nMap.has(p) ? 'N' + p : '', !nMap.has(q) ? 'N' + q : ''].filter(Boolean).join(' and ') + ' is not in this program.', null,
            'Add the contour blocks with matching N numbers, or fix P and Q.');
        else {
          if (nMap.get(p) >= nMap.get(q)) add(i, 'error', 'E-CYC-01', 'Contour start is after its end',
            'N' + p + ' appears after N' + q + ', so the finishing path is backwards.', null, 'Swap P and Q or reorder the blocks.');
          if (nmCycle !== 70 && nMap.get(p) <= i) add(i, 'warning', 'W-CYC-02', 'Contour is before the roughing call',
            'N' + p + ' is above this G' + nmCycle + ' block. The contour should follow the call.', null, 'Move the contour blocks below the cycle.');
          if (nmCycle === 70 && st.lastContour && (st.lastContour.p !== p || st.lastContour.q !== q))
            add(i, 'warning', 'W-CYC-03', 'G70 uses a different contour than the roughing cycle',
              'G70 P' + p + ' Q' + q + ' does not match the last roughing cycle (P' + st.lastContour.p + ' Q' + st.lastContour.q + ').', null,
              'Use the same P and Q as the roughing cycle.');
          if (nmCycle !== 70) st.lastContour = { p, q };
          if ((nmCycle === 71 || nmCycle === 72) && nMap.get(p) > i) {
            const cv = contourViolations(blocks, nMap.get(p), nMap.get(q), st.x, st.z, nmCycle);
            if (cv) cv.out.forEach(v => {
              const ax = v.axis;
              const msg = v.id === 'E-MONO-ARC'
                ? 'This arc turns back on itself inside the G' + nmCycle + ' P to Q blocks (it passes through a quadrant extreme), so the contour is not monotonic. Haas alarm 604 NON-MONOTONOUS ARC IN PQ BLOCK.'
                : 'The contour between P' + p + ' and Q' + q + ' reverses direction in ' + ax + ' at this block. A G' + nmCycle + ' roughing contour (' + (cv.typeII ? 'Type II' : 'Type I') + ') must move one way only in ' + ax + '. Haas alarm ' + (ax === 'X' ? '602 NON-MONOTONOUS PQ BLOCKS IN X' : '603 NON-MONOTONOUS PQ BLOCKS IN Z') + '.';
              add(v.line, 'error', v.id, v.id === 'E-MONO-ARC' ? 'Non-monotonous arc in PQ block' : 'Non-monotonous PQ blocks in ' + ax, msg, null,
                v.id === 'E-MONO-ARC' ? 'Split the arc at its extreme point so each piece moves one way, or finish the pocket with a separate cycle.' : 'Reorder the contour so ' + ax + ' only increases or only decreases, or use a Type II first block (both X and Z) where the control allows pockets.');
            });
          }
        }
      }
    }

    /* --- feed / spindle checks (both machines) --- */
    const fWord = has('F');
    const needsF = feedMotion && !nmCycle && !(lathe && !LATHE_FEED_MOTION.includes(execMotion) && !isCycleExec);
    if (needsF && st.f === null && !fWord) {
      const ex = lathe ? (st.fMode === 98 ? 'F10.' : 'F.005') : (U() === 21 ? 'F250.' : 'F10.');
      add(i, 'error', 'E-FED-01', 'Feed move without a feed rate',
        'No F has been set before this cutting move, so Haas will alarm or move at the wrong rate.',
        R(i, appendTo(b, ex), false, 'Add a feed (example value)'), 'Add F with your cutting feed.');
    }
    if (fWord && fWord.val === 0 && feedMotion) add(i, 'error', 'E-FED-02', 'Feed rate is zero', 'F0 cannot be used for a cutting move.', null, 'Set a real feed rate.');
    if (feedMotion && st.spindle === 0 && !(lathe && false)) {
      const ex = st.s !== null ? 'M03' : 'S' + Math.min(3000, o.maxRpm) + ' M03';
      add(i, 'error', 'E-SPN-01', 'Cutting move with the spindle off',
        'No M03/M04 is active when this feed move runs (M codes in a block run after the move, and M06 stops the spindle).',
        IB(i, ex, st.s !== null, st.s !== null ? 'Start spindle with M03' : 'Start spindle (example speed)'),
        'Start the spindle before the first cutting move.');
    }
    if (hasMotionIntent && (rapidMotion || feedMotion || cycNew)) st.seenMotion = true;

    /* rapid XY while Z is in the cut (mill) */
    if (!lathe && rapidMotion && st.abs && st.z !== null && st.z < 0 && !gHas(53) && (has('X') || has('Y'))) {
      const zw = has('Z');
      if (!zw || (Number.isFinite(zw.val) && zw.val < 0)) {
        const ex = U() === 21 ? 'G00 Z2.' : 'G00 Z0.1';
        add(i, 'warning', 'W-RAP-01', 'Rapid XY move while Z is below zero',
          'Z is at ' + dual(st.z, U()) + ' when this G00 moves X/Y, so the tool may drag through the part or a clamp.',
          IB(i, ex, false, 'Retract Z first (example clearance)'), 'Retract Z above the part before positioning.');
      }
    }

    /* --- position tracking (mill) --- */
    if (!lathe && !nonModalBlock && (rapidMotion || feedMotion) && !isCycleExec) {
      ['X', 'Y', 'Z'].forEach(a => {
        const w = has(a); if (!w) return;
        const key = a.toLowerCase();
        if (w.expr || !Number.isFinite(w.val)) { st[key] = null; return; }
        if (st.abs) st[key] = w.val; else if (st[key] !== null) st[key] += w.val;
      });
    }
    if (!lathe && gHas(92)) { st.x = st.y = st.z = null; }
    if (lathe && !nonModalBlock && !nmCycle && axisWords.length && (execMotion !== null || motNew !== undefined)) {
      const tv = (L, I) => { const w = has(L); return w && !w.expr ? w.val : null; };
      const X = tv('X'), U = tv('U'), Z = tv('Z'), W = tv('W');
      if (X !== null) st.x = X; else if (U !== null) st.x = st.x === null ? null : st.x + U; else if (has('X') || has('U')) st.x = null;
      if (Z !== null) st.z = Z; else if (W !== null) st.z = st.z === null ? null : st.z + W; else if (has('Z') || has('W')) st.z = null;
    }

    /* --- M codes (executed after the block's motion) --- */
    for (const mc of m) {
      if (!lathe && (mc === 6 || mc === 16)) {
        const tw = has('T');
        const tNew = tw ? tw.val : st.pendingTool;
        if (tNew === null || tNew === undefined) add(i, 'error', 'E-TC-03', 'Tool change with no tool number',
          'M06 has no T word on this block or the one before it.', null, 'Add the tool number, for example T2 M06.');
        if (st.cycle !== 80) add(i, 'error', 'E-TC-01', 'Canned cycle still active at tool change',
          'A drilling or tapping cycle is active when the tool changes.', IB(i, 'G80', true, 'Cancel the cycle first'));
        if (st.comp !== 40) add(i, 'warning', 'W-TC-02', 'Cutter comp active at tool change',
          'G' + st.comp + ' is still on when the tool changes.', IB(i, 'G40', true, 'Cancel comp first'));
        if (st.seenMotion && !st.retracted) add(i, 'info', 'I-TC-02', 'No Z retract before tool change',
          'Haas homes Z during M06, but retracting explicitly with G53 keeps the move predictable.',
          IB(i, 'G53 G00 Z0.', true, 'Retract Z first'));
        if (tNew !== null && tNew !== undefined) st.tool = tNew;
        st.pendingTool = null; st.needTLC = true; st.tlcReported = false; st.spindle = 0; st.seenToolChange = true;
        st.retracted = false;
      }
      if (mc === 3 || mc === 4) {
        const s = sw && !sw.expr ? sw.val : st.s;
        if (sw && !sw.expr && !isG50) st.s = sw.val;
        if (s === null || s === undefined) add(i, 'error', 'E-SPN-02', 'Spindle start with no speed',
          'M0' + mc + ' runs but no S speed has been set anywhere before it.',
          R(i, appendTo(b, lathe && st.css === 96 ? 'S400' : 'S' + Math.min(3000, o.maxRpm)), false, 'Add S (example value)'),
          'Add S with the spindle speed.');
        else if (s <= 0) add(i, 'error', 'E-SPN-03', 'Spindle speed is zero', 'M0' + mc + ' with S0 will not turn the spindle.', null, 'Set a real S value.');
        st.spindle = mc;
      }
      if (mc === 5) st.spindle = 0;
      if (mc === 30 || mc === 2) {
        st.hasEnd = true; st.endIdx = i; st.ended = true;
        if (st.cycle !== 80) add(i, 'warning', 'W-CAN-06', 'Canned cycle never cancelled',
          'The program ends with a canned cycle still active.', IB(i, 'G80', true, 'Cancel the cycle first'));
        if (st.comp !== 40) add(i, 'warning', 'W-CC-06', 'Cutter comp active at program end',
          'The program ends with G' + st.comp + ' still on.', IB(i, 'G40', true, 'Cancel comp first'));
      }
      if (mc === 98) {
        const p = has('P');
        if (p && !p.expr && !oNums.has(p.val)) add(i, 'info', 'I-SUB-01', 'Subprogram not found in this file',
          'M98 P' + p.text + ' calls O' + String(p.val).padStart(5, '0') + ', which is not in this file. It may already be stored in the control.', null,
          'Make sure the subprogram exists on the machine before running.');
      }
    }
    if (sw && !sw.expr && !m.some(c => c === 3 || c === 4) && !isG50) st.s = sw.val;
    if (!lathe) { const tw = has('T'); if (tw && !m.includes(6) && !m.includes(16)) st.pendingTool = tw.val; }
    if (fWord && !fWord.expr) st.f = fWord.val;
  }

  /* --- program-level checks --- */
  const nonEmpty = blocks.filter(b => !b.empty);
  if (nonEmpty.length) {
    const first = blocks[firstIdx], last = blocks[lastIdx];
    const hasStart = first.percent, hasEndPct = last.percent;
    if (!hasStart && !hasEndPct) {
      add(firstIdx, 'info', 'I-HDR-01', 'No % start and end markers',
        'Haas file transfers expect the program to begin and end with %.',
        { auto: true, label: 'Add % at both ends', ops: [{ op: 'insertBefore', at: firstIdx, lines: ['%'] }, { op: 'insertAfter', at: lastIdx, lines: ['%'] }] });
    } else if (hasStart !== hasEndPct) {
      add(hasStart ? lastIdx : firstIdx, 'warning', 'W-HDR-02', hasStart ? 'Missing closing %' : 'Missing opening %',
        'The program has a % at one end only.', hasStart ? IA(lastIdx, '%', true, 'Add closing %') : IB(firstIdx, '%', true, 'Add opening %'));
    }
    const oBlocks = blocks.filter(b => b.words.some(w => w.letter === 'O' && !w.expr));
    if (!oBlocks.length) {
      const at = hasStart ? firstIdx : firstIdx;
      add(at, 'warning', 'W-HDR-03', 'No program number',
        'Haas stores programs by O number. Without one the control asks for a name or renames it.',
        hasStart ? IA(firstIdx, 'O00001', true, 'Add O00001') : IB(firstIdx, 'O00001', true, 'Add O00001'));
    } else {
      oBlocks.forEach(b => {
        const w = b.words.find(x => x.letter === 'O');
        if (w.val > 99999 || !/^\d{1,5}$/.test(w.text)) add(b.i, 'error', 'E-HDR-04', 'Invalid program number',
          'O' + w.text + ' is not a valid Haas program number (O00000 to O99999, no decimal).', null, 'Use up to five digits.');
        else if (w.val >= 9000 && w.val <= 9999) add(b.i, 'info', 'I-HDR-05', 'Reserved O number range',
          'O09000 to O09999 are reserved by Haas for macro and probing programs.', null, 'Pick a number outside O09000-O09999.');
      });
    }
    if (!st.hasEnd && !nonEmpty.some(b => b.m.includes(99))) {
      const closing = hasEndPct ? IB(lastIdx, 'M30', true, 'Add M30 before closing %') : IA(lastIdx, 'M30', true, 'Add M30 at the end');
      add(hasEndPct ? lastIdx : lastIdx, 'error', 'E-END-01', 'No program end',
        'There is no M30 (or M02). The control will not rewind or reset modal states.', closing, 'End the main program with M30.');
    }
  }

  issues.forEach(x => { if (ALARM_MAP[x.id]) x.alarms = ALARM_MAP[x.id].map(n => ({ num: n, text: ((ALARM_DB[n] || [])[0] || {}).text || '' })); });
  issues.sort((a, b) => a.line - b.line || ({ error: 0, warning: 1, info: 2 }[a.sev] - { error: 0, warning: 1, info: 2 }[b.sev]));
  const summary = { error: 0, warning: 0, info: 0 };
  issues.forEach(x => summary[x.sev]++);
  return { issues, summary, lines };
}

function applyFix(text, fix) {
  const lines = text.split(/\r?\n/);
  return applyOps(lines, fix.ops).map(x => x.t).join('\n');
}
function fixAll(text, opts) {
  let cur = text, applied = 0;
  const seenStates = new Set();
  for (let n = 0; n < 400; n++) {
    const res = analyze(cur, opts);
    const next = res.issues.find(x => x.fix && x.fix.auto);
    if (!next) break;
    const out = applyFix(cur, next.fix);
    if (out === cur || seenStates.has(out)) break;
    seenStates.add(cur);
    cur = out; applied++;
  }
  return { text: cur, applied };
}
function detectMachine(text) {
  let l = 0, m = 0;
  const T = text.toUpperCase().replace(/\([^)]*\)/g, ' ');
  l += (T.match(/\bG(?:96|97|71|72|76|70|50|92|94)\b/g) || []).length;
  l += (T.match(/\bT\d{4}\b/g) || []).length;
  l += (T.match(/\b[UW]-?\d*\.?\d+/g) || []).length;
  m += (T.match(/\bM0?6\b/g) || []).length * 2;
  m += (T.match(/\bG4[39]\b/g) || []).length;
  m += (T.match(/\bG8[1-9]\b/g) || []).length;
  m += (T.match(/\bY-?\d*\.?\d+/g) || []).length;
  if (l >= 2 && l > m) return 'lathe';
  if (m >= 2 && m > l) return 'mill';
  return null;
}
/* ---------- Haas alarm reference (names + a few verified details) ---------- */
/* Format: number|NAME|scope  (scope: L = lathe only, M = mill only, blank = both) */
const ALARM_TXT = `
101|COMM. FAILURE WITH MOCON/MOCON MEMORY FAULT|
102|SERVOS OFF|
103|X SERVO ERROR TOO LARGE|
104|Y SERVO ERROR TOO LARGE|
105|Z SERVO ERROR TOO LARGE|
106|A SERVO ERROR TOO LARGE|
107|EMERGENCY OFF|
108|X SERVO OVERLOAD|
109|Y SERVO OVERLOAD|
110|Z SERVO OVERLOAD|
111|A SERVO OVERLOAD|
112|NO INTERRUPT|
113|TURRET UNLOCK FAULT|L
113|SHUTTLE IN FAULT|M
114|TURRET LOCK FAULT|L
114|SHUTTLE OUT FAULT|M
115|TURRET ROTATE FAULT|
116|SPINDLE ORIENTATION FAULT|
117|SPINDLE HIGH GEAR FAULT|
118|SPINDLE LOW GEAR FAULT|
119|OVERVOLTAGE|
120|LOW AIR PRESSURE|
121|LOW LUBE OR LOW PRESSURE|
122|REGEN OVERHEAT|
123|SPINDLE DRIVE FAULT|
124|LOW BATTERY|
125|TOOL TURRET FAULT|L
125|SHUTTLE FAULT|M
126|GEAR FAULT|
127|DOOR FAULT|L
127|NO TURRET MARK|M
128|SUPER TRAVEL ENABLED ON MULTIPLE AXES|M
129|M FIN FAULT|
130|CHUCK UNCLAMPED|L
130|TOOL UNCLAMPED|M
131|TOOL NOT CLAMPED|M
132|POWER DOWN FAILURE|
133|SPINDLE BRAKE ENGAGED|L
133|SPINDLE INOPERATIVE|M
134|LOW HYDRAULIC PRESSURE|L
134|TOOL CLAMP FAULT|M
135|X-AXIS MOTOR OVERHEAT|
136|Y-AXIS MOTOR OVERHEAT|
137|Z-AXIS MOTOR OVERHEAT|
138|A-AXIS MOTOR OVERHEAT|
139|X-AXIS MOTOR Z FAULT|
140|Y-AXIS MOTOR Z FAULT|
141|Z-AXIS MOTOR Z FAULT|
142|A-AXIS MOTOR Z FAULT|
143|SPINDLE ORIENTATION LOST|
144|TIMEOUT - CALL YOUR DEALER|
145|X LIMIT SWITCH|
146|Y LIMIT SWITCH|
147|Z LIMIT SWITCH|
148|A LIMIT SWITCH|
149|SPINDLE TURNING|
150|I_MODE OUT OF RANGE|L
150|Z AND TOOL INTERLOCKED|M
151|HPC LOW PRESSURE|L
151|LOW THRU SPINDLE COOLANT|M
152|SELF TEST FAIL|
153|X AXIS Z CH MISSING|
154|Y AXIS Z CH MISSING|
155|Z AXIS Z CH MISSING|
156|A AXIS Z CH MISSING|
157|MOCON WATCHDOG FAULT|
158|VIDEO/KEYBOARD PCB FAILURE|
159|KEYBOARD FAILURE|
160|LOW VOLTAGE|
161|X AXIS DRIVE FAULT|
162|Y AXIS DRIVE FAULT|
163|Z AXIS DRIVE FAULT|
164|A AXIS DRIVE FAULT|
165|X ZERO RET MARGIN TOO SMALL|
166|Y ZERO RET MARGIN TOO SMALL|
167|Z ZERO RET MARGIN TOO SMALL|
168|A ZERO RET MARGIN TOO SMALL|
169|SPINDLE DIRECTION FAULT|
170|ENABLED AXIS NEEDS MOCON2|M
171|RPM TOO HIGH TO UNCLAMP|L
171|APC-PALLET CLAMP TIMEOUT|M
172|DOOR IS OPEN AND SPINDLE IS TURNING|L
172|APC-PALLET UNCLAMP TIMEOUT|M
173|SPINDLE ENCODER Z CH MISSING|
174|TOOL LOAD EXCEEDED|
175|GROUND FAULT DETECTED|
176|OVERHEAT SHUTDOWN|
177|OVERVOLTAGE SHUTDOWN|
178|DIVIDE BY ZERO|
179|LOW PRESSURE TRANS OIL|
180|PALLET/FIXTURE NOT CLAMPED|M
181|MACRO NOT COMPLETED - SPINDLE DISABLED|
182|X CABLE FAULT|
183|LIVE TOOLING CABLE FAULT|L
183|Y CABLE FAULT|M
184|Z CABLE FAULT|
185|A CABLE FAULT|
186|SPINDLE NOT TURNING|
187|B SERVO ERROR TOO LARGE|
188|B SERVO OVERLOAD|
189|B-AXIS MOTOR OVERHEAT|
190|B MOTOR Z FAULT|
191|B LIMIT SWITCH|
192|B AXIS Z CH MISSING|
193|B AXIS DRIVE FAULT|
194|B ZERO RET MARGIN TOO SMALL|
195|B CABLE FAULT|
196|COOLANT SPIGOT FAILURE|M
197|MISC. SOFTWARE ERROR|
198|SPINDLE STALLED|
199|NEGATIVE RPM|
200|VD OVER TEMP.|
201|PARAMETER CRC ERROR|
202|SETTING CRC ERROR|
203|LEAD SCREW CRC ERROR|
204|OFFSET CRC ERROR|
205|PROGRAMS CRC ERROR|
206|INTERNAL PROG ERROR|
207|QUEUE ADVANCE ERROR|
208|QUEUE ALLOCATION ERROR|
209|QUEUE CUTTER COMP ERROR|
210|INSUFFICIENT MEMORY|
211|ODD PROG BLOCK|
212|PROG INTEGRITY ERROR|
213|PROGRAM RAM CRC ERROR|
214|NO. OF PROGRAMS CHANGED|
215|FREE MEMORY PTR CHANGED|
216|PROBE ARM DOWN WHILE RUNNING|L
216|EPROM SPEED FAILURE|M
217|X PHASING ERROR|
218|Y PHASING ERROR|
219|Z PHASING ERROR|
220|A PHASING ERROR|
221|B PHASING ERROR|
222|C PHASING ERROR|
223|DOOR LOCK FAILURE|
224|X TRANSITION FAULT|
225|Y TRANSITION FAULT|
226|Z TRANSITION FAULT|
227|A TRANSITION FAULT|
228|B TRANSITION FAULT|
229|C TRANSITION FAULT|
230|DOOR OPEN|L
231|JOG HANDLE TRANSITION FAULT|
232|SPINDLE TRANSITION FAULT|
233|JOG HANDLE CABLE FAULT|
234|SPINDLE CABLE FAULT|
235|SPINDLE Z FAULT|
236|SPINDLE MOTOR OVERLOAD|
237|SPINDLE FOLLOWING ERROR|
238|AUTOMATIC DOOR FAULT|M
239|UNKNOWN MOCON1 ALARM|
240|EMPTY PROG OR NO EOB|
241|INVALID CODE|
242|NUMBER FORMAT ERROR-OR TOO LONG|
243|BAD NUMBER|
244|MISSING (...)|
245|UNKNOWN CODE|
246|STRING TOO LONG|
247|CURSOR DATA BASE ERROR|
248|NUMBER RANGE ERROR|
249|PROG DATA BEGINS ODD|
250|PROG DATA ERROR|
251|PROG DATA STRUCT ERROR|
252|MEMORY OVERFLOW|
253|ELECTRONICS OVERHEAT|
254|SPINDLE MOTOR OVERHEAT|
255|NO TOOL IN SPINDLE|M
256|CURRENT TOOL UNKNOWN|M
257|PROG DATA ERROR|
258|INVALID DPRNT FORMAT|
259|LANGUAGE VERSION|
260|LANGUAGE CRC|
261|ROTARY CRC ERROR|
262|PARAMETER CRC MISSING|
263|LEAD SCREW CRC MISSING|
264|ROTARY CRC MISSING|
265|MACRO VARIABLE FILE CRC ERROR|
266|TOOL CHANGER FAULT|M
267|TOOL DOOR OUT OF POSITION|M
268|DOOR OPEN @ M95 START|
269|TOOL ARM FAULT|M
270|C SERVO ERROR TOO LARGE|
271|C SERVO OVERLOAD|
272|C-AXIS MOTOR OVERHEAT|
273|C MOTOR Z FAULT|
274|C LIMIT SWITCH|
275|C AXIS Z CH MISSING|
276|C AXIS DRIVE FAULT|
277|C ZERO RET MARGIN TOO SMALL|
278|C CABLE FAULT|
279|X AXIS LINEAR SCALE Z FAULT|M
280|Y AXIS LINEAR SCALE Z FAULT|M
281|Z AXIS LINEAR SCALE Z FAULT|M
282|A AXIS LINEAR SCALE Z FAULT|M
283|X AXIS LINEAR SCALE Z CH MISSING|M
284|Y AXIS LINEAR SCALE Z CH MISSING|M
285|Z AXIS LINEAR SCALE Z CH MISSING|M
286|A AXIS LINEAR SCALE Z CH MISSING|M
287|X AXIS LINEAR SCALE CABLE FAULT|M
288|Y AXIS LINEAR SCALE CABLE FAULT|M
289|Z AXIS LINEAR SCALE CABLE FAULT|M
290|A AXIS LINEAR SCALE CABLE FAULT|M
291|LOW AIR VOLUME/PRESSURE DURING ATC|M
292|320V VD/MMPS FAULT|
293|INVALID CHAMFER OR CORNER ROUNDING DISTANCE IN G01|
294|NO END MOVE FOR G01 CHAMFER CORNER ROUNDING|
295|MOVE ANGLE TOO SMALL IN G01 CORNER ROUNDING|
296|INVALID PLANE SELECTION IN G01 CHAMFER OR CORNER ROUNDING|
297|ATC SHUTTLE OVERSHOOT|M
298|ATC DOUBLE ARM OUT OF POSITION|M
299|ATC SHUTTLE OUT OF POSITION|M
301|NORMAL STOP|L
302|INVALID R IN G02 OR G03|
303|INVALID X,B OR Z IN G02 OR G03|L
303|INVALID X, Y OR Z IN G02 OR G03|M
304|INVALID I,J OR K IN G02 OR G03|
305|INVALID Q IN CANNED CYCLE|
306|INVALID I,J,K, OR Q IN CANNED CYCLE|
307|SUBROUTINE NESTING TOO DEEP|
308|INVALID TOOL OFFSET|L
309|EXCEEDED MAX FEEDRATE|
310|INVALID G CODE|
311|UNKNOWN CODE|
312|PROGRAM END|
313|NO P CODE IN M96, M97, M98, M143, M144, or G65|
314|SUBPROGRAM NOT IN MEMORY|
315|INVALID P CODE IN M97, M98 OR M99|L
315|INVALID P CODE IN M98, M97, M96, G47 OR G65|M
316|X OVER TRAVEL RANGE|
317|Y OVER TRAVEL RANGE|
318|Z OVER TRAVEL RANGE|
319|A OVER TRAVEL RANGE|
320|NO FEED RATE|
321|AUTO OFF ALARM|
322|SUB PROG WITHOUT M99|
323|ATM CRC ERROR|M
324|DELAY TIME RANGE ERROR|
325|QUEUE FULL|
326|G04 WITHOUT P CODE|
327|NO LOOP FOR M CODE EXCEPT M97, 98|
328|INVALID TOOL NUMBER|
329|UNDEFINED M CODE|
330|UNDEFINED MACRO CALL|
331|RANGE ERROR|
332|H AND T NOT MATCHED|M
333|X AXIS DISABLED|
334|Y AXIS DISABLED|
335|Z AXIS DISABLED|
336|A AXIS DISABLED|
337|GOTO OR P LINE NOT FOUND|
338|INVALID IJK AND XYZ IN G02 OR G03|
339|MULTIPLE CODES|
340|CUTTER COMP BEGIN WITH G02 OR G03|
341|CUTTER COMP END WITH G02 OR G03|
342|CUTTER COMP PATH TOO SMALL|
343|DISPLAY QUEUE RECORD FULL|
344|CUTTER COMP WITH G17 & G19|L
344|CUTTER COMP WITH G18 & G19|M
345|INVALID R VALUE IN M19 OR G105|L
346|M CODE DISABLED|L
346|M CODE DISABLED A|M
348|ILLEGAL SPIRAL MOTION|L
348|MOTION NOT ALLOWED IN G93 MODE|M
349|PROG STOP WITHOUT CANCELING CUTTER COMP|
350|CUTTER COMP LOOK AHEAD ERROR|
351|INVALID P CODE|
352|AUX AXIS POWER OFF|
353|AUX AXIS NO HOME|
354|AUX AXIS DISCONNECTED|
355|AUX AXIS POSITION MISMATCH|
356|AUX AXIS TRAVEL LIMIT|
357|AUX AXIS DISABLED|
358|MULTIPLE AUX AXIS|
359|INVALID I, J OR K IN G12 OR G13|M
360|TOOL CHANGER DISABLED|
361|GEAR CHANGER DISABLED|
362|TOOL USAGE ALARM|
363|COOLANT LOCKED OFF|
364|NO CIRC INTERP AUX AXIS|
365|P DEFINITION ERROR|
366|MISSING I, K, OR L IN G70, G71, G72|M
367|CUTTER COMP INTERFERENCE|
368|GROOVE TOO SMALL|
369|TOOL TOO BIG|
370|TAILSTOCK EXCESSIVE DRIFT|L
370|POCKET DEFINITION ERROR|M
371|INVALID I, J, K OR Q|
372|TOOL CHANGE IN CANNED CYCLE|
373|INVALID CODE IN DNC|
374|MISSING XBZA IN G31 OR G36|L
374|MISSING XYZA IN G31 OR G36|M
375|MISSING Z OR H IN G37|M
376|NO CUTTER COMP IN SKIP|
377|NO SKIP IN GRAPH/SIM|
378|SKIP SIGNAL FOUND|
379|SKIP SIGNAL NOT FOUND|
380|X, Y, A OR G49 NOT ALLOWED IN G37|
381|G43,G44 NOT ALLOWED IN G36 OR G136|
382|D CODE REQUIRED IN G35|
383|INCH IS NOT SELECTED|
384|METRIC IS NOT SELECTED|
385|INVALID L, P, OR R CODE IN G10|
386|INVALID ADDRESS FORMAT|
387|CUTTER COMP NOT ALLOWED WITH G103|
388|CUTTER COMP NOT ALLOWED WITH G10|
389|G17, G18, G19 ILLEGAL IN G68|
390|NO SPINDLE SPEED|
391|FEATURE DISABLED|
392|B AXIS DISABLED|
393|INVALID MOTION IN G84 OR G184|L
393|INVALID MOTION IN G74 OR G84|M
394|B OVER TRAVEL RANGE|
395|INVALID CODE IN CANNED CYCLE|L
395|NO G107 ROTARY AXIS SPECIFIED|M
396|CONFLICTING AXES|L
396|INVALID G107 ROTARY AXIS SPECIFIED|M
397|INVALID D CODE|L
397|AUX AXIS IN G93 BLOCK|M
398|AUX AXIS SERVO OFF|
399|INVALID U CODE|L
400|SKIP SIGNAL DURING RESTART|
401|INVALID TANGENT IN GROUP 1 CORNER ROUNDING|L
401|INVALID TANGENT IN GROUP 1 CORNER ROUNDING OR CHAMFERING|M
402|POSSIBLE CORRUPTED FILE|
403|TOO MANY PROGS|
404|RS-232 NO PROG NAME|
405|RS-232 ILLEGAL PROG NAME|
406|RS-232 MISSING CODE|
407|RS-232 INVALID CODE|
408|RS-232 NUMBER RANGE ERROR|
409|RS-232 INVALID N CODE|L
409|FILE INVALID N CODE|M
410|RS-232 INVALID V CODE|L
410|FILE INVALID V CODE|M
411|RS-232 EMPTY PROG|
412|RS-232 UNEXPECTED END OF INPUT|
413|RS-232 LOAD INSUFFICIENT MEMORY|
414|RS-232 BUFFER OVERFLOW|
415|RS-232 OVERRUN|
416|RS-232 PARITY ERROR|
417|RS-232 FRAMING ERROR|
418|RS-232 BREAK|
419|INVALID FUNCTION FOR DNC|
420|PROGRAM NUMBER MISMATCH|
421|NO VALID POCKETS|M
422|POCKET TABLE ERROR|M
423|SERVO BAR EOB SWITCH POSITION UNKNOWN|L
423|X SCALE/SCREW MISMATCH|M
424|SERVO BAR METRIC UNSUPPORTED|L
424|Y SCALE/SCREW MISMATCH|M
425|SERVO BAR LENGTH UNKNOWN|L
425|Z SCALE/SCREW MISMATCH|M
426|SERVO BAR ILLEGAL CODE G105|L
426|A SCALE/SCREW MISMATCH|M
427|INTERRUPT OVERRUN|
428|SERVO BAR SWITCH FAILURE|L
429|DISK DIR INSUFFICIENT MEMORY|
430|FILE BEGINNING/END MARKER MISSING|L
430|FILE UNEXPECTED END OF INPUT|M
431|DISK NO PROG NAME|L
431|FILE NO PROG NAME|M
432|DISK ILLEGAL PROG NAME|L
432|FILE ILLEGAL PROG NAME|M
433|DISK EMPTY PROG|L
433|FILE EMPTY PROG|M
434|DISK LOAD INSUFFICIENT MEMORY|L
434|FILE LOAD INSUFFICIENT MEMORY|M
435|DISK ABORT|
436|DISK FILE NOT FOUND|
437|TAILSTOCK UNDERSHOOT|L
438|TAILSTOCK MOVED WHILE HOLDING PART|L
439|TAILSTOCK FOUND NO PART|L
440|SERVO BAR MAX PARTS REACHED|L
441|SERVO BAR MAX BARS REACHED|L
442|SERVO BAR MAX LENGTH REACHED|L
443|SERVO BAR ALREADY NESTED|L
444|REGEN ON TOO LONG|M
445|SERVO BAR FAULT|L
446|SERVO BAR BAR TOO LONG|L
447|SERVO BAR BAR IN WAY|L
448|SERVO BAR OUT OF BARS|L
450|BAR FEEDER FAULT|L
451|BAR FEEDER SPINDLE INTERLOCK|L
452|SERVO BAR GEARMOTOR TIMEOUT|L
453|C AXIS ENGAGED|L
454|C AXIS NOT ENGAGED|L
455|G112 BLOCK ENDS W/O CANCEL CUTTER COMP|L
456|PARAMETER CONFLICT|L
457|AUX AXIS IS ENABLED|
458|LINEAR SCALES ENABLED WITHOUT MOTIF|M
459|APL DOOR FAULT|L
460|APL ILLEGAL CODE|L
461|APL GRIPPER TIMEOUT|L
462|U OVER TRAVEL RANGE|L
463|V OVER TRAVEL RANGE|L
464|W OVER TRAVEL RANGE|L
468|U LIMIT SWITCH|L
469|V LIMIT SWITCH|L
470|W LIMIT SWITCH|L
471|OUT OF TOOLS|M
472|ATM FAULT|M
473|INVALID GEOMETRY|L
474|G02 OR G03 NOT ALLOWED WITH G143|M
485|USB RESET OCCURRED|
486|USB TIMEOUT OCCURRED|
487|USB DEVICE INAPPROPRIATELY UNMOUNTED|
501|TOO MANY ASSIGNMENTS IN ONE BLOCK|
502|[ OR = NOT FIRST TERM IN EXPRESSN|
503|ILLEGAL MACRO VARIABLE REFERENCE|
504|UNBALANCED BRACKETS IN EXPRESSION|
505|VALUE STACK ERROR|
506|OPERAND STACK ERROR|
507|TOO FEW OPERANDS ON STACK|
508|DIVISION BY ZERO|
509|ILLEGAL MACRO VARIABLE USE|
510|ILLEGAL OPERATOR OR FUNCTION USE|
511|UNBALANCED RIGHT BRACKETS|
512|ILLEGAL ASSIGNMENT USE|
513|VARIABLE REFERENCE NOT ALLOWED WITH N OR O|
514|ILLEGAL MACRO ADDRESS REFERENCE|
515|TOO MANY CONDITIONALS IN A BLOCK|
516|ILLEGAL CONDITIONAL OR NO THEN|
517|EXPRSN. NOT ALLOWED WITH N OR O|
518|ILLEGAL MACRO EXPRESSION REFERENCE|
519|TERM EXPECTED|
520|OPERATOR EXPECTED|
521|ILLEGAL FUNCTIONAL PARAMETER|
522|ILLEGAL ASSIGNMENT VAR OR VALUE|
523|CONDITIONAL REQUIRED PRIOR TO THEN|
524|END FOUND WITH NO MATCHING DO|
525|VAR. REF. ILLEGAL DURING MOVEMENT|
526|COMMAND FOUND ON DO/END LINE|
527|= NOT EXPECTED OR THEN REQUIRED|
528|PARAMETER PRECEDES G65|
529|ILLEGAL G65 PARAMETER|
530|TOO MANY I, J, or K'S IN G65|
531|MACRO NESTING TOO DEEP|
532|UNKNOWN CODE IN POCKET PATTERN|
533|MACRO VARIABLE UNDEFINED|
534|DO OR END ALREADY IN USE|
535|ILLEGAL DPRNT STATEMENT|
536|COMMAND FOUND ON DPRNT LINE|
537|RS-232 ABORT ON DPRNT|
538|MATCHING END NOT FOUND|
539|ILLEGAL GOTO|
540|MACRO SYNTAX NOT ALLOWED|
541|MACRO ALARM|
542|OPERATION NOT AVAILABLE|
600|CODE NOT EXPECTED IN THIS CONTEXT|L
600|U OVER TRAVEL RANGE|M
601|MAXIMUM PQ BLOCKS EXCEEDED|L
601|V OVER TRAVEL RANGE|M
602|NON-MONOTONOUS PQ BLOCKS IN X|L
602|W OVER TRAVEL RANGE|M
603|NON-MONOTONOUS PQ BLOCKS IN Z|L
603|U LIMIT SWITCH|M
604|NON-MONOTONOUS ARC IN PQ BLOCK|L
604|V LIMIT SWITCH|M
605|INVALID TOOL NOSE ANGLE|L
605|W LIMIT SWITCH|M
606|INVALID A CODE|L
607|INVALID W CODE|L
608|INVALID Q CODE|
609|TAILSTOCK RESTRICTED ZONE|L
609|U SERVO ERROR TOO LARGE|M
610|G71/G72 DOMAIN NESTING EXCEEDED|L
610|V SERVO ERROR TOO LARGE|M
611|G71/G72 TYPE I ALARM|L
611|W SERVO ERROR TOO LARGE|M
612|G71/G72 TYPE II ALARM|L
612|U SERVO OVERLOAD|M
613|COMMAND NOT ALLOWED IN CUTTER COMPENSATION|
614|V SERVO OVERLOAD|M
615|NO INTERSECTION TO OFFSETS IN CC|L
615|W SERVO OVERLOAD|M
616|CANNED CYCLE USING P & Q IS ACTIVE|L
616|U-AXIS MOTOR OVERHEAT|M
617|MISSING ADDRESS CODE|L
617|V-AXIS MOTOR OVERHEAT|M
618|INVALID ADDRESS VALUE|L
618|W-AXIS MOTOR OVERHEAT|M
619|STROKE EXCEEDS START POSITION|L
620|C AXIS DISABLED|
621|C OVER TRAVEL RANGE|
622|C AXIS ENGAGEMENT FAILURE|L
622|TOOL ARM FAULT|M
623|INVALID CODE IN G112|L
624|COMMAND NOT ALLOWED IN G14 MODE|L
625|CAROUSEL POSITIONING ERROR|M
626|TOOL POCKET SLIDE ERROR|M
627|ATC ARM MOTION|M
628|ATC ARM POSITIONING ERROR|M
629|EXCEEDED MAX FEED PER REV|L
629|APC-PIN CLEAR/HOME SWITCH FAULT|M
630|APC-DOOR SW FAULT-SWITCH NOT EQUAL TO SOLENOID|M
631|PALLET NOT CLAMPED|M
632|APC-UNCLAMP ERROR|M
633|APC-CLAMP ERROR|M
634|APC-MISLOCATED PALLET|M
635|APC-PAL NUM CONFLICT REC & CH|M
636|APC UNLOAD-SWITCH MISSED PAL 1|M
637|APC UNLOAD-SWITCH MISSED PAL 2|M
638|APC-DOOR NOT OPEN|M
639|APC-DOOR NOT CLOSED|M
640|APC-MISSING PALLET @ REC|M
641|APC-UNKNOWN CHAIN LOCATION|M
642|APC-PIN CLEAR SWITCH FAULT|M
643|LOW BRAKE OIL A-AXIS|M
644|APC-LOW AIR PRESSURE|M
645|AMPLIFIER GROUND|M
646|VAC INPUT PHASE|M
647|REGEN LOAD SHORTED|M
648|DC BUS SHORTED|M
649|DC BUS UNDER VOLTAGE|M
650|DC BUS OVER VOLTAGE|M
651|Z AXIS IS NOT ZEROED|M
652|U ZERO RET MARGIN TOO SMALL|
653|V ZERO RET MARGIN TOO SMALL|
654|W ZERO RET MARGIN TOO SMALL|
655|MISMATCH AXIS WITH I, K CHAMFERING|L
655|U CABLE FAULT|M
656|INVALID I, K, OR R IN G01|L
656|V CABLE FAULT|M
657|NOT ONE AXIS MOVE WITH CHAMFERING|L
657|W CABLE FAULT|M
658|INVALID MOVE AFTER CHAMFERING|L
658|U PHASING ERROR|M
659|NOT ONE AXIS MOVE WITH CHAMFERING|L
659|V PHASING ERROR|M
660|W PHASING ERROR|M
661|U TRANSITION FAULT|M
662|V TRANSITION FAULT|M
663|W TRANSITION FAULT|M
664|U AXIS DISABLED|
665|V AXIS DISABLED|
666|W AXIS DISABLED|
667|U AXIS LINEAR SCALE Z FAULT|M
668|V AXIS LINEAR SCALE Z FAULT|M
669|W AXIS LINEAR SCALE Z FAULT|M
670|TT or B OVER TRAVEL RANGE|M
671|TT or B LIMIT SWITCH|M
673|TT or B SERVO ERROR TOO LARGE|M
674|TT or B SERVO OVERLOAD|M
675|TT or B-AXIS MOTOR OVERHEAT|M
676|TT or B MOTOR Z FAULT|M
677|TT or B AXIS Z CH MISSING|M
678|TT or B AXIS DRIVE FAULT|M
679|TT or B ZERO RET MARGIN TOO SMALL|M
680|TT or B CABLE FAULT|M
681|TT or B PHASING ERROR|M
682|TT or B TRANSITION FAULT|M
683|TT or B AXIS DISABLED|M
684|TT or B AXIS LINEAR SCALE Z FAULT|M
685|V MOTOR Z FAULT|M
686|W MOTOR Z FAULT|M
687|U MOTOR Z FAULT|M
688|U AXIS Z CH MISSING|M
689|V AXIS Z CH MISSING|M
690|W AXIS Z CH MISSING|M
691|U AXIS DRIVE FAULT|M
692|V AXIS DRIVE FAULT|M
693|W AXIS DRIVE FAULT|M
694|ATC SWITCH FAULT|M
695|ATC DOUBLE-ARM CYLINDER TIME OUT|M
696|ATC MOTOR TIME OUT|M
697|ATC MOTOR FAULT|M
698|ATC PARAMETER ERROR|M
701|U SERVO ERROR TOO LARGE MOCON2|L
702|V SERVO ERROR TOO LARGE|L
703|W SERVO ERROR TOO LARGE MOCON2|L
704|Sp SERVO ERROR TOO LARGE|L
705|Tt SERVO ERROR TOO LARGE MOCON2|L
706|Ss SERVO ERROR TOO LARGE MOCON2|L
707|J SERVO ERROR TOO LARGE MOCON2|L
708|S SERVO ERROR TOO LARGE MOCON2|L
711|U SERVO OVERLOAD MOCON2|L
712|V SERVO OVERLOAD|L
713|W SERVO OVERLOAD MOCON2|L
714|Sp SERVO OVERLOAD|L
715|Tt SERVO OVERLOAD MOCON2|L
716|Ss SERVO OVERLOAD MOCON2|L
717|J SERVO OVERLOAD MOCON2|L
718|S SERVO OVERLOAD MOCON2|L
721|U-AXIS MOTOR OVERHEAT MOCON2|L
722|V-AXIS MOTOR OVERHEAT|L
723|W-AXIS MOTOR OVERHEAT MOCON2|L
724|Sp MOTOR OVERHEAT|L
725|Tt MOTOR OVER HEAT MOCON2|L
726|Ss MOTOR OVER HEAT MOCON2|L
727|J-AXIS MOTOR OVERHEAT MOCON2|L
728|S-AXIS MOTOR OVERHEAT MOCON2|L
731|U MOTOR Z FAULT MOCON2|L
732|V MOTOR Z FAULT|L
733|W MOTOR Z FAULT MOCON2|L
734|Sp MOTOR Z FAULT|L
735|Tt MOTOR Z FAULT MOCON2|L
736|Ss MOTOR Z FAULT MOCON2|L
737|J MOTOR Z FAULT MOCON2|L
738|S MOTOR Z FAULT MOCON2|L
741|U AXIS Z CH MISSING MOCON2|L
742|V AXIS Z CH MISSING|L
743|W AXIS Z CH MISSING MOCON2|L
744|Sp AXIS Z CH MISSING|L
745|Tt AXIS Z CH MISSING MOCON2|L
746|Ss AXIS Z CH MISSING MOCON2|L
747|J AXIS Z CH MISSING MOCON2|L
748|S AXIS Z CH MISSING MOCON2|L
751|U AXIS DRIVE FAULT MOCON2|L
752|V AXIS DRIVE FAULT|L
753|W AXIS DRIVE FAULT MOCON2|L
754|Sp AXIS DRIVE FAULT|L
755|Tt AXIS DRIVE FAULT MOCON2|L
756|Ss AXIS DRIVE FAULT MOCON2|L
757|J AXIS DRIVE FAULT MOCON2|L
758|S AXIS DRIVE FAULT MOCON2|L
761|U CABLE FAULT MOCON2|L
762|V CABLE FAULT|L
763|W CABLE FAULT MOCON2|L
764|Sp CABLE FAULT|L
765|Tt CABLE FAULT MOCON2|L
766|Ss CABLE FAULT MOCON2|L
767|J CABLE FAULT MOCON2|L
768|S CABLE FAULT MOCON2|L
771|U PHASING ERROR MOCON2|L
772|V PHASING ERROR|L
773|W PHASING ERROR MOCON2|L
774|Sp PHASING ERROR|L
775|Tt PHASING ERROR MOCON2|L
776|Ss PHASING ERROR MOCON2|L
777|J PHASING ERROR MOCON2|L
778|S PHASING ERROR MOCON2|L
781|U TRANSITION FAULT MOCON2|L
782|V TRANSITION FAULT|L
783|W TRANSITION FAULT MOCON2|L
784|SP MOT ENC TRANSITION FAULT|L
785|Tt TRANSITION FAULT MOCON2|L
786|Ss TRANSITION FAULT MOCON2|L
787|J TRANSITION FAULT MOCON2|L
788|S TRANSITION FAULT MOCON2|L
791|COMM. FAILURE WITH MOCON2|
792|MOCON2 WATCHDOG FAULT|
796|SUB SPINDLE NOT TURNING|L
797|SUB SPINDLE ORIENTATION FAULT|L
799|UNKNOWN MOCON2 ERROR|M
800|P AND Q EXCEEDED MEMORY|L
801|NO BLOCK DELETES BETWEEN P AND Q|L
802|NEGATIVE R AND C VALUES NOT ALLOWED|
808|AUTOMATIC PROBE ARM FAULT|
809|PROBE ARM SWITCH FAULT|
810|PROBE ARM CHUCK CONFLICT|
900|A PARAMETER HAS BEEN CHANGED|
901|PARAMETERS HAVE BEEN LOADED BY DISK|
902|PARAMETERS HAVE BEEN LOADED BY RS232|
903|CNC MACHINE POWERED UP|
904|ATC AXIS VISIBLE|M
905|NO P CODE IN M14, M15, M36|M
906|INVALID P CODE IN M14, M15, M36 OR M50|M
907|APC UNLOAD-SWITCH MISSED PAL 3|M
908|APC UNLOAD-SWITCH MISSED PAL 4|M
909|APC-PROGRAM NOT LISTED|M
910|APC-PROGRAM CONFLICT|M
911|APC-PAL LOAD/UNLOAD AT ZERO|M
912|APC-NO P CODE OR Q CODE FOR M46|M
913|APC-NO P CODE OR Q CODE FOR M49|M
914|APC-INVALID P CODE|M
915|APC-ILLEGAL NESTING G188 or M48|M
916|APC-NEGATIVE PAL PRIORITY INDEX|M
917|APC-NUMBER OF PALLETS IS ZERO|M
918|APC LOAD-SWITCH MISSED PAL 1|M
919|APC LOAD-SWITCH MISSED PAL 2|M
920|APC LOAD-SWITCH MISSED PAL 3|M
921|APC LOAD-SWITCH MISSED PAL 4|M
922|APC-TABLE NOT DECLARED|M
923|LOW OIL PRESSURE|L
923|A INDEXER IS NOT AT THE PROPER INCREMENTAL POSITION|M
924|SS LOW LUBE OR LOW PRESSURE|L
924|B INDEXER IS NOT AT THE PROPER INCREMENTAL POSITION|M
925|A INDEXER IS NOT FULLY IN THE UP POSITION|M
926|B INDEXER IS NOT FULLY IN THE UP POSITION|M
927|ILLEGAL G1 CODE FOR ROTARY INDEXER|M
932|BAR 100- ZERO VALUE|L
933|BAR 100- MAXIMUM PARTS COMPLETED|L
934|BAR 100- CURRENT BAR FINISHED|L
935|BAR 100 FAULT|L
937|INPUT LINE POWER FAULT|
938|LANGUAGES LOADED|
939|LANGUAGES FAILED TO LOAD|
940|SIDE MOUNT CAROUSEL ERROR|M
941|POCKET-TOOL TABLE ERROR|M
942|CAROUSEL POSITION TIMEOUT|M
943|UNPROCESSED QUEUE CELL IN TOOL CHANGE|M
944|INDEXER OUT OF POSITION|M
945|APC-LIFT FRAME DOWN TIMEOUT|M
946|APC-PALLET CLAMP TIMEOUT|M
947|APC-PALLET UNCLAMP TIMEOUT|M
948|APC-SOFTWARE ERROR|M
949|APC-AXIS VISIBLE|M
950|APC-ILLEGAL SWITCH CONDITION, LIFT FRAME|M
951|APC-ILLEGAL SWITCH CONDITION, PALLET CLAMP|M
952|APC-MISLOCATED LIFT FRAME|M
953|APC-MISLOCATED PALLET CLAMP|M
954|APC-INCOMPLETE PALLET CHANGE|M
955|APC-INVALID PALLET CHANGER TYPE|M
956|APC-LIFT FRAME UP TIMEOUT|M
957|APC-SWITCH FAULT|M
958|TOOL OFS WEAR HAS BEEN CHANGED|
959|NON-INDEXER POSITION|M
960|INDEXER SWITCH NOT FOUND IN TIME|M
961|FLOPPY OFFSET NOT FOUND|
962|UNABLE TO RETRIEVE FILE INFORMATION|
963|UNABLE TO FNC FROM THIS DEVICE|
964|TOOL TURRET ROTATE FAULT|
965|TURRET CLAMP/UNCLAMP FAULT|
967|SKBIF COMMUNICATION FAULT|
968|DOOR HOLD OVERRIDE ENGAGED|
970|NO AXIS COMMANDED IN FEED CODE|
971|FAILED LOAD|
976|PALLET POOL-INVALID PALLET|
982|ZERO ANGLE MOVE|
983|VD OVER CURRENT|M
984|VD SHORT CIRCUIT|M
985|DC BUS OV CHRG|M
986|CALIBRATION FAILED|
991|AMPLIFIER OVER TEMPERATURE|
992|AMPLIFIER OVER CURRENT|
993|AMPLIFIER SHORT CIRCUIT|
994|AMPLIFIER OVERLOAD|
995|AMPLIFIER CURRENT ERROR TOO LARGE|
995|ERROR TOO LARGE|M
996|TAIL STOCK MUST BE ZERO RETURNED|L
997|TOO MANY FILES HAVE BEEN OPENED ON THE CURRENT DEVICE|
998|A FILE COULD NOT BE OPENED|
`;
/* Plain-language notes: only where a source stated what the alarm means. */
const ALARM_NOTES = {
  102: 'The servo motors are off. Emergency Stop, another alarm or power-on can cause this. Clear the condition behind the associated alarm, then press RESET to turn the servos back on. Usually a consequence of an earlier alarm, so check the alarm history for the first one.',
  209: 'Cycle power on the machine. If it comes back, call your dealer.',
  340: 'Cutter compensation must begin with a straight (linear) move, not a G02/G03 arc.',
  341: 'Cutter compensation must end with a straight (linear) move, not a G02/G03 arc.',
  342: 'The geometry cannot be built with the compensation amount you specified.',
  344: 'G41/G42 are not allowed in the plane that is active. Use the plane your control allows for cutter comp.',
  349: 'The program stopped while cutter compensation was still on. Cancel with G40 before the stop.',
  350: 'Too many blocks without axis motion sit between moves, so the control cannot look ahead for cutter comp.',
  367: 'The programmed path cannot be computed with the tool size.',
  376: 'Skip functions G31 and G37 cannot run with cutter compensation.',
  387: 'Block lookahead was limited (G103), which cutter comp cannot work with. Remove the block limit.',
  388: 'Coordinates cannot be changed with G10 while cutter comp is active.',
  332: 'Haas can compare H with the tool number (Setting 15, H & T code agreement). A mismatch between G43 Hxx and the T in the spindle can raise this on mills.',
  602: 'The contour between the G71/G72 P and Q blocks must run one direction only in X. A move that reverses X triggers this.',
  603: 'The contour between the G71/G72 P and Q blocks must run one direction only in Z. A move that reverses Z triggers this.',
  604: 'An arc inside the P to Q blocks turns back on itself (it passes through a quadrant extreme), so the contour is not monotonic.',
  9930: 'Serial encoder communication fault on an axis. In axis-number format 1.9930 is the X axis.'
};
const ALARM_EXTRA = {
  9930: 'SERIAL ENCODER COMMUNICATION FAULT',
  9100: 'NON RESETTABLE SOFTWARE ERROR (shows with a sub-alarm, for example 9100.018)'
};
const ALARM_DB = {};
ALARM_TXT.split('\n').forEach(l => {
  if (!l.trim()) return;
  const p = l.split('|');
  const n = parseInt(p[0], 10);
  (ALARM_DB[n] = ALARM_DB[n] || []).push({ text: p[1], scope: p[2] || '' });
});
function alarmCategory(n) {
  if (n >= 20000 && n <= 20017) return 'Informational message (logged at power-up, no service action)';
  if (n >= 101 && n <= 199) return 'Servo, spindle, hardware and safety faults';
  if (n >= 200 && n <= 299) return 'Memory/CRC, program format, spindle and tool changer faults';
  if (n >= 300 && n <= 399) return 'Programming and motion alarms';
  if (n >= 400 && n <= 487) return 'File, RS-232/USB, tailstock and bar feeder';
  if (n >= 500 && n <= 599) return 'Macro (variable and expression) alarms';
  if (n >= 600 && n <= 699) return 'Lathe PQ/cycle alarms; mill extra-axis, APC and ATC faults';
  if (n >= 700 && n <= 799) return 'Lathe MOCON2 axis and spindle drive faults';
  if (n >= 800 && n <= 899) return 'Lathe P/Q and probe-arm alarms';
  if (n >= 900 && n <= 999) return 'Messages, pallet changer, indexer and miscellaneous';
  if (n >= 1000 && n < 20000) return 'Next Generation Control alarm (4-digit range)';
  return 'Not in the bundled list';
}
const ALARM_HELP_URL = 'https://www.haascnc.com/service/troubleshooting-and-how-to/reference-documents/alarm-search-help.html';
const alarmUrl = n => 'https://www.haascnc.com/service/alarm-search.alarm=ngc_' + n + '-0000.html';

/* Parse alarm references out of free text. Handles 102, 1.9930 (axis), 9100.018 (sub-alarm), 20000-20017. */
function parseAlarmRefs(text) {
  const out = [], seen = new Set();
  const lines = String(text).split(/\r?\n/);
  const trimmed = String(text).trim();
  const short = trimmed.length <= 24 && trimmed.indexOf('\n') === -1 && !/[A-Za-z]\d/.test(trimmed);
  const re = /(?<![\d.])(?:(\d{4})\.(\d{3})|(\d{1,2})\.(\d{4})|(\d{3,5}))(?![\d])/g;
  lines.forEach(line => {
    const alarmish = short || /alarm|alm\b|fault|error|#\s*\d{3}/i.test(line) || /^\s*\d{3,5}\b\s+[A-Za-z]/.test(line);
    if (!alarmish) return;
    let m;
    while ((m = re.exec(line)) !== null) {
      let ref;
      if (m[1]) ref = { raw: m[0], kind: 'sub', num: +m[1], sub: m[2] };
      else if (m[3]) ref = { raw: m[0], kind: 'axis', axis: +m[3], num: +m[4] };
      else {
        const n = +m[5];
        ref = { raw: m[0], kind: (n >= 20000 && n <= 20017) ? 'info' : 'standard', num: n };
        if (m[5].length === 5 && !(n >= 20000 && n <= 20017)) ref.kind = 'standard';
      }
      if (seen.has(ref.raw)) continue; seen.add(ref.raw); out.push(ref);
    }
  });
  return out;
}
/* Look a query up: numbers, alarm logs, or words from the alarm name. */
function lookupAlarms(query, machine) {
  const q = String(query || '').trim();
  if (!q) return [];
  const refs = parseAlarmRefs(q);
  const results = [];
  refs.forEach(r => {
    const entries = (ALARM_DB[r.num] || []).slice();
    const extra = ALARM_EXTRA[r.num];
    const res = { ref: r, entries: entries.map(e => ({ text: e.text, scope: e.scope })), note: ALARM_NOTES[r.num] || '', category: alarmCategory(r.num), known: entries.length > 0 || !!extra, extra: extra || '' };
    if (machine) res.entries.sort((a, b) => (a.scope === (machine === 'lathe' ? 'L' : 'M') ? -1 : 0) - (b.scope === (machine === 'lathe' ? 'L' : 'M') ? -1 : 0));
    if (r.kind === 'standard' || r.kind === 'info') res.url = alarmUrl(r.num);
    results.push(res);
  });
  if (!refs.length && /[A-Za-z]{3,}/.test(q)) {
    const words = q.toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 3);
    const hits = [];
    Object.keys(ALARM_DB).forEach(k => ALARM_DB[k].forEach(e => {
      const t = e.text.toUpperCase();
      if (words.every(w => t.indexOf(w) !== -1)) hits.push({ num: +k, e });
    }));
    hits.slice(0, 40).forEach(h => {
      const entries = ALARM_DB[h.num];
      results.push({ ref: { raw: String(h.num), kind: 'standard', num: h.num }, entries: entries.map(e => ({ text: e.text, scope: e.scope })),
        note: ALARM_NOTES[h.num] || '', category: alarmCategory(h.num), known: true, extra: '', url: alarmUrl(h.num), byText: true });
    });
  }
  return results;
}
/* Program findings that line up with a documented Haas alarm. "Related" not "will raise": the control version decides. */
const ALARM_MAP = {
  'E-SYN-01': [244], 'E-SYN-02': [241, 245], 'E-SYN-04': [339], 'E-SYN-05': [339],
  'E-FED-01': [320], 'E-SPN-02': [390], 'E-CC-02': [340], 'E-CC-05': [341],
  'W-CC-06': [349], 'E-TC-01': [372], 'W-TLC-02': [332], 'I-SUB-01': [314],
  'W-FED-04': [629], 'W-UNI-02': [316, 318], 'E-ARC-01': [302, 304], 'E-ARC-02': [338],
  'E-ARC-03': [304], 'E-ARC-04': [302], 'E-CYC-01': [337], 'W-HDR-03': [431], 'E-HDR-04': [432],
  'E-MONO-X': [602], 'E-MONO-Z': [603], 'E-MONO-ARC': [604]
};

  window.GcodeCheck = {
    analyze, applyFix, fixAll, detectMachine, lookupAlarms,
    ALARM_MAP, ALARM_HELP_URL, alarmUrl
  };
})();
