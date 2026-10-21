/* =====================================================================
   Dev-tool adapter for "Speed Coder / Speed Programmer" (speed_programmer.html + gcode-rules.js). Loaded together with devtest.js the first
   time the backtick key is pressed (or when the page is opened with ?dev=quick|standard|thorough|problems).
   The page turns plain-English lines ("change tool to T3", "feed to X1 Y2 at 30") into G-code when Enter is pressed. This adapter:
     - builds real-looking and awful lines from the page's own cheat sheet (every shortcut and phrase, with in-range and awful numbers:
       negatives, 1e308, NaN, "1.2.3", ".", unicode digits, empty), presses Enter in the editor and checks what comes out
     - checks the G-code with an independent checker: valid word syntax, no NaN / undefined / Infinity, no unfilled number, decimal
       points on axis words, feeds and speeds in a sane range, every G / M code known to the rules, a converted line is final G-code
       (converting it again changes nothing)
     - builds whole programs from phrases and checks the structure: % and O-number, units and a safe start block before the first move,
       tool change before cutting, tool length compensation, spindle on before a cut, spindle off and Z retract before a tool change,
       coolant balanced, cutter compensation cancelled, M30 and the closing % at the end
     - checks the editor's own wiring: line numbers, syntax highlight text, units badge, Auto ; button, Add ; / Remove ; round trip,
       autocomplete, cheat sheet, the Debug self-test, popups opening and closing
   ===================================================================== */
(() => {
'use strict';
const GC = window.GcodeConverter;
const sel = (s) => document.querySelector(s), all = (s, r = document) => [...r.querySelectorAll(s)];
const ITEMS = GC.getCheatSheetItems();
const GSET = new Set(ITEMS.filter((i) => i.category === 'G-Code').map((i) => i.code)), MSET = new Set(ITEMS.filter((i) => i.category === 'M-Code').map((i) => i.code));
const PHRASES = ITEMS.filter((i) => i.category === 'Shortcut' || i.category === 'Natural Language').map((i) => i.code);
const BASE = { value: editor.value };

/* ---------------------------------------------------------------- independent G-code checker */
const WORD = /^[A-Z](-?\d+\.?\d*|-?\.\d+)$/, HOLE = /^[A-Z]-?_+\.?$/, AXIS = 'XYZABCUVWIJK';
const pad2 = (n) => String(n).padStart(2, '0');
/* Returns a list of { sev, msg }. o: { strict: input was in range (range problems are errors), templates: unfilled __ blanks are fine, auto: semicolons expected } */
function checkOut(text, o = {}) {
  const P = [], add = (sev, msg) => P.push({ sev, msg });
  const rangeSev = o.strict ? 'error' : 'info';
  String(text).split('\n').forEach((raw) => {
    let t = raw.trim(); if (o.auto && t.endsWith(';')) t = t.slice(0, -1).trim();
    if (t === '' || t === '%') return;
    if (/^O/.test(t)) { if (!/^O\d{1,5}(\s*\([^()]*\))?$/.test(t)) { if (!(o.templates && /^O_+/.test(t))) add('error', `bad program number line "${t}"`); } return; }
    if (/^\(/.test(t)) { if (!/^\([^()]*\)$/.test(t)) add('error', `unbalanced comment "${t}"`); return; }
    if (/[^\x20-\x7e]/.test(t.replace(/\([^()]*\)/g, ''))) add('error', `odd character in "${t}"`);
    const code = t.replace(/\([^()]*\)/g, ' ');
    if (/[()]/.test(code)) add('error', `unbalanced bracket in "${t}"`);
    if (BADOUT.test(code)) add('error', `"${t}" contains NaN, undefined, Infinity or null`);
    const toks = code.split(/\s+/).filter(Boolean), seen = {}, ws = [];
    toks.forEach((tok) => {
      if (HOLE.test(tok)) { if (!o.templates) add('error', `unfilled blank "${tok}" in "${t}"`); return; }
      if (!/^[A-Z]/.test(tok)) { add('error', `"${tok}" in "${t}" is not a G-code word (should start with a capital letter)`); return; }
      if (!WORD.test(tok)) { add('error', `malformed word "${tok}" in "${t}" (a letter needs a plain number)`); return; }
      const L = tok[0], v = parseFloat(tok.slice(1)); ws.push({ L, v, tok });
      if (L !== 'G' && L !== 'M') { seen[L] = (seen[L] || 0) + 1; if (seen[L] > 1 && 'XYZABCFSTHDPQRIJKL'.includes(L)) add(rangeSev, `word ${L} appears twice in "${t}"`); }
      if (L === 'G') { if (!GSET.has('G' + pad2(Math.floor(v))) || !Number.isInteger(v)) add('warn', `G code ${tok} in "${t}" is not in the rules table`); }
      else if (L === 'M') { if (!MSET.has('M' + pad2(Math.floor(v))) || !Number.isInteger(v)) add('warn', `M code ${tok} in "${t}" is not in the rules table`); }
      else if (L === 'T') { if (!Number.isInteger(v) || v < 0 || v > 99) add(rangeSev, `tool number ${tok} in "${t}" is out of range 0..99`); }
      else if (L === 'S') { if (v < 0 || v > 60000) add(rangeSev, `spindle speed ${tok} in "${t}" is out of range 0..60000`); }
      else if (L === 'F') { if (!(v > 0)) add(rangeSev === 'error' ? 'error' : 'warn', `feed ${tok} in "${t}" is not above zero`); else if (v > 100000) add(rangeSev, `feed ${tok} in "${t}" is above 100000`); }
      else if (L === 'H' || L === 'D') { if (!Number.isInteger(v) || v < 0 || v > 999) add(rangeSev, `offset ${tok} in "${t}" is out of range 0..999`); }
      else if (L === 'P' || L === 'Q') { if (v < 0) add(rangeSev, `${tok} in "${t}" is negative`); }
      else if (AXIS.includes(L)) { if (Math.abs(v) > 1e5) add(rangeSev, `${tok} in "${t}" is beyond 100000`); if (!/\./.test(tok) && !o.templates && v !== 0 && Math.abs(v) < 1e5) add('warn', `axis word ${tok} in "${t}" has no decimal point (on many controls X5 means 0.0005)`); }
    });
    const gs = ws.filter((w) => w.L === 'G').map((w) => 'G' + pad2(w.v)), has = (L) => ws.some((w) => w.L === L);
    if (!o.templates) {   // (a template has blanks to fill in, so it cannot be judged yet)
      if ((gs.includes('G41') || gs.includes('G42')) && !has('D')) add(rangeSev, `cutter compensation without a D offset in "${t}"`);
      if (gs.includes('G43') && !has('H')) add(rangeSev, `tool length compensation without an H offset in "${t}"`);
      if (gs.includes('G04') && !has('P') && !has('X')) add(rangeSev, `dwell without a time in "${t}"`);
    }
    if ((gs.includes('G02') || gs.includes('G03')) && !has('R') && !has('I') && !has('J') && o.strict && !o.templates) add('warn', `arc without a radius or centre in "${t}"`);
    if (gs.some((g) => /^G(73|74|76|81|82|83|84|85|86|87|89)$/.test(g)) && !o.templates && o.strict && !(has('Z'))) add('warn', `canned cycle without Z depth in "${t}"`);
    if (gs.filter((g) => ['G00', 'G01', 'G02', 'G03'].includes(g)).length > 1) add('error', `two motion codes in one block "${t}"`);
    /* a converted line is final G-code: pressing Enter on it again must not change it */
    if (!o.templates && GC.tryConvertLine(t, {}) !== null && !/^[GMTNOFSXYZABCUVW]/.test(t)) add('warn', `output line "${t}" would be converted again`);
  });
  return P;
}
/* shortcuts whose output has blanks (__) to fill in */
const tmpl = (line) => /\bblock\b|b axis index|index b|program header|new program|start program/i.test(String(line).replace(/\s+/g, ' '));
const BADOUT = /(^|[^A-Za-z])(NaN|undefined|Infinity|null)([^A-Za-z]|$)|\[object/;

/* ---------------------------------------------------------------- independent program checker (a whole program, line by line) */
function checkProgram(text, o = {}) {
  const P = [], add = (msg) => P.push({ sev: 'error', msg });
  const lines = text.split('\n').map((l) => l.trim().replace(/;$/, '').trim()).filter((l) => l !== '');
  if (!lines.length) { add('the program is empty'); return P; }
  if (lines[0] === '%') { if (lines[lines.length - 1] !== '%' || lines.length < 3) add('the program starts with % but does not end with %'); if (!/^O\d{1,5}\b/.test(lines[1] || '')) add(`the % is not followed by an O program number (line 2 is "${lines[1] || ''}")`); }
  const st = { units: null, motion: null, tool: null, tlc: false, spindle: false, wcs: false, feed: false, coolant: false, comp: null, seenBefore: new Set(), moved: false, cut: false, homed: true, ended: false, tcs: 0 };
  lines.forEach((ln, idx) => {
    if (/^[%(]/.test(ln)) return;
    if (/^O\d/.test(ln)) return;
    const code = ln.replace(/\([^()]*\)/g, ' '), ws = code.split(/\s+/).filter(Boolean).map((tk) => ({ L: tk[0], v: parseFloat(tk.slice(1)), tk })).filter((w) => /^[A-Z]$/.test(w.L) && Number.isFinite(w.v));
    const G = ws.filter((w) => w.L === 'G').map((w) => 'G' + pad2(w.v)), M = ws.filter((w) => w.L === 'M').map((w) => 'M' + pad2(w.v)), has = (L) => ws.find((w) => w.L === L);
    const axes = ws.some((w) => 'XYZABC'.includes(w.L));
    const mo = G.find((g) => ['G00', 'G01', 'G02', 'G03'].includes(g)); if (mo) st.motion = mo;
    const at = `line ${idx + 1} "${ln}"`;
    if (st.ended && !/^M30|^M02/.test(ln)) add(`${at} comes after the end of the program (M30)`);
    G.forEach((g) => { if (g === 'G20') st.units = 'in'; if (g === 'G21') st.units = 'mm'; if (/^G5[4-9]$/.test(g)) st.wcs = true; });
    if (!st.moved) G.forEach((g) => st.seenBefore.add(g));
    if (G.includes('G40')) st.comp = null; if (G.includes('G41') || G.includes('G42')) st.comp = G.includes('G41') ? 'L' : 'R';
    if (G.includes('G49')) st.tlc = false;
    if (G.includes('G43')) { if (!st.tool) add(`${at}: tool length compensation (G43) before any tool is loaded`); else if (has('H') && has('H').v !== st.tool) add(`${at}: H${has('H').v} does not match the loaded tool T${st.tool}`); st.tlc = true; }
    if (M.includes('M08') || M.includes('M07') || M.includes('M88')) st.coolant = true; if (M.includes('M09')) st.coolant = false;
    const tw = has('T');
    if (tw && M.includes('M06')) {
      if (st.spindle) add(`${at}: tool change while the spindle is still running (no M05 before it)`);
      if (!st.homed) add(`${at}: tool change without retracting Z first (no G28 after the last cut)`);
      if (st.comp) add(`${at}: tool change with cutter compensation still on`);
      st.tool = tw.v; st.tlc = false; st.tcs++;
    }
    if (M.includes('M03') || M.includes('M04')) { st.spindle = true; }
    if (M.includes('M05')) st.spindle = false;
    if (has('F') && has('F').v > 0) st.feed = true;
    if (G.includes('G28')) st.homed = true;
    if (axes && !G.includes('G28') && !G.includes('G53') && !G.includes('G10') && !(G.includes('G91') && false)) {
      const m = mo || st.motion;
      if (!m) add(`${at}: a move with no G00 / G01 motion code set yet`);
      else {
        if (!st.moved) {
          ['G17', 'G40', 'G49', 'G80', 'G90'].forEach((g) => { if (![...st.seenBefore].includes(g)) add(`${at}: first move comes before the safe start block has ${g}`); });
          if (!st.units) add(`${at}: first move comes before the units (G20 / G21) are set`);
          st.moved = true;
        }
        if (m !== 'G00') {
          st.cut = true; st.homed = false;
          if (!st.tool) add(`${at}: cutting move before any tool change`); if (!st.tlc) add(`${at}: cutting move without tool length compensation (G43 H..)`);
          if (!st.spindle) add(`${at}: cutting move with the spindle off`); if (!st.wcs) add(`${at}: cutting move without a work offset (G54..)`);
          if (!st.feed) add(`${at}: cutting move without a feed rate (F)`);
          if (['G02', 'G03'].includes(m) && !has('R') && !has('I') && !has('J')) add(`${at}: arc without R or I / J`);
        } else if (axes && st.cut) st.homed = false;
      }
    }
    if (/^M30\b|^M02\b/.test(ln) || M.includes('M30') || M.includes('M02')) {
      if (st.spindle) add(`${at}: program ends with the spindle running`);
      if (st.coolant) add(`${at}: program ends with the coolant on`);
      if (st.comp) add(`${at}: program ends with cutter compensation on`);
      st.ended = true;
    }
    if (has('N')) { /* block numbers must rise */ const nv = has('N').v; if (st.lastN != null && nv <= st.lastN) add(`${at}: block number N${nv} does not rise (after N${st.lastN})`); st.lastN = nv; }
  });
  if (!st.ended) add('the program never ends with M30 (or M02)');
  if (o.units && st.units !== o.units) add(`the program should be in ${o.units} but the units are ${st.units}`);
  if (st.tcs !== (o.tools == null ? st.tcs : o.tools)) add(`${o.tools} tool change(s) were typed but ${st.tcs} were produced`);
  return P;
}

/* ---------------------------------------------------------------- building phrases */
const AWFUL_NUM = ['1e308', '-0', '1.2.3', '.', '..', '-.', '9'.repeat(40), '1e-9', 'NaN', 'Infinity', '1,5', '0x10', '١٢', '--5', '5-', '', '0', '-1', '99999999999', '12.5.5', '٣', '1e5', '0.0000001', '-99999', '00012'];
function fill(K, code, awful) {
  const nums = [];
  const R = {
    tool: () => String(K.ri(1, 30)), coord: () => { const v = (K.rf(-20, 20)).toFixed(K.ri(0, 4)); return K.pick([v, v.replace(/^(-?)0\./, '$1.'), String(Math.round(+v))]); },
    rpm: () => String(K.ri(1, 40) * 500), sfm: () => String(K.ri(1, 30) * 50), feed: () => K.pick([String(K.ri(1, 300)), (K.rf(1, 100)).toFixed(1)]), rad: () => (K.rf(0.1, 5)).toFixed(K.ri(0, 3)), small: () => String(K.ri(1, 5)), scale: () => (K.rf(0.5, 3)).toFixed(1),
  };
  const val = (kind) => { const v = awful && K.chance(0.6) ? K.pick(AWFUL_NUM) : R[kind](); nums.push({ kind, v }); return v; };
  let s = code;
  if (/ \/ /.test(s)) { const parts = s.split(' / '); s = K.chance(0.5) ? parts[0] : (parts[1].includes(' ') ? parts[1] : parts[0].replace(/\S+$/, '') + parts[1]); }
  s = s.replace(/T##/g, () => 'T' + val('tool')).replace(/H##/g, () => 'H' + val('tool')).replace(/D##/g, () => 'D' + val('tool')).replace(/O####/g, () => 'O' + K.ri(1000, 9999))
    .replace(/####/g, () => val('rpm')).replace(/###/g, () => val('sfm')).replace(/\b([XYZABCRQF])#/g, (m, l) => l + val(l === 'R' || l === 'Q' ? 'rad' : l === 'F' ? 'feed' : 'coord'))
    .replace(/ at ##/g, () => ' at ' + val('feed')).replace(/\d+–\d+/g, () => String(K.ri(1, 6))).replace(/##/g, () => '03').replace(/#\.#/g, () => val('scale')).replace(/#/g, () => val('small'));
  return { text: s, nums };
}
function numbersIn(s) { return (String(s).match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) || []).map(Number).filter(Number.isFinite); }
const closeNum = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const addSemi = (l) => { const t = l.replace(/\s+$/, ''); return t === '' || t.startsWith('(') || /^O\d+/.test(t) || t.startsWith('%') || t.endsWith(';') ? l : t + ';'; };
const unitsOf = (text) => { let u = null; for (const line of text.split('\n')) { const t = line.replace(/\([^)]*\)/g, '').toUpperCase(); if (/(^|[^A-Z0-9.])G20(?![0-9])/.test(t)) u = 'inch'; if (/(^|[^A-Z0-9.])G21(?![0-9])/.test(t)) u = 'metric'; } return u; };

/* ---------------------------------------------------------------- pressing Enter in the editor, and what must come out */
function expectedEnter(text, pos, auto) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1, nl = text.indexOf('\n', pos), end = nl === -1 ? text.length : nl, line = text.slice(lineStart, end);
  const conv = GC.tryConvertLine(line, { lastMotionModal: GC.getLastMotionModal(text.slice(0, lineStart)) });
  const hasNL = /[a-z]{3,}/i.test(line), hasGM = /\bG\d+|\bM\d+/i.test(line), mid = pos - lineStart > 0 && pos - lineStart < line.length;
  const pure = conv === null && /\bG\d+|\bM\d+|\b[XYZUVW]\s*-?\d|\bT\d+|\bS\d+|\bF\d+/i.test(line) && !/[a-z]{3,}/i.test(line.replace(/\([^)]*\)/g, ''));
  if (pure && mid) return { value: text.slice(0, pos) + '\n' + text.slice(pos), caret: pos + 1, kind: 'split', lineStart, end, line };
  if (hasGM && hasNL) return { kind: 'mixed', lineStart, end, line };
  let n2 = conv !== null ? conv : line; if (auto) n2 = n2.split('\n').map(addSemi).join('\n');
  return { value: text.slice(0, lineStart) + n2 + '\n' + text.slice(end), caret: lineStart + n2.length + 1, kind: 'convert', newLine: n2, conv, lineStart, end, line };
}
/* put text in the editor with the caret at `caret` (default: end), press Enter, return what happened */
function pressEnter(K, text, caret) {
  const pos = caret == null ? text.length : caret, auto = autoSemicolon, exp = expectedEnter(text, pos, auto);
  K.typeInto(editor, text, { caret: pos, keyup: false, change: false });
  const prevented = K.key('Enter', {}, editor), after = editor.value;
  K.check('Enter is handled by the editor (no stray newline from the browser)', prevented) || K.find('state', 'error', 'Enter in the editor was not handled (default action not prevented)', { where: 'enter default' });
  let newLine = null;
  if (exp.kind !== 'split') { const tail = text.length - exp.end; newLine = after.slice(exp.lineStart, after.length - tail - 1); }
  if (exp.kind === 'convert' || exp.kind === 'split') {
    K.check('Enter produces exactly what the conversion rules say', after === exp.value && editor.selectionStart === exp.caret) || K.find('oracle', 'error', `Enter on "${exp.line.slice(0, 60)}" gave "${(newLine == null ? after : newLine).slice(0, 80)}" but the rules give "${(exp.newLine == null ? exp.value : exp.newLine).slice(0, 80)}"`, { where: 'enter wiring ' + exp.kind, sample: `typed: ${text.slice(-200)}\nresult: ${after.slice(-200)}` });
  }
  return { exp, after, newLine, auto };
}
const GOOD = (K) => K.pick(PHRASES);
function converted(res) { return res.exp.kind === 'convert' && res.exp.conv !== null; }
/* check one pressed-Enter result: validity of what came out, and that the typed numbers survived */
function judge(K, res, filled, o) {
  if (res.exp.kind === 'convert') {
    if (res.exp.conv === null) {   // not converted: the line must be left exactly as typed (plus a semicolon if Auto ; is on)
      K.check('a line that is not a phrase is left alone', res.newLine === (res.auto ? addSemi(res.exp.line) : res.exp.line)) || K.find('oracle', 'error', `"${res.exp.line.slice(0, 50)}" is not a phrase but Enter changed it to "${(res.newLine || '').slice(0, 60)}"`, { where: 'unconverted changed' });
      return false;
    }
    const probs = checkOut(res.newLine, { strict: !!(o && o.strict), auto: res.auto, templates: tmpl(res.exp.line) });
    K.check('converted G-code is well formed', probs.filter((p) => p.sev === 'error').length === 0);
    probs.forEach((p) => K.find(p.sev === 'error' ? 'gcode' : p.sev === 'warn' ? 'gcode' : 'gcode', p.sev === 'info' ? 'info' : p.sev, `"${res.exp.line.slice(0, 60)}" -> ${p.msg}`, { where: p.msg.replace(/[\d.]+/g, '#').replace(/"[^"]*"/g, '"."').slice(0, 70), sample: `typed: ${res.exp.line}\nresult: ${res.newLine}` }));
    if (filled && o && o.strict && !/work offset/i.test(res.exp.line)) {
      const out = numbersIn(res.newLine.replace(/\([^)]*\)/g, ''));
      filled.nums.forEach((n) => { const x = Number(n.v); if (Number.isFinite(x) && !out.some((y) => closeNum(x, y))) K.find('oracle', 'warn', `the number ${n.v} typed in "${res.exp.line.slice(0, 60)}" is missing from the output "${res.newLine.slice(0, 60)}"`, { where: 'number lost ' + res.exp.line.replace(/[\d.\-]+/g, '#').slice(0, 40) }); });
    }
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------- program builder */
function buildProgram(K, o = {}) {
  const inch = o.units ? o.units === 'inch' : K.chance(0.5), L = [];
  if (K.chance(0.6)) L.push('program header');
  L.push(inch ? 'safety line inch' : 'safety line metric', 'work offset ' + K.ri(1, 6));
  const nOps = K.ri(1, 3); let t = K.ri(1, 6);
  for (let i = 0; i < nOps; i++, t += K.ri(1, 4)) {
    L.push(`change tool to T${t}`, `enable tool comp H${t}`, `spindle on ${K.ri(2, 20) * 500}`);
    if (K.chance(0.7)) L.push('coolant on');
    L.push(`rapid to X${K.rf(-5, 5).toFixed(2)} Y${K.rf(-5, 5).toFixed(2)}`, 'rapid to Z0.1', `feed to Z-${K.rf(0.05, 1).toFixed(2)} at ${K.ri(5, 80)}`);
    for (let j = K.ri(1, 3); j > 0; j--) L.push(`feed to X${K.rf(-5, 5).toFixed(2)} Y${K.rf(-5, 5).toFixed(2)}`);
    if (K.chance(0.4)) L.push(`arc clockwise to X${K.rf(-5, 5).toFixed(2)} Y${K.rf(-5, 5).toFixed(2)} R${K.rf(0.5, 3).toFixed(2)}`);
    if (K.chance(0.3)) L.push('optional stop');
    L.push('rapid to Z1', 'coolant off', 'spindle off', 'home z');
  }
  L.push('end block');
  return { lines: L, inch, tools: nOps };
}
async function typeProgram(K, lines) {
  editor.value = ''; K.typeInto(editor, '', {}); let cur = '';
  K.allowSlow(500); let i = 0; for (const l of lines) { const r = pressEnter(K, cur + l); cur = editor.value; judge(K, r, null, { strict: true }); await K.raf(); }
  return editor.value;
}

/* ---------------------------------------------------------------- fixtures */
const RAW = ['G00 G17 G40 G49 G80 G90', 'G01 X1.5 Y-2. F20.', 'G00 Z1.', 'T3 M06', 'S5000 M03', 'G43 H03 Z1.', '(OP 1 - FACE)', 'N10 G90', 'M30', '%', 'O1234 (TEST)', 'G02 X1. Y1. R1.', 'g1 x1 y2 f10', 'G1X1Y2F10', '/G01 X1.', 'G41 D01', 'G04 P2', 'M98 P1234', 'X1. Y2.', 'G81 G99 X1. Y2. Z-.5 R.1 F10.'];
const GARBAGE = ['asdf', 'G', 'M', 'T', 'X', '%%', '(', ')', '((((', '; ;', 'O', 'O0', 'N', 'G0 G1 G2', 'G999', 'M999', 'X.', 'F-5', 'S-1', 'G1 X', 'rapid to', 'feed to', 'feed to Z at', 'rapid to X', 'rapid to X Y', 'change tool to', 'change tool to T', 'spindle on abc', 'dwell', 'dwell seconds', 'arc clockwise to', 'C'.repeat(500), 'rapid to X' + '9'.repeat(300), '日本語', '😀', '\u0000G01', 'G01\u0007', '<img src=x onerror=alert(1)>', '<b>x</b>', 'comment <script>', '&amp; &lt;', '"\'`', '${7*7}', 'rapid to X1 Y2', 'RAPID TO X1 Y2', 'Rapid To X1 y2', 'rapid  to   X1   Y2', 'rapid to x1 y2 z3', 'rapid to X1Y2', 'rapid to X1,Y2', 'rapid to X1 Y2 F-3', 'feed to X1 at -5', 'feed to X1 at 0', 'feed to X1 at 1e308', 'spindle on 99999999999', 'spindle on -5', 'spindle on 0', 'cutter comp left', 'cutter comp right', 'cutter comp left D', 'work offset 0', 'work offset 99', 'work offset -1', 'call sub', 'call subroutine O', 'dwell 1e308 seconds', 'dwell -5 s', 'rotate coords 99999', 'scale factor 0', 'scale factor 1.2.3', 'orient spindle 360', 'tool change to T99999999999', 'change tool to T0', 'change tool to T-1', 'quick tool change T', 'enable tool comp H', 'peck drill X1 Y1', 'drill at', 'arc clockwise to X1 Y1', 'arc clockwise to X1 Y1 R', 'arc ccw X.5'];
const PROSE = ['please make this a safe program', 'rapid to the left and down', 'change the tool to the big one', 'start the spindle', 'the quick brown fox jumps over the lazy dog', 'M ', '   ', ''];

/* ---------------------------------------------------------------- the adapter */
window.__devApi = {
  name: 'Speed Programmer',
  covers: [
    'every shortcut and phrase on the cheat sheet is typed with in-range numbers and with awful ones (negative, 1e308, NaN, "1.2.3", ".", unicode digits, empty) and Enter is pressed; the editor must show exactly what the conversion rules say',
    'the G-code that comes out is checked by an independent checker: word syntax, no NaN / undefined / Infinity / unfilled number, axis words have a decimal point, feeds / speeds / tool numbers in range, every G and M code in the rules table, cutter / tool-length compensation have their offset, a converted line is final G-code',
    'whole programs are built from phrases and checked as programs: % and O-number, units and the safe start block before the first move, tool change and G43 before cutting, spindle on and feed set, spindle off and Z retract before a tool change, coolant and cutter compensation cancelled, M30 and the closing % at the end',
    'raw G-code lines pass through unchanged; G-code mixed with a phrase keeps its G-code; garbage and prose are left alone; Auto ; / Add ; / Remove ; keep every code line correct and round-trip',
    'the editor agrees with itself: line numbers, highlight text, units badge, Auto ; button; autocomplete lists and applies; cheat sheet and the Debug self-test open, are complete, and close; a 5000-line paste does not freeze',
    'the browser storage is backed up and restored, and the editor text you had is put back when the run ends',
  ],
  selectors: '.ac-item',
  modal: '#cheat-sheet-modal.visible, #debug-modal.visible, #alphaNotice:not([hidden])',
  coverOk: '#autocomplete, #toast, #status-pill',
  computed: '#units-badge, #status-pill, .ac-code, .ac-desc, .cheat-code, .cheat-desc, #debug-summary, .debug-output, #toast',
  markup: [{ root: '#highlight', allowed: 'span' }, { root: '#autocomplete', allowed: 'div, span' }, { root: '#cheat-sheet-content', allowed: 'div, span' }, { root: '#debug-body', allowed: 'div, span' }, { root: '#line-numbers', allowed: 'div' }],
  alpha: { popup: '#alphaNotice:not([hidden])', button: '#anGo' },
  slowKinds: ['paste'],
  allowance: () => Math.round(editor.value.length / 25),
  snapshot: () => { const s = { value: editor.value, auto: autoSemicolon, a: editor.selectionStart, b: editor.selectionEnd, top: editor.scrollTop }; BASE.value = s.value; return s; },
  restore: (s) => { hideAutocomplete(); cheatSheetModal.classList.remove('visible'); debugModal.classList.remove('visible'); if (autoSemicolon !== s.auto) autoSemicolonBtn.click(); editor.value = s.value; updateLineNumbers(); editor.setSelectionRange(s.a, s.b); editor.scrollTop = s.top; statusPill.classList.remove('show'); },
  state: () => ({ units: sel('#units-badge').textContent, 'auto ;': autoSemicolon, lines: editor.value.split('\n').length, 'cheat sheet': cheatSheetModal.classList.contains('visible'), debug: debugModal.classList.contains('visible'), autocomplete: acVisible, status: statusPill.textContent }),
  heal: (K, force) => { if (force) { cheatSheetModal.classList.remove('visible'); debugModal.classList.remove('visible'); } hideAutocomplete(); },
  baseline: async (K) => {
    cheatSheetModal.classList.remove('visible'); debugModal.classList.remove('visible'); hideAutocomplete();
    if (autoSemicolon) autoSemicolonBtn.click();
    editor.value = BASE.value; updateLineNumbers(); editor.setSelectionRange(editor.value.length, editor.value.length); statusPill.classList.remove('show');
  },
  check: (K) => {
    const v = editor.value, lines = v.split('\n');
    const nums = lineNums.children.length;
    K.check('line numbers match the number of lines', nums === lines.length && (lines.length > 300 || all('div', lineNums).every((d, i) => d.textContent === String(i + 1)))) || K.find('state', 'error', `The editor has ${lines.length} lines but the margin shows ${nums} line numbers`, { where: 'line numbers' });
    const NUL = /\u0000/g;   // (the browser's HTML parser drops NUL characters, so they are left out of the comparison)
    K.check('the highlight layer shows exactly the editor text (upper case)', highlight.textContent.replace(NUL, '') === lines.map((l) => l.toUpperCase()).join('\n').replace(NUL, '')) || K.find('state', 'error', 'The coloured text behind the editor differs from the editor text', { where: 'highlight text', sample: highlight.textContent.slice(0, 200) + ' | ' + v.slice(0, 200) });
    const u = unitsOf(v), badge = sel('#units-badge').textContent;
    K.check('the units badge matches the G20 / G21 in the text', badge === (u === 'inch' ? 'INCH (G20)' : u === 'metric' ? 'METRIC (G21)' : 'UNITS ?')) || K.find('state', 'error', `Units badge says "${badge}" but the program says ${u || 'nothing'}`, { where: 'units badge' });
    K.check('the Auto ; button shows its state', autoSemicolonBtn.textContent === (autoSemicolon ? 'Auto ; ON' : 'Auto ; OFF') && autoSemicolonBtn.classList.contains('auto-btn-active') === autoSemicolon) || K.find('state', 'error', `Auto semicolon is ${autoSemicolon ? 'on' : 'off'} but the button says "${autoSemicolonBtn.textContent}"`, { where: 'auto button' });
    K.check('the autocomplete list is shown only when it has items', acVisible === (acDropdown.style.display === 'block') && (!acVisible || acDropdown.querySelectorAll('.ac-item').length > 0)) || K.find('state', 'error', 'The autocomplete list state and its visibility disagree', { where: 'autocomplete state' });
    K.check('the editor text never contains a stray carriage return', !v.includes('\r')) || K.find('state', 'warn', 'The editor text contains a carriage return', { where: 'cr' });
  },
  fields: { '#editor': { gen: (K) => (K.chance(0.4) ? K.pick(RAW) + '\n' + fill(K, GOOD(K), false).text : K.chance(0.5) ? fill(K, GOOD(K), true).text : K.pick(GARBAGE)) } },
  actions: [
    { id: 'phrase', weight: 22, prior: 5, purpose: 'type a shortcut or phrase from the cheat sheet with sensible numbers on a new line and press Enter; check what comes out is exactly what the rules say and is valid G-code', expect: 'the line becomes valid G-code that still contains every number that was typed',
      run: async (K) => {
        const f = fill(K, GOOD(K), false), base = editor.value.replace(/\s+$/, ''), text = (base ? base + '\n' : '') + f.text;
        const r = pressEnter(K, text); const did = judge(K, r, f, { strict: true });
        K.feature(did ? 'phrases converted and checked' : 'phrases not recognised'); if (!did) K.find('oracle', 'warn', `The cheat-sheet phrase "${f.text.slice(0, 60)}" was not converted`, { where: 'phrase not converted ' + f.text.replace(/[\d.\-]+/g, '#').slice(0, 40), sample: f.text });
        return f.text.replace(/\s+/g, ' ') + ' -> ' + (r.newLine || '').replace(/\n/g, ' / ').slice(0, 50);
      } },
    { id: 'awkward', weight: 14, prior: 5, purpose: 'type phrases with awful numbers (negative, 1e308, NaN, 1.2.3, ".", unicode digits, empty), garbage, prose and control characters and press Enter', expect: 'the line is either converted into valid G-code or left exactly as typed; never malformed code, NaN or an error',
      run: async (K) => {
        const how = K.ri(0, 3); let f = { text: '', nums: [] };
        if (how === 0) f = fill(K, GOOD(K), true); else if (how === 1) f.text = K.pick(GARBAGE); else if (how === 2) f.text = K.pick(PROSE.concat(GARBAGE)); else { f = fill(K, GOOD(K), true); f.text = K.chance(0.5) ? f.text.toUpperCase() : f.text.replace(/ /g, K.pick(['  ', '\t', ' '])); }
        const base = K.chance(0.5) ? editor.value.replace(/\s+$/, '') : '', text = (base ? base + '\n' : '') + f.text;
        const r = pressEnter(K, text, K.chance(0.15) ? K.ri(0, text.length) : undefined); judge(K, r, null, { strict: false });
        K.feature('awkward lines tried'); return f.text.replace(/\s+/g, ' ').slice(0, 60);
      } },
    { id: 'gcode', weight: 7, prior: 3, purpose: 'type raw G-code lines (also lower case, with no spaces, with block numbers) and press Enter, at the end and in the middle of the line', expect: 'raw G-code is never rewritten; a middle-of-line Enter just splits the line',
      run: async (K) => {
        const line = K.pick(RAW), base = editor.value.replace(/\s+$/, ''), text = (base ? base + '\n' : '') + line, mid = K.chance(0.3) ? text.length - K.ri(1, Math.max(1, line.length - 1)) : undefined;
        const r = pressEnter(K, text, mid); if (r.exp.kind === 'convert' && r.exp.conv !== null) judge(K, r, null, { strict: true });
        K.check('raw G-code lines pass through unchanged', r.exp.kind !== 'convert' || r.exp.conv !== null || /^[A-Za-z]/.test(line) || r.newLine === (r.auto ? addSemi(line) : line)) || K.find('oracle', 'error', `Raw G-code "${line}" was changed to "${r.newLine}"`, { where: 'raw changed' });
        K.feature('raw G-code lines'); return line;
      } },
    { id: 'mixed', weight: 5, prior: 4, purpose: 'type a line that has G-code first and a phrase after it (for example "G41 feed to Z-.5 at 12") and press Enter', expect: 'the G-code part is kept as typed and only the phrase is converted',
      run: async (K) => {
        const pre = K.pick(['G41 D01', 'G90', 'G43 H01', 'G54', 'G17', 'M08', 'G17 G90', 'G42 D02']), phr = K.pick(['feed to Z-.5 at 12', 'rapid to X1 Y2', 'feed to X1 Y1 at 20', 'spindle on 4000', 'coolant on', 'change tool to T4', 'dwell 2 seconds', 'go to X2 Y3']), line = `${pre} ${phr}`;
        const base = editor.value.replace(/\s+$/, ''), r = pressEnter(K, (base ? base + '\n' : '') + line);
        const alone = GC.tryConvertLine(phr, { lastMotionModal: GC.getLastMotionModal(base) });
        if (r.exp.kind === 'mixed' && alone !== null) {
          const want = (r.auto ? (s) => s.split('\n').map(addSemi).join('\n') : (s) => s);
          K.check('G-code typed before a phrase is kept', r.newLine.startsWith(pre) || r.newLine.toUpperCase().startsWith(pre)) || K.find('oracle', 'error', `"${line}" became "${r.newLine}": the typed G-code "${pre}" was lost`, { where: 'mixed lost ' + pre.replace(/\d+/g, '#'), sample: `typed: ${line}\nresult: ${r.newLine}` });
          K.check('the phrase after the G-code is converted', r.newLine !== line && r.newLine.includes(want(alone).split('\n')[0].replace(/;$/, ''))) || K.find('oracle', 'warn', `"${line}" was left as "${r.newLine}" instead of converting "${phr}"`, { where: 'mixed not converted' });
          const probs = checkOut(r.newLine, { strict: true, auto: r.auto, templates: tmpl(line) }); probs.forEach((p) => K.find('gcode', p.sev === 'info' ? 'info' : p.sev, `"${line}" -> ${p.msg}`, { where: p.msg.replace(/[\d.]+/g, '#').slice(0, 60) }));
        }
        K.feature('G-code mixed with a phrase'); return line;
      } },
    { id: 'program', weight: 3, prior: 4, purpose: 'build a whole program from phrases (header, safe start, tool changes, cuts, end block), press Enter on every line and check the finished program as a program', expect: 'a complete, safely ordered program with units, tool changes, M30 and the closing %',
      run: async (K) => {
        const b = buildProgram(K), text = await typeProgram(K, b.lines);
        const probs = checkProgram(text, { units: b.inch ? 'in' : 'mm', tools: b.tools });
        K.check('a program built from phrases is a complete, safe program', probs.length === 0);
        probs.forEach((p) => K.find('gcode', 'error', p.msg, { where: 'program ' + p.msg.replace(/[\d.]+/g, '#').replace(/"[^"]*"/g, '"."').slice(0, 70), sample: text.slice(0, 700) }));
        K.feature('whole programs built and checked'); return `${b.lines.length} phrases, ${b.tools} tool(s), ${b.inch ? 'inch' : 'metric'}`;
      } },
    { id: 'semicolons', weight: 5, prior: 4, purpose: 'press Add ; and Remove ; on a program and check only the code lines change, nothing is lost, and Remove ; undoes Add ;', expect: 'Add ; puts one semicolon at the end of every code line; Remove ; takes them all off again',
      run: async (K) => {
        const lines = Array.from({ length: K.ri(2, 10) }, () => K.pick(RAW.concat(['rapid to X1 Y2', '', '  G01 X1.  ', 'M30  ']))); K.typeInto(editor, lines.join('\n'));
        const before = editor.value.split('\n');
        const isCode = (l) => { const t = l.trim(); return t !== '' && !t.startsWith('(') && !/^O\d/.test(t) && !t.startsWith('%') && GC.tryConvertLine(t, {}) === null && (/\bG\d+|\bM\d+|\b[XYZUVW]\s*-?\d/.test(t) || /\bT\d+|\bS\d+|\bF\d+/.test(t)); };
        await K.realClick(addSemicolonsBtn); const added = editor.value.split('\n');
        K.check('Add ; keeps the number of lines', added.length === before.length) || K.find('oracle', 'error', 'Add ; changed the number of lines', { where: 'add count' });
        const bad = before.map((l, i) => [l, added[i]]).filter(([l, a]) => (isCode(l) ? !(a.trimEnd().endsWith(';') && a.trimEnd().slice(0, -1).trimEnd() === l.trimEnd().replace(/;$/, '').trimEnd()) && a.trimEnd() !== l.trimEnd() : a !== l));
        K.check('Add ; touches exactly the code lines', bad.length === 0) || K.find('oracle', 'error', `Add ; gave "${bad[0] && bad[0][1]}" for "${bad[0] && bad[0][0]}"`, { where: 'add wrong', sample: before.join('\n') + '\n---\n' + added.join('\n') });
        await K.realClick(addSemicolonsBtn); K.check('Add ; twice changes nothing more', editor.value === added.join('\n')) || K.find('oracle', 'error', 'Pressing Add ; a second time changed the program again (a double semicolon?)', { where: 'add twice', sample: added.join('\n') + '\n---\n' + editor.value });
        K.check('the status says there was nothing more to add', /No G-code lines need semicolons/.test(statusPill.textContent)) || K.find('state', 'warn', `After a second Add ; the status says "${statusPill.textContent}"`, { where: 'add status' });
        await K.realClick(removeSemicolonsBtn); const removed = editor.value.split('\n');
        K.check('Remove ; leaves no line ending in a semicolon', removed.every((l) => !l.trimEnd().endsWith(';'))) || K.find('oracle', 'error', 'Remove ; left a trailing semicolon', { where: 'remove left' });
        K.check('Remove ; undoes Add ;', removed.length === before.length && before.every((l, i) => removed[i].trimEnd() === l.trimEnd().replace(/;+$/, '').trimEnd() || removed[i].trimEnd() === l.trimEnd())) || K.find('oracle', 'error', 'Add ; then Remove ; did not give back the original program', { where: 'roundtrip', sample: before.join('\n') + '\n---\n' + removed.join('\n') });
        K.feature('semicolon round trips'); return `${before.length} lines`;
      } },
    { id: 'autosemi', weight: 4, prior: 3, purpose: 'switch Auto ; on, convert phrases and switch it off again', expect: 'with Auto ; on every converted code line ends with one semicolon; with it off none does',
      run: async (K) => {
        await K.realClick(autoSemicolonBtn); const on = autoSemicolon;
        const f = fill(K, GOOD(K), false), r = pressEnter(K, f.text);
        if (r.exp.kind === 'convert' && r.exp.conv !== null) {
          const code = r.newLine.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('(') && !/^O\d/.test(l) && !l.startsWith('%'));
          K.check('with Auto ; on every converted code line ends in a semicolon', !on || code.every((l) => l.trimEnd().endsWith(';') && !l.trimEnd().endsWith(';;'))) || K.find('oracle', 'error', `Auto ; is on but "${r.newLine.replace(/\n/g, ' / ')}" is missing semicolons`, { where: 'auto semi' });
          K.check('with Auto ; off no semicolon is added', on || !r.newLine.includes(';')) || K.find('oracle', 'error', 'Auto ; is off but a semicolon was added', { where: 'auto semi off' });
          checkOut(r.newLine, { strict: true, auto: on, templates: tmpl(f.text) }).forEach((p) => K.find('gcode', p.sev === 'info' ? 'info' : p.sev, `${p.msg}`, { where: 'autosemi ' + p.msg.replace(/[\d.]+/g, '#').slice(0, 50) }));
        }
        if (K.chance(0.7)) await K.realClick(autoSemicolonBtn);
        K.feature('Auto ; toggled'); return `${on ? 'on' : 'off'}: ${f.text}`;
      } },
    { id: 'autocomplete', weight: 5, prior: 3.5, purpose: 'type the start of a phrase, press Tab for the suggestions, move through them and accept or dismiss', expect: 'the list shows the suggestions for what was typed, accepting one replaces the line, Escape closes it',
      run: async (K) => {
        const src = K.pick(PHRASES.concat(['G0', 'M0', 'spin', 'cool', 'feed', 'zz', 'x']).filter(Boolean)), pre = src.slice(0, K.ri(2, Math.max(2, src.length))), base = editor.value.replace(/\s+$/, ''), text = (base ? base + '\n' : '') + pre;
        K.typeInto(editor, text); K.key('Tab', {}, editor);
        const expect = GC.getAutocompleteSuggestions(pre.trim());
        K.check('Tab shows suggestions exactly when there are some', acVisible === (expect.length > 0)) || K.find('state', 'error', `Typing "${pre}" and pressing Tab: ${expect.length} suggestions expected, list is ${acVisible ? 'shown' : 'hidden'}`, { where: 'tab suggestions' });
        if (acVisible) {
          const rows = all('.ac-item', acDropdown);
          K.check('the list has one row per suggestion (at most 16)', rows.length === expect.length && rows.length <= 16) || K.find('oracle', 'error', `${rows.length} rows shown, ${expect.length} suggestions expected`, { where: 'ac rows' });
          K.check('every suggestion has a code and a description', rows.every((r) => r.querySelector('.ac-code').textContent.trim() && r.querySelector('.ac-desc').textContent.trim())) || K.find('state', 'warn', 'A suggestion has an empty code or description', { where: 'ac empty' });
          const n = K.ri(0, rows.length - 1); for (let i = 0; i <= n; i++) K.key('ArrowDown', {}, editor);
          const how = K.ri(0, 2);
          if (how === 0) { K.key('Enter', {}, editor); K.check('Enter accepts the highlighted suggestion', editor.value.split('\n').pop() === expect[n].code && !acVisible) || K.find('oracle', 'error', `Accepting suggestion ${n + 1} gave "${editor.value.split('\n').pop()}" instead of "${expect[n].code}"`, { where: 'ac accept' }); }
          else if (how === 1) { K.key('Escape', {}, editor); K.check('Escape closes the suggestions', !acVisible && editor.value === text) || K.find('state', 'error', 'Escape did not close the suggestion list (or changed the text)', { where: 'ac escape' }); }
          else { rows[n].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); K.check('clicking a suggestion applies it', editor.value.split('\n').pop() === expect[n].code && !acVisible) || K.find('oracle', 'error', 'Clicking a suggestion did not apply it', { where: 'ac click' }); }
        }
        K.feature('autocomplete used'); return `"${pre}" -> ${expect.length} suggestions`;
      } },
    { id: 'panels', weight: 4, prior: 3, purpose: 'open the Cheat Sheet and the Debug self-test, check they are complete, and close them (X button, click outside)', expect: 'every cheat-sheet row is listed, the self-test has no failing row, and each popup closes',
      run: async (K) => {
        const which = K.chance(0.5) ? 'cheat' : 'debug', btn = which === 'cheat' ? sel('#cheat-sheet-btn') : sel('#debug-btn'), modal = which === 'cheat' ? cheatSheetModal : debugModal;
        await K.realClick(btn); K.check(`the ${which} popup opens`, modal.classList.contains('visible')) || K.find('state', 'error', `The ${which} popup did not open`, { where: which + ' open' });
        if (which === 'cheat') {
          const rows = all('.cheat-item', cheatSheetContent);
          K.check('the cheat sheet lists every phrase and code', rows.length === ITEMS.length) || K.find('oracle', 'error', `The cheat sheet shows ${rows.length} rows but the rules have ${ITEMS.length}`, { where: 'cheat count' });
          K.check('no cheat-sheet row is empty', rows.every((r) => r.querySelector('.cheat-code').textContent.trim() && r.querySelector('.cheat-desc').textContent.trim())) || K.find('state', 'warn', 'A cheat-sheet row has an empty code or description', { where: 'cheat empty' });
        } else {
          const fails = all('.debug-row.fail', debugBody), summary = debugSummary.textContent;
          K.check('the Debug self-test has no failing conversion', fails.length === 0) || K.find('oracle', 'error', `The Debug self-test reports ${fails.length} failing conversion(s): ${fails.slice(0, 4).map((r) => r.querySelector('.debug-input').textContent.trim()).join('; ')}`, { where: 'debug fails ' + fails.length, sample: summary });
          K.check('the Debug self-test lists every cheat-sheet item', all('.debug-row', debugBody).length === ITEMS.length) || K.find('oracle', 'error', `The Debug panel lists ${all('.debug-row', debugBody).length} rows but there are ${ITEMS.length} cheat-sheet items`, { where: 'debug rows' });
        }
        const way = K.ri(0, 2);
        if (way === 0) await K.realClick(which === 'cheat' ? closeCheatSheetBtn : closeDebugBtn); else if (way === 1) { const r = modal.getBoundingClientRect(); K.fire(modal, 'click', r.left + 3, r.top + 3); } else { K.key('Escape', {}, document.body); }
        const closed = !modal.classList.contains('visible');
        if (way === 2 && !closed) { K.find('stuck-overlay', 'info', `Escape does not close the ${which} popup (only its X button or a click outside does)`, { where: which + ' escape' }); modal.classList.remove('visible'); }
        else K.check(`the ${which} popup closes`, closed) || K.find('stuck-overlay', 'error', `The ${which} popup did not close`, { where: which + ' close ' + way });
        K.feature(which + ' popup opened and closed'); return `${which}, closed ${['with X', 'by clicking outside', 'with Escape'][way]}`;
      } },
    { id: 'edit', weight: 6, prior: 3.5, purpose: 'edit the program the way a person does (insert, delete, new line, change case, paste a block) and check the margin, colours and units badge follow', expect: 'line numbers, colours and the units badge always describe the current text',
      run: async (K) => {
        let v = editor.value; const how = K.ri(0, 8), p = K.ri(0, v.length);
        if (how === 0) v = v.slice(0, p) + K.pick(['G20', 'G21', '(G21)', ' G20 ', 'x', '\n', '<', '&', '"', ';']) + v.slice(p); else if (how === 1) v = v.slice(0, p) + v.slice(p + K.ri(1, 40)); else if (how === 2) v += '\n' + K.pick(RAW); else if (how === 3) v = v.toLowerCase(); else if (how === 4) v = v.toUpperCase();
        else if (how === 5) v = v.split('\n').reverse().join('\n'); else if (how === 6) v = '\n\n' + v + '\n\n'; else if (how === 7) v = v.replace(/G2[01]/g, ''); else v = K.pick(['', '%', 'G20', 'G21\nG20', '(G20)', 'G20 (G21)', 'G21 G20']);
        K.typeInto(editor, v, { caret: K.ri(0, v.length) }); return ['insert text', 'delete text', 'add a raw line', 'lower case', 'upper case', 'reverse the lines', 'blank lines around', 'remove units', 'replace everything'][how];
      } },
    { id: 'paste', weight: 1, prior: 2.5, purpose: 'paste a very long program (thousands of lines) and press Enter in it', expect: 'the margin, colours and units badge update within a couple of seconds',
      run: async (K) => {
        const n = K.ri(500, 5000), one = BASE.value.split('\n'), big = Array.from({ length: n }, (_, i) => one[i % one.length]).join('\n'); K.allowSlow(2500);
        const t0 = K.now(); K.typeInto(editor, big, { caret: K.ri(0, big.length) }); const ms = K.now() - t0;
        K.check('a very long program is drawn promptly', ms < 2500) || K.find('slow', 'warn', `${n} lines took ${Math.round(ms)} ms to draw`, { where: 'paste slow' });
        K.key('Enter', {}, editor); K.feature('long programs'); return `${n} lines in ${Math.round(ms)} ms`;
      } },
  ],
  flows: {},
  setups: {},
};
const FL = window.__devApi.flows, SU = window.__devApi.setups;
FL['build and check complete programs'] = async (K) => {
  for (const units of ['inch', 'metric']) { const b = buildProgram(K, { units }), text = await typeProgram(K, b.lines), probs = checkProgram(text, { units: units === 'inch' ? 'in' : 'mm', tools: b.tools });
    K.check('a program built from phrases is a complete, safe program', probs.length === 0); probs.forEach((p) => K.find('gcode', 'error', p.msg, { where: 'program ' + p.msg.replace(/[\d.]+/g, '#').replace(/"[^"]*"/g, '"."').slice(0, 70), sample: text.slice(0, 700) })); }
};
FL['every documented phrase gives the documented G-code'] = async (K) => {
  const table = typeof _LEGACY_DEBUG_START !== 'undefined' ? _LEGACY_DEBUG_START : [];
  let n = 0;
  for (const t of table) {
    if (++n % 4 === 0) await K.raf();
    if (typeof t.expect !== 'string') continue; if (autoSemicolon) autoSemicolonBtn.click();
    const r = pressEnter(K, t.input);
    K.check('documented phrases give the documented code', r.newLine === t.expect) || K.find('oracle', 'error', `"${t.input}" gives "${r.newLine}" but the documented result is "${t.expect}"`, { where: 'documented ' + t.input });
    checkOut(r.newLine, { strict: true, templates: tmpl(t.input) }).forEach((p) => K.find('gcode', p.sev === 'info' ? 'info' : p.sev, `"${t.input}" -> ${p.msg}`, { where: 'documented check ' + p.msg.replace(/[\d.]+/g, '#').slice(0, 50) }));
  }
};
FL['every cheat-sheet phrase with good numbers'] = async (K) => {
  let n = 0;
  for (const code of PHRASES) {
    if (++n % 4 === 0) await K.raf();
    if (autoSemicolon) autoSemicolonBtn.click(); const f = fill(K, code, false), r = pressEnter(K, f.text);
    if (!judge(K, r, f, { strict: true })) K.find('oracle', 'warn', `The cheat-sheet entry "${code}" (typed as "${f.text}") is not converted`, { where: 'cheat entry not converted ' + code });
  }
};
FL['every cheat-sheet phrase with awful numbers'] = async (K) => {
  let n = 0;
  for (const code of PHRASES) { if (++n % 3 === 0) await K.raf(); if (autoSemicolon) autoSemicolonBtn.click(); for (let i = 0; i < 2; i++) { const f = fill(K, code, true), r = pressEnter(K, f.text); judge(K, r, f, { strict: false }); } }
};
FL['garbage gauntlet'] = async (K) => {
  let n = 0;
  for (const g of GARBAGE.concat(PROSE)) { if (++n % 3 === 0) await K.raf(); const r = pressEnter(K, g); judge(K, r, null, { strict: false }); }
};
FL['Auto ; on while converting a program'] = async (K) => {
  if (!autoSemicolon) await K.realClick(autoSemicolonBtn);
  const b = buildProgram(K), text = await typeProgram(K, b.lines), code = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('(') && !/^O\d/.test(l) && !l.startsWith('%'));
  K.check('with Auto ; on every code line of a built program ends in one semicolon', code.every((l) => l.trimEnd().endsWith(';') && !l.trimEnd().endsWith(';;'))) || K.find('oracle', 'error', 'With Auto ; on, a line of the built program has no (or two) semicolons: ' + code.find((l) => !l.trimEnd().endsWith(';') || l.trimEnd().endsWith(';;')), { where: 'auto program', sample: text.slice(0, 600) });
  checkProgram(text, { tools: b.tools }).forEach((p) => K.find('gcode', 'error', 'with Auto ; on: ' + p.msg, { where: 'auto program struct ' + p.msg.replace(/[\d.]+/g, '#').slice(0, 50) }));
  await K.realClick(autoSemicolonBtn);
};
FL['panels and buttons in a row'] = async (K) => {
  for (let i = 0; i < 6; i++) {
    const b = K.pick([sel('#cheat-sheet-btn'), sel('#debug-btn'), sel('#auto-semicolon-btn'), sel('#add-semicolons-btn'), sel('#remove-semicolons-btn')]);
    await K.realClick(b); await K.raf(); heal();
  }
  function heal() { cheatSheetModal.classList.remove('visible'); debugModal.classList.remove('visible'); }
};
FL['keyboard storm in the editor'] = async (K) => {
  if (editor.value.length > 30000) K.typeInto(editor, BASE.value);   // (a normal-sized program: the cost of a 5000-line paste is tested on its own)
  editor.focus();
  for (let i = 0; i < 80; i++) { const k = K.pick(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'a', 'x', ' ', 'Backspace']); K.key(k, { ctrl: K.chance(0.1), shift: K.chance(0.1) }, editor); if (K.chance(0.3)) K.typeInto(editor, editor.value + K.pick(['\nrapid to X1', 'g', ' ', 'sp']), { change: false }); await K.raf(); }
};
SU['an empty editor'] = async (K) => { K.typeInto(editor, ''); };
SU['the sample program with Auto ; on'] = async (K) => { if (!autoSemicolon) await K.realClick(autoSemicolonBtn); };
SU['one very long line'] = async (K) => { K.typeInto(editor, 'G01 ' + 'X1. '.repeat(3000)); };
SU['two thousand lines'] = async (K) => { K.typeInto(editor, Array.from({ length: 2000 }, (_, i) => `rapid to X${i % 10} Y${i % 7}`).join('\n')); };
SU['a metric program'] = async (K) => { K.typeInto(editor, 'safety line metric\nG21\n(METRIC)\n'); };

/* ---------------------------------------------------------------- stress scenarios (Stress test mode): run at sizes 1, 2, 4, 8 ... (level) and timed */
const SS = window.__devApi.stress = {};
const STRESS_LINES = ['G00 G17 G40 G49 G80 G90', 'G01 X1.5 Y-2. F20.', 'G00 Z1.', 'T3 M06', 'S5000 M03', 'G43 H03 Z1.', '(OP 1 - FACE)', 'G02 X2. Y2. R1. F15.', 'G01 Z-.25 F10.', 'M08', 'G00 Z1.', 'M09'];
const bigText = (n) => Array.from({ length: n }, (_, i) => STRESS_LINES[i % STRESS_LINES.length]).join('\n');
const phraseText = (K, n) => Array.from({ length: n }, () => K.pick(['rapid to X1 Y2', 'feed to Z-.1 at 20', 'spindle on 5000', 'coolant on', 'change tool to T3', 'arc clockwise to X1 Y1 R.5', 'home z'])).join('\n');
SS['paste a program of 100 x size lines'] = async (K, level) => { K.allowSlow(60000); K.typeInto(editor, bigText(100 * level)); await K.raf(); };
SS['paste a program of 100 x size lines of plain-English phrases'] = async (K, level) => { K.allowSlow(60000); K.typeInto(editor, phraseText(K, 100 * level)); await K.raf(); };
SS['one single line, 500 x size characters long'] = async (K, level) => { K.allowSlow(60000); K.typeInto(editor, 'G01 ' + 'X1. '.repeat(125 * level)); await K.raf(); };
SS['press Enter on 10 x size phrases in a row at the end of a growing program'] = async (K, level) => {
  K.allowSlow(60000); editor.value = ''; K.typeInto(editor, ''); let cur = '';
  for (let i = 0; i < 10 * level; i++) { const r = pressEnter(K, cur + (i % 3 ? 'feed to X' + (i % 9) + ' Y1 at 20' : 'rapid to Z1')); cur = editor.value; if (i % 40 === 0) await K.raf(); }
};
SS['convert every cheat-sheet phrase, size times over'] = async (K, level) => { K.allowSlow(60000); const reps = Math.min(level, 32); for (let r = 0; r < reps; r++) for (const ph of PHRASES.slice(0, 80)) { pressEnter(K, ph); if (r === 0) await K.raf(); } };
SS['Add ; then Remove ; on a program of 100 x size lines'] = async (K, level) => {
  K.allowSlow(60000); const text = bigText(100 * level).replace(/\n\(OP 1 - FACE\)/g, ''); K.typeInto(editor, text); await K.raf();
  await K.realClick(sel('#add-semicolons-btn')); await K.raf(); const added = editor.value; await K.realClick(sel('#remove-semicolons-btn')); await K.raf();
  K.check('Add ; then Remove ; gives the program back', editor.value === text) || K.find('oracle', 'warn', 'Add ; then Remove ; did not give the same program back at ' + text.split('\n').length + ' lines', { where: 'semicolon round trip' });
  K.check('Add ; puts a semicolon on every line', added.split('\n').filter((l) => l.trim()).every((l) => /;\s*$/.test(l)) || added.length > text.length);
};
SS['Tab autocomplete at the end of a program of 100 x size lines'] = async (K, level) => { K.allowSlow(60000); K.typeInto(editor, bigText(100 * level) + '\nrap'); editor.setSelectionRange(editor.value.length, editor.value.length); for (let i = 0; i < 3; i++) { K.key('Tab', {}, editor); await K.raf(); } };
SS['edit in the middle of a program of 100 x size lines, 10 times'] = async (K, level) => {
  K.allowSlow(60000); const lines = bigText(100 * level).split('\n'); K.typeInto(editor, lines.join('\n')); await K.raf();
  for (let i = 0; i < 10; i++) { const at = lines.slice(0, Math.floor(lines.length / 2)).join('\n').length; const v = editor.value; K.typeInto(editor, v.slice(0, at) + (i % 2 ? ' ' : 'X') + v.slice(at), { caret: at + 1 }); await K.raf(); }
};
SS['open and close the cheat sheet, Debug and Auto ; on a program of 100 x size lines'] = async (K, level) => {
  K.allowSlow(60000); K.typeInto(editor, bigText(100 * level)); await K.raf();
  for (const b of ['#cheat-sheet-btn', '#debug-btn', '#auto-semicolon-btn']) { await K.realClick(sel(b)); await K.raf(); cheatSheetModal.classList.remove('visible'); debugModal.classList.remove('visible'); }
  if (autoSemicolon) await K.realClick(sel('#auto-semicolon-btn'));
};
SS['rapid typing: 20 x size keystrokes into a program of 200 lines'] = async (K, level) => {
  K.allowSlow(60000); K.typeInto(editor, bigText(200)); editor.focus();
  for (let i = 0; i < 20 * level; i++) { K.key(K.pick(['a', 'x', ' ', '1', '.', 'Backspace', 'Enter', 'ArrowDown']), {}, editor); if (i % 200 === 0) await K.raf(); }
};
SU['CRLF line endings pasted'] = async (K) => { K.typeInto(editor, 'G20\r\nG90\r\nrapid to X1 Y2\r\n'); };
})();
