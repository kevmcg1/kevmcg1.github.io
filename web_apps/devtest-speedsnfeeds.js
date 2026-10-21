/* =====================================================================
   Dev-tool adapter for "Speeds & Feeds" (speedsnfeeds.html). Loaded together with devtest.js the first time the backtick key is pressed
   (or when the page is opened with ?dev=quick|standard|thorough|problems). It tells the generic tester what this page is and adds the
   checks that only make sense here:
     - an independent re-calculation of every number the page shows (RPM = SFM x 3.82 / D, IPM = RPM x flutes x FPT, the stepover and
       depth-of-cut adjustments, axial / radial depth of cut, inch / mm conversion) written from the formulas, not copied from the page
     - tool specs generated line by line from a known truth (so the page's reading of "1/2\"", ".5\"", "12.7 mm", "0.5 inch", "1 1/2\"" ... is checked)
     - the same tool written in different units must give the same answer; materials, tool materials and every dropdown choice
     - awful input: empty, huge, unicode, HTML, negatives, 1e308, NaN, division by zero, odd units, mixed metric / imperial
     - nothing ever shows NaN / undefined / Infinity, typed text never turns into markup, no freezes on long lines
   ===================================================================== */
(() => {
'use strict';
const sel = (s) => document.querySelector(s), all = (s, r = document) => [...r.querySelectorAll(s)];
const MATS = Object.keys(materialData);

/* ---------------------------------------------------------------- an independent model of the maths */
const stepAdj = (s) => (s > 50 ? Math.min(1 + (s / 50 - 1) * 0.4, 1.2) : Math.max(0.7, s / 50));
const docAdj = (d) => (d > 50 ? Math.max(0.5, 1 / Math.sqrt(d / 50)) : Math.min(1.5, 1 / Math.sqrt(d / 50)));
const OPS = { slotting: [0.5, 1.0], 'heavy-roughing': [1.25, 0.5], 'light-roughing': [1.25, 0.2], finishing: [2.0, 0.05] };
const category = (D) => (D <= 0.25 ? 'small' : D <= 0.5 ? 'medium' : 'large');
/* t = { D (inches), flutes (or null = 2), carbide, fpt (or null), step (or null = 50), doc (or null = 50), op (or null) } */
function model(t, mat) {
  const m = materialData[mat], ms = t.carbide ? m.carbide : m.hss, step = t.step == null ? 50 : t.step, doc = t.doc == null ? 50 : t.doc, flutes = t.flutes == null ? 2 : t.flutes;
  const adj = stepAdj(step) * docAdj(doc);
  let r0 = Math.round(ms.sfm[0] * 3.82 / t.D), r1 = Math.round(ms.sfm[1] * 3.82 / t.D);
  if (doc > 50) { const red = Math.max(0.7, 1 / Math.sqrt(doc / 50)); r0 = Math.round(r0 * red); r1 = Math.round(r1 * red); }
  const custom = t.fpt != null && t.fpt > 0, base = ms.fpt[category(t.D)];
  const f0 = custom ? t.fpt * adj : base[0] * adj, f1 = custom ? t.fpt * adj : base[1] * adj;
  const out = { rpm: [r0, r1], ipm: [Math.round(r0 * flutes * f0), Math.round(r1 * flutes * f1)], fpt: [f0, f1], sfm: ms.sfm, adj, custom, step, doc, name: m.name };
  if (t.op) { const [a, r] = OPS[t.op]; out.axial = (t.D * a).toFixed(4); out.radial = (t.D * r).toFixed(4); out.dia = t.D.toFixed(3); }
  return out;
}
/* sizes as a person would write them: [text, inches] */
function sizeTokens(K) {
  const fr = K.pick([[1, 16], [1, 8], [3, 16], [1, 4], [5, 16], [3, 8], [7, 16], [1, 2], [9, 16], [5, 8], [3, 4], [7, 8], [1, 1]]), v = fr[0] / fr[1], mm = K.pick([1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 12.7, 16, 20, 25]);
  const dec = (digits, lead) => { const t = v.toFixed(digits); return [(lead ? t.replace(/^0/, '') : t) + '"', Number(t)]; };   // the truth is the number as WRITTEN (".438" is 0.438)
  return K.pick([
    () => [`${fr[0]}/${fr[1]}"`, v], () => [`${fr[0]}/${fr[1]}"`, v], () => [`${v}"`, v], () => dec(3, false), () => dec(4, true), () => dec(3, true),
    () => [`${mm}mm`, mm / 25.4], () => [`${mm} mm`, mm / 25.4], () => [`${v} inch`, v], () => [`${fr[0]}/${fr[1]} inch`, v], () => [`1 ${fr[0]}/${fr[1]}"`, 1 + v],
  ])();
}
const FILL = { type: ['endmill', 'end mill', 'ball mill', 'face mill', 'drill', 'reamer', 'tap', 'chamfer', 'dovetail'], mats: ['HSS', 'carbide', 'cobalt', 'tungsten carbide', null, null], ops: ['heavy roughing', 'light roughing', 'slotting', 'finishing', null, null, null] };
/* one tool line built from a known truth: returns { line, t (truth for model()), why } */
function genTool(K, opts = {}) {
  const [stext, D] = opts.size || sizeTokens(K), n = K.ri(1, 99), mat = opts.mat === undefined ? K.pick(FILL.mats) : opts.mat, op = opts.op === undefined ? K.pick(FILL.ops) : opts.op;
  const t = { D, flutes: K.chance(0.6) ? K.ri(1, 8) : null, carbide: !!mat && /carbide/i.test(mat), fpt: K.chance(0.4) ? +(K.rf(0.0002, 0.012)).toFixed(4) : null, step: K.chance(0.5) ? K.pick([5, 10, 15, 25, 40, 50, 60, 75, 100]) : null, doc: K.chance(0.5) ? K.pick([5, 10, 20, 25, 30, 40, 50, 60, 100, 150]) : null, op: op ? op.replace(' ', '-') : null };
  const parts = [{ w: 'size', s: stext }];
  if (t.flutes != null) parts.push({ s: `${t.flutes} flute` });
  if (mat) parts.push({ s: mat }); if (K.chance(0.7)) parts.push({ s: K.pick(FILL.type) });
  if (t.fpt != null) parts.push({ s: `${String(t.fpt).replace(/^0\./, '.')} fpt` });
  if (t.step != null) parts.push({ s: `${t.step}% stepover` }); if (t.doc != null) parts.push({ s: `${t.doc}% doc` });
  if (op) parts.push({ s: op });
  for (let i = parts.length - 1; i > 0; i--) { const j = K.ri(0, i); [parts[i], parts[j]] = [parts[j], parts[i]]; }   // any order
  const head = K.pick([`T${n}`, `Tool #${n}`, `Position ${n}`, `tool ${n}`]);
  const body = parts.map((p) => p.s).join(', ');
  const line = K.chance(0.25) ? `${head}: ${body}` : `${head}, ${body}`;
  /* the size the page should use is the FIRST size written on the line; parts were shuffled, the others contain no size */
  return { line, t, head, why: `${stext} -> ${D.toFixed(4)} in` };
}

/* ---------------------------------------------------------------- reading the page */
const num = (s) => { const x = parseFloat(String(s).replace(/[^0-9eE.+\-NaInfity]/g, '')); return x; };
function pair(s) { const p = String(s).split(' - '); return p.length === 2 ? [Number(p[0]), Number(p[1])] : [Number(p[0]), Number(p[0])]; }
function readTools() {
  return all('#results .tool-container').map((c) => {
    const specs = all('.spec-item', c).map((i) => ({ label: i.querySelector('.spec-label').textContent.trim(), value: i.querySelector('.spec-value').textContent.trim() }));
    const grids = all('.feeds-speeds-grid', c).map((g) => { const o = {}; all('.feeds-speeds-item', g).forEach((it) => { o[it.querySelector('.feeds-speeds-label').textContent.trim()] = it.querySelector('.feeds-speeds-value').textContent.trim(); }); return o; });
    const fpt = Object.keys(grids[0] || {}).find((k) => /^FPT/.test(k));
    return { el: c, header: c.querySelector('.tool-header').textContent.trim(), specs, spec: (l) => (specs.find((s) => s.label === l || s.label.startsWith(l + ' ')) || {}).value, has: !!c.querySelector('.feeds-speeds-section'), main: grids[0] || {}, doc: grids[1] || null, fptKey: fpt, title: (c.querySelector('.feeds-speeds-title') || {}).textContent, note: (c.querySelector('.adjustment-note') || {}).textContent };
  });
}
/* the page's own tool size token, read back strictly: 1/2"  .5"  0.5"  1 1/2"  12.7MM  0.5 INCH */
function sizeFromToken(tok) {
  let m;
  if ((m = /^(\d+)\s+(\d+)\/(\d+)\s*"$/.exec(tok))) return +m[3] ? +m[1] + m[2] / m[3] : null;
  if ((m = /^(\d+)\/(\d+)\s*(?:"|INCH|IN)$/.exec(tok))) return +m[2] ? m[1] / m[2] : null;
  if ((m = /^(\d*\.?\d+)\s*(?:"|INCH|IN)$/.exec(tok))) return +m[1];
  if ((m = /^(\d*\.?\d+)\s*MM$/.exec(tok))) return +m[1] / 25.4;
  return undefined;
}
const sameLines = (txt) => txt.trim().split('\n').map((l) => l.trim()).filter((l) => l !== '' && l.split(',').some((i) => i.trim() !== ''));
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const FMT = (x) => (Number.isFinite(x) ? +x.toPrecision(5) : String(x));

/* ---------------------------------------------------------------- oracle 1: the page agrees with itself, for ANY input */
function consistency(K, ctx) {
  const txt = toolInput.value, lines = sameLines(txt), tools = readTools(), res = sel('#results');
  K.check('one result block per non-empty line', tools.length === lines.length) || K.find('oracle', 'error', `${lines.length} non-empty line(s) typed but ${tools.length} tool block(s) shown`, { where: 'count', sample: txt.slice(0, 300) });
  if (txt.trim() === '') K.check('empty input shows the hint', !!sel('#results .no-results') && /Enter tool specifications/.test(res.textContent)) || K.find('state', 'warn', 'The input is empty but the results area does not show the "Enter tool specifications" hint', { where: 'empty' });
  else if (!lines.length) K.check('input with no tools says so', /No tool specifications detected/.test(res.textContent)) || K.find('state', 'warn', 'The input has text but no tool, and the page does not say that no tools were detected', { where: 'none', sample: txt.slice(0, 200) });
  else {
    const h3 = sel('#results h3'), nm = materialData[selectedMaterial].name;
    K.check('results header names the chosen material and tool count', !!h3 && h3.textContent.includes(nm) && new RegExp('\\b' + tools.length + ' tools\\b').test(h3.textContent)) || K.find('state', 'error', `The results header says "${h3 && h3.textContent.trim()}" but ${nm} with ${tools.length} tools is selected`, { where: 'header' });
  }
  const btn = sel('#materialDropdownButton .selected-value');
  K.check('material button shows the selected material', btn.textContent.trim() === materialData[selectedMaterial].name) || K.find('state', 'error', `Material "${selectedMaterial}" is selected but the button says "${btn.textContent.trim()}"`, { where: 'material button' });
  tools.forEach((t, i) => {
    const w = `tool ${i + 1}`;
    if (!t.has) return;
    const D = sizeFromToken((t.spec('Size/Diameter') || '').trim());
    const mats = t.specs.filter((s) => s.label === 'Material').map((s) => s.value.toLowerCase()), carbide = mats.some((m) => m.includes('carbide'));
    const fl = t.spec('Flute Count'), flutes = fl ? parseInt(fl, 10) : 2;
    const step = num(t.main.Stepover), doc = num(t.main['Depth of Cut']);
    const matName = (t.title || '').replace(/^Feeds & Speeds for\s*/, '');
    const key = MATS.find((k) => materialData[k].name === matName);
    K.check('feeds & speeds title names a real material', !!key) || K.find('oracle', 'error', `"${t.title}" does not name a known material`, { where: 'title' });
    const nums = [...pair(t.main['RPM Range']), ...pair(t.main['IPM Range']), ...pair(t.main['SFM Range'])];
    K.check('RPM, IPM and SFM are finite numbers', nums.every((x) => Number.isFinite(x))) || K.find('bad-number', 'error', `${w}: RPM ${t.main['RPM Range']}, IPM ${t.main['IPM Range']}, SFM ${t.main['SFM Range']}`, { where: 'finite ' + t.main['RPM Range'], sample: t.header });
    const [r0, r1] = pair(t.main['RPM Range']), [i0, i1] = pair(t.main['IPM Range']);
    K.check('minimum is not above maximum (RPM, IPM)', r0 <= r1 && i0 <= i1) || K.find('oracle', 'error', `${w}: ranges run backwards: RPM ${t.main['RPM Range']}, IPM ${t.main['IPM Range']}`, { where: 'range order', sample: t.header });
    K.check('speeds and feeds are not negative', r0 >= 0 && i0 >= 0) || K.find('oracle', 'error', `${w}: negative RPM or IPM (${t.main['RPM Range']}, ${t.main['IPM Range']})`, { where: 'negative' });
    if (!key || D === undefined || D === null || !Number.isFinite(D) || D <= 0 || !Number.isFinite(step) || !Number.isFinite(doc)) {
      if (D === null || (D !== undefined && !(D > 0 && Number.isFinite(D)))) K.find('oracle', 'error', `${w}: feeds & speeds are shown for a tool with an impossible diameter (${t.spec('Size/Diameter')})`, { where: 'impossible diameter', sample: t.header });
      return;
    }
    const sfm = pair(t.main['SFM Range']), want = materialData[key][carbide ? 'carbide' : 'hss'].sfm;
    K.check('SFM range comes from the material table', sfm[0] === want[0] && sfm[1] === want[1]) || K.find('oracle', 'error', `${w}: SFM ${t.main['SFM Range']} shown but ${matName} ${carbide ? 'carbide' : 'HSS'} is ${want.join(' - ')}`, { where: 'sfm ' + matName, sample: t.header });
    K.check('material on the title is the selected material', key === selectedMaterial || ctx.mixedOk) || K.find('state', 'error', `The tool block is for ${matName} but ${materialData[selectedMaterial].name} is selected`, { where: 'stale material' });
    const customRaw = t.spec('Feed Per Tooth (Custom)'), fptn = customRaw !== undefined ? Number(customRaw.replace(/^\./, '0.')) : null, fptv = fptn > 0 && Number.isFinite(fptn) ? fptn : null;   // (0, or too big to be a number, is not a custom value)
    const ex = model({ D, flutes, carbide, fpt: fptv, step, doc }, key);
    K.check('RPM = SFM x 3.82 / D (with the depth-of-cut reduction)', close(r0, ex.rpm[0], 1) && close(r1, ex.rpm[1], 1)) || K.find('oracle', 'error', `${w}: RPM ${t.main['RPM Range']} but SFM ${want.join('-')} x 3.82 / ${FMT(D)} in (doc ${doc}%) gives ${ex.rpm.join(' - ')}`, { where: 'rpm', sample: t.header });
    const fp = pair(t.main[t.fptKey]);
    const tolF = 0.00006;
    K.check('feed per tooth = table or custom value x stepover / depth adjustment', close(fp[0], ex.fpt[0], tolF) && close(fp[1], ex.fpt[1], tolF)) || K.find('oracle', 'error', `${w}: FPT ${t.main[t.fptKey]} but expected ${ex.fpt.map((x) => x.toFixed(4)).join(' - ')} (step ${step}%, doc ${doc}%${ex.custom ? ', custom ' + fptv : ''})`, { where: 'fpt', sample: t.header });
    const slack = (r, f, fl) => Math.max(1, Math.ceil(fl * r * 0.00005) + 1);
    K.check('IPM = RPM x flutes x FPT', close(i0, Math.round(r0 * flutes * fp[0]), slack(r0, fp[0], flutes)) && close(i1, Math.round(r1 * flutes * fp[1]), slack(r1, fp[1], flutes))) || K.find('oracle', 'error', `${w}: IPM ${t.main['IPM Range']} but RPM ${r0}-${r1} x ${flutes} flutes x FPT ${t.main[t.fptKey]} gives ${Math.round(r0 * flutes * fp[0])} - ${Math.round(r1 * flutes * fp[1])}`, { where: 'ipm', sample: t.header });
    if (t.note !== undefined) {
      const m = /adjusted for (\S+)% stepover and (\S+)% DOC \(adjustment factor: ([\d.]+)x\)/.exec(t.note);
      K.check('adjustment note matches the factor', !!m && close(+m[3], ex.adj, 0.006)) || K.find('oracle', 'error', `${w}: adjustment note "${(t.note || '').trim().replace(/\s+/g, ' ')}" but the factor should be ${ex.adj.toFixed(2)}`, { where: 'note' });
    }
    K.check('adjustment note only when stepover or DOC is not 50%', (step !== 50 || doc !== 50) === (t.note !== undefined)) || K.find('oracle', 'warn', `${w}: stepover ${step}%, DOC ${doc}% but the adjustment note is ${t.note !== undefined ? 'shown' : 'missing'}`, { where: 'note presence' });
    if (t.doc) {
      const op = (t.doc.Operation || '').toLowerCase().replace(' ', '-'), mm = OPS[op];
      K.check('operation is one the page knows', !!mm) || K.find('oracle', 'error', `${w}: unknown operation "${t.doc.Operation}"`, { where: 'operation' });
      if (mm) {
        K.check('axial and radial depth of cut = diameter x the operation factor', t.doc['Axial DOC (ap)'] === `${(D * mm[0]).toFixed(4)}"` && t.doc['Radial DOC (ae)'] === `${(D * mm[1]).toFixed(4)}"`) || K.find('oracle', 'error', `${w}: ${t.doc.Operation} on ${FMT(D)} in shows ap ${t.doc['Axial DOC (ap)']} ae ${t.doc['Radial DOC (ae)']} but ${(D * mm[0]).toFixed(4)}" / ${(D * mm[1]).toFixed(4)}" are expected`, { where: 'doc ' + op, sample: t.header });
        K.check('tool diameter shown matches the size typed', t.doc['Tool Diameter'] === `${D.toFixed(3)}"`) || K.find('oracle', 'error', `${w}: size ${t.spec('Size/Diameter')} shown as diameter ${t.doc['Tool Diameter']} (expected ${D.toFixed(3)}")`, { where: 'diameter', sample: t.header });
      }
    }
  });
}

/* ---------------------------------------------------------------- oracle 2: the page reads what was typed (known truth) */
function verifyTruth(K, made, mat, label, total) {
  const tools = readTools(), want = total || made.length;
  if (!K.check('every typed tool line produced a result block', tools.length === want)) { K.find('oracle', 'error', `${want} well-formed tool line(s) typed, ${tools.length} block(s) shown`, { where: 'truth count ' + label, sample: made.slice(0, 5).map((m) => m.line).join('\n') }); return; }
  made.forEach((m, i) => {
    const t = tools[i], e = model(m.t, mat), w = `"${m.line}"`;
    K.check('the tool number typed is the one shown', t.header.toLowerCase().startsWith(m.head.toLowerCase())) || K.find('oracle', 'warn', `${w}: header reads "${t.header.slice(0, 40)}"`, { where: 'head ' + label });
    if (!K.check('a well-formed size gets feeds & speeds', t.has)) { K.find('oracle', 'error', `${w}: size ${m.why.split(' -> ')[0]} was not understood (no feeds & speeds shown)`, { where: 'size not understood ' + m.why.split(' -> ')[0].replace(/[\d.]+/g, '#'), sample: m.line }); return; }
    const [r0, r1] = pair(t.main['RPM Range']), [i0, i1] = pair(t.main['IPM Range']), fp = pair(t.main[t.fptKey]);
    const okR = close(r0, e.rpm[0], 1) && close(r1, e.rpm[1], 1), okI = close(i0, e.ipm[0], 1) && close(i1, e.ipm[1], 1), okF = close(fp[0], e.fpt[0], 0.00006) && close(fp[1], e.fpt[1], 0.00006);
    if (!K.check('RPM matches the independent calculation', okR)) K.find('oracle', 'error', `${w}: RPM ${t.main['RPM Range']}, expected ${e.rpm.join(' - ')} for ${m.why}`, { where: 'truth rpm ' + m.why.split(' -> ')[0].replace(/[\d.]+/g, '#'), sample: m.line + '\n' + t.header });
    if (!K.check('IPM matches the independent calculation', okI)) K.find('oracle', 'error', `${w}: IPM ${t.main['IPM Range']}, expected ${e.ipm.join(' - ')}`, { where: 'truth ipm', sample: m.line });
    if (!K.check('FPT matches the independent calculation', okF)) K.find('oracle', 'error', `${w}: FPT ${t.main[t.fptKey]}, expected ${e.fpt.map((x) => x.toFixed(4)).join(' - ')}`, { where: 'truth fpt', sample: m.line });
    K.check('stepover and depth of cut shown as typed (or 50%)', num(t.main.Stepover) === e.step && num(t.main['Depth of Cut']) === e.doc) || K.find('oracle', 'error', `${w}: shows stepover ${t.main.Stepover} / DOC ${t.main['Depth of Cut']}, typed ${e.step}% / ${e.doc}%`, { where: 'truth step/doc' });
    K.check('tool material read correctly (carbide uses the carbide table)', pair(t.main['SFM Range'])[1] === e.sfm[1]) || K.find('oracle', 'error', `${w}: SFM ${t.main['SFM Range']} expected ${e.sfm.join(' - ')}`, { where: 'truth sfm', sample: m.line });
    if (m.t.op) {
      K.check('a roughing / finishing / slotting keyword gives depth-of-cut figures', !!t.doc) || K.find('oracle', 'error', `${w}: operation "${m.t.op}" was typed but no depth-of-cut figures are shown`, { where: 'truth op missing', sample: m.line });
      if (t.doc) K.check('depth of cut figures match', t.doc['Axial DOC (ap)'] === `${e.axial}"` && t.doc['Radial DOC (ae)'] === `${e.radial}"` && t.doc['Tool Diameter'] === `${e.dia}"`) || K.find('oracle', 'error', `${w}: ap ${t.doc['Axial DOC (ap)']} ae ${t.doc['Radial DOC (ae)']} dia ${t.doc['Tool Diameter']}, expected ${e.axial}" ${e.radial}" ${e.dia}"`, { where: 'truth doc', sample: m.line });
    } else K.check('no operation keyword, no depth-of-cut figures', !t.doc) || K.find('oracle', 'warn', `${w}: depth-of-cut figures shown although no operation was typed`, { where: 'truth doc extra', sample: m.line });
  });
}

/* ---------------------------------------------------------------- driving the page */
function enter(K, text, o = {}) { K.typeInto(toolInput, text, o); }
async function chooseMaterial(K, key, viaUi) {
  const item = sel(`#materialDropdown .grid-item[data-value="${key}"]`);
  if (viaUi) {
    if (!materialDropdownContent.classList.contains('show')) await K.realClick(materialDropdownButton);
    K.check('the material menu opens when its button is pressed', materialDropdownContent.classList.contains('show') && materialDropdown.classList.contains('active')) || K.find('state', 'error', 'The material menu did not open after pressing the button', { where: 'menu open' });
    K.note(K.ctlKey(item), K.ctlKey(item), 'button', false); await K.realClick(item);
    K.check('the material menu closes after a choice', !materialDropdownContent.classList.contains('show') && !materialDropdown.classList.contains('active')) || K.find('state', 'warn', 'The material menu is still open after choosing a material', { where: 'menu close' });
  } else item.click();
  await K.raf();
  K.check('the chosen material becomes the selected one', selectedMaterial === key) || K.find('state', 'error', `Chose ${key} but the page uses ${selectedMaterial}`, { where: 'choose ' + key });
}
const AWFUL = [
  '', ' ', '\n\n\n', ',,,,,', ', , ,', 'T1', 'T', '"', '/', '1/2"', '0', '0"', '0mm', '0 mm, 4 flute', '-1/2"', '-5mm', '1/0"', '0/0"', '3/0", 2 flute, carbide', '1e308"', '1e308 fpt', '9'.repeat(400) + '"', '9'.repeat(400) + ' mm', '1/2", ' + '9'.repeat(400) + ' fpt',
  '.5"', '0.5 inch', '1/2 inch, carbide', '12.7 mm', '12.7mm, 1/2"', '1/2", 12.7mm, 3 mm', '1 1/2" endmill', '1-1/2" endmill', '0.0001"', '1e-300 mm', '5 thou', '1/2 in', '12 cm', '0.5 inches', '10 millimeters', '12.7MM', ' 1/2 " ', '1/2"endmill', '½"', '1/2″', '1/2”',
  'NaN', 'Infinity fpt', '1/2", NaN fpt', '1/2", -0.001 fpt', '1/2", 0 fpt', '1/2", 1e-320 fpt', '1/2", 99999999999 flute', '1/2", 0 flute', '1/2", 4 flute, 1e308 fpt', '1/2", 500% stepover, 0% doc', '1/2", 0% stepover, 100000% doc', '1/2", ' + '9'.repeat(30) + '% stepover', '1/2", 4 flute, 4 flute, 2 flute',
  '日本語, 1/2" エンドミル', '😀🔩, 1/2"', '٣/٤"', 'Ⅻ mm', '１／２" endmill', '1/2" \u0000endmill\u0007', '\t1/2"\t', 'T1  1/2"', 'T1\r\n1/2"\r\n3/8"\r\n', '﻿T1, 1/2"',
  '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<b>bold</b>, 1/2"', '"><svg/onload=alert(1)>, 1/2" endmill', '&lt;&amp;, 1/2"', 'T1, </div></div>, 1/2"', '<style>body{display:none}</style>, 1/2"', 'javascript:alert(1), 1/2"',
  '__proto__', 'constructor, toString, hasOwnProperty, 1/2"', 'T1, 1/2", 4 flute\nT1, 1/2", 4 flute\nT1, 1/2", 4 flute',
  'T1, 1/2", 4 flute, hss, endmill, .001 fpt, 10% stepover, 20% doc, heavy roughing, finishing, slotting, light roughing',
  '6mm, 1/4"', 'Tool #2: 6mm and 1/4" carbide', '1/4" and 6mm and 3/8" and 8mm',
];
const HUGE = [() => 'x'.repeat(100000), () => 'T1, 1/2", 4 flute, '.repeat(1000), () => '1'.repeat(3000) + ' fpt, 1/2"', () => ('T1, 1/2", 4 flute, hss, .001 fpt, 10% stepover, 20% doc, finishing\n').repeat(300), () => '9'.repeat(3000) + '/' + '9'.repeat(3000) + '"'];
function awful(K) { return K.chance(0.06) ? K.pick(HUGE)() : K.pick(AWFUL); }
const OUT_CTX = {};
async function pickMaterialRandom(K, p) { if (K.chance(p)) await chooseMaterial(K, K.pick(MATS), K.chance(0.5)); }

/* ---------------------------------------------------------------- the adapter */
window.__devApi = {
  name: 'Speeds & Feeds',
  covers: [
    'every number in every result block is re-calculated independently: RPM = SFM x 3.82 / D (with the depth-of-cut reduction), FPT range or custom FPT x stepover / depth-of-cut adjustment, IPM = RPM x flutes x FPT, axial / radial depth of cut = D x the operation factor, the adjustment note',
    'tool lines are generated from a known truth in many spellings (1/2", .5", 0.500", 12.7mm, 12.7 mm, 0.5 inch, 1 1/2", any order of the specs, carbide / HSS / cobalt) and the result must match the truth',
    'the same tool in different units gives the same answer; steps through every material and tool material; stepover and depth-of-cut sweeps must be monotonic',
    'awful input in the text box: empty, huge, unicode, HTML, negatives, 1e308, NaN, 1/0, odd units, mixed metric / imperial, thousands of lines',
    'NaN / undefined / Infinity never shown, typed text never becomes markup, no freezes on long lines, the page agrees with itself (counts, headers, material button)',
    'the material menu: opens, closes, selects, outside click; the Load Sample button; the browser storage is backed up and restored',
  ],
  selectors: '.grid-item',
  modal: '#materialDropdownContent.show, #alphaNotice:not([hidden])',
  coverOk: '.dropdown-content',
  computed: '.feeds-speeds-value, .adjustment-note, .detected-count, .feeds-speeds-title, #results h3',
  markup: { root: '#results', allowed: 'div, span, h3' },
  alpha: { popup: '#alphaNotice:not([hidden])', button: '#anGo' },
  slowKinds: ['big'],
  allowance: () => Math.round(toolInput.value.length / 40),   // ms a frame may take: long lists legitimately take longer to draw
  snapshot: () => ({ text: toolInput.value, mat: selectedMaterial }),
  restore: (s) => { sel(`#materialDropdown .grid-item[data-value="${s.mat}"]`).click(); toolInput.value = s.text; handleInput(); toolInput.setSelectionRange(s.text.length, s.text.length); },
  state: () => ({ material: selectedMaterial, 'input lines': sameLines(toolInput.value).length, 'tool blocks': all('#results .tool-container').length, 'menu open': materialDropdownContent.classList.contains('show'), 'input length': toolInput.value.length }),
  heal: (K, force) => { if (force) { document.body.click(); } },
  baseline: async (K) => {
    document.body.click(); sel(`#materialDropdown .grid-item[data-value="aluminum"]`).click();
    toolInput.value = ''; handleInput();
  },
  check: (K) => consistency(K, OUT_CTX),
  fields: { '#toolInput': { gen: (K) => (K.chance(0.5) ? Array.from({ length: K.ri(1, 4) }, () => genTool(K).line).join('\n') : awful(K)) } },
  actions: [
    { id: 'spec', weight: 16, prior: 5, purpose: 'type tool lines built from a known truth (sizes written in many ways) and check every number the page shows against an independent calculation', expect: 'RPM, IPM, FPT and depth of cut equal the independent calculation for the size and specs that were typed',
      run: async (K) => {
        await pickMaterialRandom(K, 0.4);
        const made = Array.from({ length: K.ri(1, 5) }, () => genTool(K));
        enter(K, made.map((m) => m.line).join(K.chance(0.8) ? '\n' : '\r\n'));
        await K.raf(); verifyTruth(K, made, selectedMaterial, 'spec');
        K.feature('tool lines checked against the truth'); return `${made.length} line(s) in ${materialData[selectedMaterial].name}: ${made[0].line}`;
      } },
    { id: 'awkward', weight: 12, prior: 5, purpose: 'type awful input (empty, huge, unicode, HTML, negatives, 1e308, NaN, 1/0, odd units, mixed units) and check the page refuses or handles it without errors, NaN, Infinity or markup', expect: 'a polite result or message, never an error, NaN / Infinity on screen, or injected HTML',
      run: async (K) => {
        const parts = Array.from({ length: K.ri(1, 3) }, () => awful(K)); if (K.chance(0.4)) parts.push(genTool(K).line);
        const text = K.shuffle ? K.shuffle(parts).join('\n') : parts.join('\n');
        const t0 = K.now(); enter(K, text); await K.raf(); const ms = K.now() - t0;
        if (!K.check('awful input is handled quickly', ms < 1500)) K.find('freeze', 'error', `Typing ${text.length} characters took ${Math.round(ms)} ms to process`, { where: 'awful slow ' + String(text).slice(0, 20).replace(/\d+/g, '#'), sample: text.slice(0, 200) });
        K.feature('awful inputs tried'); return text.replace(/\s+/g, ' ').slice(0, 70);
      } },
    { id: 'material', weight: 7, prior: 4, purpose: 'open the material menu, pick a material with the mouse and check the menu, the button and the results all agree', expect: 'the menu closes, the button names the material, every result block is for that material',
      run: async (K) => {
        if (!sameLines(toolInput.value).length) enter(K, Array.from({ length: K.ri(1, 3) }, () => genTool(K).line).join('\n'));
        const key = K.pick(MATS); await chooseMaterial(K, key, true);
        if (K.chance(0.4)) { await K.realClick(materialDropdownButton); await K.raf(); document.body.click(); await K.raf(); K.check('a click outside closes the material menu', !materialDropdownContent.classList.contains('show')) || K.find('state', 'warn', 'A click outside the material menu did not close it', { where: 'outside close' }); }
        K.feature('materials chosen with the mouse'); return materialData[key].name;
      } },
    { id: 'edit', weight: 7, prior: 4, purpose: 'edit the existing list the way a person does (add, delete, duplicate or change a line, change a character, add blank lines) and check the results follow', expect: 'results always describe the current text',
      run: async (K) => {
        let lines = toolInput.value.split('\n'); if (!toolInput.value.trim()) lines = [genTool(K).line, genTool(K).line];
        const how = K.ri(0, 8), i = K.ri(0, lines.length - 1);
        if (how === 0) lines.push(genTool(K).line); else if (how === 1 && lines.length > 1) lines.splice(i, 1); else if (how === 2) lines.splice(i, 0, lines[i]);
        else if (how === 3) { const s = lines[i]; const p = K.ri(0, s.length); lines[i] = s.slice(0, p) + s.slice(p + 1); } else if (how === 4) { const s = lines[i]; const p = K.ri(0, s.length); lines[i] = s.slice(0, p) + K.pick(['"', ',', '5', '/', ' ', '%', '.', 'mm', 'x']) + s.slice(p); }
        else if (how === 5) lines.splice(i, 0, ''); else if (how === 6) lines = lines.map((l) => l.toUpperCase()); else if (how === 7) lines[i] += '   '; else lines.reverse();
        enter(K, lines.join('\n'), { caret: 'keep' }); await K.raf();
        return ['add a line', 'delete a line', 'duplicate a line', 'delete a character', 'insert a character', 'insert a blank line', 'UPPER CASE', 'trailing spaces', 'reverse the order'][how];
      } },
    { id: 'sample', weight: 3, prior: 3, purpose: 'press Load Sample Tools and check the six sample tools are all understood', expect: 'six tool blocks, each with feeds and speeds except the tap / metric line which has a size',
      run: async (K) => {
        await pickMaterialRandom(K, 0.3); await K.realClick(sel('.load-sample-btn')); await K.raf();
        K.check('the sample list has six tools', all('#results .tool-container').length === 6) || K.find('state', 'error', `Load Sample Tools shows ${all('#results .tool-container').length} tool blocks instead of 6`, { where: 'sample count' });
        K.check('every sample tool gets feeds & speeds', readTools().every((t) => t.has)) || K.find('state', 'warn', 'A sample tool shows no feeds & speeds', { where: 'sample no fs' });
        K.feature('sample loaded'); return materialData[selectedMaterial].name;
      } },
    { id: 'big', weight: 1.2, prior: 2.5, purpose: 'paste a very long list (hundreds of tools) and check the page stays responsive', expect: 'every line is rendered within a couple of seconds',
      run: async (K) => {
        const n = K.ri(100, 400), made = Array.from({ length: n }, () => genTool(K)); const t0 = K.now(); enter(K, made.map((m) => m.line).join('\n')); await K.raf(); const ms = K.now() - t0;
        K.check('hundreds of tools render promptly', ms < 2500) || K.find('slow', 'warn', `${n} tool lines took ${Math.round(ms)} ms to render`, { where: 'big list' });
        K.allowSlow(1500); verifyTruth(K, made.slice(0, 60), selectedMaterial, 'big', n); K.feature('long lists'); return `${n} lines in ${Math.round(ms)} ms`;
      } },
  ],
  flows: {},
  setups: {},
};
const FL = window.__devApi.flows, SU = window.__devApi.setups;
FL['every material x tool material'] = async (K) => {
  for (const key of MATS) {
    await chooseMaterial(K, key, K.chance(0.5));
    for (const carb of [false, true]) {
      const made = Array.from({ length: 3 }, () => genTool(K, { mat: carb ? 'carbide' : 'HSS', size: sizeTokens(K) }));
      enter(K, made.map((m) => m.line).join('\n')); await K.raf(); verifyTruth(K, made, key, 'material sweep');
    }
  }
};
FL['the same tool in different units'] = async (K) => {
  const sizes = [['1/4"', .25], ['.25"', .25], ['0.250"', .25], ['0.25 inch', .25], ['6.35mm', 6.35 / 25.4], ['6.35 mm', 6.35 / 25.4], ['1/2"', .5], ['.5"', .5], ['0.500"', .5], ['12.7mm', .5], ['12.7 mm', .5], ['0.5 inch', .5], ['3/8"', .375], ['.375"', .375], ['9.525mm', .375], ['1 1/2"', 1.5], ['1.5"', 1.5], ['38.1mm', 1.5]];
  for (const key of [K.pick(MATS), 'aluminum']) {
    await chooseMaterial(K, key, false);
    const lines = sizes.map(([s, D]) => ({ s, D, line: `T1, ${s}, 3 flute, carbide, 10% stepover, 30% doc, finishing`, head: 'T1', t: { D, flutes: 3, carbide: true, fpt: null, step: 10, doc: 30, op: 'finishing' }, why: `${s} -> ${D}` }));
    enter(K, lines.map((l) => l.line).join('\n')); await K.raf(); verifyTruth(K, lines, key, 'units');
    const tl = readTools(), groups = {}; tl.forEach((t, i) => { const g = String(Math.round(sizes[i][1] * 1000)); (groups[g] = groups[g] || []).push([sizes[i][0], t.main['RPM Range'], t.main['IPM Range'], t.doc && t.doc['Axial DOC (ap)']].join('|')); });
    Object.values(groups).forEach((g) => { const first = g[0].split('|').slice(1).join('|'); K.check('the same size in inches, fractions, decimals and mm gives the same answer', g.every((x) => x.split('|').slice(1).join('|') === first)) || K.find('oracle', 'error', `Same tool size gives different results by spelling: ${g.join(' / ')}`, { where: 'unit spelling ' + g[0].replace(/[\d.]+/g, '#') }); });
  }
};
FL['mixed metric and imperial on one line'] = async (K) => {
  const mk = (line, first) => ({ line, head: line.split(/[,:]/)[0], t: { D: first, flutes: null, carbide: false, fpt: null, step: null, doc: null, op: null }, why: `first size -> ${first}` });
  const lines = [mk('T1, 6mm, 1/4", HSS', 6 / 25.4), mk('T2, 1/4", 6mm, HSS', 0.25), mk('Tool #3: 12.7mm and 1/2" endmill, HSS', 0.5), mk('T4, 1/2", hss, 12.7mm, 2 flute', 0.5)];
  enter(K, lines.map((l) => l.line).join('\n')); await K.raf();
  const tl = readTools(); K.check('mixed-unit lines list both sizes', tl.length === 4 && tl.every((t) => t.specs.filter((s) => s.label === 'Size/Diameter').length >= 2)) || K.find('oracle', 'warn', 'A line with two sizes does not list both', { where: 'mixed sizes' });
  verifyTruth(K, lines, selectedMaterial, 'mixed units');   // the FIRST size on the line is the one used
};
FL['stepover and depth of cut sweeps'] = async (K) => {
  const pcts = [0, 1, 5, 10, 25, 49, 50, 51, 75, 100, 150, 200, 1000];
  await chooseMaterial(K, K.pick(MATS), false);
  let prev = null;
  for (const p of pcts) {
    enter(K, `T1, 1/2", 4 flute, carbide, ${p}% stepover`); await K.raf();
    const t = readTools()[0]; if (!t || !t.has) continue; const ipm = pair(t.main['IPM Range'])[1];
    if (prev !== null) K.check('more stepover never lowers the feed rate', ipm >= prev - 1) || K.find('oracle', 'warn', `Stepover ${p}% gives IPM ${ipm}, lower than ${prev} at a smaller stepover`, { where: 'step monotonic' });
    prev = ipm;
  }
  prev = null;
  for (const p of pcts) {
    enter(K, `T1, 1/2", 4 flute, carbide, ${p}% doc`); await K.raf();
    const t = readTools()[0]; if (!t || !t.has) continue; const ipm = pair(t.main['IPM Range'])[1];
    if (prev !== null) K.check('a deeper cut never raises the feed rate', ipm <= prev + 1) || K.find('oracle', 'warn', `Depth of cut ${p}% gives IPM ${ipm}, higher than ${prev} at a shallower cut`, { where: 'doc monotonic' });
    prev = ipm;
  }
  const t100 = readTools()[0]; if (t100) K.check('the numbers stay finite at extreme depth of cut', pair(t100.main['RPM Range']).every(Number.isFinite)) || K.find('bad-number', 'error', 'Extreme depth of cut gives a non-finite RPM', { where: 'extreme doc' });
};
FL['typing a line one character at a time'] = async (K) => {
  const m = genTool(K, { op: 'finishing' }); let worst = 0;
  for (let i = 1; i <= m.line.length; i++) { const t0 = K.now(); enter(K, m.line.slice(0, i), { change: false }); worst = Math.max(worst, K.now() - t0); if (i % 8 === 0) await K.raf(); }
  K.check('typing is fast enough per keystroke', worst < 400) || K.find('slow', 'warn', `One keystroke took ${Math.round(worst)} ms to process`, { where: 'keystroke' });
  verifyTruth(K, [m], selectedMaterial, 'typing');
};
FL['awful input gauntlet'] = async (K) => {
  for (const s of AWFUL) { enter(K, s); await K.raf(); }
  for (const h of HUGE.slice(0, 3)) { const t0 = K.now(); enter(K, h()); await K.raf(); const ms = K.now() - t0; K.check('very long input is processed promptly', ms < 2500) || K.find('freeze', 'error', `A very long line (${h().length} characters) took ${Math.round(ms)} ms`, { where: 'gauntlet slow ' + h().slice(0, 6) }); }
};
FL['material menu thrash'] = async (K) => {
  for (let i = 0; i < 25; i++) {
    if (K.chance(0.5)) await K.realClick(materialDropdownButton); else document.body.click();
    if (K.chance(0.4)) { const it = K.pick(all('#materialDropdown .grid-item')); await K.realClick(it); }
    await K.raf();
  }
  document.body.click(); await K.raf();
  K.check('after thrashing the menu is closed again', !materialDropdownContent.classList.contains('show')) || K.find('state', 'warn', 'The material menu is stuck open after repeated clicks', { where: 'menu stuck' });
};
FL['whole sample in every material'] = async (K) => {
  for (const key of MATS) { await chooseMaterial(K, key, true); await K.realClick(sel('.load-sample-btn')); await K.raf(); }
};
SU['six sample tools'] = async (K) => { sel('.load-sample-btn').click(); };
SU['three hundred tools'] = async (K) => { enter(K, Array.from({ length: 300 }, () => genTool(K).line).join('\n')); };
SU['the material menu left open'] = async (K) => { if (!materialDropdownContent.classList.contains('show')) await K.realClick(materialDropdownButton); };
SU['a stainless steel job'] = async (K) => { await chooseMaterial(K, 'stainless', false); enter(K, 'T1, 1/8", 2 flute, carbide, 5% stepover, 100% doc, slotting'); };
SU['an awful line first'] = async (K) => { enter(K, awful(K)); };
})();
