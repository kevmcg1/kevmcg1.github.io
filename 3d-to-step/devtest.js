/* =====================================================================
   3D File to STEP File: automatic UX tester (dev tool).
   Press the ` key to open it. It clicks, drags, types, drops files and presses keys
   on its own (about 10 actions a second, as many thousands as you like) while it
   checks that things work (errors, state, undo/redo, STEP output) and look right
   (blank 3D view, clipped or covered controls, contrast, jank), then tells you what
   went right and wrong, with how to reproduce each problem and a guess at the cause.
   Seeded: the same seed gives the same sequence of actions.
   ===================================================================== */
(() => {
'use strict';
if (window.DevTest) return;
const A = window.__devApi;
if (!A) return;
const S = A.S;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const now = () => performance.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------- random */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let rng = mulberry32(1);
const rf = (a = 0, b = 1) => a + (b - a) * rng(), ri = (a, b) => Math.floor(rf(a, b + 1)), chance = (p) => rng() < p, pick = (arr) => arr[Math.floor(rng() * arr.length)];
function wpick(items, w) { let t = 0; const ws = items.map((x, i) => (t += Math.max(0, w(x, i)))); let r = rng() * t; for (let i = 0; i < items.length; i++) { r -= Math.max(0, w(items[i], i)); if (r <= 0) return items[i]; } return items[items.length - 1]; }

/* ---------------------------------------------------------------- state */
const T = {
  open: false, running: false, paused: false, seed: 1, rate: 10, max: 0, n: 0, sub: 0, t0: 0, tRun: 0, endReason: '',
  pass: 0, fail: 0, warn: 0, checks: new Map(),       // checks: name -> {runs, bad}
  kinds: new Map(),                                    // action kind -> {n, bad, ms:[], jank}
  issues: new Map(), log: [], recent: [], cur: null,
  cover: new Map(),                                    // control key -> {n, bad, label, kind}
  pairs: new Set(), lastKey: '', features: new Map(),
  downloads: [], blobs: new Map(), counters: { filePickerBlocked: 0, externalBlocked: 0, dialogs: 0, healed: 0, rejectedOk: 0, loadedOk: 0 },
  errs: [], toasts: [], toastSeq: 0, shifts: 0, longtasks: [], dts: [], base: 16, heap0: 0, mem0: null, lastRate: 0, rateWin: [], blank: 0, offscreen: 0, thumbs: 0,
};
const sevRank = { error: 3, warn: 2, info: 1 };

/* ---------------------------------------------------------------- findings */
const norm = (m) => String(m).replace(/0x[0-9a-f]+/gi, '0x#').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 160);
function check(name, ok) { const c = T.checks.get(name) || { runs: 0, bad: 0 }; c.runs++; if (!ok) c.bad++; T.checks.set(name, c); return ok; }
function snap() {
  try { if (T.thumbs > 40) return null; const cv = A.renderer.domElement, o = document.createElement('canvas'); o.width = 192; o.height = 108; o.getContext('2d').drawImage(cv, 0, 0, 192, 108); T.thumbs++; return o.toDataURL('image/jpeg', 0.6); } catch (e) { return null; }
}
function dumpState() {
  try { const h = A.Hist.info(), m = S.mesh; return `model ${S.name || '-'} · ${m ? m.m + ' triangles, ' + (S.faces ? S.faces.length + ' faces' : 'no faces') : 'none'} · mode ${S.mode} · tool ${S.tool} · finish ${S.mat} · history ${h.i + 1}/${h.n} · ${S.sel ? S.sel.size : 0} selected · camera ${A.camera.position.toArray().map((v) => v.toFixed(1)).join(',')}`; } catch (e) { return ''; }
}
function find(kind, sev, msg, extra = {}) {
  const sig = kind + '|' + norm(msg + (extra.where || ''));
  let it = T.issues.get(sig);
  if (!it) {
    if (T.issues.size > 600) return;
    it = { sig, kind, sev, msg: String(msg).slice(0, 400), count: 0, first: T.n, last: T.n, ctl: new Set(), actions: new Set(), repro: T.recent.slice(-12), seed: T.seed, state: dumpState(), diag: extra.diag || diagnose(kind, msg, extra), thumb: extra.thumb === false ? null : (kind.startsWith('visual') || kind === 'blank' ? snap() : null), stack: extra.stack || '' };
    T.issues.set(sig, it); logLine(sev === 'error' ? 'bad' : 'warn', `#${T.n} ${kind}: ${it.msg}`);
  }
  it.count++; it.last = T.n; if (T.cur) { it.actions.add(T.cur.kind); if (T.cur.ctl) it.ctl.add(T.cur.ctl); }
  if (sevRank[sev] > sevRank[it.sev]) it.sev = sev;
  if (T.cur) T.cur.bad.push(kind);
  return it;
}
function diagnose(kind, msg, x) {
  const m = String(msg);
  if (kind === 'js-error' || kind === 'promise') {
    const top = (x.stack || '').split('\n').slice(0, 3).map((l) => l.trim()).filter(Boolean).join(' <- ');
    if (/undefined|null/.test(m) && /read|reading|of/.test(m)) return 'A value was missing when the code used it (null or undefined). Likely a handler running before its data exists, or after it was cleared. ' + (top ? 'Look at: ' + top : '');
    if (/not a function/.test(m)) return 'Something was called that is not a function, often a handler wired to the wrong element or a missing API. ' + (top ? 'Look at: ' + top : '');
    if (/NaN|Infinity|finite|Invalid array length|out of range/i.test(m)) return 'A number went bad (NaN, Infinity or out of range). Check the input validation of whatever the last action fed in. ' + (top ? 'Look at: ' + top : '');
    return top ? 'Look at: ' + top : 'No stack was available; reproduce with the steps shown.';
  }
  if (kind === 'stuck-busy') return 'The busy overlay stayed on: an async job started but never finished or threw before calling busy(false). Wrap that job in try/finally.';
  if (kind === 'blank') return 'The 3D view drew nothing while a model was loaded. Camera, model position or material probably went invalid (NaN), or the renderer lost its context.';
  if (kind === 'state') return 'The app state disagrees with what the controls show (or itself). A handler changed one without updating the other.';
  if (kind === 'step-invalid') return 'The exported STEP text is malformed or empty. Check the writer for the model that was loaded (see the repro list).';
  if (kind === 'visual-covered') return 'Another element sits on top of this control, so a person could not click it. Check z-index, a stuck overlay, or panel overflow.';
  if (kind === 'visual-clipped') return 'This text is wider than its box and is cut off. Give it room, let it wrap, or add an ellipsis with a tooltip.';
  if (kind === 'visual-offscreen') return 'This control is partly outside the window or its panel, so it cannot be reached. Check the layout at this size.';
  if (kind === 'visual-overflow') return 'The page is wider than the window, so a horizontal scrollbar appears. Find the element that sticks out.';
  if (kind === 'visual-contrast') return 'Text color and its background are too close, so it is hard to read. Raise the contrast to at least 4.5:1 (3:1 for large text).';
  if (kind === 'visual-icon') return 'An icon rendered with no size, so the button shows nothing. The icon font or SVG did not load.';
  if (kind === 'jank' || kind === 'freeze') return 'A frame took far longer than normal right after this action: the main thread was busy (heavy rebuild, layout thrash, or a long synchronous loop). Break the work up or move it off the main thread.';
  if (kind === 'slow') return 'This kind of action takes a long time to finish. Add progress feedback or speed up the slow part.';
  if (kind === 'leak') return 'GPU memory (geometries or textures) keeps growing as models are loaded and removed. Something is not being disposed.';
  if (kind === 'layout-shift') return 'Things on the page jumped around right after this action. Reserve space for content that appears later.';
  if (kind === 'a11y') return 'A control has no accessible name, so screen readers and tooltips cannot describe it. Add aria-label or visible text.';
  if (kind === 'silent') return 'The app gave the user no feedback at all for this input (no model, no error message).';
  if (kind === 'toast-error') return 'The app showed an error message while a normal action was running. Either the action is broken for that model or the message is misleading.';
  if (kind === 'xss') return 'Text typed into the app showed up as live HTML. Escape user text before putting it in innerHTML.';
  return '';
}
function logLine(cls, text) { T.log.push({ cls, text, t: Date.now() }); if (T.log.length > 800) T.log.splice(0, 200); }

/* ---------------------------------------------------------------- hooks */
const HK = { on: false, undo: [] };
function swap(obj, key, fn) { const o = obj[key]; obj[key] = fn(o); HK.undo.push(() => { obj[key] = o; }); }
const onErr = (e) => {
  if (!T.running) return;
  if (e.target && e.target !== window && e.target.tagName) { find('resource', 'warn', 'A resource failed to load: ' + (e.target.src || e.target.href || e.target.tagName), { where: e.target.src || e.target.href, thumb: false }); return; }
  find('js-error', 'error', e.message || 'Script error', { stack: e.error && e.error.stack });
};
const onRej = (e) => { if (T.running) find('promise', 'error', 'Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason), { stack: e.reason && e.reason.stack }); };
function hook() {
  if (HK.on) return; HK.on = true;
  window.addEventListener('error', onErr, true); window.addEventListener('unhandledrejection', onRej);
  HK.undo.push(() => { window.removeEventListener('error', onErr, true); window.removeEventListener('unhandledrejection', onRej); });
  swap(console, 'error', (o) => function () { if (T.running && !T.quiet) find('console-error', 'error', [...arguments].map((a) => (a && a.message) || String(a)).join(' ').slice(0, 300), { stack: arguments[0] && arguments[0].stack }); return o.apply(this, arguments); });
  swap(console, 'warn', (o) => function () { if (T.running && !T.quiet) find('console-warn', 'warn', [...arguments].map((a) => String(a)).join(' ').slice(0, 300), { thumb: false }); return o.apply(this, arguments); });
  swap(HTMLInputElement.prototype, 'click', (o) => function () { if (this.type === 'file') { T.counters.filePickerBlocked++; return; } return o.apply(this, arguments); });
  swap(URL, 'createObjectURL', (o) => function (b) { const u = o.call(URL, b); T.blobs.set(u, b); if (T.blobs.size > 20) T.blobs.delete(T.blobs.keys().next().value); return u; });
  swap(HTMLAnchorElement.prototype, 'click', (o) => function () {
    if (this.download) { T.downloads.push({ name: this.download, blob: T.blobs.get(this.href), n: T.n }); if (T.downloads.length > 30) T.downloads.shift(); return; }
    if (this.href && !/^#/.test(this.getAttribute('href') || '') && this.origin !== location.origin) { T.counters.externalBlocked++; return; }
    return o.apply(this, arguments);
  });
  swap(window, 'open', () => function () { T.counters.externalBlocked++; return null; });
  swap(window, 'alert', () => function () { T.counters.dialogs++; });
  swap(window, 'confirm', () => function () { T.counters.dialogs++; return true; });
  swap(window, 'prompt', () => function () { T.counters.dialogs++; return ''; });
  swap(Element.prototype, 'setPointerCapture', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* synthetic pointer ids have no capture */ } });
  swap(Element.prototype, 'releasePointerCapture', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* same */ } });
  const blockNav = (e) => { if (!T.running || e.isTrusted) return; const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a && a.origin !== location.origin && !/^#/.test(a.getAttribute('href'))) { e.preventDefault(); T.counters.externalBlocked++; } };
  document.addEventListener('click', blockNav, true); HK.undo.push(() => document.removeEventListener('click', blockNav, true));
  const tt = $('#toasts');
  if (tt) { const mo = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.classList && n.classList.contains('toast')) T.toasts.push({ seq: ++T.toastSeq, kind: n.classList.contains('err') ? 'err' : n.classList.contains('warn') ? 'warn' : 'ok', text: n.textContent.trim().slice(0, 200), n: T.n }); if (T.toasts.length > 60) T.toasts.shift(); }))); mo.observe(tt, { childList: true }); HK.undo.push(() => mo.disconnect()); }
  try { const po = new PerformanceObserver((l) => l.getEntries().forEach((en) => { if (en.hadRecentInput) return; T.shifts += en.value; })); po.observe({ type: 'layout-shift', buffered: false }); HK.undo.push(() => po.disconnect()); } catch (e) { /* not supported */ }
  try { const po = new PerformanceObserver((l) => l.getEntries().forEach((en) => { T.longtasks.push({ d: en.duration, n: T.n }); if (T.longtasks.length > 200) T.longtasks.shift(); })); po.observe({ type: 'longtask', buffered: false }); HK.undo.push(() => po.disconnect()); } catch (e) { /* not supported */ }
}
function unhook() { HK.undo.reverse().forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); HK.undo = []; HK.on = false; }
// frame monitor: how long between frames, so a stall shows up as a long gap
const FM = { on: false, last: 0, max: 0 };
function fmLoop(t) { if (!FM.on) return; if (FM.last) { const dt = t - FM.last; T.dts.push(dt); if (T.dts.length > 900) T.dts.shift(); if (dt > FM.max) FM.max = dt; } FM.last = t; requestAnimationFrame(fmLoop); }

/* ---------------------------------------------------------------- the page's controls */
const root = () => $('#devtest');
const inDev = (el) => !!(el.closest && el.closest('#devtest'));
function visible(el) {
  if (!el.isConnected || inDev(el)) return false;
  const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) return false;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const c = getComputedStyle(p); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity < 0.02) return false; }
  return true;
}
function showing(el) {   // false when a scrolling or collapsing parent has pushed the control out of sight (it can't be tested right now)
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p); if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const a = p.getBoundingClientRect(); if (a.height < 1 && cs.overflowY !== 'visible') return false;
    if (cx < a.left - 1 || cx > a.right + 1 || cy < a.top - 1 || cy > a.bottom + 1) return false;
  }
  return true;
}
function ctlKey(el) {
  if (el.id) return '#' + el.id;
  const t = el.tagName.toLowerCase(), cls = (el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => c && !/^(hv|on|off|run|sm|big|primary|ghost|icon|dd-i)$/.test(c))[0] : '') || '';
  const d = el.dataset ? Object.entries(el.dataset).filter(([k]) => !/tip/.test(k)).slice(0, 1).map(([k, v]) => `[data-${k}=${String(v).slice(0, 14)}]`).join('') : '';
  const tx = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
  const par = el.closest('[id]') && el.closest('[id]') !== el ? '@' + el.closest('[id]').id : '';
  return t + (cls ? '.' + cls : '') + d + (tx ? `"${tx}"` : '') + par;
}
function kindOf(el) {
  const t = el.tagName;
  if (t === 'SELECT') return 'select'; if (t === 'TEXTAREA') return 'text';
  if (t === 'INPUT') { const y = el.type; return y === 'checkbox' || y === 'radio' ? 'check' : y === 'range' ? 'range' : y === 'number' ? 'number' : y === 'color' ? 'color' : y === 'file' ? 'file' : y === 'button' || y === 'submit' ? 'button' : 'text'; }
  if (el.matches('.dd-t')) return 'dropdown'; if (t === 'A') return 'link';
  return 'button';
}
const SEL = 'button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=switch], [tabindex]:not([tabindex="-1"]), .hv, label.chk, .ex, .dd-i, .swatch, [data-ex]';
function scan() {
  const out = [], seen = new Set();
  $$(SEL).forEach((el) => {
    if (seen.has(el) || inDev(el)) return; seen.add(el);
    const k = kindOf(el);
    if (k === 'file') return;
    const hiddenNative = el.tagName === 'SELECT' && el.classList.contains('native');
    if (!hiddenNative && !visible(el)) return;
    if (el.tagName === 'LABEL' && el.querySelector('input')) return;   // the input itself is the target
    out.push({ el, k, key: ctlKey(el) });
  });
  return out;
}
function note(key, label, kind, bad) {
  let c = T.cover.get(key); if (!c) { c = { n: 0, bad: 0, label, kind }; T.cover.set(key, c); }
  c.n++; if (bad) c.bad++;
  if (T.lastKey && T.cover.size < 4000) T.pairs.add(T.lastKey + '>' + key);
  T.lastKey = key;
}
function seenControls(list) { list.forEach((c) => { if (!T.cover.has(c.key)) T.cover.set(c.key, { n: 0, bad: 0, label: c.key, kind: c.k }); }); }

/* ---------------------------------------------------------------- synthetic input */
const view = () => { const t = $('#touch') || A.renderer.domElement; return t; };
function center(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function mev(type, x, y, o = {}) {
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window, button: o.button || 0, buttons: o.buttons || 0, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, metaKey: false, detail: o.detail || 0 };
  return type.startsWith('pointer') ? new PointerEvent(type, Object.assign(base, { pointerId: o.id || 1, pointerType: o.type || 'mouse', isPrimary: o.primary !== false, width: 1, height: 1, pressure: o.buttons ? 0.5 : 0 })) : new MouseEvent(type, base);
}
function fire(target, type, x, y, o) { (target || document.body).dispatchEvent(mev(type, x, y, o)); }
function under(x, y) { return document.elementFromPoint(clamp(x, 0, innerWidth - 1), clamp(y, 0, innerHeight - 1)) || document.body; }
function pdown(el, x, y, o = {}) { const b = o.button || 0; const oo = Object.assign({ buttons: b === 2 ? 2 : b === 1 ? 4 : 1 }, o); fire(el, 'pointerdown', x, y, oo); fire(el, 'mousedown', x, y, oo); try { if (el.focus && /^(INPUT|BUTTON|TEXTAREA|SELECT)$/.test(el.tagName)) el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
function pmove(x, y, o = {}) { const t = under(x, y); fire(t, 'pointermove', x, y, o); fire(t, 'mousemove', x, y, o); }
function pup(el, x, y, o = {}) { const oo = Object.assign({ buttons: 0 }, o); fire(el, 'pointerup', x, y, oo); fire(el, 'mouseup', x, y, oo); }
async function realClick(el, o = {}) {
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ }
  const [x, y] = center(el), t = el.isConnected ? el : document.body;
  pmove(x, y); await raf();
  pdown(t, x, y, o); await raf(); pup(t, x, y, o);
  if (o.button === 2) fire(t, 'contextmenu', x, y, o); else fire(t, 'click', x, y, Object.assign({ detail: 1 }, o));
  if (o.dbl) { fire(t, 'dblclick', x, y, { detail: 2 }); }
}
function setValue(el, v) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value'); d && d.set ? d.set.call(el, v) : (el.value = v);
}
function key(k, o = {}, target) {
  const t = target || document.activeElement || document.body, code = /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : /^\d$/.test(k) ? 'Digit' + k : k === ' ' ? 'Space' : k;
  const init = { key: k, code, bubbles: true, cancelable: true, composed: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, metaKey: false, view: window };
  t.dispatchEvent(new KeyboardEvent('keydown', init)); t.dispatchEvent(new KeyboardEvent('keyup', init));
}

/* ---------------------------------------------------------------- generated test files */
function meshBox(x, y, z, w, h, d) {
  const v = [[x, y, z], [x + w, y, z], [x + w, y + h, z], [x, y + h, z], [x, y, z + d], [x + w, y, z + d], [x + w, y + h, z + d], [x, y + h, z + d]];
  const f = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return { v, f };
}
function meshSphere(n, m, r) {
  const v = [], f = [];
  v.push([0, r, 0]); for (let i = 1; i < n; i++) for (let j = 0; j < m; j++) { const a = Math.PI * i / n, b = 2 * Math.PI * j / m; v.push([r * Math.sin(a) * Math.cos(b), r * Math.cos(a), r * Math.sin(a) * Math.sin(b)]); } v.push([0, -r, 0]);
  const id = (i, j) => 1 + (i - 1) * m + (j % m), last = v.length - 1;
  for (let j = 0; j < m; j++) f.push([0, id(1, j + 1), id(1, j)]);
  for (let i = 1; i < n - 1; i++) for (let j = 0; j < m; j++) { f.push([id(i, j), id(i, j + 1), id(i + 1, j)]); f.push([id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)]); }
  for (let j = 0; j < m; j++) f.push([last, id(n - 1, j), id(n - 1, j + 1)]);
  return { v, f };
}
function meshCombine(ms) { const v = [], f = []; ms.forEach((m) => { const o = v.length; m.v.forEach((p) => v.push(p)); m.f.forEach((t) => f.push(t.map((i) => i + o))); }); return { v, f }; }
const tri = (m, i) => m.f[i].map((k) => m.v[k]);
function norm3(a, b, c) { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n) || 1; return n.map((q) => q / l); }
function toAsciiSTL(m) { let s = 'solid devtest\n'; m.f.forEach((_, i) => { const [a, b, c] = tri(m, i), n = norm3(a, b, c); s += `facet normal ${n.join(' ')}\nouter loop\n` + [a, b, c].map((p) => `vertex ${p.join(' ')}\n`).join('') + 'endloop\nendfacet\n'; }); return s + 'endsolid devtest\n'; }
function toBinSTL(m) { const buf = new ArrayBuffer(84 + 50 * m.f.length), dv = new DataView(buf); dv.setUint32(80, m.f.length, true); m.f.forEach((_, i) => { const [a, b, c] = tri(m, i), n = norm3(a, b, c); let o = 84 + 50 * i;[n, a, b, c].forEach((p) => p.forEach((q) => { dv.setFloat32(o, q, true); o += 4; })); }); return buf; }
function toOBJ(m) { return m.v.map((p) => 'v ' + p.join(' ')).join('\n') + '\n' + m.f.map((t) => 'f ' + t.map((i) => i + 1).join(' ')).join('\n') + '\n'; }
function toPLY(m) { return `ply\nformat ascii 1.0\nelement vertex ${m.v.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${m.f.length}\nproperty list uchar int vertex_indices\nend_header\n` + m.v.map((p) => p.join(' ')).join('\n') + '\n' + m.f.map((t) => '3 ' + t.join(' ')).join('\n') + '\n'; }
function toOFF(m) { return `OFF\n${m.v.length} ${m.f.length} 0\n` + m.v.map((p) => p.join(' ')).join('\n') + '\n' + m.f.map((t) => '3 ' + t.join(' ')).join('\n') + '\n'; }
function makeFile() {
  const sz = () => rf(0.5, 80), shapes = {
    cube: () => meshBox(0, 0, 0, sz(), sz(), sz()), sphere: () => meshSphere(ri(4, 18), ri(5, 24), rf(1, 40)),
    twoCubes: () => meshCombine([meshBox(0, 0, 0, 10, 10, 10), meshBox(20, 0, 0, 10, 10, 10)]),
    touching: () => meshCombine([meshBox(0, 0, 0, 10, 10, 10), meshBox(10, 0, 0, 10, 10, 10)]),
    open: () => { const m = meshBox(0, 0, 0, 10, 10, 10); m.f.pop(); m.f.pop(); return m; },
    inverted: () => { const m = meshBox(0, 0, 0, 10, 10, 10); m.f = m.f.map((t) => [t[0], t[2], t[1]]); return m; },
    tiny: () => meshBox(0, 0, 0, 1e-4, 1e-4, 1e-4), huge: () => meshBox(0, 0, 0, 1e7, 1e7, 1e7), offset: () => meshBox(1e5, -1e5, 3e4, 10, 10, 10),
    thin: () => meshBox(0, 0, 0, 100, 100, 0.001), flat: () => meshBox(0, 0, 0, 10, 10, 0),
    dup: () => { const m = meshBox(0, 0, 0, 10, 10, 10); m.f = m.f.concat(m.f); return m; },
    manySph: () => meshSphere(60, 80, 30),
  };
  const bad = {
    empty: () => ['empty.stl', new Uint8Array(0)], garbage: () => ['garbage.stl', Uint8Array.from({ length: rf(10, 5000) | 0 }, () => (rng() * 256) | 0)],
    text: () => ['notes.txt', 'hello, this is not a mesh'], noext: () => ['model', 'solid x\nendsolid x\n'], nan: () => ['nan.stl', 'solid x\nfacet normal 0 0 1\nouter loop\nvertex NaN 0 0\nvertex 1 Infinity 0\nvertex 0 1 -Infinity\nendloop\nendfacet\nendsolid x\n'],
     zeroTri: () => ['zero.stl', toAsciiSTL({ v: [[0, 0, 0]], f: [[0, 0, 0]] })],
    wrongExt: () => ['image.png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])], badObj: () => ['bad.obj', 'v 1 2\nf 1 2 3 4 5\nf a b c\n'], badPly: () => ['bad.ply', 'ply\nformat ascii 1.0\nelement vertex 99999999\nend_header\n1 2 3\n'],
    huge: () => ['big.obj', 'v 0 0 0\n'.repeat(20000)], 
  };
  if (chance(0.12)) { const nm = pick(['x'.repeat(240) + '.stl', '<img src=x onerror=alert(1)>.stl', 'sp ace & (odd) #name%20.stl', 'ünï©ödé 日本.stl']); return { name: nm, file: new File([toAsciiSTL(meshBox(0, 0, 0, 5, 5, 5))], nm), expect: 'either', what: 'odd file name' }; }
  if (chance(0.3)) { const k = pick(Object.keys(bad)), [name, data] = bad[k](); return { name, file: new File([data], name), expect: 'reject', what: k }; }
  const sk = pick(Object.keys(shapes)), m = shapes[sk](), fmt = pick(['stl', 'bstl', 'obj', 'ply', 'off']);
  const name = `dt-${sk}.${fmt === 'bstl' ? 'stl' : fmt}`, data = fmt === 'stl' ? toAsciiSTL(m) : fmt === 'bstl' ? toBinSTL(m) : fmt === 'obj' ? toOBJ(m) : fmt === 'ply' ? toPLY(m) : toOFF(m);
  const degenerate = /^(flat|tiny|huge)$/.test(sk);
  return { name, file: new File([data], name), expect: degenerate ? 'either' : 'load', what: sk + '.' + fmt };
}

/* ---------------------------------------------------------------- waiting and settling */
async function settle(maxMs = 12000) {
  await raf(); await raf();
  const t0 = now(); let stuck = false;
  while (now() - t0 < maxMs) {
    const b = $('#busy'), hist = A.Hist.info();
    if (!(b && b.classList.contains('on')) && !hist.working) break;
    await sleep(40);
  }
  const b = $('#busy');
  if ((b && b.classList.contains('on')) || A.Hist.info().working) { stuck = true; find('stuck-busy', 'error', `The busy overlay was still on ${Math.round(maxMs / 1000)} s after: ${T.cur ? T.cur.desc : 'an action'}`); try { A.busy(false); } catch (e) { /* ignore */ } T.counters.healed++; }
  await raf();
  return !stuck;
}
function heal() {
  // get the app back to a state where the next action means something: only things that have been in the way for a few actions in a row
  const blocked = !!($('.modal.on') || (A.Tut && A.Tut.running)); T.stuck = blocked ? (T.stuck || 0) + 1 : 0;
  if (T.stuck >= 4) { try { if (A.Tut && A.Tut.running) A.Tut.end(false); } catch (e) { /* ignore */ } $$('.modal.on').forEach((m) => { if (!inDev(m)) m.classList.remove('on'); }); T.counters.healed++; T.stuck = 0; }
  const mob = $('#mobile.on'); if (mob) mob.classList.remove('on');
  const dr = $('#dropov.on'); if (dr) dr.classList.remove('on');
  $$('.dd-menu.on, .dd-menu.open').forEach((m) => m.classList.remove('on', 'open'));
}

/* ---------------------------------------------------------------- oracles */
const finite = (a, n = 4000) => { const step = Math.max(1, Math.floor(a.length / n)); for (let i = 0; i < a.length; i += step) if (!Number.isFinite(a[i])) return false; return true; };
function checkState() {
  const m = S.mesh;
  const fin = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  if (!check('camera is finite', fin(A.camera.position) && fin(A.controls.target))) find('state', 'error', 'The camera position or target became NaN or Infinity');
  if (!check('model transform is finite', fin(A.pivot.position) && fin(A.pivot.scale) && fin(A.holder.position) && [A.pivot.quaternion.x, A.pivot.quaternion.y, A.pivot.quaternion.z, A.pivot.quaternion.w].every(Number.isFinite))) find('state', 'error', 'The model position, rotation or scale became NaN or Infinity');
  const cv = $('#btnConvert');
  if (cv && !check('Export button matches whether a model is loaded', !!m === !cv.disabled)) find('state', 'warn', `Export STEP is ${cv.disabled ? 'disabled' : 'enabled'} but ${m ? 'a model is' : 'no model is'} loaded`);
  const on = $('[data-mode].on'), app = $('#app');
  if (on && !check('mode buttons match the current mode', on.dataset.mode === S.mode && (!app || app.dataset.mode === S.mode))) find('state', 'warn', `Mode is "${S.mode}" but the highlighted button is "${on.dataset.mode}"`);
  const h = A.Hist.info(), u = $('#btnUndo'), r = $('#btnRedo');
  if (u && r && !h.working) { if (!check('Undo and Redo buttons match the history', u.disabled === !(h.i > 0) && r.disabled === !(h.i < h.n - 1))) find('state', 'warn', `History at ${h.i + 1}/${h.n} but Undo is ${u.disabled ? 'disabled' : 'enabled'} and Redo is ${r.disabled ? 'disabled' : 'enabled'}`); }
  if (m && S.view) {
    if (!check('mesh data is finite', finite(S.view.pos))) find('state', 'error', 'The model\'s vertex data contains NaN or Infinity');
    if (S.patchTris && S.sel) { let ok = true; S.sel.forEach((p) => { if (!(p >= 0 && p < S.patchTris.length)) ok = false; }); if (!check('selection only holds real faces', ok)) find('state', 'error', 'The selection contains a face that does not exist'); }
    const mm = A.getModel(); if (!check('3D model exists for the loaded mesh', !!mm)) find('state', 'error', 'A mesh is loaded but there is nothing in the 3D scene');
  }
  const tb = $('.tool[data-tool].on'); if (tb && !check('tool buttons match the current tool', tb.dataset.tool === S.tool)) find('state', 'warn', `Tool is "${S.tool}" but the highlighted button is "${tb.dataset.tool}"`);
  const sw = $('#vMat'); if (sw && !check('finish list shows the chosen finish', sw.value === S.mat)) find('state', 'warn', `Finish is "${S.mat}" but the list shows "${sw.value}"`);
}
function checkCanvas() {
  if (!S.mesh || S.mode === '2d') return;
  const cv = A.renderer.domElement; if (!cv || cv.clientWidth < 10) return;
  try {
    const mm = A.getModel(); let inView = true, big = true;
    if (mm) {
      const b = new THREE.Box3().setFromObject(mm), f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(A.camera.projectionMatrix, A.camera.matrixWorldInverse));
      inView = !b.isEmpty() && f.intersectsBox(b);
      if (inView) { const c = new THREE.Vector3(), size = b.getSize(new THREE.Vector3()).length(), d = Math.max(0.01, A.camera.position.distanceTo(b.getCenter(c))); big = size / d * cv.clientHeight / (2 * Math.tan(A.camera.fov * Math.PI / 360)) > 6; }
      if (check('model stays in view', inView)) T.offscreen = 0; else { T.offscreen++; if (T.offscreen === 40) find('visual-offscreen', 'info', 'The model has been out of view for 40 actions in a row (is there an obvious way back, like Fit?)', { where: 'model' }); }
    }
    if (!inView || !big) return;
    if (mm && new THREE.Box3().setFromObject(mm).containsPoint(A.camera.position)) return;   // the camera is inside the part: nothing to see by design   // nothing to see, so a blank view is correct
    const o = document.createElement('canvas'); o.width = 160; o.height = 90; const c = o.getContext('2d', { willReadFrequently: true }); c.drawImage(cv, 0, 0, 160, 90);
    const px = c.getImageData(0, 0, 160, 90).data; let maxA = 0, maxL = 0;
    for (let i = 0; i < px.length; i += 4) { if (px[i + 3] > maxA) maxA = px[i + 3]; const l = Math.max(px[i], px[i + 1], px[i + 2]); if (l > maxL) maxL = l; }
    const blank = maxA < 6 || maxL < 8;   // nothing was drawn at all (lines in Wire mode are thin, so look for any pixel at all)
    if (!check('3D view is not blank', !blank)) find('blank', 'error', 'The 3D view is blank while the model is in view (mode ' + S.mode + ')');
  } catch (e) { /* tainted or unsupported */ }
}
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
function parseRGBA(s) { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
function bgOf(el) { let a = el; const stack = []; while (a && a.nodeType === 1) { const cs0 = getComputedStyle(a); if (cs0.backgroundImage && cs0.backgroundImage !== 'none') return null; const c = parseRGBA(cs0.backgroundColor); if (c && c[3] > 0.05) { stack.push(c); if (c[3] >= 0.98) break; } a = a.parentElement; } let base = [10, 10, 12]; for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; base = base.map((v, k) => k < 3 ? c[k] * c[3] + v * (1 - c[3]) : 1); } return base; }
let scanBusy = false;
async function checkDom(deep) {
  if (scanBusy) return; scanBusy = true;
  const later = [];   // layout problems are only reported if they are still there a moment later (animations move things)
  const maybe = (kind, sev, msg, where, test) => { later.push({ kind, sev, msg, where, test }); };
  try {
    const modalOpen = !!$('.modal.on, #tut.on, #busy.on, #mobile.on');
    if (!check('page fits the window width', document.documentElement.scrollWidth <= innerWidth + 1)) maybe('visual-overflow', 'warn', `The page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`, 'page', () => document.documentElement.scrollWidth > innerWidth + 1);
    const list = scan(); seenControls(list);
    const ids = new Map(); $$('[id]').forEach((e) => { if (!inDev(e)) ids.set(e.id, (ids.get(e.id) || 0) + 1); });
    ids.forEach((n, id) => { if (n > 1) find('a11y', 'warn', `The id "${id}" is used ${n} times on the page`, { where: id, thumb: false }); });
    const limit = deep ? 400 : 60, sample = deep ? list : list.filter(() => chance(Math.min(1, limit / Math.max(1, list.length))));
    sample.slice(0, limit).forEach(({ el, key: kk, k }) => {
      if (k === 'select' && el.classList.contains('native')) return;
      if (!visible(el) || !showing(el)) return;
      const r = el.getBoundingClientRect(), name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() || el.getAttribute('alt') || (el.labels && el.labels[0] && el.labels[0].textContent.trim()) || el.dataset.tip || '';
      if (!check('every control has a name', !!name || el.type === 'hidden')) find('a11y', 'warn', `A ${k} has no accessible name: ${kk}`, { where: kk, thumb: false });
      const ico = el.querySelector('svg, i'); if (ico && !el.textContent.trim()) { const ir = ico.getBoundingClientRect(); if (!check('button icons render', ir.width > 1 && ir.height > 1)) find('visual-icon', 'warn', `The icon on ${kk} has no size`, { where: kk }); }
      if (!modalOpen && r.width > 2) {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const coverTest = () => { if (!el.isConnected || !showing(el)) return false; const q = el.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2; if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return false; const top = document.elementFromPoint(x, y); coverTest.by = top; return !!top && !(top === el || el.contains(top) || top.contains(el) || el.tagName === 'LABEL' || top.closest('.dd-menu, #toasts, .tip, #devtest, .modal.on, #tut, #busy')); };
        if (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
          const covered = coverTest(); check('controls are not covered by something else', !covered);
          if (covered) maybe('visual-covered', 'warn', `${kk} is covered by ${coverTest.by ? ctlKey(coverTest.by) : 'something'}`, kk, coverTest);
        }
        const sideTest = () => { if (!el.isConnected) return false; const q = el.getBoundingClientRect(); return q.width > 2 && (q.right > innerWidth + 1 || q.left < -1); };
        const out = sideTest(); check('controls are inside the window', !out);
        if (out) maybe('visual-offscreen', 'warn', `${kk} sticks out of the window sideways (${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth})`, kk, sideTest);
      }
      const cs = getComputedStyle(el);
      const clipTest = () => el.isConnected && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).textOverflow !== 'ellipsis' && el.clientWidth > 0;
      if (name && !el.matches('input, textarea, select') && clipTest()) { check('text is not cut off', false); maybe('visual-clipped', 'warn', `Text is cut off in ${kk} (${el.scrollWidth}px of text in ${el.clientWidth}px)`, kk, clipTest); } else check('text is not cut off', true);
    });
    if (deep) {
      const tx = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim().length > 1 && n.parentElement && !inDev(n.parentElement) && !/^(SCRIPT|STYLE)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
      for (let n; (n = w.nextNode()) && tx.length < 250;) { const p = n.parentElement; if (p && visible(p) && showing(p)) tx.push(p); }
      new Set(tx).forEach((p) => {
        const cs = getComputedStyle(p), fg = parseRGBA(cs.color), bg = bgOf(p); if (!fg || !bg) return;   // (a gradient or image behind the text can't be measured this way)
        const fl = lum(fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]))), bl = lum(bg), ratio = (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05), big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.6 && +cs.fontWeight >= 700);
        const faint = p.closest('[disabled], .disabled, [aria-disabled=true], :disabled');
        const ok = !!faint || ratio >= 3; check('text is readable (contrast)', ok);
        if (!ok) maybe('visual-contrast', 'info', `Low contrast ${ratio.toFixed(1)}:1 for "${p.textContent.trim().slice(0, 30)}" in ${ctlKey(p)}`, ctlKey(p), () => { if (!p.isConnected) return false; const c2 = getComputedStyle(p), f2 = parseRGBA(c2.color), b2 = bgOf(p); if (!f2 || !b2) return false; const l1 = lum(f2.slice(0, 3).map((v, i) => v * f2[3] + b2[i] * (1 - f2[3]))), l2 = lum(b2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) < 3; });
      });
      if (document.getAnimations().length > 250) find('jank', 'warn', 'More than 250 animations are running at once', { where: 'animations', thumb: false });
    }
    if (later.length) { await sleep(400); later.forEach((q) => { let still = false; try { still = q.test(); } catch (e) { /* element went away */ } if (still) find(q.kind, q.sev, q.msg, { where: q.where }); }); }
  } finally { scanBusy = false; }
}
function leakCheck() {
  const m = A.renderer.info.memory; if (!T.mem0) { T.mem0 = { g: m.geometries, t: m.textures }; return; }
  if (!check('GPU memory stays bounded', m.geometries - T.mem0.g < 60 && m.textures - T.mem0.t < 40)) find('leak', 'warn', `GPU memory is growing: ${m.geometries} geometries (started ${T.mem0.g}), ${m.textures} textures (started ${T.mem0.t})`, { where: 'gpu', thumb: false });
  if (performance.memory) { const mb = performance.memory.usedJSHeapSize / 1048576; if (!T.heap0) T.heap0 = mb; if (!check('JS memory stays bounded', mb < T.heap0 + 700)) find('leak', 'warn', `JS heap grew from ${T.heap0.toFixed(0)} MB to ${mb.toFixed(0)} MB`, { where: 'heap', thumb: false }); }
}
async function checkDownload(since) {
  const ds = T.downloads.filter((d) => d.n >= since); if (!ds.length) return null;
  for (const d of ds) {
    if (!d.blob) { find('step-invalid', 'warn', 'A download "' + d.name + '" was made but its data could not be read', { where: d.name, thumb: false }); continue; }
    const head = await d.blob.slice(0, 400).text(), tail = await d.blob.slice(Math.max(0, d.blob.size - 200)).text();
    const ok = d.blob.size > 200 && /ISO-10303-21;/.test(head) && /END-ISO-10303-21;/.test(tail) && /FILE_SCHEMA/.test(head + (await d.blob.slice(0, 3000).text()));
    if (!check('exported STEP file is well formed', ok)) find('step-invalid', 'error', `The exported file ${d.name} (${d.blob.size} bytes) is not a valid STEP file: starts "${head.slice(0, 40).replace(/\s+/g, ' ')}"`, { where: d.name, thumb: false });
    if (/\.step$/i.test(d.name) && d.blob.size < 40e6) { const txt = await d.blob.text(); if (!check('exported STEP has no NaN or Infinity', !/\bNaN\b|\bInfinity\b|-Infinity/.test(txt))) find('step-invalid', 'error', `The exported file ${d.name} contains NaN or Infinity numbers`, { where: d.name + 'nan', thumb: false }); }
    feature('STEP exports checked');
  }
  return ds.length;
}
const feature = (n) => T.features.set(n, (T.features.get(n) || 0) + 1);

/* ---------------------------------------------------------------- actions */
const TEXTS = ['', ' ', 'part', 'My Part 2', '<img src=x onerror=alert(1)>', '<b>bold</b>', '"quote\'s"', 'x'.repeat(3000), '日本語のテスト', '😀🔩', '../../etc/passwd', 'a;b,c|d', '-1', '1e309', 'NaN', '0'.repeat(400)];
const NUMS = ['', '0', '-0', '1', '-1', '0.5', '45', '90', '180', '359.99', '360', '-360', '1000', '1e6', '1e12', '-1e12', '0.0000001', '1.', '.5', '1,5', 'abc', '+', 'e', '999999999999999999999'];
const COLORS = () => '#' + ((rng() * 0xffffff) | 0).toString(16).padStart(6, '0');
async function aClick(c) {
  const o = {}; const r = rng(); if (r < 0.04) o.shift = true; else if (r < 0.07) o.ctrl = true; else if (r < 0.09) o.button = 2;
  await realClick(c.el, o);
}
async function aForm(c) {
  const el = c.el; const k = c.k; let d = '';
  if (k === 'select') { const opts = [...el.options]; const o = pick(opts); setValue(el, o.value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); d = o.text; }
  else if (k === 'range') { const mn = +el.min || 0, mx = +el.max || 100, st = +el.step || 1; const v = pick([mn, mx, (mn + mx) / 2, mn + Math.round(rf(0, (mx - mn) / st)) * st, mn - 1, mx + 1]); setValue(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); if (chance(0.6)) el.dispatchEvent(new Event('change', { bubbles: true })); d = String(v); }
  else if (k === 'number') { const v = chance(0.5) ? pick(NUMS) : String(rf(-500, 500).toFixed(ri(0, 4))); el.focus && el.focus({ preventScroll: true }); setValue(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); if (chance(0.5)) el.blur(); d = v; }
  else if (k === 'text') { const v = pick(TEXTS); el.focus && el.focus({ preventScroll: true }); setValue(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); if (chance(0.5)) el.blur(); d = v.slice(0, 30); }
  else if (k === 'color') { const v = COLORS(); setValue(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); if (chance(0.5)) el.dispatchEvent(new Event('change', { bubbles: true })); d = v; }
  else if (k === 'check') { await realClick(el); d = el.checked ? 'on' : 'off'; }
  else if (k === 'dropdown') {
    await realClick(el); await raf(); await raf();
    const items = $$('.dd-i').filter((i) => visible(i) && !inDev(i));
    if (items.length) { const it = pick(items); d = it.textContent.trim().slice(0, 24); await realClick(it); } else d = '(no menu)';
  }
  return d;
}
const DRAGS = ['orbit', 'orbit', 'pan', 'zoom', 'click', 'shiftclick', 'dblclick', 'hover', 'dragout', 'flick', 'pinch', 'ctxmenu', 'ctrlclick'];
async function aCanvas() {
  const el = view(), r = el.getBoundingClientRect(); if (r.width < 20) return 'no canvas';
  const px = () => r.left + rf(0.05, 0.95) * r.width, py = () => r.top + rf(0.05, 0.95) * r.height, kind = pick(DRAGS);
  const x0 = px(), y0 = py();
  const drag = async (btn, steps, dx, dy, o = {}) => { pdown(el, x0, y0, Object.assign({ button: btn }, o)); for (let i = 1; i <= steps; i++) { pmove(x0 + dx * i / steps, y0 + dy * i / steps, Object.assign({ buttons: btn === 2 ? 2 : 1 }, o)); if (i % 3 === 0) await raf(); } pup(el, x0 + dx, y0 + dy, Object.assign({ button: btn }, o)); };
  if (kind === 'orbit') await drag(0, ri(4, 16), rf(-300, 300), rf(-200, 200));
  else if (kind === 'pan') await drag(2, ri(4, 12), rf(-200, 200), rf(-150, 150));
  else if (kind === 'ctrlclick') { fire(el, 'pointerdown', x0, y0, { buttons: 1, ctrl: true }); fire(el, 'pointerup', x0, y0, { ctrl: true }); fire(el, 'click', x0, y0, { ctrl: true, detail: 1 }); }
  else if (kind === 'zoom') { for (let i = ri(1, 8); i > 0; i--) { el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x0, clientY: y0, deltaY: pick([-1, 1]) * pick([3, 33, 100, 400, 2000]), deltaMode: pick([0, 0, 1]), ctrlKey: chance(0.1) })); await raf(); } }
  else if (kind === 'click' || kind === 'shiftclick') { const o = kind === 'shiftclick' ? { shift: true } : {}; pmove(x0, y0); pdown(el, x0, y0, o); pup(el, x0, y0, o); fire(el, 'click', x0, y0, Object.assign({ detail: 1 }, o)); }
  else if (kind === 'dblclick') { pdown(el, x0, y0); pup(el, x0, y0); fire(el, 'click', x0, y0, { detail: 1 }); pdown(el, x0, y0); pup(el, x0, y0); fire(el, 'click', x0, y0, { detail: 2 }); fire(el, 'dblclick', x0, y0, { detail: 2 }); }
  else if (kind === 'hover') { for (let i = 0; i < ri(5, 30); i++) { pmove(px(), py()); if (i % 4 === 0) await raf(); } fire(el, 'pointerleave', x0, y0); }
  else if (kind === 'dragout') { await drag(0, 8, pick([-1, 1]) * (r.width + 200), pick([-1, 1]) * (r.height + 200)); }
  else if (kind === 'flick') { await drag(0, 3, rf(-900, 900), rf(-600, 600)); }
  else if (kind === 'pinch') {
    const p1 = { id: 11, type: 'touch', primary: true, buttons: 1 }, p2 = { id: 12, type: 'touch', primary: false, buttons: 1 }, cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2, s0 = rf(40, 150), s1 = rf(40, 250);
    fire(el, 'pointerdown', cx - s0, cy, p1); fire(el, 'pointerdown', cx + s0, cy, p2);
    for (let i = 1; i <= 8; i++) { const s = s0 + (s1 - s0) * i / 8; fire(el, 'pointermove', cx - s, cy, p1); fire(el, 'pointermove', cx + s, cy, p2); if (i % 3 === 0) await raf(); }
    fire(el, 'pointerup', cx - s1, cy, { id: 11, type: 'touch', buttons: 0 }); fire(el, 'pointerup', cx + s1, cy, { id: 12, type: 'touch', buttons: 0, primary: false });
  } else if (kind === 'ctxmenu') { fire(el, 'contextmenu', x0, y0, { button: 2 }); }
  return kind;
}
const KEYS = [['z', { ctrl: 1 }], ['y', { ctrl: 1 }], ['z', { ctrl: 1, shift: 1 }], ['a', { ctrl: 1 }], ['c', { ctrl: 1 }], ['v', { ctrl: 1 }], ['Escape'], ['Enter'], ['Delete'], ['Backspace'], ['ArrowLeft'], ['ArrowRight'], ['ArrowUp'], ['ArrowDown'], ['Tab'], ['Tab', { shift: 1 }], [' '], ['v'], ['g'], ['r'], ['s'], ['a'], ['m'], ['?'], ['h'], ['f'], ['1'], ['2'], ['3'], ['0'], ['+'], ['-'], ['x'], ['q'], ['e'], ['PageUp'], ['PageDown'], ['Home'], ['End'], ['F1'], ['ContextMenu']];
function aKey() { const [k, o] = pick(KEYS); const tgt = chance(0.3) ? view() : document.activeElement && !inDev(document.activeElement) ? document.activeElement : document.body; key(k, o || {}, tgt); return (o && o.ctrl ? 'Ctrl+' : '') + (o && o.shift ? 'Shift+' : '') + (k === ' ' ? 'Space' : k); }
async function aExample() {
  const all = A.EX().flatMap((g) => g.items.map((e) => ({ id: e.id, tag: e.tag, name: e.name })));
  const ex = pick(all), before = S.mesh;
  if (chance(0.4)) { const b = $('#btnExamples'); if (b) { await realClick(b); await raf(); const it = $(`[data-ex="${ex.id}"]`); if (it && visible(it)) await realClick(it); else await A.loadExample(ex.id); } else await A.loadExample(ex.id); } else await A.loadExample(ex.id);
  await settle(20000);
  if (!check('examples open a model', !!S.mesh && (S.mesh !== before || !before))) find('silent', 'error', `Opening the example "${ex.name}" produced no model`, { where: ex.id });
  else { feature('examples opened'); T.features.set('example: ' + ex.name, (T.features.get('example: ' + ex.name) || 0) + 1); }
  return ex.name;
}
async function aDrop() {
  const f = makeFile(), before = S.mesh, beforeName = S.name, t0 = T.toastSeq;
  T.quiet = f.expect !== 'load';
  const dt = new DataTransfer(); dt.items.add(f.file);
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })); window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await settle(25000); T.quiet = false;
  const loaded = !!S.mesh && (S.mesh !== before || S.name !== beforeName), msgs = T.toasts.filter((m) => m.seq > t0), errToast = msgs.some((m) => m.kind !== 'ok');
  if (f.expect === 'load') { if (!check('valid files open', loaded)) find('silent', 'error', `A valid ${f.what} file did not open${errToast ? ': ' + msgs.map((m) => m.text).join(' / ').slice(0, 160) : ' and no message was shown'}`, { where: f.what }); else { T.counters.loadedOk++; feature('files dropped and opened'); } }
  else if (f.expect === 'reject') { if (!check('bad files are rejected with a message', !loaded || errToast)) find('silent', 'warn', `A bad file (${f.what}) was accepted as a model`, { where: f.what }); else if (!check('bad files give feedback', errToast || msgs.length > 0)) find('silent', 'warn', `A bad file (${f.what}) was ignored with no message`, { where: f.what }); else { T.counters.rejectedOk++; feature('bad files handled'); } }
  else if (!check('odd files do not hang', true)) { /* never */ }
  if (f.expect !== 'load') T.expectedErrToasts = true;
  return f.what;
}
async function aHistory() {
  if (!S.mesh) return 'no model';
  const i0 = A.Hist.info().i, n = ri(1, 6); let moved = 0;
  for (let k = 0; k < n; k++) { const b = A.Hist.info().i; key('z', { ctrl: 1 }, document.body); await settle(15000); if (A.Hist.info().i < b) moved++; }
  const mid = A.Hist.info().i;
  for (let k = 0; k < n; k++) { key('y', { ctrl: 1 }, document.body); await settle(15000); }
  const i1 = A.Hist.info().i;
  if (!check('undo then redo returns to the same step', i1 === i0 || mid === i0)) find('state', 'error', `Undo x${n} then Redo x${n} moved the history from step ${i0 + 1} to ${i1 + 1}`, { where: 'history' });
  else feature('undo/redo round trips');
  return `undo x${n} (${moved} moved) + redo`;
}
async function aExport() {
  if (!S.mesh) { await A.loadExample(pick(['gear', 'bracket', 'knot'])); await settle(20000); }
  const since = T.n, b = $('#btnConvert'); if (!b || b.disabled) return 'export disabled';
  await realClick(b); await settle(60000);
  const got = await checkDownload(since);
  if (!check('Export STEP produces a file', !!got)) find('step-invalid', 'warn', 'Export STEP finished but no file was downloaded' + (T.toasts.slice(-1)[0] ? ' (last message: ' + T.toasts.slice(-1)[0].text + ')' : ''), { where: 'export none' });
  return 'export';
}
const MACROS = {
  async 'tour of finishes'() { await A.loadExample(pick(['gear', 'bracket', 'knot'])); await settle(20000); const b = $('[data-mode="rt"]'); b && await realClick(b); await settle(); for (const k of Object.keys(A.MATS)) { const s = $('#vMat'); if (!s) break; setValue(s, k); s.dispatchEvent(new Event('change', { bubbles: true })); await raf(); await raf(); checkCanvas(); feature('finish: ' + k); } for (const m of ['wire', 'solid', 'rt']) { const bb = $(`[data-mode="${m}"]`); bb && await realClick(bb); await raf(); await raf(); checkCanvas(); } },
  async 'repair flow'() { const ids = A.EX().flatMap((g) => g.items).filter((e) => e.raw).map((e) => e.id); await A.loadExample(pick(ids)); await settle(20000); const fx = $$('button').find((b) => /fix everything/i.test(b.textContent) && visible(b)); if (fx) { await realClick(fx); await settle(30000); feature('fix everything'); } key('z', { ctrl: 1 }, document.body); await settle(); key('y', { ctrl: 1 }, document.body); await settle(); },
  async 'rapid fire'() { const list = scan().filter((c) => c.k !== 'link'); for (let i = 0; i < 20 && list.length; i++) { const c = pick(list); if (c.el.isConnected) { c.k === 'button' || c.k === 'check' ? await realClick(c.el) : await aForm(c); note(c.key, c.key, c.k, false); } if (chance(0.5)) await raf(); } },
  async 'mode thrash'() { for (let i = 0; i < 24; i++) { const b = $(`[data-mode="${pick(['solid', 'wire', 'rt', 'solid', 'rt'])}"]`); b && b.isConnected && (pdown(b, ...center(b)), pup(b, ...center(b)), fire(b, 'click', ...center(b), { detail: 1 })); if (chance(0.6)) await raf(); } },
  async 'transform stress'() { if (!S.mesh) { await A.loadExample('gear'); await settle(20000); } for (const k of ['g', 'r', 's', 'v']) { key(k, {}, document.body); await aCanvas(); await aCanvas(); } const fields = scan().filter((c) => c.k === 'number'); for (let i = 0; i < 6 && fields.length; i++) await aForm(pick(fields)); await aHistory(); },
  async 'drop burst'() { for (let i = 0; i < 3; i++) await aDrop(); },
};
async function aMacro() { const name = pick(Object.keys(MACROS)); T.sub++; await MACROS[name](); feature('macro: ' + name); return name; }

const KINDS = [
  ['click', 38, async (st) => { const c = wpick(st.list.filter((q) => q.k === 'button' || q.k === 'link' || q.k === 'dropdown'), (q) => 1 / Math.pow(1 + (T.cover.get(q.key) ? T.cover.get(q.key).n : 0), 1.2)); if (!c) return null; T.cur.ctl = c.key; T.cur.desc = 'click ' + c.key; await aClick(c); note(c.key, c.key, c.k, false); return c.key; }],
  ['form', 18, async (st) => { const c = wpick(st.list.filter((q) => ['select', 'range', 'number', 'text', 'color', 'check', 'dropdown'].includes(q.k)), (q) => 1 / Math.pow(1 + (T.cover.get(q.key) ? T.cover.get(q.key).n : 0), 1.2)); if (!c) return null; T.cur.ctl = c.key; const d = await aForm(c); T.cur.desc = `${c.k} ${c.key} = ${d}`; note(c.key, c.key, c.k, false); return c.key; }],
  ['canvas', 20, async () => { const d = await aCanvas(); T.cur.desc = 'mouse ' + d; return null; }],
  ['key', 8, async () => { const d = aKey(); T.cur.desc = 'key ' + d; return null; }],
  ['example', 5, async () => { const d = await aExample(); T.cur.desc = 'open example ' + d; return null; }],
  ['drop', 4, async () => { const d = await aDrop(); T.cur.desc = 'drop file ' + d; return null; }],
  ['history', 3, async () => { const d = await aHistory(); T.cur.desc = d; return null; }],
  ['export', 2, async () => { const d = await aExport(); T.cur.desc = d; return null; }],
  ['macro', 2, async () => { const d = await aMacro(); T.cur.desc = 'macro: ' + d; return null; }],
];

/* ---------------------------------------------------------------- one test */
async function oneAction() {
  T.n++; const n = T.n;
  heal();
  const st = { list: scan() }; seenControls(st.list);
  let kind = wpick(KINDS, (k) => k[1] * (!S.mesh && (k[0] === 'history' || k[0] === 'canvas') ? 0.25 : 1)), cur = T.cur = { n, kind: kind[0], desc: kind[0], ctl: '', bad: [] };
  // tester load when nothing is open: most actions mean little without a model
  if (!S.mesh && chance(0.5)) { kind = KINDS.find((k) => k[0] === 'example'); cur.kind = 'example'; }
  const tt0 = T.toastSeq, sh0 = T.shifts, lt0 = T.longtasks.length, t0 = now();
  FM.max = 0; T.expectedErrToasts = false; const dl0 = T.downloads.length;
  try { await kind[2](st); } catch (e) { find('js-error', 'error', 'Action threw: ' + (e && e.message), { stack: e && e.stack }); }
  const ok = await settle(kind[0] === 'export' ? 60000 : 15000);
  await raf(); await sleep(30);
  const ms = now() - t0;
  // oracles
  const ks = T.kinds.get(cur.kind) || { n: 0, bad: 0, ms: [], jank: 0 }; ks.n++; ks.ms.push(ms); if (ks.ms.length > 400) ks.ms.shift(); T.kinds.set(cur.kind, ks);
  checkState();
  if (n % 2 === 0) checkCanvas();
  if (n % 6 === 0) await checkDom(false);
  if (n % 60 === 0) await checkDom(true);
  if (n % 40 === 0) leakCheck();
  // toasts that said something went wrong
  T.toasts.filter((m) => m.seq > tt0 && m.kind === 'err').forEach((m) => { if (!T.expectedErrToasts && !check('no unexpected error messages', false)) find('toast-error', 'warn', 'The app showed an error message: ' + m.text, { where: m.text.slice(0, 40), thumb: false }); });
  // XSS: typed text must not become markup
  if ($$('img[src="x"]').some((i) => !inDev(i))) find('xss', 'error', 'Text typed or dropped into the app became live HTML (an <img src=x> exists)', { where: 'xss' });
  // smoothness
  const worst = FM.max, jank = Math.max(80, T.base * 3.2), freeze = Math.max(300, T.base * 9);
  if (!check('no long freezes', worst < freeze)) find('freeze', 'error', `The page froze for ${Math.round(worst)} ms after: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || ''), thumb: false });
  else if (!check('frames stay smooth', worst < jank)) { ks.jank++; find('jank', 'warn', `A frame took ${Math.round(worst)} ms (normal is ${Math.round(T.base)} ms) after: ${cur.kind}`, { where: cur.kind, thumb: false }); }
  const shift = T.shifts - sh0; if (!check('layout does not jump', shift < 0.25)) find('layout-shift', 'info', `The layout shifted (score ${shift.toFixed(2)}) after: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || ''), thumb: false });
  const slow = cur.kind === 'example' || cur.kind === 'export' || cur.kind === 'drop' || cur.kind === 'macro' ? 30000 : 3000;
  if (!check('actions finish promptly', ms < slow)) find('slow', 'warn', `${cur.kind} took ${(ms / 1000).toFixed(1)} s: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || ''), thumb: false });
  const bad = cur.bad.length > 0; if (bad) { T.fail++; ks.bad++; if (cur.ctl && T.cover.get(cur.ctl)) T.cover.get(cur.ctl).bad++; } else T.pass++;
  T.recent.push(`#${n} ${cur.desc}`); if (T.recent.length > 40) T.recent.shift();
  logLine(bad ? 'bad' : 'ok', `#${n} ${cur.desc}${bad ? '  ⟵ ' + cur.bad.join(', ') : ''}`);
  T.cur = null;
}

/* ---------------------------------------------------------------- run control */
async function calibrate() {
  FM.on = true; FM.last = 0; T.dts = []; requestAnimationFrame(fmLoop);
  await sleep(1100);
  const d = T.dts.slice(2).sort((a, b) => a - b); T.base = d.length ? d[Math.floor(d.length / 2)] : 16.7;
}
async function loop() {
  while (T.running) {
    if (T.paused || document.hidden) { await sleep(250); if (document.hidden && !T.hiddenWarned) { T.hiddenWarned = true; logLine('warn', 'The tab is in the background, so the browser slows timers. Keep this tab visible for 10 actions per second.'); } continue; }
    T.hiddenWarned = false; const t0 = now();
    try { await oneAction(); } catch (e) { find('js-error', 'error', 'Tester error: ' + (e && e.message), { stack: e && e.stack }); T.cur = null; }
    T.rateWin.push(now()); while (T.rateWin.length > 40) T.rateWin.shift();
    if (T.max && T.n >= T.max) { stop('reached ' + T.max + ' actions'); break; }
    if (T.duration && now() - T.tRun > T.duration * 1000) { stop('time limit'); break; }
    const wait = T.turbo ? 0 : Math.max(0, 1000 / T.rate - (now() - t0)); if (wait > 0) await sleep(wait); else await raf();
    if (T.n % 25 === 0) autosave();
  }
}
async function start(o = {}) {
  if (T.running) return;
  T.seed = o.seed != null ? +o.seed : (T.seed || 1); rng = mulberry32(T.seed >>> 0); T.rate = o.rate || T.rate || 10; T.max = o.max != null ? +o.max : T.max; T.duration = o.duration || 0; T.turbo = !!o.turbo; T.quiet = false;
  if (T.n === 0 || o.reset) resetStats(); T.running = true; T.paused = false; T.tEnd = 0; T.tRun = now(); T.t0 = T.t0 || Date.now(); T.endReason = '';
  { const al = $('#alphaModal.on #alphaGo'); if (al) al.click(); }   // (the alpha-testing popup shown when the page loads)
  hook(); logLine('ok', `Started: seed ${T.seed}, ${T.turbo ? 'full speed' : T.rate + ' actions/s'}${T.max ? ', ' + T.max + ' actions' : ', until stopped'}`); ui();
  await calibrate(); if (!T.running) return; loop();
}
function stop(why) { if (!T.running) return; T.running = false; T.tEnd = now(); T.endReason = why || 'stopped'; FM.on = false; unhook(); logLine('ok', 'Finished: ' + T.endReason); autosave(); ui(); }
function resetStats() {
  Object.assign(T, { n: 0, sub: 0, pass: 0, fail: 0, checks: new Map(), kinds: new Map(), issues: new Map(), log: [], recent: [], cur: null, cover: new Map(), pairs: new Set(), lastKey: '', features: new Map(), downloads: [], counters: { filePickerBlocked: 0, externalBlocked: 0, dialogs: 0, healed: 0, rejectedOk: 0, loadedOk: 0 }, toasts: [], shifts: 0, longtasks: [], mem0: null, heap0: 0, rateWin: [], thumbs: 0, t0: Date.now(), offscreen: 0, errCount: 0 });
}

/* ---------------------------------------------------------------- report */
const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
const fmtT = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };
function build() {
  const dur = (T.running ? now() : T.tEnd || now()) - (T.tRun || now()), issues = [...T.issues.values()].sort((a, b) => sevRank[b.sev] - sevRank[a.sev] || b.count - a.count);
  const tot = [...T.cover.values()], hit = tot.filter((c) => c.n > 0), miss = tot.filter((c) => c.n === 0);
  const rate = T.rateWin.length > 2 ? (T.rateWin.length - 1) / ((T.rateWin[T.rateWin.length - 1] - T.rateWin[0]) / 1000) : 0;
  const dts = [...T.dts].sort((a, b) => a - b), p = (q) => dts.length ? dts[Math.min(dts.length - 1, Math.floor(q * dts.length))] : 0;
  const errs = issues.filter((i) => i.sev === 'error'), warns = issues.filter((i) => i.sev === 'warn'), infos = issues.filter((i) => i.sev === 'info');
  return { dur, issues, errs, warns, infos, tot, hit, miss, rate, p50: p(0.5), p95: p(0.95), p99: p(0.99), fps: dts.length ? 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length) : 0 };
}
function reportText() {
  const R = build(), L = [];
  L.push('# 3D File to STEP File: automatic UX test report', '', `Seed ${T.seed} · ${T.n} actions (${T.sub} extra steps inside macros) in ${fmtT(R.dur)} · about ${R.rate.toFixed(1)} actions/s · ${T.endReason || (T.running ? 'still running' : 'stopped')}`, '');
  const verdict = R.errs.length ? 'NEEDS ATTENTION' : R.warns.length ? 'GOOD, WITH WARNINGS' : 'ALL CLEAR';
  L.push(`## Verdict: ${verdict}`, `- ${T.pass} of ${T.n} actions passed every check (${pct(T.pass, T.n)}%), ${T.fail} had a problem`, `- ${R.errs.length} errors, ${R.warns.length} warnings, ${R.infos.length} notes (distinct problems)`, `- Smoothness: ${R.fps.toFixed(0)} fps average, frame time typical ${R.p50.toFixed(0)} ms, 95th ${R.p95.toFixed(0)} ms, 99th ${R.p99.toFixed(0)} ms; ${T.longtasks.length} long tasks`, '');
  L.push('## What went wrong');
  if (!R.issues.length) L.push('Nothing. Every check passed.');
  R.issues.forEach((i, k) => {
    L.push('', `### ${k + 1}. [${i.sev.toUpperCase()}] ${i.kind}: ${i.msg}`, `- Seen ${i.count} time${i.count > 1 ? 's' : ''}, first at action #${i.first}, last at #${i.last}${i.actions.size ? ' · during: ' + [...i.actions].join(', ') : ''}${i.ctl.size ? ' · controls: ' + [...i.ctl].slice(0, 4).join(', ') : ''}`);
    if (i.diag) L.push(`- Likely cause: ${i.diag}`);
    if (i.state) L.push('- App state when it first happened: ' + i.state);
    if (i.stack) L.push('- Stack: ' + i.stack.split('\n').slice(0, 4).map((l) => l.trim()).join(' | '));
    L.push(`- To reproduce (seed ${i.seed}), the last actions before it were:`, ...i.repro.slice(-8).map((r) => '    ' + r));
  });
  L.push('', '## What went right');
  [...T.checks.entries()].sort((a, b) => b[1].runs - a[1].runs).forEach(([n, c]) => L.push(`- ${c.bad ? '✗' : '✓'} ${n}: ${c.runs - c.bad} of ${c.runs} passed`));
  if (T.features.size) { L.push('', '## Features exercised'); [...T.features.entries()].filter(([k]) => !/^example: /.test(k)).forEach(([k, v]) => L.push(`- ${k}: ${v}`)); const ex = [...T.features.keys()].filter((k) => /^example: /.test(k)); if (ex.length) L.push(`- examples opened: ${ex.length} different (${ex.map((k) => k.slice(9)).join(', ')})`); }
  L.push('', '## Actions', ...[...T.kinds.entries()].map(([k, v]) => { const a = [...v.ms].sort((x, y) => x - y); return `- ${k}: ${v.n} run, ${v.bad} with problems, median ${Math.round(a[Math.floor(a.length / 2)] || 0)} ms, slowest ${Math.round(a[a.length - 1] || 0)} ms${v.jank ? ', ' + v.jank + ' janky' : ''}`; }));
  L.push('', '## Coverage', `- Controls found: ${R.tot.length}; used at least once: ${R.hit.length} (${pct(R.hit.length, R.tot.length)}%); different control-to-control combinations tried: ${T.pairs.size}`, `- Blocked safely: ${T.counters.filePickerBlocked} file pickers, ${T.counters.externalBlocked} external links, ${T.counters.dialogs} browser dialogs; stuck states healed: ${T.counters.healed}`);
  const worstCtl = R.tot.filter((c) => c.bad).sort((a, b) => b.bad - a.bad).slice(0, 8); if (worstCtl.length) L.push('- Controls involved in the most problems: ' + worstCtl.map((c) => `${c.label} (${c.bad})`).join('; '));
  if (R.miss.length) L.push(`- Not used yet (${R.miss.length}): ${R.miss.slice(0, 40).map((c) => c.label).join('; ')}${R.miss.length > 40 ? '; …' : ''}`);
  return L.join('\n');
}
function reportJSON() { const R = build(); return JSON.stringify({ seed: T.seed, actions: T.n, durationMs: Math.round(R.dur), rate: R.rate, pass: T.pass, fail: T.fail, issues: R.issues.map((i) => ({ kind: i.kind, severity: i.sev, message: i.msg, count: i.count, first: i.first, last: i.last, likelyCause: i.diag, stack: i.stack, state: i.state, during: [...i.actions], controls: [...i.ctl], repro: i.repro, thumb: i.thumb })), checks: Object.fromEntries([...T.checks.entries()].map(([k, v]) => [k, v])), kinds: Object.fromEntries([...T.kinds.entries()].map(([k, v]) => [k, { n: v.n, bad: v.bad, jank: v.jank }])), features: Object.fromEntries(T.features), coverage: { total: R.tot.length, used: R.hit.length, pairs: T.pairs.size, unused: R.miss.map((c) => c.label) }, smoothness: { fps: R.fps, p50: R.p50, p95: R.p95, p99: R.p99, longTasks: T.longtasks.length } }, null, 1); }
function autosave() { try { localStorage.setItem('devtest-report', JSON.stringify({ at: Date.now(), n: T.n, text: reportText() })); } catch (e) { /* ignore */ } }
function download(name, text, type) { const b = new Blob([text], { type }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click')); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }

/* ---------------------------------------------------------------- panel */
let el = null, tab = 'log', lastUi = 0;
const CSS = `#devtest{position:fixed;left:12px;bottom:12px;width:460px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 24px);z-index:2147483000;display:flex;flex-direction:column;background:#0d0f13f2;color:#e8eaee;border:1px solid #2c323c;border-radius:12px;box-shadow:0 18px 60px #000a;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:both;overflow:hidden;min-width:340px;min-height:220px}
#devtest *{box-sizing:border-box}#devtest .h{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #232831;cursor:move;user-select:none}#devtest .h b{font:700 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}#devtest .h .sp{flex:1}
#devtest button{font:600 11px system-ui,sans-serif;color:#e8eaee;background:#1b2028;border:1px solid #333b47;border-radius:7px;padding:5px 9px;cursor:pointer}#devtest button:hover{border-color:#6c7a90}#devtest button.go{background:#1f6f43;border-color:#2e9d62}#devtest button.no{background:#7a2530;border-color:#b0404f}#devtest button.on{border-color:#7ab8ff;color:#7ab8ff}
#devtest input{font:11px ui-monospace,monospace;color:#e8eaee;background:#12161c;border:1px solid #333b47;border-radius:6px;padding:4px 6px;width:64px}#devtest label{display:flex;align-items:center;gap:4px;color:#98a2b3}
#devtest .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #232831}#devtest .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#232831;border-bottom:1px solid #232831}#devtest .stats div{background:#0d0f13;padding:6px 8px}#devtest .stats b{display:block;font-size:15px}#devtest .stats span{color:#98a2b3;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
#devtest .tabs{display:flex;gap:4px;padding:6px 10px 0}#devtest .body{flex:1;overflow:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word}#devtest .ok{color:#7bd59a}#devtest .bad{color:#ff7b8a}#devtest .warn{color:#ffc766}#devtest .dim{color:#7b8696}#devtest .iss{border:1px solid #2c323c;border-radius:8px;padding:7px 9px;margin-bottom:7px;background:#12161c}#devtest .iss h4{margin:0 0 3px;font:700 11px system-ui,sans-serif}#devtest .iss img{display:block;margin-top:5px;border-radius:5px;max-width:100%}
#devtest>.h,#devtest>.row,#devtest>.stats,#devtest>.tabs,#devtest>.bar{flex:none}#devtest .body{flex:1 1 auto;min-height:0}#devtest .tabs{flex-wrap:wrap;padding-bottom:6px}
#devtest .bar{height:4px;background:#232831}#devtest .bar i{display:block;height:100%;background:#2e9d62}`;
function build_ui() {
  if (el) return;
  const st = document.createElement('style'); st.id = 'devtest-css'; st.textContent = CSS; document.head.appendChild(st);
  el = document.createElement('div'); el.id = 'devtest'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Automatic UX tester');
  el.innerHTML = `<div class="h"><b>UX tester</b><span class="dim">press ` + '`' + ` to hide</span><span class="sp"></span><button data-a="min" title="Collapse">–</button><button data-a="close" title="Hide (the test keeps running)">✕</button></div>
<div class="row"><button class="go" data-a="start">▶ Start</button><button data-a="pause" disabled>❚❚ Pause</button><button class="no" data-a="stop" disabled>■ Stop</button>
<label>per sec<input id="dtRate" type="number" min="1" max="60" value="10"></label><label>max<input id="dtMax" type="number" min="0" value="0" title="0 = keep going until stopped"></label><label>seed<input id="dtSeed" type="number" value="1"></label><label title="Ignore the rate and go as fast as the page allows"><input id="dtTurbo" type="checkbox" style="width:auto">turbo</label></div>
<div class="bar"><i id="dtBar" style="width:0%"></i></div>
<div class="stats"><div><b id="dtN">0</b><span>actions</span></div><div><b id="dtP" class="ok">0</b><span>passed</span></div><div><b id="dtF" class="bad">0</b><span>failed</span></div><div><b id="dtR">0</b><span>per sec</span></div><div><b id="dtT">0s</b><span>running</span></div></div>
<div class="tabs"><button data-t="log" class="on">Live log</button><button data-t="issues">Problems <span id="dtI">0</span></button><button data-t="report">Report</button><button data-t="cover">Coverage</button></div>
<div class="body" id="dtBody"></div>
<div class="row"><button data-a="copy">Copy report</button><button data-a="md">Save .md</button><button data-a="json">Save .json</button><button data-a="clear">Clear</button><span class="dim" id="dtMsg"></span></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.t) { tab = b.dataset.t; $$('.tabs button', el).forEach((x) => x.classList.toggle('on', x === b)); ui(true); return; }
    const a = b.dataset.a;
    if (a === 'start') start({ seed: +$('#dtSeed').value || 1, rate: clamp(+$('#dtRate').value || 10, 1, 60), max: Math.max(0, +$('#dtMax').value || 0), turbo: $('#dtTurbo').checked, reset: T.n > 0 && !T.running });
    else if (a === 'stop') stop('stopped by you');
    else if (a === 'pause') { T.paused = !T.paused; b.textContent = T.paused ? '▶ Resume' : '❚❚ Pause'; }
    else if (a === 'close') toggle(false);
    else if (a === 'min') el.style.height = el.style.height === '40px' ? '520px' : '40px';
    else if (a === 'copy') { const t = reportText(); (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => msg('Report copied'), () => { tab = 'report'; ui(true); msg('Select and copy from the Report tab'); }); }
    else if (a === 'md') download('ux-test-report.md', reportText(), 'text/markdown');
    else if (a === 'json') download('ux-test-report.json', reportJSON(), 'application/json');
    else if (a === 'clear') { if (!T.running) { resetStats(); ui(true); } else msg('Stop the test first'); }
  });
  // drag by the header
  let drag = null; $('.h', el).addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; const r = el.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top }; el.setPointerCapture && e.isTrusted && el.setPointerCapture(e.pointerId); });
  addEventListener('pointermove', (e) => { if (!drag || !e.isTrusted) return; el.style.left = clamp(e.clientX - drag.x, 0, innerWidth - 100) + 'px'; el.style.top = clamp(e.clientY - drag.y, 0, innerHeight - 40) + 'px'; el.style.bottom = 'auto'; });
  addEventListener('pointerup', () => { drag = null; });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  setInterval(() => { if (T.open && now() - lastUi > 400) ui(); }, 500);
}
const msg = (t) => { const m = $('#dtMsg'); if (m) { m.textContent = t; setTimeout(() => { m.textContent = ''; }, 2500); } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ui(force) {
  if (!el || (!T.open && !force)) return; lastUi = now();
  const R = build(), set = (id, v) => { const e = $('#' + id); if (e && e.textContent !== String(v)) e.textContent = v; };
  set('dtN', T.n); set('dtP', T.pass); set('dtF', T.fail); set('dtR', R.rate.toFixed(1)); set('dtT', fmtT(R.dur)); set('dtI', R.issues.length);
  const bar = $('#dtBar'); if (bar) bar.style.width = (T.max ? Math.min(100, 100 * T.n / T.max) : T.running ? (T.n % 100) : 0) + '%';
  const s = $('[data-a=start]', el), p = $('[data-a=pause]', el), x = $('[data-a=stop]', el); s.disabled = T.running; p.disabled = !T.running; x.disabled = !T.running; s.textContent = T.running ? '● Running' : T.n ? '▶ Run again' : '▶ Start';
  const body = $('#dtBody'), atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  if (tab === 'log') { body.innerHTML = T.log.slice(-160).map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('') || '<span class="dim">Press Start. It will click, drag, type, drop files and press keys by itself, and check what happens. Leave this tab in front so the browser does not slow it.</span>'; if (atBottom) body.scrollTop = body.scrollHeight; }
  else if (tab === 'issues') { body.innerHTML = R.issues.length ? R.issues.map((i) => `<div class="iss"><h4 class="${i.sev === 'error' ? 'bad' : i.sev === 'warn' ? 'warn' : 'dim'}">${i.sev.toUpperCase()} · ${esc(i.kind)} · ×${i.count}</h4>${esc(i.msg)}${i.diag ? `<div class="dim">Likely cause: ${esc(i.diag)}</div>` : ''}<div class="dim">first at #${i.first} · ${esc([...i.actions].join(', '))}</div>${i.thumb ? `<img src="${i.thumb}" alt="">` : ''}<div class="dim">${esc(i.repro.slice(-5).join('\n'))}</div></div>`).join('') : '<span class="ok">No problems found so far.</span>'; }
  else if (tab === 'report') body.textContent = reportText();
  else if (tab === 'cover') { const rows = [...T.cover.values()].sort((a, b) => a.n - b.n); body.innerHTML = `<div class="dim">${R.hit.length} of ${R.tot.length} controls used · ${T.pairs.size} combinations</div>` + rows.slice(0, 300).map((c) => `<div class="${c.n ? (c.bad ? 'bad' : 'ok') : 'dim'}">${String(c.n).padStart(4)} × ${esc(c.label)} <span class="dim">(${c.kind}${c.bad ? ', ' + c.bad + ' problems' : ''})</span></div>`).join(''); }
}
function toggle(force) {
  build_ui(); T.open = force == null ? !T.open : !!force; el.hidden = !T.open; if (T.open) ui(true);
}
window.DevTest = { toggle, start, stop, report: reportText, reportJSON, state: T, issues: () => [...T.issues.values()] };
})();
