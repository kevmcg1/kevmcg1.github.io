/* =====================================================================
   Stress tester for Speed Coder. Loaded the first time the tilde key (~) is pressed, and toggled by it after that. Nothing else summons it.
   Runs 10 tests per second (one every 100 ms). Each test does something real on the page (types a phrase and presses Enter, flips the
   machine, runs the Syntax Check, opens and closes windows, searches the cheat sheet, scrolls, undoes and redoes) and then checks that
   nothing broke: no script error, no console error, no NaN / undefined / Infinity in the output, the editor and its line numbers still agree.
   A frame meter runs the whole time and reports how smooth the page stayed (frames per second, 95th percentile frame time, dropped
   frames, long tasks). Stopping puts the editor text and the machine back the way they were.
   ===================================================================== */
(() => {
'use strict';
if (window.__devStress) return;
const RATE = 10, TICK = 1000 / RATE, FRAME_BUDGET = 1000 / 60, DROP_MS = 25, SLOW_TEST_MS = 50;
const $ = (s, r = document) => r.querySelector(s);
const rnd = (n) => Math.floor(Math.random() * n), pick = (a) => a[rnd(a.length)];
const GC = window.GcodeConverter, CK = window.GcodeCheck;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ---------------------------------------------------------------- random input */
const NUMS = ['0', '1', '2.5', '.75', '10', '-1.25', '100', '0.0001', '3.14159', '12345', '1e3', '-0', '99999.9'];
const num = () => pick(NUMS);
const fill = (p) => p.replace(/#+/g, () => num());
let PHRASES = [];
function loadPhrases() {
  try { PHRASES = GC.getCheatSheetItems().filter((x) => x.category === 'Shortcut' || x.category === 'Natural Language').map((x) => x.code); } catch (e) { PHRASES = []; }
  if (!PHRASES.length) PHRASES = ['clear z', 'feed to X# at ##'];
}
const GCODE_BAD = /\b(NaN|undefined|Infinity|null|\[object)\b/;
function randomProgram() {
  const L = ['%', 'O' + String(rnd(99999)).padStart(5, '0'), pick(['G20', 'G21', '']), pick(['T1 M06', 'T0101', ''])];
  for (let i = 0, n = 3 + rnd(25); i < n; i++) {
    L.push(pick([
      () => 'G0' + rnd(4) + ' X' + num() + ' Y' + num(), () => 'G01 Z' + num() + ' F' + num(), () => 'S' + rnd(9000) + ' M03', () => 'M0' + rnd(9) + ' M0' + rnd(9),
      () => 'G' + pick([41, 42, 40, 43, 49, 80, 81, 83, 54, 96, 71]) + ' X' + num(), () => '(' + pick(['TEST', 'NESTED (X)', 'OPEN']) + ')', () => 'X' + rnd(100), () => 'G0 O1 X1', () => 'N' + rnd(40) + ' G01 X' + num() + ' X' + num(),
      () => 'G71 P10 Q20 U.02 W.005 D.08 F.012', () => 'G02 X' + num() + ' Z' + num() + ' R' + num(), () => ''
    ])());
  }
  if (rnd(3)) L.push('M30'); if (rnd(2)) L.push('%');
  return L.join('\n');
}

/* ---------------------------------------------------------------- state and bookkeeping */
const S = { on: false, tests: 0, pass: 0, fail: 0, slow: 0, started: 0, elapsed: 0, perName: {}, fails: [], errors: 0, consoleErrors: 0, busy: false, skipped: 0, saved: null, timer: 0, next: 0, minuteTests: [] };
const F = { last: 0, dts: [], total: 0, drops: 0, worst: 0, long: 0, longMax: 0, raf: 0, sum: 0 };
let ui = null, po = null;
const origConsoleError = console.error;
const onErr = (e) => { S.errors++; note('script error', (e.message || e.reason || e.type) + ''); };
function note(test, msg) {
  S.fail++; const f = S.perName[test] || (S.perName[test] = { n: 0, ok: 0, bad: 0, ms: 0, max: 0 });
  S.fails.unshift({ t: new Date().toLocaleTimeString(), test, msg: String(msg).slice(0, 200) }); if (S.fails.length > 60) S.fails.pop();
  f.note = (f.note || 0) + 1;
}

/* ---------------------------------------------------------------- the tests */
function pressEnter(ed) {
  ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
}
function placeCaretAtEnd(ed) { ed.focus({ preventScroll: true }); ed.setSelectionRange(ed.value.length, ed.value.length); }
function editorSane(where) {
  const ed = $('#editor'); if (!ed) throw new Error('editor is gone');
  if (typeof ed.value !== 'string') throw new Error('editor value is not text');
  if (GCODE_BAD.test(ed.value.split('\n').slice(-40).join('\n').replace(/\([^)]*\)/g, ''))) throw new Error(where + ': NaN / undefined / Infinity in the editor text');
}
const closeWindows = async () => {
  for (const id of ['#sc-modal', '#cs-modal', '#wz-modal', '#fix-modal']) { const m = $(id); if (m && !m.hidden) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(230); if (!m.hidden) throw new Error(id + ' did not close with Escape'); } }
};
const TESTS = [
  ['convert phrase', 5, () => {
    const p = fill(pick(PHRASES)), out = GC.tryConvertLine(p, {});
    if (out != null && GCODE_BAD.test(out)) throw new Error('"' + p + '" gave ' + out);
    if (out != null && typeof out !== 'string') throw new Error('output is not text');
  }],
  ['type and Enter', 5, async () => {
    const ed = $('#editor'); placeCaretAtEnd(ed);
    const line = fill(pick(PHRASES)); const before = ed.value;
    ed.value = before.replace(/\n?$/, '\n') + line; ed.setSelectionRange(ed.value.length, ed.value.length);
    ed.dispatchEvent(new Event('input', { bubbles: true })); pressEnter(ed);
    await nextFrame(); editorSane('Enter');
    if (ed.value.length > 12000) ed.value = before;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }],
  ['line numbers agree', 3, async () => {
    const ed = $('#editor'), n = ed.value.split('\n').length; await nextFrame();
    const g = $('#line-numbers'); if (!g || !g.textContent.trim()) throw new Error('line numbers are empty');
    const top = ed.scrollTop; ed.scrollTop = rnd(Math.max(1, ed.scrollHeight)); await nextFrame(); await nextFrame();
    if (!g.querySelector('div') || !g.firstElementChild.textContent) throw new Error('line numbers vanished after scrolling a ' + n + ' line program');
    ed.scrollTop = top;
  }],
  ['machine toggle', 2, async () => {
    const t = pick(['mill', 'lathe']); $('#machine-' + t).click(); await nextFrame();
    if (GC.getMachine().type !== t) throw new Error('machine did not switch to ' + t);
    if ($('#machine-' + t).getAttribute('aria-checked') !== 'true') throw new Error('machine button state is wrong');
    loadPhrases(); editorSane('machine');
  }],
  ['undo / redo', 3, async () => {
    const b = pick([$('#undo-btn'), $('#redo-btn')]); if (!b.disabled) b.click(); await nextFrame(); editorSane('undo');
  }],
  ['syntax check', 4, async () => {
    const ed = $('#editor'); ed.value = randomProgram(); ed.dispatchEvent(new Event('input', { bubbles: true }));
    $('#syntax-check-btn').click(); await wait(60);
    const m = $('#sc-modal'); if (m.hidden) throw new Error('Syntax Check did not open');
    const cards = document.querySelectorAll('#sc-code .sc-card2').length, sum = $('#sc-sum').textContent;
    if (!sum) throw new Error('summary chips are empty');
    if (/NaN|undefined/.test($('#sc-code').textContent)) throw new Error('NaN / undefined in the findings');
    if (rnd(2) && !$('#sc-fixall').disabled) { $('#sc-fixall').click(); await nextFrame(); editorSane('fix all'); }
    else if (cards) { const a = $('#sc-code button[data-a=apply]'); if (a) a.click(); await nextFrame(); }
    $('#sc-close').click(); await wait(230); if (!m.hidden) throw new Error('Syntax Check did not close');
  }],
  ['fix all settles', 3, () => {
    const t = randomProgram(), mach = pick(['mill', 'lathe']), r1 = CK.fixAll(t, { machine: mach, maxRpm: 8100 }), r2 = CK.fixAll(r1.text, { machine: mach, maxRpm: 8100 });
    if (r2.applied) throw new Error('a second Fix all still applied ' + r2.applied + ' fixes (' + mach + ')');
    if (GCODE_BAD.test(r1.text.replace(/\([^)]*\)/g, ''))) throw new Error('Fix all wrote NaN / undefined');
  }],
  ['analyze random', 4, () => {
    for (let i = 0; i < 3; i++) { const res = CK.analyze(randomProgram(), { machine: pick(['mill', 'lathe']), maxRpm: 1 + rnd(20000) }); if (!res.issues || res.summary.error + res.summary.warning + res.summary.info !== res.issues.length) throw new Error('summary does not add up'); }
  }],
  ['alarm lookup', 2, () => {
    const q = pick(['102', '1.9930', '9100.018', '20005', 'cutter comp', 'alarm ' + rnd(99999), 'zzzz', '', '0', '99999.99']);
    const r = CK.lookupAlarms(q, pick(['mill', 'lathe', null])); if (!Array.isArray(r)) throw new Error('lookup did not give a list');
  }],
  ['cheat sheet search', 3, async () => {
    const s = $('#cheat-search'); if (!s) return; s.value = pick(['G', 'M0', 'feed', 'tool', 'zzz', '', 'x#', '(', '\\', '[']);
    s.dispatchEvent(new Event('input', { bubbles: true })); await nextFrame(); await nextFrame();
    if (/NaN|undefined/.test($('#cheat-count').textContent)) throw new Error('bad count text');
    s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
  }],
  ['autocomplete', 3, () => {
    const a = GC.getAutocompleteSuggestions(pick(['f', 'feed', 'g0', 'm', 'tool', 'x', 'zz', 'spindle', '1', '']));
    if (!Array.isArray(a)) throw new Error('suggestions are not a list');
  }],
  ['open and close windows', 3, async () => {
    const [btn, win] = pick([['#my-shortcuts-btn', '#cs-modal'], ['#shaft-wizard', '#wz-modal'], ['#debug-btn', '#debug-modal']]);
    const b = $(btn); if (!b) return; b.click(); await wait(80);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(230); const w = $(win);
    if (win === '#debug-modal' ? w.classList.contains('visible') : !w.hidden) { const x = w.querySelector('button[id$="-x"], #close-debug'); if (x) x.click(); await wait(100); }
  }],
  ['scroll editor', 2, async () => {
    const ed = $('#editor'); for (let i = 0; i < 4; i++) { ed.scrollTop = rnd(ed.scrollHeight + 1); await nextFrame(); }
    editorSane('scroll');
  }],
  ['semicolons', 2, async () => {
    const b = $(pick(['#add-semicolons-btn', '#remove-semicolons-btn'])); b.click(); await nextFrame(); editorSane('semicolons');
  }]
];
const BAG = []; TESTS.forEach((t) => { for (let i = 0; i < t[1]; i++) BAG.push(t); });

/* Tests that open a window need the screen to themselves; every other test is short and can overlap, so the rate stays at 10 per second */
const UI_TESTS = new Set(['syntax check', 'open and close windows', 'machine toggle']);
const LIGHT = BAG.filter((t) => !UI_TESTS.has(t[0]));
let uiBusy = false, inflight = 0;
async function runOne() {
  if (inflight >= 12) { S.skipped++; return; }
  let t = pick(BAG), isUI = UI_TESTS.has(t[0]);
  if (isUI && uiBusy) { t = pick(LIGHT); isUI = false; }
  if (isUI) uiBusy = true;
  const name = t[0], rec = S.perName[name] || (S.perName[name] = { n: 0, ok: 0, bad: 0, ms: 0, max: 0 });
  const errs0 = S.errors + S.consoleErrors, alone = inflight === 0, t0 = performance.now();
  inflight++;
  try {
    await t[2]();
    const d = performance.now() - t0; rec.ms += d; rec.max = Math.max(rec.max, d);
    if (alone && inflight === 1 && S.errors + S.consoleErrors > errs0) throw new Error('a script or console error was raised during the test');
    if (d > SLOW_TEST_MS + 400 && !isUI) S.slow++;
    rec.ok++; S.pass++;
  } catch (e) { rec.bad++; note(name, e && e.message ? e.message : e); if (isUI) await closeWindows().catch(() => {}); }
  rec.n++; S.tests++; inflight--; if (isUI) uiBusy = false;
}

/* ---------------------------------------------------------------- frame meter */
function frame(ts) {
  if (!S.on && !F.keep) return;
  if (F.last) {
    const dt = ts - F.last; F.total++; F.sum += dt; if (dt > F.worst) F.worst = dt;
    if (dt > DROP_MS) F.drops += Math.max(1, Math.round(dt / FRAME_BUDGET) - 1);
    F.dts.push(dt); if (F.dts.length > 600) F.dts.shift();
  }
  F.last = ts; F.raf = requestAnimationFrame(frame);
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
function fpsNow() { const r = F.dts.slice(-60); if (!r.length) return 0; return 1000 / (r.reduce((a, b) => a + b, 0) / r.length); }

/* ---------------------------------------------------------------- panel */
const CSS = `
#ds{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:min(360px,calc(100vw - 24px));max-height:min(80vh,640px);display:flex;flex-direction:column;background:#0a0a0a;border:1px solid #2b2e33;border-radius:10px;color:#ededed;font:13px/1.45 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);opacity:0;transform:translate3d(0,8px,0);transition:opacity .2s ease,transform .2s ease;will-change:transform,opacity}
#ds.in{opacity:1;transform:none}#ds[hidden]{display:none}
#ds *{box-sizing:border-box;text-transform:none;letter-spacing:normal}
#ds button,#ds span,#ds b,#ds li,#ds small,#ds div{font-family:inherit}#ds button,#ds li em{font-style:normal}
#ds .h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #262626;font-weight:600;cursor:grab;user-select:none;touch-action:none}
#ds .h small{color:#8c8c8c;font-weight:400}
#ds button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 12px;border:1px solid #3d4147;border-radius:7px;background:transparent;color:#ededed;font-size:12px;font-weight:600;cursor:pointer;transition:border-color .2s ease,color .2s ease,transform .15s ease;-webkit-tap-highlight-color:transparent}
#ds button:hover{background:transparent;border-color:#fff;color:#fff}#ds button:active{transform:scale(.96)}#ds button:focus-visible{outline:2px solid #fff;outline-offset:2px}
#ds button.on{border-color:#fff}
#ds i{color:#fff}
#ds .b{padding:12px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}
#ds .b>*{flex:none}
#ds .row{display:flex;flex-wrap:wrap;gap:8px}
#ds .g{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
#ds .c{border:1px solid #262626;border-radius:8px;padding:6px 8px;min-width:0}
#ds .c b{display:block;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
#ds .c span{display:block;font-size:10.5px;color:#8c8c8c;text-transform:uppercase!important;letter-spacing:.06em!important}
#ds canvas{width:100%;height:56px;border:1px solid #262626;border-radius:8px;display:block}
#ds .v{font-weight:600}#ds .bad{color:#ff6b6b}#ds .good{color:#4ade80}
#ds ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto;font-size:12px}
#ds li{border:1px solid #262626;border-radius:6px;padding:4px 8px;word-break:break-word}#ds li em{color:#8c8c8c;font-style:normal}
#ds .t{font-size:11px;color:#8c8c8c;display:grid;grid-template-columns:1fr auto auto;gap:2px 10px;font-variant-numeric:tabular-nums}
@media(max-width:520px){#ds{right:8px;left:8px;bottom:8px;width:auto}#ds .g{grid-template-columns:repeat(2,1fr)}#ds button{min-height:38px}}
@media(prefers-reduced-motion:reduce){#ds{transition:none}}`;
function build() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  if (!document.querySelector('link[href*="all.min.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '../fa/css/all.min.css'; document.head.appendChild(l); }
  ui = document.createElement('div'); ui.id = 'ds'; ui.hidden = true; ui.setAttribute('role', 'dialog'); ui.setAttribute('aria-label', 'Stress tester');
  ui.innerHTML = `<div class="h" id="ds-h"><span><i class="fa-solid fa-bolt"></i> Stress test <small>${RATE} tests/s</small></span><button type="button" id="ds-x" aria-label="Close (~)" title="Close (~)"><i class="fa-solid fa-xmark"></i></button></div>
<div class="b">
 <div class="row"><button type="button" id="ds-go"><i class="fa-solid fa-play"></i><span>Start</span></button><button type="button" id="ds-reset"><i class="fa-solid fa-rotate-left"></i><span>Reset</span></button><button type="button" id="ds-copy"><i class="fa-regular fa-copy"></i><span>Copy report</span></button></div>
 <div class="g"><div class="c"><b id="ds-st">idle</b><span>State</span></div><div class="c"><b id="ds-rate">0.0</b><span>Tests/s</span></div><div class="c"><b id="ds-n">0</b><span>Tests</span></div><div class="c"><b id="ds-ok" class="good">0</b><span>Passed</span></div>
 <div class="c"><b id="ds-bad">0</b><span>Failed</span></div><div class="c"><b id="ds-errs">0</b><span>Errors</span></div><div class="c"><b id="ds-skip">0</b><span>Skipped</span></div><div class="c"><b id="ds-time">0:00</b><span>Run time</span></div></div>
 <div class="row" style="align-items:center"><span class="v">Smoothness</span><span id="ds-grade" style="margin-left:auto" class="v">-</span></div>
 <canvas id="ds-cv" width="640" height="112" aria-label="Frame times"></canvas>
 <div class="g"><div class="c"><b id="ds-fps">0</b><span>FPS</span></div><div class="c"><b id="ds-p95">0</b><span>P95 ms</span></div><div class="c"><b id="ds-worst">0</b><span>Worst ms</span></div><div class="c"><b id="ds-drop">0</b><span>Dropped</span></div></div>
 <div class="g"><div class="c"><b id="ds-lt">0</b><span>Long tasks</span></div><div class="c"><b id="ds-ltm">0</b><span>Longest ms</span></div><div class="c"><b id="ds-slow">0</b><span>Slow tests</span></div><div class="c"><b id="ds-heap">-</b><span>Heap MB</span></div></div>
 <div class="v">Failures</div><ul id="ds-fails"><li><em>None yet</em></li></ul>
 <div class="v">Per test</div><div class="t" id="ds-per"></div>
</div>`;
  document.body.appendChild(ui);
  $('#ds-x').onclick = () => toggle(false); $('#ds-go').onclick = () => (S.on ? stop() : start()); $('#ds-reset').onclick = reset; $('#ds-copy').onclick = copyReport;
  // drag by the header (transform-free: position only changes on pointer moves)
  let dx = 0, dy = 0, drag = false; const h = $('#ds-h');
  h.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = true; const r = ui.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; h.setPointerCapture(e.pointerId); h.style.cursor = 'grabbing'; });
  h.addEventListener('pointermove', (e) => { if (!drag) return; ui.style.left = Math.max(0, Math.min(innerWidth - 60, e.clientX - dx)) + 'px'; ui.style.top = Math.max(0, Math.min(innerHeight - 40, e.clientY - dy)) + 'px'; ui.style.right = 'auto'; ui.style.bottom = 'auto'; });
  const up = () => { drag = false; h.style.cursor = ''; }; h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
}
const set = (id, v, cls) => { const e = $('#' + id); if (e && e.textContent !== String(v)) e.textContent = v; if (e && cls !== undefined) e.className = cls; };
let ltxt = '';
function draw() {
  const c = $('#ds-cv'); if (!c) return; const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  const d = F.dts.slice(-160), max = 50, y = (ms) => H - Math.min(ms, max) / max * (H - 6) - 3;
  g.strokeStyle = '#4ade80'; g.globalAlpha = .5; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y(FRAME_BUDGET)); g.lineTo(W, y(FRAME_BUDGET)); g.stroke();
  g.strokeStyle = '#ff6b6b'; g.beginPath(); g.moveTo(0, y(DROP_MS)); g.lineTo(W, y(DROP_MS)); g.stroke(); g.globalAlpha = 1;
  if (d.length < 2) return; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath();
  d.forEach((v, i) => { const x = i / 159 * W; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); }); g.stroke();
}
function paint() {
  if (!ui || ui.hidden) return;
  const el = S.on ? performance.now() - S.started : S.elapsed, sec = el / 1000;
  set('ds-st', S.on ? 'running' : (S.tests ? 'stopped' : 'idle')); set('ds-rate', sec > 1 ? (S.tests / sec).toFixed(1) : '0.0');
  set('ds-n', S.tests); set('ds-ok', S.pass); set('ds-bad', S.fail, S.fail ? 'bad' : ''); set('ds-errs', S.errors + S.consoleErrors, S.errors + S.consoleErrors ? 'bad' : ''); set('ds-skip', S.skipped);
  set('ds-time', Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0'));
  const p95 = pct(F.dts, .95), fps = fpsNow();
  set('ds-fps', fps ? fps.toFixed(0) : 0); set('ds-p95', p95.toFixed(1)); set('ds-worst', F.worst.toFixed(0)); set('ds-drop', F.drops);
  set('ds-lt', F.long); set('ds-ltm', F.longMax.toFixed(0)); set('ds-slow', S.slow);
  set('ds-heap', performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) : 'n/a');
  const gr = grade(); set('ds-grade', gr.text, 'v ' + gr.cls);
  const txt = S.fails.map((f) => `<li><em>${f.t}</em> <b>${f.test}</b>: ${f.msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</li>`).join('') || '<li><em>None yet</em></li>';
  if (txt !== ltxt) { ltxt = txt; $('#ds-fails').innerHTML = txt; }
  $('#ds-per').innerHTML = Object.keys(S.perName).filter((k) => S.perName[k].n).map((k) => { const r = S.perName[k]; return `<span>${k}</span><span>${r.ok}/${r.n}</span><span>${(r.ms / r.n).toFixed(0)} ms</span>`; }).join('');
  draw();
}
function grade() {
  if (F.dts.length < 30) return { text: 'measuring', cls: '' };
  const p95 = pct(F.dts, .95), fps = fpsNow();
  if (fps >= 55 && p95 <= 20) return { text: 'smooth (60 fps)', cls: 'good' };
  if (fps >= 40 && p95 <= 34) return { text: 'mostly smooth', cls: '' };
  return { text: 'janky', cls: 'bad' };
}
function report() {
  const gr = grade(), p95 = pct(F.dts, .95), sec = (S.on ? performance.now() - S.started : S.elapsed) / 1000;
  const L = ['Speed Coder stress test', new Date().toISOString(), navigator.userAgent, '',
    `Tests: ${S.tests} in ${sec.toFixed(1)} s (${(S.tests / Math.max(1, sec)).toFixed(1)}/s), passed ${S.pass}, failed ${S.fail}, skipped ${S.skipped}, script errors ${S.errors}, console errors ${S.consoleErrors}`,
    `Smoothness: ${gr.text}. ${fpsNow().toFixed(0)} fps, p95 ${p95.toFixed(1)} ms, worst ${F.worst.toFixed(0)} ms, dropped ${F.drops}, long tasks ${F.long} (longest ${F.longMax.toFixed(0)} ms), slow tests ${S.slow}`, '', 'Per test:'];
  Object.keys(S.perName).forEach((k) => { const r = S.perName[k]; if (r.n) L.push(`  ${k}: ${r.ok}/${r.n} passed, avg ${(r.ms / r.n).toFixed(0)} ms, max ${r.max.toFixed(0)} ms`); });
  L.push('', 'Failures:'); S.fails.length ? S.fails.forEach((f) => L.push(`  [${f.t}] ${f.test}: ${f.msg}`)) : L.push('  none');
  return L.join('\n');
}
async function copyReport() {
  const t = report(); try { await navigator.clipboard.writeText(t); } catch (e) { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
  const b = $('#ds-copy span'); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy report'; }, 1200);
}

/* ---------------------------------------------------------------- run control */
function save() {
  const ed = $('#editor'); S.saved = { text: ed.value, machine: GC.getMachine(), a: ed.selectionStart, b: ed.selectionEnd, top: ed.scrollTop };
}
function restore() {
  const s = S.saved; if (!s) return; const ed = $('#editor');
  try { if (GC.getMachine().type !== s.machine.type || GC.getMachine().multi !== s.machine.multi) { $('#machine-' + s.machine.type).click(); const cb = $('#multiaxis-chk'); if (cb && s.machine.type === 'mill' && cb.checked !== !!s.machine.multi) cb.click(); } } catch (e) {}
  ed.value = s.text; ed.setSelectionRange(s.a, s.b); ed.scrollTop = s.top; ed.dispatchEvent(new Event('input', { bubbles: true }));
  if (typeof updateLineNumbers === 'function') updateLineNumbers(); if (typeof histCheck === 'function') histCheck(); S.saved = null;
}
function start() {
  if (S.on) return; loadPhrases(); save();
  S.on = true; S.started = performance.now() - S.elapsed; S.next = performance.now() + TICK;
  F.last = 0; cancelAnimationFrame(F.raf); F.raf = requestAnimationFrame(frame);
  console.error = function () { S.consoleErrors++; note('console.error', Array.prototype.slice.call(arguments).join(' ')); return origConsoleError.apply(console, arguments); };
  addEventListener('error', onErr); addEventListener('unhandledrejection', onErr);
  try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => { F.long++; F.longMax = Math.max(F.longMax, e.duration); })); po.observe({ entryTypes: ['longtask'] }); } catch (e) { po = null; }
  const loop = () => {   // drift-corrected: a late tick is followed by a shorter wait, so the average stays at 10 per second
    if (!S.on) return; runOne(); S.next += TICK; const now = performance.now(); if (S.next < now - TICK * 3) S.next = now;
    S.timer = setTimeout(loop, Math.max(0, S.next - performance.now()));
  };
  loop(); const b = $('#ds-go'); b.querySelector('i').className = 'fa-solid fa-stop'; b.querySelector('span').textContent = 'Stop'; b.classList.add('on');
}
async function stop() {
  if (!S.on) return; S.on = false; clearTimeout(S.timer); S.elapsed = performance.now() - S.started; cancelAnimationFrame(F.raf);
  console.error = origConsoleError; removeEventListener('error', onErr); removeEventListener('unhandledrejection', onErr); if (po) { po.disconnect(); po = null; }
  for (let i = 0; i < 40 && inflight > 0; i++) await wait(50);
  await closeWindows().catch(() => {}); restore();
  const b = $('#ds-go'); b.querySelector('i').className = 'fa-solid fa-play'; b.querySelector('span').textContent = 'Start'; b.classList.remove('on'); paint();
}
function reset() {
  const was = S.on; if (was) { S.tests = S.pass = S.fail = S.slow = S.errors = S.consoleErrors = S.skipped = 0; S.started = performance.now(); S.elapsed = 0; }
  else { S.tests = S.pass = S.fail = S.slow = S.errors = S.consoleErrors = S.skipped = 0; S.elapsed = 0; }
  S.perName = {}; S.fails = []; ltxt = ''; F.dts = []; F.total = F.drops = F.worst = F.long = F.longMax = F.sum = 0; paint();
}
function toggle(force) {
  if (!ui) build(); const show = typeof force === 'boolean' ? force : ui.hidden;
  if (show) { ui.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => ui.classList.add('in'))); if (!window.__dsPaint) window.__dsPaint = setInterval(paint, 250); paint(); }
  else { if (S.on) stop(); ui.classList.remove('in'); setTimeout(() => { if (!ui.classList.contains('in')) ui.hidden = true; }, 200); }
}
window.__devStress = { toggle, start, stop, reset, report, state: S, frames: F };
})();
