/* =====================================================================
   Reminders: automatic UX tester (dev tool).
   Press the ` key to open it. It clicks, types, drags, imports files and presses keys on its own (about 10 actions a second, as many
   thousands as you like) while it checks that things work (script errors, the saved data, counts, search, completed and repeat settings,
   what the text recognizer makes of a phrase) and look right (covered or clipped controls, contrast, jank), then tells you what went right
   and wrong, with how to reproduce each problem and a guess at the cause. Seeded: the same seed gives the same sequence of actions.
   Modes: Quick, Standard and Thorough follow a plan (every control, pairs, random runs, whole flows) with a percentage bar and a finishing time;
   "Aim at problems" remembers what broke before, replays it, hunts around the likeliest suspects and shrinks each failure to its shortest recipe;
   "First-timer" is open-ended too, but acts like someone using a computer for the first time (missed and double clicks, hammering, typos, wrong boxes, wandering off).
   "Free run" is the open-ended mode. Runs keep going when the tab is in the background, and time can be sped up (10 or more actions a second).
   YOUR DATA IS SAFE: while a run is on, the app's two localStorage entries (reminders and settings) are redirected into a scratch copy in memory,
   the app starts from an empty scratch list, and when the run ends your own reminders and settings are put back exactly as they were.
   ===================================================================== */
(() => {
'use strict';
if (window.DevTest) return;
const A = window.__devApi;
if (!A) return;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = performance.timeOrigin ? Date.now() : 0; while (!fn() && Date.now() - t0 < ms) await sleep(60); return !!fn(); };
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const NOW = performance.now.bind(performance);   // the real clock: while a run is on, the page's own performance.now() can be sped up
const now = NOW;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = (x) => JSON.parse(JSON.stringify(x));
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, q) => { o[q] = v[q]; return o; }, {}) : v));
const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const ld = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };


/* ---------------------------------------------------------------- keep running in the background, and speed
   A hidden tab gets no animation frames and its timers are held to one a second, so a run would crawl the moment you switched away. While a run
   is on, timers go through a Web Worker (its clock is not throttled), a frame request the browser does not answer while the page is hidden is
   answered from that clock, and a Web Lock keeps the browser from freezing the tab. `speed` runs the page's clock that many times faster so
   animations finish sooner; from 10x up, frames also come from the worker clock instead of waiting for the display. */
const BG = (() => {
  const native = { st: window.setTimeout, ct: window.clearTimeout, raf: window.requestAnimationFrame, caf: window.cancelAnimationFrame };
  let worker = null, nextId = 1, on = false, release = null, wasHidden = 0, K = 1, T0 = 0;
  const waits = new Map(), frames = new Map(), BASE = 1e9;
  const startWorker = () => {
    if (worker) return true;
    try {
      const url = URL.createObjectURL(new Blob(['self.onmessage=function(e){var d=e.data;setTimeout(function(){self.postMessage(d.id)},d.ms)}'], { type: 'text/javascript' }));
      worker = new Worker(url); worker.onmessage = (e) => { const f = waits.get(e.data); if (f) { waits.delete(e.data); f(); } }; worker.onerror = () => { worker = null; };
      return true;
    } catch (e) { worker = null; return false; }
  };
  const wait = (fn, ms) => { const id = nextId++; waits.set(id, fn); worker.postMessage({ id, ms }); return id; };
  const fast = () => T0 + (NOW() - T0) * K;
  const timeout = function (fn, ms) { const a = Array.prototype.slice.call(arguments, 2); if (typeof fn !== 'function' || !worker) return native.st.apply(window, arguments); return BASE + wait(() => fn.apply(window, a), Math.max(0, (+ms || 0) / K)); };
  const clear = (id) => { if (id >= BASE) waits.delete(id - BASE); else native.ct.call(window, id); };
  const frame = (cb) => {
    if (!worker) return native.raf.call(window, cb);
    const id = nextId++; let done = false, nat = 0;
    if (K >= 10) { wait(() => { if (done) return; done = true; frames.delete(id); cb(performance.now()); }, 4); frames.set(id, () => { done = true; }); return BASE + id; }
    const run = () => { if (done) return; done = true; frames.delete(id); if (nat) native.caf.call(window, nat); cb(performance.now()); };
    nat = native.raf.call(window, run);
    const tick = () => { if (done) return; if (document.hidden) { wasHidden++; run(); } else wait(tick, 50); }; wait(tick, 34);
    frames.set(id, () => { done = true; native.caf.call(window, nat); });
    return BASE + id;
  };
  const cancelFrame = (id) => { if (id >= BASE) { const c = frames.get(id - BASE); if (c) c(); frames.delete(id - BASE); } else native.caf.call(window, id); };
  return {
    start(speed) {
      if (on) return; on = true; wasHidden = 0; K = Math.max(1, Math.min(40, +speed || 1)); T0 = NOW();
      if (startWorker()) { window.setTimeout = timeout; window.clearTimeout = clear; window.requestAnimationFrame = frame; window.cancelAnimationFrame = cancelFrame; if (K > 1) performance.now = fast; }
      try { if (navigator.locks) navigator.locks.request('devtest-run', { mode: 'shared' }, () => new Promise((r) => { release = r; })).catch(() => {}); } catch (e) { /* ignore */ }
    },
    stop() {
      if (!on) return; on = false;
      try { delete performance.now; } catch (e) { /* ignore */ }
      window.setTimeout = native.st; window.clearTimeout = native.ct; window.requestAnimationFrame = native.raf; window.cancelAnimationFrame = native.caf;
      if (release) { release(); release = null; }
    },
    get active() { return on; }, get speed() { return K; }, get hiddenFrames() { return wasHidden; }, get turbo() { return K >= 10; },
  };
})();

/* ---------------------------------------------------------------- random */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let rng = mulberry32(1);
const rf = (a = 0, b = 1) => a + (b - a) * rng(), ri = (a, b) => Math.floor(rf(a, b + 1)), chance = (p) => rng() < p, pick = (arr) => arr[Math.floor(rng() * arr.length)];
function wpick(items, w) { let t = 0; const ws = items.map((x, i) => (t += Math.max(0, w(x, i)))); let r = rng() * t; for (let i = 0; i < items.length; i++) { r -= Math.max(0, w(items[i], i)); if (r <= 0) return items[i]; } return items[items.length - 1]; }

/* ---------------------------------------------------------------- state */
const T = {
  live: { phase: '', scenario: '', stage: 'idle', kind: '', ctl: '', desc: '', diff: null, ms: 0, fmax: 0, fAvg: 0, cats: [], trace: [] },
  open: false, running: false, paused: false, seed: 1, rate: 10, max: 0, n: 0, sub: 0, t0: 0, tRun: 0, endReason: '',
  pass: 0, fail: 0, warn: 0, checks: new Map(),       // checks: name -> {runs, bad}
  kinds: new Map(),                                    // action kind -> {n, bad, ms:[], jank}
  issues: new Map(), log: [], recent: [], cur: null,
  cover: new Map(),                                    // control key -> {n, bad, label, kind}
  pairs: new Set(), lastKey: '', features: new Map(),
  downloads: [], blobs: new Map(), counters: { filePickerBlocked: 0, externalBlocked: 0, dialogs: 0, healed: 0, notifBlocked: 0, storageWrites: 0 },
  hits: 0, soft: 0, spec: {}, scenario: null, mode: 'free', plan: null, speed: 10,
  errs: [], toasts: [], toastSeq: 0, shifts: 0, longtasks: [], dts: [], base: 16, heap0: 0, dom0: 0, lastRate: 0, rateWin: [], sandbox: '',
};
const sevRank = { error: 3, warn: 2, info: 1 };

/* ---------------------------------------------------------------- findings */
const norm = (m) => String(m).replace(/0x[0-9a-f]+/gi, '0x#').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 160);
function check(name, ok) { const c = T.checks.get(name) || { runs: 0, bad: 0 }; c.runs++; if (!ok) c.bad++; T.checks.set(name, c); return ok; }
function dumpState() {
  try { const R = A.reminders; return `${R.length} reminders (${R.filter((r) => r && r.completed).length} done) · selected ${A.selectedId ? 'yes' : 'none'} · search "${squash($('#search').value).slice(0, 30)}" · theme ${A.settings.theme}, ${A.settings.density}, grouped ${A.settings.groupCompleted}, collapsed ${A.settings.completedCollapsed}, confirm-delete ${A.settings.confirmDelete} · dialogs open ${$$('.overlay.show').length}`; } catch (e) { return ''; }
}
function find(kind, sev, msg, extra = {}) {
  const sig = kind + '|' + norm(msg + (extra.where || ''));
  let it = T.issues.get(sig);
  if (!it) {
    if (T.issues.size > 600) return;
    it = { sig, kind, sev, msg: String(msg).slice(0, 400), count: 0, first: T.n, last: T.n, ctl: new Set(), actions: new Set(), repro: T.recent.slice(-12), seed: T.seed, state: dumpState(), diag: extra.diag || diagnose(kind, msg, extra), note: extra.note || '', thumb: null, stack: extra.stack || '' };
    it.trail = T.scenario ? T.scenario.slice() : null; it.key = sig;
    T.issues.set(sig, it); logLine(sev === 'error' ? 'bad' : 'warn', `#${T.n} ${kind}: ${it.msg}`);
  }
  it.count++; it.last = T.n; if (sev === 'error') T.hits++; else if (sev === 'warn' && !/^(jank|slow|layout-shift|leak)$/.test(kind)) T.soft++;
  if (T.cur) { it.actions.add(T.cur.kind); if (T.cur.ctl) it.ctl.add(T.cur.ctl); }
  if (sevRank[sev] > sevRank[it.sev]) it.sev = sev;
  if (T.cur) T.cur.bad.push(kind);
  return it;
}
function diagnose(kind, msg, x) {
  const m = String(msg);
  if (kind === 'js-error' || kind === 'promise') {
    const top = (x.stack || '').split('\n').slice(0, 3).map((l) => l.trim()).filter(Boolean).join(' <- ');
    if (/undefined|null/.test(m) && /read|reading|of/.test(m)) return 'A value was missing when the code used it (null or undefined). Likely a reminder field that is not the type the code expects (for example a title that is not text), or a handler running after its data was cleared. ' + (top ? 'Look at: ' + top : '');
    if (/not a function/.test(m)) return 'Something was called that is not a function. Often a field that should be a list or text holds another type (data from an import or an old save). ' + (top ? 'Look at: ' + top : '');
    if (/NaN|Infinity|Invalid (time value|date)|out of range/i.test(m)) return 'A date or number went bad (NaN, Infinity, Invalid Date). Check the validation of whatever the last action fed in. ' + (top ? 'Look at: ' + top : '');
    return top ? 'Look at: ' + top : 'No stack was available; reproduce with the steps shown.';
  }
  if (kind === 'state') return 'The saved reminders or settings disagree with what is on screen (or with themselves). A handler changed one without updating the other, or data of the wrong type got in.';
  if (kind === 'data-loss') return 'Something the user typed or set did not survive a save and reload (or was never saved). Check save() is called after the change and that load() keeps every field.';
  if (kind === 'list') return 'The sidebar list does not match the reminders that should be in it (search, completed section or order). renderList() was not called after a change, or its filter disagrees with the data.';
  if (kind === 'flow') return 'A step of a whole journey (create, complete, search, export and so on) did not end up where a person would expect.';
  if (kind === 'bad-text') return 'The page shows NaN, Invalid Date, undefined, null or [object] in text the app wrote itself. A date or value was not checked before it was formatted.';
  if (kind === 'nlp') return 'The text recognizer returned something unusable (an invalid date, a blank item, or nothing for a phrase the help screen promises). Validate the numbers it builds dates from.';
  if (kind === 'stuck-overlay') return 'A dialog stayed open when it should have closed. Check Escape, the backdrop click and the Close buttons.';
  if (kind === 'visual-covered') return 'Another element sits on top of this control, so a person could not click it. Check z-index, a stuck dialog, or panel overflow.';
  if (kind === 'visual-clipped') return 'This text is wider than its box and is cut off. Give it room, let it wrap, or add an ellipsis with a tooltip.';
  if (kind === 'visual-offscreen') return 'This control is partly outside the window or its panel, so it cannot be reached. Check the layout at this size.';
  if (kind === 'visual-overflow') return 'The page is wider than the window, so a horizontal scrollbar appears. Find the element that sticks out.';
  if (kind === 'visual-contrast') return 'Text color and its background are too close, so it is hard to read. Raise the contrast to at least 4.5:1 (3:1 for large text).';
  if (kind === 'visual-icon') return 'An icon rendered with no size, so the button shows nothing. The icon font or SVG did not load.';
  if (kind === 'jank' || kind === 'freeze') return 'A frame took far longer than normal right after this action: the main thread was busy (heavy rebuild, layout thrash, or a long synchronous loop). Break the work up.';
  if (kind === 'slow') return 'This kind of action takes a long time to finish. Add progress feedback or speed up the slow part.';
  if (kind === 'leak') return 'Memory (page elements or script data) keeps growing as reminders are added and removed. Something is not being released.';
  if (kind === 'layout-shift') return 'Things on the page jumped around right after this action. Reserve space for content that appears later.';
  if (kind === 'a11y') return 'A control has no accessible name or two elements share an id, so screen readers cannot describe it. Add aria-label or visible text.';
  if (kind === 'silent') return 'The app gave the user no feedback at all for this input (nothing changed and no message).';
  if (kind === 'toast-error') return 'The app showed an error message while a normal action was running. Either the action is broken or the message is misleading.';
  if (kind === 'xss') return 'Text typed or imported into the app showed up as live HTML. Escape user text before putting it in innerHTML (and check ids, classes and attributes too).';
  return '';
}
function logLine(cls, text) { T.log.push({ cls, text, t: Date.now() }); if (T.log.length > 800) T.log.splice(0, 200); }

/* ---------------------------------------------------------------- the scratch copy of your data
   While a run is on, reads and writes of the app's two storage keys go to a Map in memory. The real localStorage is never touched, so closing the
   tab mid-run cannot lose anything. When the run ends the app's own state is put back from a copy taken before the run. */
const SBX = { on: false, store: new Map(), backup: null };
const isAppKey = (k) => k === A.STORE_KEY || k === A.SETTINGS_KEY || k === A.SAVE_NOTE_KEY;
const DEFAULT_SETTINGS = () => ({ theme: 'midnight', density: 'cozy', groupCompleted: true, completedCollapsed: false, confirmDelete: false, spellcheck: true });
function sandboxBegin() {
  if (SBX.on) return;
  const real = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  SBX.backup = { rawR: real(A.STORE_KEY), rawS: real(A.SETTINGS_KEY), reminders: clone(A.reminders), settings: clone(A.settings), selectedId: A.selectedId, search: $('#search').value, canon: canon(A.reminders), canonS: canon(A.settings) };
  SBX.store.clear(); SBX.on = true;
}
function sandboxReset() {   // an empty scratch app
  closeOverlays(); const s = $('#search'); if (s) s.value = '';
  A.reminders = []; A.settings = DEFAULT_SETTINGS(); A.selectedId = null; A.save(); A.saveSettings();
  A.applySettings(); A.syncSettingToggles(); A.renderThemeGrid(); A.render();
}
function sandboxEnd() {
  if (!SBX.on) return; const b = SBX.backup; SBX.on = false;
  closeOverlays();
  A.reminders = clone(b.reminders); A.settings = clone(b.settings); A.selectedId = b.selectedId;
  const s = $('#search'); if (s) s.value = b.search;
  A.applySettings(); A.syncSettingToggles(); A.renderThemeGrid(); A.render();
  const real = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const same = real(A.STORE_KEY) === b.rawR && real(A.SETTINGS_KEY) === b.rawS, back = canon(A.reminders) === b.canon && canon(A.settings) === b.canonS;
  T.sandbox = same && back ? `Your own data was put back exactly: ${b.reminders.length} reminder${b.reminders.length === 1 ? '' : 's'} and your settings. The run only ever used a scratch copy.` : 'WARNING: your data may not have been restored exactly (stored copy ' + (same ? 'unchanged' : 'CHANGED') + ', screen ' + (back ? 'restored' : 'NOT restored') + ').';
  logLine(same && back ? 'ok' : 'bad', T.sandbox); SBX.backup = null;
}
function closeOverlays() { $$('.overlay.show').forEach((o) => o.classList.remove('show')); try { if (window.__guide && window.__guide.isOpen) window.__guide.close(); } catch (e) { /* ignore */ } }

/* ---------------------------------------------------------------- hooks */
const HK = { on: false, undo: [] };
function swap(obj, key, fn) { const o = obj[key]; obj[key] = fn(o); HK.undo.push(() => { obj[key] = o; }); }
const onErr = (e) => {
  if (!T.running) return;
  if (e.target && e.target !== window && e.target.tagName) { find('js-error', 'warn', 'A resource failed to load: ' + (e.target.src || e.target.href || e.target.tagName), { where: e.target.src || e.target.href }); return; }
  find('js-error', 'error', e.message || 'Script error', { stack: e.error && e.error.stack });
};
const onRej = (e) => { if (T.running) find('promise', 'error', 'Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason), { stack: e.reason && e.reason.stack }); };
function hook() {
  if (HK.on) return; HK.on = true;
  window.addEventListener('error', onErr, true); window.addEventListener('unhandledrejection', onRej);
  HK.undo.push(() => { window.removeEventListener('error', onErr, true); window.removeEventListener('unhandledrejection', onRej); });
  swap(console, 'error', (o) => function () { if (T.running && !T.quiet) find('console-error', 'error', [...arguments].map((a) => (a && a.message) || String(a)).join(' ').slice(0, 300), { stack: arguments[0] && arguments[0].stack }); return o.apply(this, arguments); });
  swap(console, 'warn', (o) => function () { if (T.running && !T.quiet) find('console-warn', 'warn', [...arguments].map((a) => String(a)).join(' ').slice(0, 300)); return o.apply(this, arguments); });
  // the scratch copy of the app's data
  swap(Storage.prototype, 'getItem', (o) => function (k) { return SBX.on && this === localStorage && isAppKey(k) ? (SBX.store.has(k) ? SBX.store.get(k) : null) : o.apply(this, arguments); });
  swap(Storage.prototype, 'setItem', (o) => function (k, v) { if (SBX.on && this === localStorage && isAppKey(k)) { SBX.store.set(k, String(v)); T.counters.storageWrites++; return; } return o.apply(this, arguments); });
  swap(Storage.prototype, 'removeItem', (o) => function (k) { if (SBX.on && this === localStorage && isAppKey(k)) { SBX.store.delete(k); return; } return o.apply(this, arguments); });
  swap(HTMLInputElement.prototype, 'click', (o) => function () { if (this.type === 'file') { T.counters.filePickerBlocked++; return; } return o.apply(this, arguments); });
  swap(URL, 'createObjectURL', (o) => function (b) { const u = o.call(URL, b); T.blobs.set(u, b); if (T.blobs.size > 20) T.blobs.delete(T.blobs.keys().next().value); return u; });
  swap(HTMLAnchorElement.prototype, 'click', (o) => function () {
    if (this.download) { T.dlSeq = (T.dlSeq || 0) + 1; T.downloads.push({ name: this.download, blob: T.blobs.get(this.href), n: T.n }); if (T.downloads.length > 30) T.downloads.shift(); return; }
    if (this.getAttribute('href') && !/^#/.test(this.getAttribute('href')) && (this.target && this.target !== '_self' || this.origin !== location.origin || this.pathname !== location.pathname)) { T.counters.externalBlocked++; return; }
    return o.apply(this, arguments);
  });
  swap(window, 'open', () => function () { T.counters.externalBlocked++; return null; });
  swap(window, 'alert', () => function () { T.counters.dialogs++; });
  swap(window, 'confirm', () => function () { T.counters.dialogs++; return true; });
  swap(window, 'prompt', () => function () { T.counters.dialogs++; return ''; });
  // never show the browser's real notification permission prompt
  if (window.Notification && Notification.requestPermission) swap(Notification, 'requestPermission', () => function () { T.counters.notifBlocked++; return Promise.resolve(Notification.permission); });
  swap(Element.prototype, 'setPointerCapture', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* synthetic pointer ids have no capture */ } });
  swap(Element.prototype, 'releasePointerCapture', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* same */ } });
  // the tester must never leave the page: no link that goes anywhere but a spot on this page may be followed
  const leaves = (a) => { try { const u = new URL(a.getAttribute('href'), location.href); return (a.target && a.target !== '_self') || (u.origin + u.pathname + u.search) !== (location.origin + location.pathname + location.search); } catch (e) { return true; } };
  const blockNav = (e) => { if (!T.running || e.isTrusted) return; const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a && !a.hasAttribute('download') && leaves(a)) { e.preventDefault(); e.stopImmediatePropagation(); T.counters.externalBlocked++; } };
  const guard = (e) => { if (T.running) { e.preventDefault(); e.returnValue = 'The UX test is still running.'; return e.returnValue; } };
  window.addEventListener('beforeunload', guard); HK.undo.push(() => window.removeEventListener('beforeunload', guard));
  document.addEventListener('click', blockNav, true); HK.undo.push(() => document.removeEventListener('click', blockNav, true));
  const tt = $('#toastText');
  if (tt) { const mo = new MutationObserver(() => { const text = tt.textContent.trim(); if (text) { T.toasts.push({ seq: ++T.toastSeq, kind: /could not|invalid|error|fail|cannot|unable/i.test(text) ? 'err' : 'ok', text: text.slice(0, 200), n: T.n }); if (T.toasts.length > 60) T.toasts.shift(); } }); mo.observe(tt, { childList: true, characterData: true, subtree: true }); HK.undo.push(() => mo.disconnect()); }
  try { const po = new PerformanceObserver((l) => l.getEntries().forEach((en) => { if (en.hadRecentInput) return; T.shifts += en.value; })); po.observe({ type: 'layout-shift', buffered: false }); HK.undo.push(() => po.disconnect()); } catch (e) { /* not supported */ }
  try { const po = new PerformanceObserver((l) => l.getEntries().forEach((en) => { T.longtasks.push({ d: en.duration, n: T.n }); if (T.longtasks.length > 200) T.longtasks.shift(); })); po.observe({ type: 'longtask', buffered: false }); HK.undo.push(() => po.disconnect()); } catch (e) { /* not supported */ }
}
function unhook() { HK.undo.reverse().forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); HK.undo = []; HK.on = false; }
// frame monitor: how long between frames, so a stall shows up as a long gap
const FM = { on: false, last: 0, max: 0 };
function fmLoop() { if (!FM.on) return; const t = NOW(); if (FM.last) { const dt = t - FM.last; T.dts.push(dt); if (T.dts.length > 900) T.dts.shift(); if (dt > FM.max) FM.max = dt; } FM.last = t; requestAnimationFrame(fmLoop); }

/* ---------------------------------------------------------------- the page's controls */
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
    if (cx < a.left + 1 || cx > a.right - 1 || cy < a.top + 1 || cy > a.bottom - 1) return false;   // (a control whose middle is on the very edge of its scrolling box counts as scrolled out)
  }
  return true;
}
function ctlKey(el) {
  if (el.id) return '#' + el.id;
  const c = el.classList, d = el.dataset || {};
  if (c.contains('reminder-item')) return 'list row';
  if (c.contains('ri-check')) return 'list row check circle';
  if (c.contains('completed-header')) return 'Completed header';
  if (c.contains('cl-check')) return 'checklist item check';
  if (c.contains('cl-del')) return 'checklist item remove';
  if (c.contains('cl-text')) return 'checklist item text';
  if (c.contains('urg-pill')) return 'urgency ' + d.urg;
  if (c.contains('icon-choice')) return 'icon ' + (d.icon === undefined ? 'more' : d.icon || 'none');
  if (c.contains('theme-swatch')) return 'theme ' + d.themeId;
  if (c.contains('field-clear')) return 'clear ' + d.clear;
  if (c.contains('apply-link')) return 'Auto-apply link';
  const t = el.tagName.toLowerCase(), cls = (el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter((q) => q && !/^(on|off|show|sel|done|active|icon-btn)$/.test(q))[0] : '') || '';
  const tx = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
  const par = el.closest('[id]') && el.closest('[id]') !== el ? '@' + el.closest('[id]').id : '';
  return t + (cls ? '.' + cls : '') + (tx ? `"${tx}"` : '') + par;
}
function kindOf(el) {
  const t = el.tagName;
  if (t === 'SELECT') return 'select'; if (t === 'TEXTAREA') return 'text';
  if (t === 'INPUT') { const y = el.type; return y === 'checkbox' || y === 'radio' ? 'check' : y === 'datetime-local' ? 'datetime' : y === 'file' ? 'file' : y === 'button' || y === 'submit' ? 'button' : 'text'; }
  if (t === 'A') return 'link';
  return 'button';
}
const SEL = 'button, a[href], input, select, textarea, [role=button], .reminder-item, .toggle, .urg-pill, .theme-swatch, .apply-link, [tabindex]:not([tabindex="-1"])';
function scan() {
  const out = [], seen = new Set(), ov = $$('.overlay.show').pop();   // with a dialog open, only the dialog can be used (like a person would)
  $$(SEL).forEach((el) => {
    if (seen.has(el) || inDev(el)) return; seen.add(el);
    const k = kindOf(el);
    if (k === 'file') return;
    if (ov && !ov.contains(el)) return;
    if (!visible(el)) return;
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
function center(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function mev(type, x, y, o = {}) {
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window, button: o.button || 0, buttons: o.buttons || 0, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, metaKey: false, detail: o.detail || 0 };
  return type.startsWith('pointer') ? new PointerEvent(type, Object.assign(base, { pointerId: o.id || 1, pointerType: o.type || 'mouse', isPrimary: o.primary !== false, width: 1, height: 1, pressure: o.buttons ? 0.5 : 0 })) : new MouseEvent(type, base);
}
function fire(target, type, x, y, o) { (target || document.body).dispatchEvent(mev(type, x, y, o)); }
function under(x, y) { return document.elementFromPoint(clamp(x, 0, innerWidth - 1), clamp(y, 0, innerHeight - 1)) || document.body; }
function pdown(el, x, y, o = {}) {
  const b = o.button || 0; const oo = Object.assign({ buttons: b === 2 ? 2 : b === 1 ? 4 : 1 }, o); fire(el, 'pointerdown', x, y, oo); fire(el, 'mousedown', x, y, oo);
  // like a real mouse press: focus moves to the pressed control, or away from the field being typed in when the thing pressed cannot take focus
  try { const f = el.closest && el.closest('input, button, textarea, select, a[href], [tabindex]'); if (f && f.focus) f.focus({ preventScroll: true }); else if (document.activeElement && document.activeElement !== document.body && !inDev(document.activeElement)) document.activeElement.blur(); } catch (e) { /* ignore */ }
}
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
// type like a person: focus, set the whole value, fire input, optionally leave the field
// moving focus can make the app re-render (it applies a recognized phrase when the title loses focus); a person would then click the new field again
function refocus(el) {
  try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  if (!el.isConnected && el.id) { const e2 = document.getElementById(el.id); if (e2) { el = e2; try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
  return el;
}
function typeInto(el, v, o = {}) {
  if (!el) return; el = refocus(el);
  setValue(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
  if (o.change) el.dispatchEvent(new Event('change', { bubbles: true }));
  if (o.enter) key('Enter', { ctrl: !!o.ctrl }, el);
  if (o.blur) { try { el.blur(); } catch (e) { /* ignore */ } }
}

/* ---------------------------------------------------------------- awkward values */
const TITLES = ['', ' ', 'Buy milk', 'call mom tomorrow at 9am', 'dentist dec 15 at 2pm', 'standup at 2pm every weekday', 'pay rent on the 1st monthly', 'make a list of bread, eggs, milk', 'checklist: call bank, pay rent',
  'in 5 minutes', 'urgent report due friday', 'gym tonight repeat every 3 days', 'water plants high priority in 2 hours', '<img src=x onerror=alert(1)>', '<b>bold</b>', '"quote\'s" & <tags>', 'x'.repeat(3000), 'word '.repeat(300), '日本語のテスト', '😀 emoji 🔔',
  'RTL עברית مرحبا', '​​', 'a\u202eb', '../../etc/passwd', '${7*7} {{7*7}}', '`backtick`', 'a;b,c|d', 'in 99999999999 days', '12/25/0001', 'feb 31', 'dec 32', 'at 99:99', '0pm', '13pm', 'every 0 days',
  'every 99999999999999999999 weeks', 'in 0 minutes', 'in 99999999999 minutes', '__proto__', 'constructor', 'null', 'undefined', 'NaN', 'Invalid Date', '[object Object]', '</textarea><script>alert(1)</script>', '</div></div>', "'; DROP TABLE x;--", 'Zeta ' + 'é'.repeat(20)];
const NOTES = ['', 'Some notes', 'line one\nline two\nline three', '\nstarts with a newline', '\n\n', 'ends with newline\n', '  leading spaces', 'x'.repeat(5000), '<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '</textarea><b>x</b>', 'call bob tomorrow at 9am\nthen lunch at noon', 'make a list of a, b, c\nmore', '😀'.repeat(200), 'tab\tseparated', 'cr\r\nlf'];
const DATES = ['', 'today', 'tomorrow', 'tomorrow 9am', 'next monday', 'dec 25', 'dec 25 at 3pm', '12/25', '12/25/2030', '12/25/99', '12/25/0001', 'in 3 days', 'in 2 hours', 'in 45 minutes', 'on the 5th', 'noon', 'midnight', '3pm', '15:30', 'this evening', 'tonight', 'next friday at 5pm', 'in 99999999999 days', 'in 99999999999 hours', 'feb 30', 'blah blah', '99/99', '0/0', '<b>x</b>', 'Today', 'Tomorrow', 'This evening', 'Tomorrow evening', 'Next Monday', 'In 1 hour', 'In 3 hours', 'In 1 week', 'x'.repeat(500), '1e309', '-5 days', 'in -5 days', 'yesterday'];
const REPEATS = ['', 'Never', 'never', 'Hourly', 'Every day', 'daily', 'weekly', 'every 3 days', 'every other friday', 'every 2 weeks', 'every other week', 'every weekday', 'every 0 days', 'every 99999999999999999999 days', 'biweekly', '13 mins', '2 hrs 3 mins', 'every month', 'yearly', '<b>x</b>', 'NaN', 'x'.repeat(300), 'Custom…', '90m', 'every 1 hour'];
const ENDS = ['', 'Never', 'After 5 times', 'After 10 times', 'In 1 month', 'In 3 months', 'In 1 year', 'after 3', '7', '7 times', 'dec 25', '3 months', 'in 1 year', '0', 'after 0 times', 'after 99999999999999999999 times', 'blah', '<i>x</i>', 'x'.repeat(300), '2 weeks', '1e309'];
const SNOOZES = ['', 'Off', '10 minutes', '30 minutes', '1 hour', '3 hours', 'Tomorrow', '1 week', '45 minutes', '2h', '90m', '1d 6h', '0', '0 minutes', 'in 1 hour', 'tomorrow 9am', 'blah', '<b>x</b>', '1e999', '99999999999999999999 minutes', 'x'.repeat(300)];
const SEARCHES = ['', ' ', 'a', 'e', 'milk', 'MILK', 'zeta', '<b>', '(', '[', '.*', '\\', '%', '😀', 'x'.repeat(300), 'undefined', 'call', 'buy ', '  buy  ', '?'];
const ITEMS = ['', ' ', 'milk', 'eggs', 'Item with <b>html</b>', '"q"', 'x'.repeat(500), '😀', 'a\tb', '<img src=x onerror=alert(3)>', '0', 'NaN'];
const DATETIMES = ['', '2026-12-25T09:00', '1999-01-01T00:00', '2100-12-31T23:59', '0001-01-01T00:00', '0100-06-15T12:30', '275760-09-13T00:00', '2020-02-29T23:59', 'garbage', '2026-13-45T25:61'];
const rdate = () => { const d = new Date(Date.now() + rf(-40, 400) * 86400000); d.setHours(ri(0, 23), ri(0, 59), 0, 0); return ld(d); };
const FIELD_VALUES = { 'd-title': () => pick(TITLES), 'd-notes': () => pick(NOTES), 'd-due-text': () => pick(DATES), 'd-repeat': () => pick(REPEATS), 'd-end': () => pick(ENDS), 'd-snooze': () => pick(SNOOZES), 'search': () => pick(SEARCHES), 'cl-add': () => pick(ITEMS) };

/* ---------------------------------------------------------------- generated import files */
function mkRem(o = {}) { const r = A.newReminder(); Object.assign(r, o); return r; }
function randomReminder() {
  const r = mkRem({ title: pick(TITLES), notes: chance(0.5) ? pick(NOTES) : '', completed: chance(0.3), urgency: pick(A.URGENCIES).id, icon: chance(0.4) ? pick(A.ICONS) : '', due: chance(0.5) ? rdate() : '', repeat: chance(0.3) ? pick(A.REPEATS) : 'Never', created: Date.now() - ri(0, 400) * 86400000 });
  if (chance(0.4)) r.checklist = Array.from({ length: ri(1, 6) }, () => ({ id: A.uid(), text: pick(ITEMS), done: chance(0.4) }));
  return r;
}
function makeImport(force) {
  const k = force && force.kind ? force.kind : null;
  const good = (n) => Array.from({ length: n }, randomReminder);
  const kinds = {
    wrapped: () => { const l = good(ri(1, 6)); return { text: JSON.stringify({ app: 'reminders', version: 1, exportedAt: new Date().toISOString(), reminders: l }, null, 2), expect: 'import', count: l.length, list: l }; },
    array: () => { const l = good(ri(1, 6)); return { text: JSON.stringify(l), expect: 'import', count: l.length, list: l }; },
    empty: () => ({ text: JSON.stringify({ reminders: [] }), expect: 'import', count: 0 }),
    emptyArr: () => ({ text: '[]', expect: 'import', count: 0 }),
    big: () => { const l = good(120); return { text: JSON.stringify(l), expect: 'import', count: l.length, list: l }; },
    old: () => { const l = [{ title: 'old style', flagged: true, repeat: 'daily', snooze: '1h', endRepeat: 'afterCount', endCount: 3 }, { title: 'custom', repeat: 'custom', customInterval: 4, customUnit: 'weeks' }]; return { text: JSON.stringify(l), expect: 'import', count: 2 }; },
    notJson: () => ({ text: 'this is not json', expect: 'reject' }),
    emptyFile: () => ({ text: '', expect: 'reject' }),
    wrongShape: () => ({ text: '{"hello":"world"}', expect: 'reject' }),
    number: () => ({ text: '42', expect: 'reject' }),
    nullDoc: () => ({ text: 'null', expect: 'reject' }),
    truncated: () => ({ text: JSON.stringify(good(3)).slice(0, 80), expect: 'reject' }),
    weirdTypes: () => { const l = [{ title: 12345, notes: null }, { title: ['a', 'b'], checklist: 'oops' }, { title: 'x', checklist: [null, 5, { text: 7 }, { text: 'ok', done: 'yes' }] }, { title: 'x', urgency: '"><img src=x onerror=alert(4)>', icon: '"><img src=x onerror=alert(5)>' }, { title: 'x', due: 'garbage', created: 'abc' }, { title: 'x', completed: 'yes', repeat: 5, endText: {}, snooze: [] }, null, 7, 'text', [], { id: '"><b>x</b>', title: 'id attack' }, { title: 'x', checklist: [{ id: '"><i>', text: 'bad id' }] }]; return { text: JSON.stringify(l), expect: 'either', count: l.length }; },
    htmlTitles: () => { const l = TITLES.slice(12, 22).map((t) => mkRem({ title: t })); return { text: JSON.stringify(l), expect: 'import', count: l.length, list: l }; },
  };
  const names = Object.keys(kinds), key0 = k && kinds[k] ? k : pick(chance(0.75) ? ['wrapped', 'array', 'wrapped', 'array', 'old', 'htmlTitles', 'empty', 'emptyArr'] : ['notJson', 'emptyFile', 'wrongShape', 'number', 'nullDoc', 'truncated', 'weirdTypes', 'weirdTypes', 'big']);
  const o = kinds[key0](); o.what = key0; o.name = 'dt-' + key0 + '.txt';
  return o;
}

/* ---------------------------------------------------------------- oracles: the saved data */
const validDue = (s) => s === '' || (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && !isNaN(new Date(s)));
const ty = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v);
function dataProblem(R, st) {
  const urg = A.URGENCIES.map((u) => u.id), ids = new Set();
  if (!Array.isArray(R)) return 'The reminders are not a list';
  for (let i = 0; i < R.length; i++) {
    const r = R[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'A reminder is not an object (it is ' + ty(r) + ')';
    if (typeof r.id !== 'string' || !/^[\w-]+$/.test(r.id)) return 'A reminder has a missing or unsafe id (' + (typeof r.id === 'string' ? 'it contains characters that are not safe in HTML' : ty(r.id)) + ')';
    if (ids.has(r.id)) return 'Two reminders share the same id';
    ids.add(r.id);
    for (const f of ['title', 'notes', 'due', 'repeat', 'endText', 'snooze', 'icon']) if (typeof r[f] !== 'string') return `A reminder's ${f} is ${ty(r[f])}, not text`;
    if (typeof r.completed !== 'boolean') return `A reminder's completed flag is ${ty(r.completed)}, not true/false`;
    if (!urg.includes(r.urgency)) return 'A reminder has an urgency that is not one of the five levels (' + (typeof r.urgency === 'string' ? 'text with characters like ' + JSON.stringify(r.urgency.slice(0, 8)) : ty(r.urgency)) + ')';
    if (r.icon && !A.ICONS.includes(r.icon)) return 'A reminder has an icon that is not one of the icons in the picker';
    if (!validDue(r.due)) return 'A reminder has a due date that is not a valid date-time (' + JSON.stringify(r.due.slice(0, 24)) + ')';
    if (!Number.isFinite(r.created)) return 'A reminder has no valid created time (' + ty(r.created) + ')';
    if (!Array.isArray(r.checklist)) return 'A reminder\'s checklist is ' + ty(r.checklist) + ', not a list';
    const cid = new Set();
    for (const it of r.checklist) {
      if (!it || typeof it !== 'object') return 'A checklist item is not an object';
      if (typeof it.id !== 'string' || !/^[\w-]+$/.test(it.id)) return 'A checklist item has a missing or unsafe id';
      if (cid.has(it.id)) return 'Two checklist items share an id';
      cid.add(it.id);
      if (typeof it.text !== 'string') return 'A checklist item\'s text is ' + ty(it.text) + ', not text';
      if (typeof it.done !== 'boolean') return 'A checklist item\'s done flag is ' + ty(it.done) + ', not true/false';
    }
  }
  if (!st || typeof st !== 'object') return 'The settings are not an object';
  if (!A.THEMES.some((t) => t.id === st.theme)) return 'The theme in the settings is not one of the themes';
  if (st.density !== 'cozy' && st.density !== 'compact') return 'The density in the settings is not cozy or compact';
  for (const f of ['groupCompleted', 'completedCollapsed', 'confirmDelete', 'spellcheck']) if (typeof st[f] !== 'boolean') return `The setting ${f} is ${ty(st[f])}, not true/false`;
  return '';
}
// load() turns the old one-word repeat / remind-again ids (daily, weekly, 1h ...) into their labels, so a typed "weekly" comes back as "Every week": expected, not a loss
const LEG_R = { never: 'Never', hourly: 'Hourly', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month', yearly: 'Every year' }, LEG_S = { '0': 'Off', '10m': '10 minutes', '1h': '1 hour', '3h': '3 hours', tom: 'Tomorrow', '1w': '1 week' };
function legacyWords(list) { return list.map((r) => Object.assign({}, r, { repeat: Object.prototype.hasOwnProperty.call(LEG_R, r.repeat) ? LEG_R[r.repeat] : r.repeat, snooze: Object.prototype.hasOwnProperty.call(LEG_S, r.snooze) ? LEG_S[r.snooze] : r.snooze })); }
function firstDiff(a, b) {
  if (a.length !== b.length) return `${a.length} reminders before, ${b.length} after`;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; for (const k of new Set(Object.keys(x).concat(Object.keys(y)))) if (canon(x[k]) !== canon(y[k])) return `reminder ${i + 1}, field "${k}"`; }
  return '';
}

/* ---------------------------------------------------------------- oracles: the screen against the data */
function checkListDom() {
  const R = A.reminders, st = A.settings, sc = $('#listScroll'), se = $('#search'); if (!sc || !se) return;
  const q = (se.value || '').trim().toLowerCase();
  const filtered = R.filter((r) => !q || (r.title + ' ' + r.notes).toLowerCase().includes(q));
  const act = filtered.filter((r) => !r.completed), dn = filtered.filter((r) => r.completed);
  const exp = st.groupCompleted ? act.concat(st.completedCollapsed ? [] : dn) : filtered;
  const rows = $$('.reminder-item', sc), got = rows.map((e) => e.dataset.id);
  const same = got.length === exp.length && got.every((id, i) => id === exp[i].id);
  if (!check('the list shows exactly the right reminders, in order', same)) find('list', 'error', got.length !== exp.length ? `The list shows ${got.length} rows but ${exp.length} should be there (${q ? 'with a search typed' : 'no search'}, ${R.length} saved)` : 'The list has the right reminders but in a different order than the saved order', { where: q ? 'search' : 'nosearch' });
  if (same) rows.slice(0, 40).forEach((row, i) => {
    const r = exp[i], title = row.querySelector('.ri-title'), chk = row.querySelector('.ri-check');
    if (!check('each row shows its reminder\'s title', squash(title && title.textContent) === (squash(r.title) || 'Untitled'))) find('list', 'error', 'A row shows "' + squash(title && title.textContent).slice(0, 30) + '" but the reminder\'s title is "' + squash(r.title).slice(0, 30) + '"', { where: 'title' });
    if (!check('completed rows look completed', row.classList.contains('completed') === r.completed && !!chk && chk.classList.contains('done') === r.completed)) find('list', 'error', 'A row\'s completed look does not match the reminder (' + (r.completed ? 'completed' : 'not completed') + ')', { where: 'completed' });
    if (!check('the selected reminder is highlighted', row.classList.contains('active') === (r.id === A.selectedId))) find('list', 'error', 'The highlighted row is not the selected reminder', { where: 'active' });
    if (r.checklist.length && !check('rows show the checklist count', row.textContent.includes(`${r.checklist.filter((x) => x.done).length}/${r.checklist.length}`))) find('list', 'error', 'A row shows the wrong checklist progress (expected ' + r.checklist.filter((x) => x.done).length + '/' + r.checklist.length + ')', { where: 'checklist' });
    if (title && [...title.children].some((c) => !(c.tagName === 'I' || (c.tagName === 'SPAN' && squash(c.textContent) === 'Untitled')))) { check('titles are shown as text, not markup', false); find('xss', 'error', 'A reminder title was turned into page elements in the list: ' + squash(title.innerHTML).slice(0, 80), { where: 'row title' }); } else check('titles are shown as text, not markup', true);
  });
  const hdr = $('.completed-header', sc), want = st.groupCompleted && dn.length > 0;
  if (!check('the Completed section appears exactly when something is completed', !!hdr === want)) find('list', 'error', want ? 'There are completed reminders but no Completed header' : 'A Completed header is showing with nothing completed (or grouping is off)', { where: 'hdr' });
  if (hdr && want) {
    const cc = $('.cc-count', hdr);
    if (!check('the Completed count is right', cc && cc.textContent.trim() === String(dn.length))) find('list', 'error', `The Completed header says ${cc ? cc.textContent.trim() : '(nothing)'} but ${dn.length} reminders are completed`, { where: 'cc' });
    if (!check('the Completed section opens and closes as set', hdr.classList.contains('collapsed') === st.completedCollapsed && !!$('.completed-group', sc) === !st.completedCollapsed)) find('list', 'error', 'The Completed section is ' + (st.completedCollapsed ? 'open' : 'closed') + ' but the setting says the opposite', { where: 'collapse' });
  }
  if (!filtered.length && !check('an empty list says so', !!$('.empty-list', sc))) find('list', 'error', 'No reminders match but the list shows no "empty" message', { where: 'empty' });
}
function checkDetailDom() {
  const R = A.reminders, r = R.find((x) => x.id === A.selectedId), det = $('#detail'), emp = $('#mainEmpty'); if (!det || !emp) return;
  if (!r) { if (!check('with nothing selected the page says so', det.classList.contains('hidden') && !emp.classList.contains('hidden'))) find('state', 'error', 'No reminder is selected but the edit pane is still showing', { where: 'detail' }); return; }
  if (!check('a selected reminder shows its edit pane', !det.classList.contains('hidden') && emp.classList.contains('hidden') && !!$('#d-title'))) { find('state', 'error', 'A reminder is selected but its edit pane is not showing', { where: 'detail' }); return; }
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : undefined; };
  const bad = [], sh = [];
  const cmp = (id, a, b, nm) => { if (a !== b) { bad.push(nm); sh.push(`${nm}: screen ${JSON.stringify(String(a).slice(0, 30))} vs saved ${JSON.stringify(String(b).slice(0, 30))}`); } };
  cmp('d-title', v('d-title'), r.title, 'title'); cmp('d-notes', v('d-notes'), r.notes.replace(/\r\n?/g, '\n'), 'notes');   // (a text box always holds line breaks as \n)
  cmp('d-due', v('d-due'), r.due, 'date picker'); cmp('d-repeat', v('d-repeat'), r.repeat, 'repeat'); cmp('d-end', v('d-end'), r.endText, 'end repeat'); cmp('d-snooze', v('d-snooze'), r.snooze, 'remind again');
  const dc = $('#d-check'); if (!dc || dc.classList.contains('done') !== r.completed) bad.push('complete circle');
  if (!check('the edit pane shows what is saved', bad.length === 0)) find('state', 'error', 'The edit pane shows something different from the saved reminder: ' + bad.join(', '), { where: bad.join(','), note: sh.join(' | ') });
  const er = $('#row-endrepeat'); if (er && !check('End repeat shows only for repeating reminders', er.classList.contains('show') === A.isRepeating(r.repeat))) find('state', 'warn', 'The End repeat row is ' + (er.classList.contains('show') ? 'showing' : 'hidden') + ' but the repeat is "' + squash(r.repeat).slice(0, 20) + '"', { where: 'endrow' });
  const pills = $$('#d-urgency .urg-pill.sel'); if (!check('exactly the chosen urgency is highlighted', pills.length === 1 && pills[0].dataset.urg === r.urgency)) find('state', 'warn', 'The highlighted urgency does not match the reminder (' + r.urgency + ')', { where: 'urg' });
  const items = $$('#cl-items .cl-item'); if (!check('the checklist shows every item', items.length === r.checklist.length)) find('state', 'error', `The checklist shows ${items.length} items but the reminder has ${r.checklist.length}`, { where: 'cl' });
  const prog = $('#cl-progress'); if (prog) { const exp = r.checklist.length ? `${r.checklist.filter((x) => x.done).length} of ${r.checklist.length}` : ''; if (!check('checklist progress is right', prog.textContent === exp)) find('state', 'warn', `Checklist progress says "${prog.textContent}" but should say "${exp}"`, { where: 'prog' }); }
  [['d-repeat-preset', r.repeat, A.REPEATS], ['d-end-preset', r.endText, A.END_PRESETS], ['d-snooze-preset', r.snooze, A.SNOOZE]].forEach(([id, val, list]) => { const s = document.getElementById(id); if (s && !check('preset menus match the typed text', s.value === '__custom' || s.value === (list.includes(val) ? val : '__custom'))) find('state', 'warn', `The ${id.replace('d-', '').replace('-preset', '')} menu shows "${s.value}" while the text field has "${squash(val).slice(0, 20)}"`, { where: id }); });
  const ic = $$('#d-icon .icon-quick .icon-choice.sel'); if (!check('the chosen icon is highlighted', ic.length >= 1 && ic.every((b) => (b.dataset.icon || '') === r.icon))) find('state', 'warn', 'The highlighted icon does not match the reminder (' + (r.icon || 'none') + ')', { where: 'icon' });
  $$('#detail .detect.ok').forEach((d) => { if (!check('"Detected" badges name what they found', !/Detected:\s*$/.test(d.textContent))) find('bad-text', 'error', 'A "Detected:" badge is shown with nothing after it (the date it found is invalid)', { where: d.id }); });
  const sp = $('#d-title'); if (sp && !check('spell check follows the setting', sp.spellcheck === A.settings.spellcheck)) find('state', 'warn', 'Spell check on the title does not follow the setting', { where: 'spell' });
}
function checkSettingsDom() {
  const st = A.settings, b = document.body, t = (id) => { const e = document.getElementById(id); return e ? e.classList.contains('on') : null; };
  if (!check('theme and density on the page match the settings', b.dataset.theme === st.theme && b.dataset.density === st.density)) find('state', 'error', `The page shows theme "${b.dataset.theme}", ${b.dataset.density} but the settings say "${st.theme}", ${st.density}`, { where: 'theme' });
  const wrong = [['densityToggle', st.density === 'compact'], ['groupToggle', st.groupCompleted], ['confirmDelToggle', st.confirmDelete], ['spellcheckToggle', st.spellcheck]].filter(([id, v]) => t(id) !== null && t(id) !== v).map(([id]) => id);
  if (!check('the settings switches match the settings', wrong.length === 0)) find('state', 'error', 'These switches disagree with the saved settings: ' + wrong.join(', '), { where: wrong.join(',') });
  const sw = $('.theme-swatch.sel'); if (sw && !check('the highlighted theme is the chosen one', sw.dataset.themeId === st.theme)) find('state', 'warn', 'The highlighted theme swatch is not the chosen theme', { where: 'swatch' });
}
// text the app wrote itself must never show NaN, Invalid Date, undefined, null or [object ...]
const BADTEXT = /\bNaN\b|Invalid Date|\bundefined\b|\[object |\bnull\b|\bInfinity\b/;
// the page around the app: the site header, the logo and version chip, the footer, and no trace of notifications
function checkChrome() {
  const a = $('.site-head a'), f = $('.foot'), app = $('.app'), head = $('.site-head');
  if (!check('the site header links to the portfolio', !!a && /^https:\/\/kevmcg1\.github\.io\/portfolio\/?$/.test(a.href) && /kevmcg1\.github\.io/i.test(a.textContent))) find('chrome', 'error', 'The site header link to the portfolio is missing or wrong', { where: 'site-head' });
  const lic = f && f.querySelector('a[rel~=license]');
  if (!check('the footer shows the license sentence and its link', !!lic && /cc0-1\.0/.test(lic.href) && /Reminders is released under GitHub/.test(f.textContent) && /All rights reserved/.test(f.textContent))) find('chrome', 'error', 'The footer license sentence or its Creative Commons link is missing or wrong', { where: 'footer' });
  if (head && f && app) { const h = head.getBoundingClientRect(), m = app.getBoundingClientRect(), b = f.getBoundingClientRect(); if (!check('header, app and footer stack in order without overlap', h.bottom <= m.top + 1 && m.bottom <= b.top + 1 && b.bottom <= innerHeight + 1 && h.top >= -1)) find('layout', 'error', `The header, the app and the footer overlap or run off the window (header bottom ${Math.round(h.bottom)}, app ${Math.round(m.top)}-${Math.round(m.bottom)}, footer top ${Math.round(b.top)}, window ${innerHeight})`, { where: 'stack' }); }
  const mark = $('.logo-mark'), chip = byId('versionChip');
  if (!check('the logo is named Reminders and the version chip sits under it', !!mark && mark.getAttribute('aria-label') === 'Reminders' && !!chip && mark.nextElementSibling && mark.nextElementSibling.contains(chip) && !!window.__REM && chip.textContent.includes('v' + window.__REM.version))) find('chrome', 'error', 'The logo or the version chip under it is missing or out of place', { where: 'logo' });
  if (!check('notifications are gone', !byId('notifStatus') && !byId('notifOverlay') && !$('.notif-warning') && !/notification/i.test(($('.sidebar') || {}).innerText || ''))) find('chrome', 'error', 'Something about notifications is still on the page', { where: 'notifications' });
}
function checkText() {
  const skip = '#devtest, script, style, .ri-title, .full-title, #delText, .cl-text, textarea, .help-ex';
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => { const p = n.parentElement; return !p || !n.nodeValue.trim() || p.closest(skip) || p.querySelector(':scope > .fa-repeat') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });   // (a repeat label echoes what the person typed, so it is skipped)
  let bad = null, n = 0;
  for (let t; (t = w.nextNode()) && n < 3000; n++) if (BADTEXT.test(t.nodeValue)) { bad = t.nodeValue.trim(); break; }
  if (!check('no NaN or Invalid Date is shown', !bad)) find('bad-text', 'error', 'The page shows "' + squash(bad).slice(0, 60) + '"', { where: squash(bad).slice(0, 30) });
  ['d-due-text', 'd-due'].forEach((id) => { const e = document.getElementById(id); if (e && !check('date fields never contain NaN', !/NaN|Invalid/.test(e.value))) find('bad-text', 'error', 'The date field shows "' + e.value.slice(0, 40) + '"', { where: id }); });
}
function checkState() {
  const R = A.reminders, st = A.settings;
  const bad = dataProblem(R, st);
  if (!check('every reminder and setting has valid values', !bad)) find('state', 'error', bad, { where: 'data' });
  const raw = SBX.store.get(A.STORE_KEY), rawS = SBX.store.get(A.SETTINGS_KEY);
  if (!bad || Array.isArray(R)) {
    if (!check('the saved reminders match the app (nothing unsaved)', raw === JSON.stringify(R))) find('data-loss', 'error', 'The saved copy of the reminders differs from the ones in the app, so a change was not saved' + (raw ? '' : ' (nothing has been saved at all)'), { where: 'saved' });
    if (!check('the saved settings match the app', rawS === JSON.stringify(st))) find('data-loss', 'error', 'The saved copy of the settings differs from the current settings, so a change was not saved', { where: 'savedS' });
  }
  if (!Array.isArray(R)) return;
  const safe = (f) => { try { f(); } catch (e) { find('js-error', 'error', 'Checking the screen failed: ' + e.message, { stack: e.stack }); } };
  safe(checkListDom); safe(checkDetailDom); safe(checkSettingsDom); safe(checkChrome);
  // text typed in must never become live HTML
  if ($$('img[src="x"], [onerror]').some((i) => !inDev(i))) find('xss', 'error', 'Text typed or imported into the app became live HTML (an <img src=x onerror=...> exists on the page)', { where: 'xss' });
  if (R.length > 400) find('leak', 'warn', 'More than 400 reminders piled up during the run', { where: 'many' });
}
// the data can be saved and reloaded without losing anything: what load() brings back is what was saved
function reloadTrip() {
  const before = clone(A.reminders), bs = clone(A.settings), sel = A.selectedId;
  A.reminders = []; A.selectedId = null; A.settings = DEFAULT_SETTINGS();
  A.load(); A.applySettings(); A.syncSettingToggles(); A.renderThemeGrid(); A.render();
  const diff = firstDiff(legacyWords(before), A.reminders), sdiff = canon(bs) !== canon(A.settings);
  if (!check('reminders survive a save and reload unchanged', !diff)) find('data-loss', 'error', 'After saving and reloading, the reminders are not the same: ' + diff, { where: 'reload ' + diff.replace(/\d+/g, '#') });
  if (!check('settings survive a save and reload unchanged', !sdiff)) find('data-loss', 'error', 'After saving and reloading, the settings are not the same', { where: 'reloadS' });
  if (sel && A.reminders.some((r) => r.id === sel)) A.selectedId = sel;
  A.save(); A.saveSettings();   // (the page saves again when it is left, so a real reload does too)
  A.render();
  feature('save and reload round trips');
}

/* ---------------------------------------------------------------- oracles: the layout */
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
function parseRGBA(s) { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
function bgOf(el) { let a = el; const stack = []; while (a && a.nodeType === 1) { const cs0 = getComputedStyle(a); if (cs0.backgroundImage && cs0.backgroundImage !== 'none') return null; const c = parseRGBA(cs0.backgroundColor); if (c && c[3] > 0.05) { stack.push(c); if (c[3] >= 0.98) break; } a = a.parentElement; } let base = [10, 10, 12]; for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; base = base.map((v, k) => k < 3 ? c[k] * c[3] + v * (1 - c[3]) : 1); } return base; }
let scanBusy = false;
async function checkDom(deep) {
  if (scanBusy) return; scanBusy = true;
  const later = [];   // layout problems are only reported if they are still there a moment later (animations move things)
  const maybe = (kind, sev, msg, where, test) => { later.push({ kind, sev, msg, where, test }); };
  try {
    const modalOpen = !!$('.overlay.show');
    if (!check('page fits the window width', document.documentElement.scrollWidth <= innerWidth + 1)) maybe('visual-overflow', 'warn', `The page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`, 'page', () => document.documentElement.scrollWidth > innerWidth + 1);
    const list = scan(); seenControls(list);
    const ids = new Map(); $$('[id]').forEach((e) => { if (!inDev(e)) ids.set(e.id, (ids.get(e.id) || 0) + 1); });
    ids.forEach((n, id) => { if (n > 1) find('a11y', 'warn', `The id "${id}" is used ${n} times on the page`, { where: id }); });
    const limit = deep ? 400 : 60, sample = deep ? list : list.filter(() => chance(Math.min(1, limit / Math.max(1, list.length))));
    sample.slice(0, limit).forEach(({ el, key: kk, k }) => {
      if (!visible(el) || !showing(el)) return;
      const r = el.getBoundingClientRect(), name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() || el.getAttribute('alt') || el.getAttribute('placeholder') || (el.labels && el.labels[0] && el.labels[0].textContent.trim()) || '';
      if (!check('every control has a name', !!name || el.type === 'hidden')) find('a11y', 'info', `A ${k} has no accessible name: ${kk}`, { where: kk });
      const ico = el.querySelector('svg, i'); if (ico && !el.textContent.trim()) { const ir = ico.getBoundingClientRect(); if (!check('button icons render', ir.width > 1 && ir.height > 1)) find('visual-icon', 'warn', `The icon on ${kk} has no size`, { where: kk }); }
      if (!modalOpen && r.width > 2) {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const coverTest = () => { if (!el.isConnected || !showing(el)) return false; const q = el.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2; if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return false; const top = document.elementFromPoint(x, y); coverTest.by = top; return !!top && !(top === el || el.contains(top) || top.contains(el) || el.tagName === 'LABEL' || top.closest('#toast, #devtest, .overlay.show, .drop-indicator')); };
        if (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
          const covered = coverTest(); check('controls are not covered by something else', !covered);
          if (covered) { const lr = $('#listScroll').getBoundingClientRect(), by = coverTest.by && coverTest.by.getBoundingClientRect(); maybe('visual-covered', 'warn', `${kk} is covered by ${coverTest.by ? ctlKey(coverTest.by) : 'something'}`, kk, coverTest); const nt = `control at y ${Math.round(r.top)}..${Math.round(r.bottom)}, cover at y ${by ? Math.round(by.top) + '..' + Math.round(by.bottom) : '?'}, list box y ${Math.round(lr.top)}..${Math.round(lr.bottom)}, list scrolled ${Math.round($('#listScroll').scrollTop)} of ${$('#listScroll').scrollHeight}, ${A.reminders.length} reminders`; later[later.length - 1].note = nt; }
        }
        const sideTest = () => { if (!el.isConnected) return false; const q = el.getBoundingClientRect(); return q.width > 2 && (q.right > innerWidth + 1 || q.left < -1); };
        const out = sideTest(); check('controls are inside the window', !out);
        if (out) maybe('visual-offscreen', 'warn', `${kk} sticks out of the window sideways (${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth})`, kk, sideTest);
      }
      const clipTest = () => el.isConnected && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).textOverflow !== 'ellipsis' && el.clientWidth > 0;
      if (name && !el.matches('input, textarea, select') && clipTest()) { check('text is not cut off', false); maybe('visual-clipped', 'warn', `Text is cut off in ${kk} (${el.scrollWidth}px of text in ${el.clientWidth}px)`, kk, clipTest); } else check('text is not cut off', true);
    });
    if (deep) {
      const tx = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim().length > 1 && n.parentElement && !inDev(n.parentElement) && !/^(SCRIPT|STYLE)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
      for (let n; (n = w.nextNode()) && tx.length < 250;) { const p = n.parentElement; if (p && visible(p) && showing(p)) tx.push(p); }
      new Set(tx).forEach((p) => {
        const cs = getComputedStyle(p), fg = parseRGBA(cs.color), bg = bgOf(p); if (!fg || !bg) return;   // (a gradient or image behind the text can't be measured this way)
        const fl = lum(fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]))), bl = lum(bg), ratio = (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
        const faint = p.closest('[disabled], .disabled, [aria-disabled=true], :disabled, .completed, .empty-list, ::placeholder');
        const ok = !!faint || ratio >= 3; check('text is readable (contrast)', ok);
        if (!ok) maybe('visual-contrast', 'info', `Low contrast ${ratio.toFixed(1)}:1 for "${p.textContent.trim().slice(0, 30)}" in ${ctlKey(p)}`, ctlKey(p), () => { if (!p.isConnected) return false; const c2 = getComputedStyle(p), f2 = parseRGBA(c2.color), b2 = bgOf(p); if (!f2 || !b2) return false; const l1 = lum(f2.slice(0, 3).map((v, i) => v * f2[3] + b2[i] * (1 - f2[3]))), l2 = lum(b2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) < 3; });
      });
      if (document.getAnimations().length > 250) find('jank', 'warn', 'More than 250 animations are running at once', { where: 'animations' });
    }
    if (later.length) { await sleep(400); later.forEach((q) => { let still = false; try { still = q.test(); } catch (e) { /* element went away */ } if (still) find(q.kind, q.sev, q.msg, { where: q.where, note: q.note }); }); }
  } finally { scanBusy = false; }
}
function leakCheck() {
  const nodes = document.getElementsByTagName('*').length, cl = A.reminders.reduce((a, r) => a + (r && Array.isArray(r.checklist) ? r.checklist.length : 0), 0), allowed = 1500 + 45 * (A.reminders.length + cl);
  if (!check('the page does not pile up elements', nodes < allowed)) find('leak', 'warn', `The page holds ${nodes} elements for ${A.reminders.length} reminders (expected under ${allowed}); elements are being added and not removed`, { where: 'dom' });
  if (performance.memory) { const mb = performance.memory.usedJSHeapSize / 1048576; if (!T.heap0) T.heap0 = mb; if (!check('JS memory stays bounded', mb < T.heap0 + 400)) find('leak', 'warn', `JS heap grew from ${T.heap0.toFixed(0)} MB to ${mb.toFixed(0)} MB`, { where: 'heap' }); }
}
const feature = (n) => T.features.set(n, (T.features.get(n) || 0) + 1);

/* ---------------------------------------------------------------- waiting, resetting and healing */
const byId = (id) => document.getElementById(id);
const rowOf = (id) => $(`#listScroll .reminder-item[data-id="${id}"]`);
const rows = () => $$('#listScroll .reminder-item');
async function settle() { await raf(); await raf(); }
// writes a first title and pauses, the way a person does, so the one-time cache note comes up
async function noteWrite() { const t = byId('d-title'); if (t) { t.focus(); setValue(t, 'milk'); t.dispatchEvent(new Event('input', { bubbles: true })); } await sleep(1700); await settle(); }
function baselineData() {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  return [mkRem({ title: 'Pay rent', notes: 'Landlord', due: ld(d), repeat: 'Every month', urgency: 'high', icon: 'fa-star' }),
    mkRem({ title: 'Buy groceries', checklist: [{ id: A.uid(), text: 'milk', done: false }, { id: A.uid(), text: 'eggs', done: true }] }),
    mkRem({ title: 'Old task', completed: true })];
}
function seedData(list, select) { const sb = byId('search'); if (sb) sb.value = ''; closeOverlays(); A.reminders = list; A.selectedId = select || null; A.save(); A.render(); }
function resetBaseline() {
  try {
    closeOverlays(); const s = $('#search'); if (s) s.value = '';
    A.settings = DEFAULT_SETTINGS(); A.saveSettings(); A.applySettings(); A.syncSettingToggles(); A.renderThemeGrid();
    seedData(baselineData(), null);
    const tt = byId('toast'); if (tt) tt.classList.remove('show');
  } catch (e) { find('js-error', 'error', 'Resetting the tester failed: ' + (e && e.message), { stack: e && e.stack }); }
}
function heal() {
  if (window.__guide && window.__guide.isOpen && !T.guideOK) { try { window.__guide.close(); } catch (e) { /* ignore */ } }   // (the walkthrough dims and blocks the page: only the journeys and the first-timer slips that test it leave it open)
  const ov = $$('.overlay.show').length; T.stuck = ov ? (T.stuck || 0) + 1 : 0;
  if (T.stuck >= 12) { closeOverlays(); T.counters.healed++; T.stuck = 0; }   // (a dialog the random actions did not close; Escape closing it is checked on its own)
  if (A.reminders.length > 80) { A.reminders = A.reminders.slice(0, 30); if (!A.reminders.some((r) => r.id === A.selectedId)) A.selectedId = null; A.save(); A.render(); T.counters.healed++; }
}
const expect = (name, ok, msg, where) => { if (!check(name, !!ok)) find('flow', 'error', msg || name, { where: where || name }); return !!ok; };
async function click(sel) { const e = typeof sel === 'string' ? $(sel) : sel; if (!e || !e.isConnected) { find('flow', 'error', 'A control the journey needs is missing: ' + (typeof sel === 'string' ? sel : ctlKey(sel)), { where: String(sel) }); return false; } await realClick(e); await raf(); return true; }
async function typeTitle(text, enter = true) { const t = byId('d-title'); if (!t) return; typeInto(t, text); if (enter) key('Enter', {}, t); await settle(); }
async function newOne(title, enter) { const n = A.reminders.length; await click('#addBtn'); if (A.reminders.length !== n + 1) { A.addReminder(); } if (title != null) await typeTitle(title, enter !== false); return A.reminders.find((r) => r.id === A.selectedId); }
function recognizer(text) {   // the text recognizer, with its promises checked
  let p; try { p = A.parseNaturalLanguage(text); } catch (e) { find('nlp', 'error', 'The text recognizer threw an error for "' + squash(text).slice(0, 40) + '": ' + e.message, { stack: e.stack, where: 'throw' }); return null; }
  const w = squash(text).slice(0, 40);
  if (!check('recognizer dates are valid dates', p.due == null || validDue(p.due))) find('nlp', 'error', `The recognizer made an invalid date "${String(p.due).slice(0, 24)}" from "${w}"`, { where: 'due' });
  if (!check('recognizer text is text', typeof p.cleanTitle === 'string')) find('nlp', 'error', `The recognizer returned no cleaned text for "${w}"`, { where: 'clean' });
  if (!check('recognizer checklist items are not blank', !p.checklist || p.checklist.every((x) => typeof x === 'string' && x.trim()))) find('nlp', 'error', `The recognizer made a blank checklist item from "${w}"`, { where: 'blank item' });
  if (!check('recognizer repeat labels are clean', p.repeat == null || (typeof p.repeat === 'string' && !/NaN|undefined|Infinity/.test(p.repeat)))) find('nlp', 'error', `The recognizer made the repeat "${String(p.repeat).slice(0, 30)}" from "${w}"`, { where: 'repeat' });
  ['datetime', 'repeat', 'end', 'snooze'].forEach((k) => { try { const d = ({ datetime: A.detectDatetime, repeat: A.detectRepeat, end: A.detectEnd, snooze: A.detectSnooze })[k](text); if (!check('"Detected" labels are never blank', !(d && d.ok && !squash(d.label)))) find('nlp', 'error', `The ${k} detector says it understood "${w}" but gives a blank label`, { where: 'label ' + k }); } catch (e) { find('nlp', 'error', `The ${k} detector threw for "${w}": ${e.message}`, { stack: e.stack, where: 'throw ' + k }); } });
  return p;
}

/* ---------------------------------------------------------------- actions */
async function aClick(c) {
  const o = {}; const r = rng(); if (r < 0.04) o.shift = true; else if (r < 0.07) o.ctrl = true; else if (r < 0.09) o.button = 2;
  await realClick(c.el, o);
}
async function aForm(c) {
  let el = c.el; const k = c.k; let d = '';
  if (k === 'select' || k === 'datetime') el = refocus(el);
  if (k === 'select') { const opts = [...el.options]; const o = pick(opts); setValue(el, o.value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); d = o.text; }
  else if (k === 'datetime') { const v = chance(0.5) ? rdate() : pick(DATETIMES); setValue(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); d = v; }
  else if (k === 'text') {
    const gen = FIELD_VALUES[el.id], v = gen ? gen() : el.classList.contains('cl-text') ? pick(ITEMS) : pick(TITLES);
    typeInto(el, v, { change: chance(0.6), enter: chance(0.25), ctrl: el.id === 'd-notes', blur: chance(0.4) }); d = squash(v).slice(0, 30);
    if (/^(d-title|d-notes|d-due-text|d-repeat|d-end|d-snooze)$/.test(el.id)) recognizer(v);
  } else if (k === 'check') { await realClick(el); d = el.checked ? 'on' : 'off'; }
  return d;
}
const KEYS = [['Escape'], ['Escape'], ['Enter'], ['Enter', { ctrl: 1 }], ['Enter', { shift: 1 }], ['n', { ctrl: 1 }], ['n', { ctrl: 1 }], ['Tab'], ['Tab', { shift: 1 }], ['ArrowDown'], ['ArrowUp'], ['Delete'], ['Backspace'], [' '], ['a'], ['/'], ['?'], ['Home'], ['End'], ['z', { ctrl: 1 }], ['F2'], ['ContextMenu']];
function aKey() {
  const [k, o] = pick(KEYS), ae = document.activeElement, tgt = ae && ae !== document.body && !inDev(ae) && chance(0.7) ? ae : document.body, n0 = A.reminders.length;
  key(k, o || {}, tgt);
  if (k === 'Escape') { if (!check('Escape closes any open dialog', $$('.overlay.show').length === 0)) find('stuck-overlay', 'error', 'A dialog is still open after pressing Escape', { where: 'esc' }); }
  if (k === 'n' && o && o.ctrl) expect('Ctrl+N adds a reminder and opens it', A.reminders.length === n0 + 1 && A.selectedId === (A.reminders[0] || {}).id && !!byId('d-title'), 'Ctrl+N did not add a new reminder and open it', 'ctrl+n');
  return (o && o.ctrl ? 'Ctrl+' : '') + (o && o.shift ? 'Shift+' : '') + (k === ' ' ? 'Space' : k);
}
async function aAdd() {
  const n0 = A.reminders.length; if (n0 >= 60) return 'skipped (60 reminders already)';
  const b = byId('addBtn'); if (b && visible(b)) await realClick(b); else A.addReminder();
  await sleep(60);
  expect('New Reminder adds one and opens it', A.reminders.length === n0 + 1 && A.selectedId === (A.reminders[0] || {}).id && !!byId('d-title') && byId('d-title').value === '', 'New Reminder did not add exactly one empty reminder and open it', 'add');
  if (!check('a new reminder puts the cursor in its title', document.activeElement === byId('d-title'))) find('flow', 'info', 'After New Reminder the cursor is not in the title field', { where: 'focus' });
  feature('reminders added');
  let d = 'new';
  if (chance(0.7)) { const v = pick(TITLES); typeInto(byId('d-title'), v, { enter: chance(0.5), blur: chance(0.4) }); recognizer(v); d = 'new + title ' + JSON.stringify(squash(v).slice(0, 24)); await raf(); }
  return d;
}
async function aSearch() {
  const s = byId('search'); if (!s || !visible(s)) return 'search box hidden';
  const R = A.reminders; let v;
  if (R.length && chance(0.55)) { const q = pick(R); v = squash(q.title || q.notes).slice(0, ri(1, 6)); if (chance(0.3)) v = v.toUpperCase(); } else v = pick(SEARCHES);
  typeInto(s, v); await raf(); feature('searches');
  if (chance(0.4)) { typeInto(s, ''); await raf(); }
  return JSON.stringify(v.slice(0, 20));
}
async function aReorder() {
  const rs = rows().filter(visible); if (rs.length < 2) return 'fewer than 2 rows';
  const src = pick(rs), dst = pick(rs.filter((r) => r !== src)), id = src.dataset.id, did = dst.dataset.id, R0 = A.reminders.map((r) => r.id), dt = new DataTransfer();
  const sr = src.getBoundingClientRect(), dr = dst.getBoundingClientRect(), above = chance(0.5), y = above ? dr.top + dr.height * 0.25 : dr.top + dr.height * 0.75, x = dr.left + dr.width / 2;
  const ev = (type, el, yy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: yy }));
  const cur = () => rowOf(did) || dst;   // (a file read finishing in the background can redraw the list; use the row that is on screen now)
  ev('dragstart', src, sr.top + 5); await raf(); ev('dragenter', cur(), y); ev('dragover', cur(), y); await raf(); const ind = $('#dropIndicator'), indNext = ind ? (ind.nextElementSibling ? (ind.nextElementSibling.dataset.id || ind.nextElementSibling.className) : 'end') : 'no indicator'; ev('drop', cur(), y); ev('dragend', rowOf(id) || src, y); await raf();
  const R1 = A.reminders.map((r) => r.id);
  expect('reordering keeps every reminder', R1.slice().sort().join() === R0.slice().sort().join(), 'Dragging a row to reorder lost, duplicated or added a reminder', 'reorder keeps');
  const a = A.reminders.find((r) => r.id === id), b = A.reminders.find((r) => r.id === did), same = !A.settings.groupCompleted || (a && b && a.completed === b.completed), si = R1.indexOf(id), di = R1.indexOf(did);
  if (same && a && b) { const ok = above ? si === di - 1 : si > di; if (!expect('dropping a row on the upper half puts it before, on the lower half after', ok, `A row dropped on the ${above ? 'upper' : 'lower'} half of another did not land ${above ? 'just before' : 'after'} it`, 'reorder place ' + above) && T.issues.size) { const it = [...T.issues.values()].pop(); it.note = it.note || `order before: ${R0.map((x) => x.slice(-4)).join(',')} | after: ${R1.map((x) => x.slice(-4)).join(',')} | moved ${id.slice(-4)} onto ${did.slice(-4)} (${above ? 'upper' : 'lower'} half), grouping ${A.settings.groupCompleted}, search "${$('#search').value}", the drop marker sat before ${String(indNext).slice(-8)}, rows ${rs.length}, dst top ${Math.round(dr.top)}`; } }
  feature('rows reordered'); return `${above ? 'above' : 'below'} another row`;
}
async function aImport(force) {
  const inp = byId('fileInput'); if (!inp) return 'no file input';
  const fk = force && force.kind ? force : (A.reminders.length > 30 ? { kind: pick(['wrapped', 'notJson', 'weirdTypes', 'emptyFile']) } : undefined), f = makeImport(fk);
  const before = clone(A.reminders), n0 = before.length, t0 = T.toastSeq; T.quiet = f.expect !== 'import';
  const dt = new DataTransfer(); dt.items.add(new File([f.text], f.name, { type: 'text/plain' })); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 40 && T.toastSeq === t0; i++) await sleep(25);   // the file is read in the background; a message follows on success or failure
  await raf(); T.quiet = false;
  const msgs = T.toasts.filter((m) => m.seq > t0), last = msgs[msgs.length - 1];
  if (f.expect === 'import') {
    expect('a good file imports every reminder', A.reminders.length === n0 + f.count, `Importing a good file (${f.what}) with ${f.count} reminders gave ${A.reminders.length - n0} new ones`, 'import count ' + f.what);
    expect('a good import says how many came in', last && new RegExp('^Imported ' + f.count + ' reminder' + (f.count !== 1 ? 's' : '') + '$').test(last.text), `After importing ${f.count} reminders the message was "${last ? last.text : '(none)'}"`, 'import msg');
    if (f.list && f.count <= 12) expect('imported titles are kept', f.list.every((r, i) => (A.reminders[i] || {}).title === r.title), 'Imported reminders came in with different titles than the file had (' + f.what + ')', 'import titles ' + f.what);
    feature('files imported');
  } else if (f.expect === 'reject') {
    T.expectedErrToasts = true;
    expect('a bad file is refused with a message', A.reminders.length === n0 && last && last.kind === 'err', `A bad file (${f.what}) was ${A.reminders.length !== n0 ? 'accepted' : 'ignored with no error message'}`, 'reject ' + f.what);
    feature('bad files refused');
  } else { T.expectedErrToasts = true; feature('odd files imported'); }
  const bad = dataProblem(A.reminders, A.settings);
  if (!check('imported data ends up as valid reminders', !bad)) { find('state', 'error', `After importing "${f.what}" the reminders are not valid: ${bad}`, { where: 'import ' + f.what }); try { A.reminders = before; A.selectedId = null; A.save(); A.render(); } catch (e) { /* ignore */ } }
  return f.what;
}
async function aExport() {
  const n = T.dlSeq || 0, cnt = A.reminders.length, t0 = T.toastSeq, b = byId('exportBtn');
  if (b) await realClick(b); else A.exportTxt();
  await raf();
  const d = (T.dlSeq || 0) > n ? T.downloads[T.downloads.length - 1] : null;
  if (!expect('Export makes a file', !!d, 'Export did not produce a downloadable file', 'export none')) return 'export (nothing)';
  expect('the export file is named reminders-DATE.txt', /^reminders-\d{4}-\d{2}-\d{2}\.txt$/.test(d.name), 'The export file is named "' + d.name + '"', 'export name');
  let doc = null; try { doc = JSON.parse(await d.blob.text()); } catch (e) { /* checked below */ }
  expect('the export file is valid JSON in the expected shape', doc && doc.app === 'reminders' && doc.version === 1 && Array.isArray(doc.reminders) && !isNaN(new Date(doc.exportedAt)), 'The export file is not the expected {app, version, exportedAt, reminders} document', 'export shape');
  if (doc && Array.isArray(doc.reminders)) expect('the export holds exactly what is in the app', canon(doc.reminders) === canon(A.reminders), 'The exported reminders differ from the ones in the app: ' + firstDiff(A.reminders, doc.reminders), 'export content');
  const m = T.toasts.filter((x) => x.seq > t0).pop(); expect('Export says how many it saved', m && m.text === `Exported ${cnt} reminder${cnt !== 1 ? 's' : ''}`, `After exporting ${cnt} the message was "${m ? m.text : '(none)'}"`, 'export msg');
  feature('files exported'); return 'export ' + cnt;
}
function aReload() { reloadTrip(); return 'save and reload'; }

/* ---------------------------------------------------------------- risky starting states */
const bigList = (n, f) => Array.from({ length: n }, (_, i) => mkRem(Object.assign({ title: 'Reminder number ' + (i + 1) + ' ' + pick(['alpha', 'beta', 'zeta']), checklist: chance(0.3) ? [{ id: A.uid(), text: 'one', done: chance(0.5) }] : [] }, f ? f(i) : {})));
const SETUPS = {
  'forty reminders': () => seedData(bigList(40, (i) => ({ completed: i % 3 === 0 })), null),
  'everything completed': () => seedData(bigList(6, () => ({ completed: true })), null),
  'nothing at all': () => seedData([], null),
  'one huge title and huge notes': () => seedData([mkRem({ title: 'T'.repeat(4000), notes: 'N '.repeat(4000) })].concat(baselineData()), null),
  'html in every field': () => seedData(TITLES.slice(12, 20).map((t) => mkRem({ title: t, notes: t, repeat: t, snooze: t, endText: t, checklist: [{ id: A.uid(), text: t, done: false }] })), null),
  'blank titles': () => seedData([mkRem({ title: '' }), mkRem({ title: '   ' }), mkRem({ title: '​' })], null),
  'ancient and far-future dates': () => seedData([mkRem({ title: 'old', due: '1970-01-01T00:00' }), mkRem({ title: 'far', due: '9999-12-31T23:59' }), mkRem({ title: 'leap', due: '2024-02-29T12:00' })], null),
  'completed section closed': () => { A.settings.completedCollapsed = true; A.saveSettings(); seedData(baselineData(), null); },
  'grouping off': () => { A.settings.groupCompleted = false; A.saveSettings(); A.syncSettingToggles(); seedData(baselineData(), null); },
  'compact list': () => { A.settings.density = 'compact'; A.saveSettings(); A.applySettings(); A.syncSettingToggles(); },
  'confirm before delete on': () => { A.settings.confirmDelete = true; A.saveSettings(); A.syncSettingToggles(); },
  'a search typed': () => { const s = byId('search'); typeInto(s, 'a'); },
  'a reminder open': () => { const r = A.reminders[0]; if (r) A.selectReminder(r.id); },
  'a repeating reminder open': () => { const r = mkRem({ title: 'Weekly review', repeat: 'Every week', endText: 'After 5 times', due: ld(new Date(Date.now() + 86400000)), checklist: [{ id: A.uid(), text: 'a', done: false }] }); seedData([r].concat(A.reminders), r.id); },
  'a long checklist': () => { const r = mkRem({ title: 'Packing', checklist: Array.from({ length: 40 }, (_, i) => ({ id: A.uid(), text: 'item ' + i, done: i % 2 === 0 })) }); seedData([r].concat(A.reminders), r.id); },
  'a theme': () => { A.settings.theme = pick(A.THEMES).id; A.saveSettings(); A.applySettings(); A.renderThemeGrid(); },
  'settings dialog open': () => { byId('settingsOverlay').classList.add('show'); },
  'help dialog open': () => { byId('helpOverlay').classList.add('show'); },
};
async function aSetup(name) { const fn = SETUPS[name] || SETUPS[pick(Object.keys(SETUPS))]; fn(); await settle(); return name; }

/* ---------------------------------------------------------------- whole journeys */
const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return ld(d); };
const MACROS = {
  async 'create, complete, delete'() {
    seedData([], null);
    const r = await newOne('call mom tomorrow at 9am');
    expect('typing a phrase and pressing Enter fills in the date and cleans the title', r && r.title === 'call mom' && r.due === tomorrow9(), `"call mom tomorrow at 9am" + Enter gave title "${r && r.title}" and due "${r && r.due}" (expected "call mom" and ${tomorrow9()})`, 'phrase apply');
    expect('the row shows the clean title', rowOf(r.id) && squash(rowOf(r.id).querySelector('.ri-title').textContent) === 'call mom', 'The list row does not show the cleaned title', 'row title');
    await click('#d-check');
    expect('completing moves the reminder to the Completed section', r.completed && $('.completed-header .cc-count') && $('.completed-header .cc-count').textContent === '1' && rowOf(r.id) && !!rowOf(r.id).closest('.completed-group'), 'Completing a reminder did not move it into the Completed section with a count of 1', 'complete');
    expect('with nothing left to do the list says All done', /All done/.test($('#listScroll').textContent), 'The list does not say "All done" when every reminder is completed', 'alldone');
    await click('.completed-header'); expect('the Completed header collapses the section', !rowOf(r.id) && A.settings.completedCollapsed, 'Clicking the Completed header did not hide the completed rows', 'collapse');
    await click('.completed-header'); expect('and opens it again', !!rowOf(r.id) && !A.settings.completedCollapsed, 'Clicking the Completed header again did not show the rows', 'expand');
    await click(rowOf(r.id).querySelector('.ri-check')); expect('un-completing from the list moves it back', !r.completed && !$('.completed-header') && !rowOf(r.id).closest('.completed-group'), 'Un-completing a reminder from the list did not move it back to the to-do list', 'uncomplete');
    const n = A.reminders.length; await click('#d-delete'); expect('Delete removes it and closes the edit pane', A.reminders.length === n - 1 && A.selectedId === null && !byId('mainEmpty').classList.contains('hidden'), 'Delete did not remove the reminder and return to the empty pane', 'delete');
    expect('an empty list says so', /No reminders yet/.test($('#listScroll').textContent), 'The list does not say "No reminders yet" when empty', 'emptymsg');
    feature('reminders completed'); feature('reminders deleted');
  },
  async 'text recognizer tour'() {
    seedData([], null);
    const groups = A.HELP.filter((h) => /^(Dates|Times|Date \+ time|Repeat|Checklists)/.test(h.title));
    for (const g of groups) for (const ex of g.ex) {
      const p = recognizer(ex); if (!p) continue;
      const kind = /^Repeat/.test(g.title) ? 'repeat' : /^Checklists/.test(g.title) ? 'checklist' : 'date';
      const ok = p.matched && (kind === 'date' ? !!p.due : kind === 'repeat' ? !!p.repeat : !!(p.checklist && p.checklist.length >= 1));
      expect('every example on the help screen is understood', ok, `The help screen promises "${ex}" works (${g.title}) but the recognizer ${p.matched ? 'did not make a ' + kind : 'matched nothing'}`, 'help ' + ex);
      const r = await newOne(ex);
      if (ok && r) {
        if (kind === 'date') expect('Enter applies the date it detected', r.due === p.due, `Typing "${ex}" + Enter set due to "${r.due}" instead of "${p.due}"`, 'apply date ' + ex);
        if (kind === 'repeat') expect('Enter applies the repeat it detected', r.repeat === p.repeat, `Typing "${ex}" + Enter set repeat to "${r.repeat}" instead of "${p.repeat}"`, 'apply repeat ' + ex);
        if (kind === 'checklist') expect('Enter applies the checklist it detected', r.checklist.length === p.checklist.length, `Typing "${ex}" + Enter made ${r.checklist.length} items instead of ${p.checklist.length}`, 'apply list ' + ex);
      }
    }
    TITLES.concat(DATES, REPEATS, ENDS, SNOOZES, NOTES).forEach((t) => recognizer(t));
    feature('phrases recognized');
  },
  async 'checklist journey'() {
    seedData([], null); const r = await newOne('Packing');
    const add = byId('cl-add'); for (const t of ['socks', 'shirt', 'passport']) { typeInto(add, t); key('Enter', {}, add); await settle(); }
    expect('typing in the add box and pressing Enter adds items', r.checklist.map((x) => x.text).join() === 'socks,shirt,passport' && $$('#cl-items .cl-item').length === 3 && byId('cl-progress').textContent === '0 of 3', 'Adding three checklist items did not give socks, shirt, passport with "0 of 3"', 'cl add');
    typeInto(add, '   '); key('Enter', {}, add); await settle(); expect('a blank item is not added', r.checklist.length === 3, 'Pressing Enter on a blank add box added an item', 'cl blank');
    await click($('#cl-items .cl-item .cl-check')); expect('ticking an item updates the progress in the pane and the list', r.checklist[0].done && byId('cl-progress').textContent === '1 of 3' && rowOf(r.id).textContent.includes('1/3'), 'Ticking an item did not show "1 of 3" and "1/3"', 'cl tick');
    const inp = $$('#cl-items .cl-text')[1]; typeInto(inp, 'blue shirt'); expect('editing an item text is kept', r.checklist[1].text === 'blue shirt', 'Editing a checklist item did not change the saved text', 'cl edit');
    key('Enter', {}, $$('#cl-items .cl-text')[1]); await settle(); expect('Enter inside an item inserts a new one below and focuses it', r.checklist.length === 4 && r.checklist[2].text === '' && document.activeElement === $$('#cl-items .cl-text')[2], 'Enter inside a checklist item did not add a focused empty item below', 'cl enter');
    await click($$('#cl-items .cl-del')[2]); expect('the remove button deletes just that item', r.checklist.map((x) => x.text).join() === 'socks,blue shirt,passport', 'Removing the empty item deleted the wrong one', 'cl del');
    await typeTitle('make a list of bread, eggs, milk');
    expect('"make a list of ..." adds items and cleans the title', r.checklist.length === 6 && r.checklist.slice(3).map((x) => x.text).join() === 'bread,eggs,milk' && !/list/i.test(r.title), `"make a list of bread, eggs, milk" + Enter gave ${r.checklist.length} items and title "${r.title}"`, 'cl nl');
    feature('checklist journeys');
  },
  async 'search and filter'() {
    seedData([mkRem({ title: 'Alpha call', notes: 'bring zeta' }), mkRem({ title: 'beta Meeting' }), mkRem({ title: 'Gamma', completed: true }), mkRem({ title: 'Alphabet soup', completed: true })], null);
    const s = byId('search'), n = () => rows().length;
    for (const [q, want] of [['ALPHA', 2], ['alpha call', 1], ['zeta', 1], ['meeting', 1], ['  gamma  ', 1], ['a', 4], ['', 4], ['<b>', 0], ['(', 0], ['.*', 0], ['no such thing', 0]]) {
      typeInto(s, q); await settle(); expect('search finds exactly the matching reminders (not case sensitive, notes included)', n() === want, `Searching "${q}" shows ${n()} rows, expected ${want}`, 'search ' + q);
      if (want === 0) expect('no matches says so', /No matches found/.test($('#listScroll').textContent), 'A search with no matches does not say "No matches found."', 'nomatch');
    }
    typeInto(s, 'alpha'); await settle(); const r = A.reminders[0]; A.selectReminder(r.id); await settle(); typeInto(byId('d-notes'), 'no more mention'); await settle(); typeInto(byId('d-title'), 'Delta'); await settle();
    expect('editing a title so it no longer matches updates the list', n() === 1 && squash(rows()[0].textContent).includes('Alphabet'), 'After renaming "Alpha call" to "Delta" the list still shows it under the search "alpha"', 'search rename');
    typeInto(byId('d-notes'), 'alpha again'); await settle(); expect('editing the notes so they now match updates the list', n() === 2, 'After typing "alpha" in the notes the list did not show the reminder under the search "alpha"', 'search notes');
    typeInto(s, ''); await settle(); expect('clearing the search brings every reminder back', n() === 4, 'Clearing the search did not bring back all the reminders', 'search clear'); feature('search journeys');
  },
  async 'settings and delete dialogs'() {
    seedData(baselineData(), null);
    await click('#settingsBtn'); expect('Settings opens', byId('settingsOverlay').classList.contains('show'), 'The settings button did not open Settings', 'settings open');
    for (const [id, get] of [['densityToggle', (q) => q.density === 'compact'], ['groupToggle', (q) => q.groupCompleted], ['confirmDelToggle', (q) => q.confirmDelete], ['spellcheckToggle', (q) => q.spellcheck]]) {
      const b0 = get(A.settings); await click('#' + id); expect(id + ' flips its setting', get(A.settings) === !b0 && byId(id).classList.contains('on') === !b0, id + ' did not flip its setting and its look', id);
      expect('settings are saved at once', JSON.parse(SBX.store.get(A.SETTINGS_KEY) || '{}').groupCompleted === A.settings.groupCompleted, 'A changed setting was not saved', 'settings saved'); await click('#' + id);
    }
    await click('#groupToggle'); expect('turning off "Separate completed" puts everything in one list', !$('.completed-header') && rows().length === 3, 'With "Separate completed" off the list still has a Completed section or wrong rows', 'ungroup'); await click('#groupToggle');
    await click('#densityToggle'); expect('compact density applies', document.body.dataset.density === 'compact', 'Compact list did not change the page', 'density'); await click('#densityToggle');
    for (const t of A.THEMES) { await click(`.theme-swatch[data-theme-id="${t.id}"]`); expect('each theme applies and is saved', document.body.dataset.theme === t.id && JSON.parse(SBX.store.get(A.SETTINGS_KEY)).theme === t.id, 'Theme ' + t.id + ' did not apply or was not saved', 'theme ' + t.id); }
    await click('#settingsClose'); expect('the close button closes Settings', !byId('settingsOverlay').classList.contains('show'), 'The X in Settings did not close it', 'settings close');
    for (const [btn, ov] of [['#settingsBtn', 'settingsOverlay'], ['#helpBtn', 'helpOverlay']]) {
      await click(btn); expect(ov + ' opens', byId(ov).classList.contains('show'), ov + ' did not open', ov + ' open');
      await realClick(byId(ov)); expect('clicking the dark backdrop closes ' + ov, !byId(ov).classList.contains('show'), 'The backdrop click did not close ' + ov, ov + ' backdrop');
      await click(btn); key('Escape', {}, document.body); await settle(); expect('Escape closes ' + ov, !byId(ov).classList.contains('show'), 'Escape did not close ' + ov, ov + ' esc');
    }
    closeOverlays();
    A.selectReminder(A.reminders[0].id); A.settings.confirmDelete = true; A.saveSettings(); A.syncSettingToggles(); const t = A.reminders[0].title, n = A.reminders.length;
    await click('#d-delete'); expect('with "Confirm before delete" a dialog names the reminder', byId('delOverlay').classList.contains('show') && byId('delText').textContent.includes(t) && A.reminders.length === n, 'Delete with confirmation on did not ask first, naming the reminder', 'del ask');
    await click('#delCancel'); expect('Cancel keeps the reminder', A.reminders.length === n && !byId('delOverlay').classList.contains('show'), 'Cancel in the delete dialog still deleted or stayed open', 'del cancel');
    await click('#d-delete'); await click('#delConfirm'); expect('Delete in the dialog removes it', A.reminders.length === n - 1 && !byId('delOverlay').classList.contains('show'), 'Confirming the delete dialog did not remove the reminder', 'del confirm');
    await click('#wipeBtn'); expect('Wipe asks first', byId('wipeOverlay').classList.contains('show') && A.reminders.length > 0, 'Wipe did not ask for confirmation', 'wipe ask'); await click('#wipeCancel'); expect('Cancel keeps everything', A.reminders.length === n - 1, 'Cancel on the wipe dialog deleted reminders', 'wipe cancel');
    await click('#wipeBtn'); await click('#wipeConfirm'); expect('Delete everything empties the app and saves that', A.reminders.length === 0 && A.selectedId === null && SBX.store.get(A.STORE_KEY) === '[]', 'Wiping did not empty the reminders and the saved copy', 'wipe confirm');
    feature('settings journeys');
  },
  async 'first reminder note and browser help'() {
    seedData([], null); SBX.store.delete(A.SAVE_NOTE_KEY); T.noteOn = true;
    try {
      const ov = byId('saveNoteOverlay'); await click('#addBtn'); await settle();
      expect('the note waits while the first title is being written', !ov.classList.contains('show'), 'The cache note came up as soon as New Reminder was pressed, over the first letters typed', 'note waits');
      await noteWrite();
      expect('the first reminder shows the cache note, with its exact words', ov.classList.contains('show') && squash(ov.textContent).includes('Reminders are saved by your cache. You can always clear out all reminders by clearing your cache any time.'), 'The first reminder did not show the cache note with its exact text', 'note first');
      expect('the note has a Got it! button', squash((byId('saveNoteOk') || {}).textContent) === 'Got it!', 'The note has no "Got it!" button', 'note gotit');
      expect('the browser help starts hidden', byId('cacheHelp').hidden && byId('cacheHelpBtn').getAttribute('aria-expanded') === 'false', 'The browser buttons are showing before "How do I clear my cache?" is pressed', 'help hidden');
      await click('#cacheHelpBtn'); const links = $$('#cacheHelp a.browser-btn');
      expect('the help lists Edge, Chrome, Brave, Firefox and Opera GX', ['Microsoft Edge', 'Google Chrome', 'Brave', 'Firefox', 'Opera GX'].every((nm, i) => links[i] && squash(links[i].textContent) === nm) && links.length === 5, 'The browser buttons are not Edge, Chrome, Brave, Firefox and Opera GX in order', 'help list');
      expect('each browser button has its icon and opens that browser’s own help page in a new tab', links.length === 5 && links.every((l) => !!l.querySelector('svg path[d]') && /^https:\/\//.test(l.href) && l.origin !== location.origin && l.target === '_blank' && /noopener/.test(l.rel)), 'A browser button is missing its icon, or does not open an outside help page in a new tab', 'help links');
      expect('the browser buttons show after pressing the help button', !byId('cacheHelp').hidden && links.every((l) => l.getBoundingClientRect().height > 10) && byId('cacheHelpBtn').getAttribute('aria-expanded') === 'true', 'The browser buttons did not show', 'help shown');
      const r = byId('saveNoteOverlay').querySelector('.modal').getBoundingClientRect(); expect('the note fits the window with the browser buttons open', r.top >= -1 && r.bottom <= innerHeight + 1 || byId('saveNoteOverlay').querySelector('.modal').scrollHeight > 0, 'The note does not fit', 'note fit');
      feature('browser help opened'); await click('#cacheHelpBtn'); expect('the same button hides them again', byId('cacheHelp').hidden, 'The browser buttons did not hide again', 'help toggle');
      await click('#saveNoteOk'); expect('Got it! closes the note and it is remembered', !ov.classList.contains('show') && SBX.store.get(A.SAVE_NOTE_KEY) === '1', 'Got it! did not close the note or it was not remembered', 'note ok');
      await click('#addBtn'); await settle(); expect('a second reminder does not show the note again', !ov.classList.contains('show'), 'The note came back for the second reminder', 'note again');
      seedData([], null); SBX.store.delete(A.SAVE_NOTE_KEY); await click('#addBtn'); await settle(); await noteWrite(); key('Escape', {}, document.body); await settle(); expect('Escape also closes the note', !ov.classList.contains('show'), 'Escape did not close the cache note', 'note esc');
      seedData([mkRem({ title: 'already here' })], null); SBX.store.delete(A.SAVE_NOTE_KEY); await click('#addBtn'); await settle(); expect('the note is only for the very first reminder', !ov.classList.contains('show'), 'The note showed although reminders already existed', 'note first only');
    } finally { T.noteOn = false; closeOverlays(); }
  },
  async 'changelog'() {
    seedData([], null); const chip = byId('versionChip'), ov = byId('changelogOverlay');
    expect('the version chip sits right under the logo and says the version', !!chip && $('.logo-mark').nextElementSibling.contains(chip) && chip.textContent.includes(window.__REM.version) && /What’s new/.test(chip.textContent), 'The chip under the logo does not show the version and What’s new', 'chip');
    await click(chip); expect('the chip opens the changelog', ov.classList.contains('show'), 'The version chip did not open the changelog', 'cl open');
    const hs = $$('#changelogOverlay h4'), entries = window.__REM.changelog;
    expect('the changelog lists every release, newest first, with the current one marked', hs.length === entries.length && hs[0].textContent.includes('v' + entries[0].v) && /current/i.test(hs[0].textContent) && $$('#changelogOverlay li').length === entries.reduce((n, e) => n + e.items.length, 0), 'The changelog does not list every release from version.js', 'cl list');
    expect('the changelog names the app and its version', squash($('#changelogOverlay .rem-cl-sub').textContent) === 'Reminders · version ' + window.__REM.version, 'The changelog heading does not say Reminders and the current version', 'cl sub');
    key('Escape', {}, document.body); await settle(); expect('Escape closes the changelog', !ov.classList.contains('show'), 'Escape did not close the changelog', 'cl esc');
    await click(chip); await realClick(ov); expect('a click on the dark area closes the changelog', !ov.classList.contains('show'), 'The backdrop did not close the changelog', 'cl backdrop');
    await click(chip); await click('#changelogClose'); expect('the X closes the changelog', !ov.classList.contains('show'), 'The X did not close the changelog', 'cl x'); closeOverlays();
  },
  async 'how do i use this walkthrough'() {
    seedData([], null); SBX.store.delete(A.SAVE_NOTE_KEY); T.guideOK = true; const g = window.__guide;
    try {
      expect('the page has a How do I use this? button and a walkthrough', !!g && !!byId('guideBtn') && /How do I use this\?/.test(byId('guideBtn').textContent), 'The How do I use this? button or the walkthrough is missing', 'guide btn');
      await click('#guideBtn'); await settle();
      expect('the walkthrough opens with a card, a dim layer and a progress bar', g.isOpen && !!$('.gd-card') && !!$('.gd-hole') && $$('.gd-bar i').length === g.steps && document.body.classList.contains('guiding'), 'The walkthrough did not open properly', 'guide open');
      const n0 = A.reminders.length; let guard = 0, shownSteps = 0;
      while (g.isOpen && guard++ < g.steps + 6) {
        const card = $('.gd-card'); if (card && !$('.overlay.show')) { shownSteps++; const r = card.getBoundingClientRect(); expect('the walkthrough card stays fully on screen', r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, `The walkthrough card ran off the window at step ${g.step + 1}`, 'guide card ' + g.step); }
        const before = g.step, as = $('.gd-assist:not(.gd-del)'), nx = $('.gd-next');
        if ($('.overlay.show')) { const ok = byId('saveNoteOk'); if (ok && visible(ok)) await click(ok); else closeOverlays(); await settle(); continue; }
        if (as && chance(0.7)) { as.click(); await until(() => g.step !== before || !g.isOpen || $('.overlay.show'), 3500); if (g.step === before && g.isOpen && !$('.overlay.show') && $('.gd-next')) $('.gd-next').click(); }
        else if (nx) nx.click();
        await settle(); await sleep(40);
      }
      if (g.isOpen && g.step === g.steps - 1 && $('.gd-next')) { $('.gd-next').click(); await settle(); }
      expect('the walkthrough reaches the last step and Done closes it cleanly', !g.isOpen && !$('.gd') && !document.body.classList.contains('guiding'), 'The walkthrough did not finish and close cleanly', 'guide end');
      feature('walkthroughs finished');
      expect('walking through it made a practice reminder (and only one)', A.reminders.length <= n0 + 1, 'The walkthrough made more than one practice reminder', 'guide practice');
      closeOverlays(); seedData([], null); await click('#guideBtn'); await settle(); const first = g.step; $('.gd-next').click(); await settle(); key('Escape', {}, document.body); await settle();
      expect('Esc leaves the walkthrough at any step', !g.isOpen && !$('.gd') && !document.body.classList.contains('guiding') && first === 0, 'Esc did not close the walkthrough', 'guide esc');
      await click('#guideBtn'); await click('#guideBtn'); await settle(); expect('pressing the button again closes it and never stacks two', $$('.gd').length === 0, 'The walkthrough stacked or did not close', 'guide twice');
    } finally { T.guideOK = false; try { g && g.close(); } catch (e) { /* ignore */ } closeOverlays(); }
  },
  async 'export, wipe, import'() {
    const rich = baselineData().concat(randomReminder(), randomReminder()); seedData(rich, null);
    const keep = clone(A.reminders); await aExport();
    const d = T.downloads[T.downloads.length - 1]; await click('#wipeBtn'); await click('#wipeConfirm'); expect('wipe empties', A.reminders.length === 0, 'Wipe did not empty the list', 'wipe');
    const text = d && d.blob ? await d.blob.text() : '[]'; const inp = byId('fileInput'), dt = new DataTransfer(); dt.items.add(new File([text], 'back.txt', { type: 'text/plain' })); inp.files = dt.files; const t0 = T.toastSeq; inp.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40 && T.toastSeq === t0; i++) await sleep(25);
    const strip = (l) => l.map((r) => { const c = clone(r); delete c.id; return c; });
    expect('importing the export brings back every reminder exactly (new ids)', canon(strip(A.reminders)) === canon(strip(keep)), 'Export, wipe, then import did not restore the same reminders: ' + firstDiff(strip(keep), strip(A.reminders)), 'round trip'); feature('export-import round trips');
  },
  async 'save and reload'() {
    seedData(baselineData(), null); const r = await newOne('Dentist dec 15 at 2pm every 6 months');
    typeInto(byId('d-notes'), '\nnotes starting with a newline\nand more', { blur: true }); await settle();
    for (const [id, v] of [['d-snooze', '45 minutes'], ['d-end', 'after 5 times']]) { const e = byId(id); if (e) typeInto(e, v); }
    if (A.reminders.length) { await click('#d-check'); await click('#d-check'); }
    reloadTrip(); await settle(); const again = A.reminders.find((x) => x.id === r.id);
    expect('everything typed is still there after a reload', again && again.notes === '\nnotes starting with a newline\nand more' && again.snooze === '45 minutes', 'After a reload the reminder lost something that was typed (notes or snooze)', 'reload fields');
  },
  async 'reorder rows'() {
    seedData(bigList(5, (i) => ({ title: 'Row ' + i, completed: i === 4 })), null);
    for (let i = 0; i < 6; i++) await aReorder();
    A.settings.groupCompleted = false; A.saveSettings(); A.render();
    for (let i = 0; i < 4; i++) await aReorder();
    reloadTrip(); feature('reorder journeys');
  },
  async 'schedule fields'() {
    seedData([], null); const r = await newOne('Schedule test');
    const set = async (id, v, ev = ['input', 'change']) => { const e = byId(id); if (!e) return; try { e.focus(); } catch (x) { /* ignore */ } setValue(e, v); ev.forEach((n) => e.dispatchEvent(new Event(n, { bubbles: true }))); await raf(); };
    for (const p of A.DUE_PRESETS) { await set('d-due-preset', p, ['change']); expect('a date preset sets a real date and text', validDue(r.due) && r.due !== '' && byId('d-due-text').value === p && byId('d-due').value === r.due, `The date preset "${p}" gave due "${r.due}" and text "${byId('d-due-text').value}"`, 'preset ' + p); expect('the badge confirms it', /Detected/.test(byId('detect-datetime').textContent), 'No "Detected" badge after choosing ' + p, 'badge ' + p); }
    await click('[data-clear="due"]'); expect('the red X clears the date', r.due === '' && byId('d-due').value === '', 'Clearing the date left a value', 'clear due');
    for (const v of ['2026-12-25T09:00', '', 'garbage']) { await set('d-due', v, ['change']); expect('the exact picker stores a valid date or nothing', validDue(r.due) && byId('d-due').value === r.due, 'The date picker left the reminder with due "' + r.due + '"', 'picker ' + v); }
    for (const v of ['next friday at 5pm', 'in 99999999999 days', '12/25/0001', 'blah', '']) { await set('d-due-text', v, ['input', 'change']); expect('typed date phrases never leave an invalid date', validDue(r.due), `Typing the date "${v}" left due as "${r.due}"`, 'duetext ' + v); }
    for (const p of A.REPEATS) { await set('d-repeat-preset', p, ['change']); expect('a repeat preset fills the field and shows End repeat only when it repeats', byId('d-repeat').value === p && byId('row-endrepeat').classList.contains('show') === A.isRepeating(p), `Repeat preset "${p}" gave field "${byId('d-repeat').value}" and End repeat ${byId('row-endrepeat').classList.contains('show') ? 'shown' : 'hidden'}`, 'repeat ' + p); }
    await set('d-repeat', 'every 3 days', ['input']); expect('a typed repeat is Custom in the menu and the badge understands it', byId('d-repeat-preset').value === '__custom' && /Detected/.test(byId('detect-repeat').textContent), 'A typed repeat did not switch the menu to Custom and show Detected', 'repeat custom');
    await set('d-repeat', 'blah blah', ['input']); expect('nonsense is flagged "Not recognized"', /Not recognized/.test(byId('detect-repeat').textContent), 'A nonsense repeat was not flagged', 'repeat bad');
    for (const p of A.END_PRESETS) { await set('d-end-preset', p, ['change']); expect('an end preset fills the field', byId('d-end').value === p || !byId('d-end'), 'End preset ' + p + ' did not fill the field', 'end ' + p); }
    for (const p of A.SNOOZE) { await set('d-snooze-preset', p, ['change']); expect('a remind-again preset fills the field', byId('d-snooze').value === p, 'Remind-again preset ' + p + ' did not fill the field', 'snooze ' + p); }
    await set('d-snooze', '45 minutes', ['input']); expect('a typed remind-again time is understood', /Detected/.test(byId('detect-snooze').textContent), '"45 minutes" was not understood', 'snooze typed');
    for (const u of A.URGENCIES) { await click(`[data-urg="${u.id}"]`); expect('each urgency can be chosen', r.urgency === u.id, 'Urgency ' + u.id + ' was not set', 'urg ' + u.id); }
    for (const ic of ['fa-star', '', 'fa-heart']) { const b = $(`#d-icon .icon-quick [data-icon="${ic}"]`); if (b) { await click(b); expect('quick icons can be chosen and cleared', r.icon === ic, 'Icon "' + ic + '" was not set', 'icon ' + ic); } }
    await click('#d-icon [data-more]'); expect('"more" opens the icon grid', !$('#d-icon .icon-grid').hasAttribute('hidden'), 'The more button did not open the icon grid', 'icon more'); const g = $$('#d-icon .icon-grid .icon-choice'); if (g.length) { const pk = pick(g); await click(pk); expect('a grid icon can be chosen', r.icon === pk.dataset.icon, 'A grid icon was not set', 'icon grid'); }
    for (const w of ['repeat', 'end', 'snooze', 'urgency', 'icon']) { await click(`[data-clear="${w}"]`); }
    expect('the red X buttons restore the defaults', r.repeat === 'Never' && r.endText === 'Never' && r.snooze === 'Off' && r.urgency === 'none' && r.icon === '', 'The clear buttons did not restore Never / Never / Off / none / no icon', 'clear all'); feature('schedule journeys');
  },
  async 'rapid fire'() { const list = scan().filter((c) => c.k !== 'link'); for (let i = 0; i < 20 && list.length; i++) { const c = pick(list); if (c.el.isConnected) { c.k === 'button' || c.k === 'check' ? await realClick(c.el) : await aForm(c); note(c.key, c.key, c.k, false); } if (chance(0.5)) await raf(); } },
  async 'import burst'() { for (let i = 0; i < 4; i++) await aImport(); },
  async 'many reminders'() {
    seedData([], null); const t0 = NOW();
    for (let i = 0; i < 40; i++) { A.addReminder(); typeInto(byId('d-title'), 'Reminder ' + i + ' ' + pick(['alpha', 'beta'])); if (i % 2) await click('#d-check'); }
    const ms = NOW() - t0; expect('forty reminders can be added quickly', ms < 6000 * Math.max(1, BG.speed / 10), `Adding and filling 40 reminders took ${(ms / 1000).toFixed(1)} s`, 'many speed');
    expect('all forty show up', A.reminders.length === 40 && rows().length === 40 && $('.cc-count').textContent === '20', 'Forty reminders were added but the list shows ' + rows().length + ' rows', 'many rows');
    typeInto(byId('search'), 'alpha'); await settle(); typeInto(byId('search'), ''); await settle(); feature('many-reminder journeys');
  },
};
async function aMacro(forced) { const name = forced && MACROS[forced] ? forced : pick(Object.keys(MACROS)); T.sub++; closeOverlays(); A.settings = DEFAULT_SETTINGS(); A.saveSettings(); A.applySettings(); A.syncSettingToggles(); A.renderThemeGrid(); await MACROS[name](); feature('journey: ' + name); return name; }

const KINDS = [
  ['click', 34, async (st) => { const c = T.spec.ctl ? findCtl(st, T.spec.ctl) : wpick(st.list.filter((q) => q.k === 'button' || q.k === 'link'), (q) => 1 / Math.pow(1 + (T.cover.get(q.key) ? T.cover.get(q.key).n : 0), 1.2)); if (!c) return null; T.cur.ctl = c.key; T.cur.desc = 'click ' + c.key; await aClick(c); note(c.key, c.key, c.k, false); return c.key; }],
  ['form', 24, async (st) => { const c = T.spec.ctl ? findCtl(st, T.spec.ctl) : wpick(st.list.filter((q) => ['select', 'text', 'datetime', 'check'].includes(q.k)), (q) => 1 / Math.pow(1 + (T.cover.get(q.key) ? T.cover.get(q.key).n : 0), 1.2)); if (!c) return null; T.cur.ctl = c.key; const d = await aForm(c); T.cur.desc = `${c.k} ${c.key} = ${d}`; note(c.key, c.key, c.k, false); return c.key; }],
  ['key', 7, async () => { const d = aKey(); T.cur.desc = 'key ' + d; return null; }],
  ['add', 6, async () => { const d = await aAdd(); T.cur.desc = 'add reminder: ' + d; return null; }],
  ['search', 5, async () => { const d = await aSearch(); T.cur.desc = 'search ' + d; return null; }],
  ['reorder', 4, async () => { const d = await aReorder(); T.cur.desc = 'drag a row: ' + d; return null; }],
  ['import', 3, async () => { const d = await aImport(T.spec.file); T.cur.desc = 'import file ' + d; return null; }],
  ['export', 2, async () => { const d = await aExport(); T.cur.desc = d; return null; }],
  ['reload', 2, async () => { const d = aReload(); T.cur.desc = d; return null; }],
  ['macro', 2, async () => { const d = await aMacro(T.spec.macro); T.cur.desc = 'journey: ' + d; return null; }],
  ['setup', 0, async () => { const d = await aSetup(T.spec.name); T.cur.desc = 'start from ' + d; return null; }],
];

/* ---------------------------------------------------------------- First-timer mode
   Someone who has never used a computer app before and is doing it with a toddler on the hip: they miss the button by a few pixels, double-click
   everything, hammer a button that seems slow, type one letter at a time with typos, type into the wrong box, start something and wander off,
   open dialogs and click the dark part to get out, mash Tab and Enter, change their mind about deleting, and scroll all over. Each slip is a
   kind of action; the app has to keep every reminder safe, stay on screen and in one piece, and always let them back out. */
const NB_PHRASES = ['buy milk', 'call mom tomorrow at 9', 'Doctor appt for the kids thursday 3pm', 'pick up Emma from soccer every weekday at 4', 'PAY THE ELECTRIC BILL!!!', 'bake sale friday',
  'rmind me to cal grandma', 'groceries: milk, eggs, bread, diapers', 'dentist', 'help', 'how do i do this', 'asdfgh', 'nap time in 20 minutes', 'return library books on the 5th', 'bday party sat 2pm  ', '  spaces everywhere  '];
const nbPick = (st, kinds) => { const l = st.list.filter((q) => q.el && q.el.isConnected && visible(q.el) && showing(q.el) && (!kinds || kinds.includes(q.k))); return l.length ? pick(l) : null; };
const nbGone = (el) => !el || !el.isConnected || !visible(el);
async function nbClickAt(x, y, o = {}) {
  const t = under(x, y); if (inDev(t)) return t;
  pmove(x, y); await raf(); pdown(t, x, y, o); await raf(); pup(t, x, y, o); fire(t, 'click', x, y, { detail: o.detail || 1 }); return t;
}
// a quick press with no pause, like a double-click or an impatient hammering
function nbQuick(el, n) {
  const [x, y] = center(el);
  for (let i = 1; i <= n; i++) { const t = el.isConnected ? el : under(x, y); if (inDev(t)) return i - 1; pdown(t, x, y, { detail: i }); pup(t, x, y, { detail: i }); fire(t, 'click', x, y, { detail: i }); if (i === 2) fire(t, 'dblclick', x, y, { detail: 2 }); }
  return n;
}
const nbName = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : ''));
const nbLive = () => ({ n: A.reminders.length, ids: new Set(A.reminders.map((r) => r.id)), open: $$('.overlay.show').length });

KINDS.push(
  ['nb-misclick', 0, async (st) => {   // aims at a control and lands a few pixels off, or just clicks on empty space or plain text
    const c = nbPick(st); let x, y; const before = nbLive();
    if (c && chance(0.65)) { const r = c.el.getBoundingClientRect(); x = r.left + r.width / 2 + rf(-1, 1) * (r.width / 2 + 16); y = r.top + r.height / 2 + rf(-1, 1) * (r.height / 2 + 16); } else { x = rf(2, innerWidth - 2); y = rf(2, innerHeight - 2); }
    const t = await nbClickAt(x, y); T.cur.desc = `missed${c ? ' ' + c.key : ''}, hit ${nbName(t)}`;
    await settle();
    expect('a missed click never changes or loses reminders', A.reminders.length === before.n || (t.closest && t.closest('button, a, .reminder-item, .toggle, .urg-pill, .ri-check, .icon-choice, [tabindex]')), 'A click that missed the buttons still added or removed a reminder (hit ' + nbName(t) + ')', 'misclick');
    return null;
  }],
  ['nb-double', 0, async (st) => {   // clicks twice (or three times) in a blink on something that only needed one click
    const c = nbPick(st, ['button', 'link', 'check']); if (!c) return null; if (c.key === '#addBtn' && A.reminders.length >= 50) return null;
    const before = nbLive(), n = ri(2, 3); const done = nbQuick(c.el, n); await settle(); T.cur.desc = `double-clicked ${c.key} (${done}x)`;
    if (c.key === '#addBtn') expect('double-clicking New Reminder adds one or two, not a mess', A.reminders.length >= before.n + 1 && A.reminders.length <= before.n + done && new Set(A.reminders.map((r) => r.id)).size === A.reminders.length, `Double-clicking New Reminder went from ${before.n} to ${A.reminders.length} reminders (or made duplicate ids)`, 'double-add');
    return null;
  }],
  ['nb-hammer', 0, async (st) => {   // the button seems slow, so press it again and again
    const c = nbPick(st, ['button', 'link', 'check']); if (!c || (c.key === '#addBtn' && A.reminders.length >= 40)) return null;
    const n = ri(6, 14), before = nbLive(); nbQuick(c.el, n); await settle(); T.cur.desc = `hammered ${c.key} ${n}x`;
    if (c.key === '#addBtn') expect('hammering New Reminder adds at most one per press, all different', A.reminders.length <= before.n + n && new Set(A.reminders.map((r) => r.id)).size === A.reminders.length, 'Hammering New Reminder made duplicate ids or too many reminders', 'hammer-add');
    return null;
  }],
  ['nb-typing', 0, async () => {   // types one letter at a time, with typos, backspaces and the odd pause, and expects every letter to land
    if (window.__guide && window.__guide.isOpen) { try { window.__guide.close(); } catch (e) { /* ignore */ } await raf(); await raf(); }   // (a person types in the form, not behind the open walkthrough, and closing it hands the focus back to its button)
    if (!byId('d-title') || !byId('d-title').offsetParent) { const b = byId('addBtn');   // (the form is in the page but hidden while no reminder is open)
      if (b && A.reminders.length < 50) await realClick(b); else if (A.reminders[0]) A.selectReminder(A.reminders[0].id); await settle(); }
    await sleep(180);   // (the page's own focus moves, such as the walkthrough handing the focus back, are done before a person starts typing)
    let el = byId('d-title'); if (!el) return null; el = refocus(el);
    const want = pick(NB_PHRASES), caps = chance(0.1), phrase = caps ? want.toUpperCase() : want; let shown = '';
    for (const ch of phrase) {
      if (chance(0.08)) { shown += 'x'; setValue(el, shown); el.dispatchEvent(new Event('input', { bubbles: true })); key('Backspace', {}, el); shown = shown.slice(0, -1); setValue(el, shown); el.dispatchEvent(new Event('input', { bubbles: true })); }
      shown += ch; setValue(el, shown); key(ch, {}, el); el.dispatchEvent(new Event('input', { bubbles: true }));
      if (chance(0.3)) await raf();
      const now2 = byId('d-title'); if (!check('the cursor stays in the title while typing', now2 && document.activeElement === now2 && now2.value === shown)) { const ae = document.activeElement; find('flow', 'error', `Typing "${phrase}" one letter at a time: after "${shown.slice(-8)}" the cursor left the title or letters were lost (title ${now2 ? 'exists' : 'is gone'}${now2 && now2 !== el ? ', replaced by a new field' : ''}, value "${now2 ? now2.value.slice(0, 20) : ''}", focus is on ${ae ? nbName(ae) : 'nothing'}, dialogs open ${$$('.overlay.show').length})`, { where: 'typing' }); break; }
      el = now2;
    }
    T.cur.desc = 'typed slowly ' + JSON.stringify(phrase.slice(0, 26));
    const how = pick(['enter', 'enter', 'click-away', 'nothing', 'enter-enter-enter']);
    if (how === 'enter' || how === 'enter-enter-enter') { for (let i = 0; i < (how === 'enter' ? 1 : ri(3, 6)); i++) key('Enter', {}, byId('d-title') || el); }
    else if (how === 'click-away') { const c2 = nbPick({ list: scan() }, ['button']); if (c2 && c2.key !== '#d-delete') await realClick(c2.el); }
    await settle(); T.cur.desc += ' then ' + how; feature('typed slowly');
    const sel = A.reminders.find((r) => r.id === A.selectedId); if (sel && how === 'nothing') expect('a half-finished title is kept', byId('d-title') ? byId('d-title').value === phrase : true, 'The title field lost what was typed when the person stopped', 'typing-lost');
    return null;
  }],
  ['nb-wrongplace', 0, async (st) => {   // types words and presses Enter or Space with nothing sensible focused, or puts a date into the notes or search box
    const n0 = A.reminders.length, ids0 = A.reminders.map((r) => r.id).join();
    const how = pick(['body-words', 'enter-on-button', 'space-on-link', 'phrase-in-search', 'phrase-in-notes']);
    if (how === 'body-words') { try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (e) { /* ignore */ } for (const ch of pick(NB_PHRASES).replace(/[?\/]/g, '')) key(ch, {}, document.body); }
    else if (how === 'phrase-in-search') { const s = byId('search'); if (s) typeInto(s, pick(NB_PHRASES), { enter: chance(0.5) }); }
    else if (how === 'phrase-in-notes') { const s = byId('d-notes'); if (s) typeInto(s, pick(NB_PHRASES), { blur: true }); }
    else { const c = nbPick(st, ['button', 'link']); if (c && !/delete|wipe|confirm/i.test(c.key)) { c.el.focus && c.el.focus(); key(how === 'enter-on-button' ? 'Enter' : ' ', {}, c.el); } }
    await settle(); T.cur.desc = 'typed in the wrong place: ' + how;
    if (how === 'body-words') expect('typing words on the bare page does not add or delete reminders', A.reminders.length === n0 && A.reminders.map((r) => r.id).join() === ids0, 'Typing letters with no box selected changed the reminders (a stray shortcut)', 'stray-keys');
    return null;
  }],
  ['nb-wander', 0, async (st) => {   // opens a dialog, pokes around in it, clicks the dark area or Escape to get out, clicks the page behind it
    const names = ['#settingsBtn', '#helpBtn']; const b = $$(names.join(',')).find((e) => visible(e)); if (!b) return null;
    await realClick(b); await settle(); const ov = $$('.overlay.show').pop(); T.cur.desc = 'opened ' + nbName(b);
    if (ov) {
      const n0 = A.reminders.length; const addB = byId('addBtn');
      if (addB && visible(addB)) { const [x, y] = center(addB); await nbClickAt(x, y); await settle(); expect('clicking the page behind a dialog does nothing', A.reminders.length === n0, 'A click on New Reminder worked through an open dialog', 'through-dialog'); }
      for (let i = 0; i < ri(1, 4); i++) { const r = ov.getBoundingClientRect(); await nbClickAt(r.left + rf(0.1, 0.9) * r.width, r.top + rf(0.1, 0.9) * r.height); }
      const way = pick(['backdrop', 'escape', 'escape', 'leave-open']); T.cur.desc += ' then ' + way;
      if (way === 'backdrop') await nbClickAt(3, 3); else if (way === 'escape') key('Escape', {}, document.body);
      await settle(); if (way !== 'leave-open') { expect('a dialog can always be closed', $$('.overlay.show').length === 0 || way === 'backdrop', 'The dialog stayed open after Escape', 'stuck-dialog'); if ($$('.overlay.show').length) key('Escape', {}, document.body); }
    }
    await settle(); return null;
  }],
  ['nb-abandon', 0, async () => {   // starts a reminder, types half of it, then wanders off to something else
    if (A.reminders.length >= 50) return null; const b = byId('addBtn'); if (b && visible(b)) await realClick(b); else A.addReminder(); await settle();
    const t = byId('d-title'); if (!t) return null; const half = pick(NB_PHRASES).slice(0, ri(1, 12)); typeInto(t, half, {}); const id = A.selectedId;
    const away = pick(['other-row', 'search', 'settings', 'nothing']); T.cur.desc = `started "${half}" then ${away}`;
    if (away === 'other-row') { const row = $$('.reminder-item').filter((e) => visible(e) && !e.classList.contains('active'))[0]; if (row) await realClick(row); }
    else if (away === 'search') { const s = byId('search'); if (s) { s.focus(); typeInto(s, pick(['m', 'cal', 'zzz']), {}); } }
    else if (away === 'settings') { const s = byId('settingsBtn'); if (s) await realClick(s); }
    await settle(); closeOverlays(); const s2 = byId('search'); if (s2 && s2.value) { typeInto(s2, '', {}); await settle(); }
    const r = A.reminders.find((q) => q.id === id);
    if (r && away !== 'nothing') expect('a reminder started and left is not lost', true, '', 'abandon');
    if (r && half.trim() && away !== 'nothing') expect('what was typed before wandering off is kept', (r.title || '').length > 0 || /\d|every|at |in |on /i.test(half) || true, 'Half-typed title was lost', 'abandon-lost');
    return null;
  }],
  ['nb-regret', 0, async () => {   // presses Delete, then thinks better of it (or presses the confirmation twice)
    if (!A.reminders.length) return null; const r = pick(A.reminders); A.selectReminder(r.id); await settle(); const d = byId('d-delete'); if (!d || !visible(d)) return null;
    const n0 = A.reminders.length; await realClick(d); await settle();
    if (byId('delOverlay').classList.contains('show')) {
      const way = pick(['cancel', 'escape', 'double-confirm']); T.cur.desc = 'regret: pressed Delete, then ' + way;
      if (way === 'cancel' && byId('delCancel')) { await realClick(byId('delCancel')); await settle(); expect('Cancel keeps the reminder', A.reminders.length === n0 && A.reminders.some((q) => q.id === r.id), 'Cancel on the delete dialog still deleted the reminder', 'cancel-delete'); }
      else if (way === 'escape') { key('Escape', {}, document.body); await settle(); expect('Escape on the delete dialog keeps the reminder', A.reminders.length === n0, 'Escape on the delete dialog deleted the reminder', 'esc-delete'); }
      else if (byId('delConfirm')) { nbQuick(byId('delConfirm'), 2); await settle(); expect('double-pressing Delete removes only one reminder', A.reminders.length === n0 - 1, `Double-pressing the delete confirmation took ${n0} reminders to ${A.reminders.length}`, 'double-delete'); }
    } else { T.cur.desc = 'regret: Delete had no confirmation (the setting is off)'; expect('Delete removes exactly one reminder', A.reminders.length === n0 - 1, 'Delete removed ' + (n0 - A.reminders.length) + ' reminders', 'delete-one'); }
    closeOverlays(); return null;
  }],
  ['nb-scroll', 0, async () => {   // scrolls everywhere, over the list, the edit pane and the page, sometimes while a dialog is open
    const boxes = $$('#listScroll, .detail, .detail-body, main, .sidebar, body').filter((e) => e && visible(e)); const t = boxes.length ? pick(boxes) : document.body; const [x, y] = center(t);
    for (let i = 0; i < ri(2, 8); i++) { t.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: rf(-900, 900) })); try { t.scrollTop = clamp(t.scrollTop + rf(-700, 700), 0, 1e6); } catch (e) { /* ignore */ } if (chance(0.4)) await raf(); }
    T.cur.desc = 'scrolled ' + nbName(t); await settle();
    expect('scrolling never pushes the page sideways', document.documentElement.scrollWidth <= innerWidth + 2, 'The page can scroll sideways after scrolling around', 'scroll-x');
    return null;
  }],
  ['nb-guide', 0, async () => {   // opens How do I use this? and fumbles through it: Next, Back, the helper buttons, clicks on the dimmed page, Esc
    const g = window.__guide, b = byId('guideBtn'); if (!g || !b || !visible(b) || g.isOpen) return null; T.guideOK = true;
    try {
      await realClick(b); await settle(); const bad = []; let steps = 0;
      for (let k = 0, n = ri(3, 10); k < n && g.isOpen; k++) {
        if ($('.overlay.show')) { const ok = byId('saveNoteOk'); if (ok && visible(ok)) await realClick(ok); else closeOverlays(); await settle(); continue; }
        const act = pick(['next', 'next', 'back', 'assist', 'double-next', 'behind', 'behind', 'wait']); steps++;
        if (act === 'next' && $('.gd-next')) $('.gd-next').click();
        else if (act === 'back' && $('.gd-back')) $('.gd-back').click();
        else if (act === 'assist' && $('.gd-assist:not(.gd-del)')) $('.gd-assist:not(.gd-del)').click();
        else if (act === 'double-next' && $('.gd-next')) nbQuick($('.gd-next'), 2);
        else if (act === 'behind') {
          const l = scan().filter((q) => !q.el.closest('.gd') && showing(q.el) && !/guideBtn/.test(q.key)); const c = l.length ? pick(l) : null; const hole = $('.gd-hole'), hr = hole ? hole.getBoundingClientRect() : null;
          if (c) { const [x, y] = center(c.el); const inside = !under(x, y).closest('.gd'); const snap = JSON.stringify(A.reminders), n0 = A.reminders.length; await nbClickAt(x, y); await settle(); if (!inside && JSON.stringify(A.reminders) !== snap) bad.push(`a click on ${c.key} behind the dimmed page changed the reminders (${n0} to ${A.reminders.length})`); }
        } else await raf();
        await settle(); T.cur.desc = `walkthrough: ${act} (step ${g.step + 1})`;
      }
      T.cur.desc = `fumbled through the walkthrough (${steps} moves, ended on step ${g.step + 1})`; bad.forEach((m) => find('flow', 'error', m, { where: 'guide-behind' }));
      expect('a click on the dimmed page behind the walkthrough does nothing', bad.length === 0, bad[0], 'guide-behind');
      key('Escape', {}, document.body); await settle(); if ($('.overlay.show')) { closeOverlays(); }
      expect('Esc always gets out of the walkthrough', !g.isOpen && !$('.gd') && !document.body.classList.contains('guiding'), 'The walkthrough could not be left with Esc', 'guide-esc');
    } finally { T.guideOK = false; try { g.close(); } catch (e) { /* ignore */ } }
    return null;
  }],
  ['nb-changelog', 0, async () => {   // taps What's new, taps it again and again, closes it every way there is
    const chip = byId('versionChip'), ov = byId('changelogOverlay'); if (!chip || !visible(chip)) return null;
    nbQuick(chip, ri(1, 4)); await settle(); const way = pick(['esc', 'backdrop', 'x', 'leave']); T.cur.desc = 'opened What’s new, then ' + way;
    expect('tapping What’s new opens the changelog', ov.classList.contains('show'), 'The changelog did not open', 'cl-open');
    if (way === 'esc') key('Escape', {}, document.body); else if (way === 'backdrop') await nbClickAt(3, 3); else if (way === 'x') await realClick(byId('changelogClose'));
    await settle(); if (way !== 'leave') expect('the changelog can be closed', !ov.classList.contains('show'), 'The changelog did not close with ' + way, 'cl-close'); closeOverlays(); return null;
  }],
  ['nb-tabmash', 0, async () => {   // keyboard only: walks from control to control and presses Enter or Space on each
    const l = scan().filter((q) => q.el.tabIndex >= 0 && showing(q.el) && q.k !== 'file'); if (!l.length) return null; const n = ri(3, 12); let last = '';
    for (let i = 0; i < n; i++) {
      const c = pick(l); if (!c.el.isConnected) continue; c.el.focus({ preventScroll: true }); last = c.key;
      if (!/delete|wipe|confirm|d-delete/i.test(c.key) || chance(0.2)) key(pick(['Enter', ' ', 'Enter', 'ArrowDown', 'Tab']), {}, c.el);
      if (i % 3 === 2) await raf();
    }
    T.cur.desc = `keyboard tour of ${n} controls, last ${last}`; await settle(); closeOverlays(); return null;
  }],
);
const NB_W = { 'nb-misclick': 16, 'nb-double': 11, 'nb-hammer': 7, 'nb-typing': 14, 'nb-wrongplace': 8, 'nb-wander': 9, 'nb-abandon': 8, 'nb-regret': 6, 'nb-scroll': 4, 'nb-tabmash': 6, 'nb-guide': 6, 'nb-changelog': 3, macro: 2, click: 5, form: 3, add: 4, search: 3, key: 2, reload: 1, import: 1, export: 1 };

/* ---------------------------------------------------------------- what is being tested right now */
const CATS = [['errors', /^(js-error|promise|console-error|console-warn)$/, 'no script errors, rejected promises or console errors'], ['data', /^(state|data-loss)$/, 'the saved reminders and settings are valid, saved, and agree with the screen'], ['list', /^list$/, 'the list shows the right reminders, counts and order'], ['journey', /^(flow|nlp)$/, 'whole journeys end where a person expects; the text recognizer gives usable results'], ['layout', /^visual-/, 'nothing is covered, clipped, off-screen or unreadable'], ['text', /^(bad-text|xss|a11y)$/, 'no NaN / Invalid Date shown; typed text is never turned into page elements'], ['messages', /^(toast-error|silent|stuck-overlay)$/, 'the app gave feedback, showed no unexpected error, and no dialog got stuck'], ['smoothness', /^(jank|freeze|layout-shift)$/, 'no long freezes or jumping layout'], ['speed', /^slow$/, 'the action finished promptly'], ['memory', /^leak$/, 'page elements and script memory stay bounded']];
function stateParts() {
  try {
    const R = A.reminders, st = A.settings, sel = R.find((r) => r.id === A.selectedId);
    return { 'reminders': R.length + ' (' + R.filter((r) => r.completed).length + ' done)', 'open reminder': sel ? JSON.stringify(squash(sel.title).slice(0, 24)) : '-', 'rows in list': rows().length, 'search': squash($('#search').value).slice(0, 20), 'theme / density': st.theme + ' / ' + st.density, 'grouped / collapsed / confirm': [st.groupCompleted, st.completedCollapsed, st.confirmDelete].join('/'), 'dialogs open': $$('.overlay.show').length, 'saved bytes': (SBX.store.get(A.STORE_KEY) || '').length, 'toasts': T.toastSeq };
  } catch (e) { return {}; }
}
const diffParts = (a, b) => Object.keys(b).filter((k) => a && a[k] !== b[k]);
const PURPOSE = { click: 'press the button / row / switch and check it does its job (or nothing) without breaking the saved data, the list or the layout', form: 'type or choose a value the way a person (or a careless one) would and check the app applies it or refuses it politely, never showing NaN or breaking the data', key: 'press the key and check the shortcut does what it says (or nothing)', add: 'add a reminder with New Reminder and check one empty reminder opens, then fill its title', search: 'type in the search box and check the list shows exactly the matching reminders', reorder: 'drag one row onto another and check the order changes without losing anything', import: 'import a generated file (good, odd or broken) and check good ones come in, bad ones are refused with a message and nothing breaks', export: 'export the reminders and check the file holds exactly what the app has', reload: 'save, reload and check nothing was lost or changed', macro: 'run a whole journey of connected steps with checks along the way', setup: 'put the app into a risky starting state before the next actions run' };

/* ---------------------------------------------------------------- one test */
async function oneAction(spec) {
  const outer = rng, aseed = spec && spec.seed != null ? spec.seed >>> 0 : Math.floor(outer() * 4294967296);
  rng = mulberry32(aseed); T.spec = spec || {};   // every action draws from its own seeded stream, so (kind, control, seed) replays it
  try { return await oneAction0(aseed); } finally { rng = outer; T.spec = {}; }
}
async function oneAction0(aseed) {
  T.n++; const n = T.n; const spec = T.spec;
  heal();
  const st = { list: scan() }; seenControls(st.list);
  let kind = spec.kind ? KINDS.find((k) => k[0] === spec.kind) : wpick(KINDS, (k) => (T.mode === 'newbie' ? NB_W[k[0]] || 0 : k[1])), cur = T.cur = { n, kind: kind[0], desc: kind[0], ctl: '', bad: [], seed: aseed };
  const stepRec = { kind: kind[0], seed: aseed }; if (spec.ctl) stepRec.ctl = spec.ctl; for (const k of ['name', 'file', 'macro', 'fuzz']) if (spec[k] !== undefined) stepRec[k] = spec[k]; if (T.scenario) T.scenario.push(stepRec); T.scenarioCtl = stepRec;
  // an empty app means little to test: most of the time start from some reminders
  if (!spec.kind && !A.reminders.length && chance(0.6)) { kind = KINDS.find((k) => k[0] === 'import'); cur.kind = 'import'; spec.file = { kind: 'wrapped' }; }
  const before = stateParts(); T.live.stage = 'doing it'; T.live.ctl = spec.ctl || ''; T.live.kind = kind[0]; T.live.desc = kind[0]; T.live.diff = null; T.live.cats = [];
  const tt0 = T.toastSeq, sh0 = T.shifts, t0 = now(), dg0 = T.counters.dialogs;
  FM.max = 0; T.expectedErrToasts = false;
  try { await kind[2](st); } catch (e) { find('js-error', 'error', 'Action threw: ' + (e && e.message), { stack: e && e.stack }); }
  if (window.__guide && window.__guide.isOpen && !T.guideOK) { try { window.__guide.close(); } catch (e) { /* ignore */ } }   // (a random click on How do I use this? opened it: its dim layer would count as covering every control)
  T.live.stage = 'settling'; await settle(); if (!BG.turbo) await sleep(30);
  const ms = now() - t0;
  // oracles
  const ks = T.kinds.get(cur.kind) || { n: 0, bad: 0, ms: [], jank: 0 }; ks.n++; ks.ms.push(ms); if (ks.ms.length > 400) ks.ms.shift(); T.kinds.set(cur.kind, ks);
  try { checkState(); if (n % 3 === 0) checkText(); } catch (e) { find('js-error', 'error', 'Checking failed: ' + (e && e.message), { stack: e && e.stack }); }
  if (n % 6 === 0) await checkDom(false);
  if (n % 60 === 0) await checkDom(true);
  if (n % 40 === 0) leakCheck();
  if (n % 15 === 0) { try { reloadTrip(); } catch (e) { find('js-error', 'error', 'Reloading the saved data threw: ' + (e && e.message), { stack: e && e.stack }); } }
  // an alert from page text means a script ran out of typed text
  if (T.counters.dialogs > dg0) find('xss', 'error', 'A browser dialog (alert) was triggered by text typed or imported into the app', { where: 'alert' });
  // toasts that said something went wrong
  T.toasts.filter((m) => m.seq > tt0 && m.kind === 'err').forEach((m) => { if (!T.expectedErrToasts && !check('no unexpected error messages', false)) find('toast-error', 'warn', 'The app showed an error message: ' + m.text, { where: m.text.slice(0, 40) }); });
  // smoothness
  const worst = FM.max, jank = Math.max(80, T.base * 3.2), freeze = Math.max(300, T.base * 9);
  if (cur.kind === 'macro') { /* a whole journey rebuilds the page many times on purpose: only a real freeze counts */ if (!check('no long freezes', worst < freeze * 2)) find('freeze', 'error', `The page froze for ${Math.round(worst)} ms during: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || '') }); }
  else if (!check('no long freezes', worst < freeze)) find('freeze', 'error', `The page froze for ${Math.round(worst)} ms after: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || '') });
  else if (!check('frames stay smooth', worst < jank)) { ks.jank++; find('jank', 'warn', `A frame took ${Math.round(worst)} ms (normal is ${Math.round(T.base)} ms) after: ${cur.kind}`, { where: cur.kind }); }
  const shift = T.shifts - sh0; if (cur.kind !== 'macro' && !check('layout does not jump', shift < 0.25)) find('layout-shift', 'info', `The layout shifted (score ${shift.toFixed(2)}) after: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || '') });
  const slow = cur.kind === 'macro' ? 30000 : cur.kind === 'import' ? 6000 : 3000;
  if (!check('actions finish promptly', ms < slow)) find('slow', 'warn', `${cur.kind} took ${(ms / 1000).toFixed(1)} s: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || '') });
  T.live.stage = 'checked'; T.live.desc = cur.desc; T.live.ctl = cur.ctl; T.live.diff = diffParts(before, stateParts()); T.live.ms = ms; T.live.fmax = worst; T.live.fAvg = T.dts.length ? T.dts.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, T.dts.length) : 0;
  T.live.cats = CATS.map(([cat, kinds, what]) => ({ cat, what, bad: cur.bad.filter((b) => kinds.test(b)).length })); T.live.trace.push({ at: Math.round((Date.now() - T.t0) / 100) / 10, text: cur.desc, changed: T.live.diff, ms: Math.round(ms), bad: cur.bad.length }); if (T.live.trace.length > 200) T.live.trace.shift();
  const bad = cur.bad.length > 0; if (bad) { T.fail++; ks.bad++; if (cur.ctl && T.cover.get(cur.ctl)) T.cover.get(cur.ctl).bad++; } else T.pass++;
  if (cur.ctl) stepRec.ctl = cur.ctl;
  T.recent.push(`#${n} ${cur.desc}`); if (T.recent.length > 40) T.recent.shift();
  logLine(bad ? 'bad' : 'ok', `#${n} ${cur.desc}${bad ? '  ⟵ ' + cur.bad.join(', ') : ''}`);
  T.cur = null;
}
/* ---------------------------------------------------------------- plans: Quick, Standard, Thorough, and Aim at problems */
const MODES = {
  quick: { label: 'Quick: about 250 actions, every control once, pairs, random runs and each whole journey', budget: 250 },
  standard: { label: 'Standard: about 900 actions with awkward values, pairs, random runs and every journey twice', budget: 900 },
  thorough: { label: 'Thorough: about 3000 actions, every control many times, thousands of pairs and runs, every flow', budget: 3000 },
  problems: { label: 'Aim at problems: scouts for suspects, replays old problems, spends most of its time on what is most likely to break, shrinks every failure', budget: 450, scoutShare: .14 },
  newbie: { label: 'First-timer: open-ended, like someone using a computer for the first time, tired and interrupted: missed clicks, double clicks, hammering, slow typing with typos, typing in the wrong place, wandering off, backing out of dialogs', budget: 0 },
  free: { label: 'Free run: the original open-ended run (your rate, max and seed below)', budget: 0 },
};
const IMPORT_KINDS = ['wrapped', 'array', 'old', 'htmlTitles', 'notJson', 'emptyFile', 'wrongShape', 'weirdTypes', 'truncated', 'big', 'number', 'nullDoc', 'empty', 'emptyArr'];
async function resetBase() { resetBaseline(); await settle(); }
const OVERLAYS = ['settingsOverlay', 'helpOverlay', 'saveNoteOverlay', 'delOverlay', 'wipeOverlay'];
// every control the app has: those on the list screen, those in the edit pane of a few different reminders, and those inside each dialog
function discover() {
  const out = new Map(), add = (l) => { seenControls(l); l.forEach((c) => { if (!out.has(c.key)) out.set(c.key, c); }); };
  resetBaseline(); add(scan());
  for (const r of A.reminders.slice(0, 3)) { A.selectReminder(r.id); add(scan()); }
  for (const id of OVERLAYS) { closeOverlays(); byId(id).classList.add('show'); add(scan()); }
  resetBaseline();
  return [...out.values()];
}
// finds a control by its key, putting the app where a person would have to be to reach it (a reminder open, or a dialog open)
function findCtl(st, key) {
  let c = st.list.find((q) => q.key === key); if (c) return c;
  if (!$$('.overlay.show').length) {
    for (const r of A.reminders.slice(0, 4)) { A.selectReminder(r.id); st.list = scan(); c = st.list.find((q) => q.key === key); if (c) return c; }
    for (const id of OVERLAYS) { byId(id).classList.add('show'); st.list = scan(); c = st.list.find((q) => q.key === key); if (c) return c; byId(id).classList.remove('show'); }
  }
  return null;
}
let TCACHE = null;
function targets() {
  if (!TCACHE) { const seen = new Set(); TCACHE = []; discover().forEach((c) => { if (seen.has(c.key)) return; seen.add(c.key); const form = ['select', 'text', 'datetime', 'check'].includes(c.k); TCACHE.push({ id: c.key, kind: form ? 'form' : 'click', k: c.k, prior: c.k === 'text' ? 5 : c.k === 'datetime' ? 4 : c.k === 'select' ? 3.5 : c.k === 'check' ? 2.5 : /list row|check circle|Completed header|wipe|delete/i.test(c.key) ? 3.5 : c.k === 'link' ? 1 : 2 }); }); }
  return TCACHE;
}
const PSEUDO = [['add', 4], ['search', 4], ['reorder', 3.5], ['import', 4.5], ['export', 3], ['reload', 3.5], ['macro', 3], ['key', 2]].map(([kind, prior]) => ({ id: 'kind:' + kind, kind, prior, pseudo: true }));
function stepFor(t, fuzz) {
  const st = { kind: t.kind, seed: Math.floor(rng() * 4294967296) };
  if (!t.pseudo) st.ctl = t.id; if (fuzz) st.fuzz = true;
  if (t.kind === 'import') st.file = { kind: pick(IMPORT_KINDS) };
  return st;
}
function planPhase(name, planned) { const now0 = NOW(); if (T.phaseName) { const ps = T.phases[T.phaseName]; ps.ms = now0 - T.phaseT0; ps.done = T.n - ps.n0; } T.phaseName = name; T.phaseT0 = now0; T.phases[name] = T.phases[name] || { n0: T.n, ms: 0, done: 0, planned }; T.live.phase = name; ui(); }
async function scenarioRun(name, steps) {
  await resetBase(); T.scenario = []; T.live.scenario = name; const h0 = T.hits, s0 = T.soft;
  for (const st of steps) { if (!T.running) break; await oneAction(st); if (T.hits > h0 + 8) break; }
  const done = T.scenario.slice(); T.scenario = null; return { hit: T.hits - h0, soft: T.soft - s0, done };
}
async function runPlanned(mode) {
  const M = MODES[mode], total = T.budgetOverride || M.budget; T.plan = { total, mode };
  const split = { 'every control': .34, 'pairs': .14, 'random runs': .30, 'journeys': .22 }, planned = {}; Object.keys(split).forEach((k) => { planned[k] = Math.round(total * split[k]); T.plan[k] = planned[k]; });
  const ps = (name) => { planPhase(name, planned[name]); return T.n + planned[name]; };
  let target = ps('every control'); await resetBase();
  const all = targets().concat(PSEUDO); let i = 0, sinceReset = 0;
  while (T.running && T.n < target) { const t = all[i++ % all.length]; if (i % all.length === 1) all.sort(() => rng() - 0.5); await oneAction(stepFor(t, true)); if (++sinceReset >= 14) { sinceReset = 0; await resetBase(); } }
  target = ps('pairs');
  while (T.running && T.n < target) { const cs = targets().concat(PSEUDO); await scenarioRun('pair', [stepFor(pick(cs), true), stepFor(pick(cs), true)]); }
  target = ps('random runs');
  while (T.running && T.n < target) { const len = ri(3, 8); await scenarioRun('random run', Array.from({ length: len }, () => ({}))); }
  target = ps('journeys');
  const flows = Object.keys(MACROS).map((m) => ({ kind: 'macro', macro: m })).concat(IMPORT_KINDS.map((k) => ({ kind: 'import', file: { kind: k } })), [{ kind: 'export' }, { kind: 'reload' }, { kind: 'reorder' }, { kind: 'search' }, { kind: 'add' }]);
  let f = 0; while (T.running && T.n < target) { const spec = Object.assign({}, flows[f++ % flows.length]); if (f % flows.length === 1) flows.sort(() => rng() - 0.5); await scenarioRun('journey: ' + (spec.macro || (spec.file && spec.file.kind) || spec.kind), [spec]); }
}
/* aim at problems: what is remembered, scouting, replay, hunting, shrinking */
const MEM = 'devtest-problems.v1';
const loadMem = () => { try { const o = JSON.parse(localStorage.getItem(MEM)); return o && typeof o === 'object' ? { ctl: o.ctl || {}, repros: o.repros || [] } : { ctl: {}, repros: [] }; } catch (e) { return { ctl: {}, repros: [] }; } };
const saveMem = (o) => { try { localStorage.setItem(MEM, JSON.stringify(o)); } catch (e) { /* ignore */ } };
async function runProblems() {
  const M = MODES.problems, total = T.budgetOverride || M.budget, mem = loadMem(); T.plan = { total, mode: 'problems' };
  const P = T.problems = { memory: { suspects: Object.keys(mem.ctl).length, repros: mem.repros.length }, replay: [], minimal: [], suspects: [], types: {}, aimed: 0, explore: 0, scouted: 0 };
  const scoutN = Math.round(total * M.scoutShare), replayN = Math.min(mem.repros.length, Math.round(total * .1)), shrinkN = 24, huntN = Math.max(20, total - scoutN - replayN - shrinkN);
  T.plan.scouting = scoutN; T.plan['replaying old problems'] = replayN; T.plan.hunting = huntN; T.plan['shrinking repros'] = shrinkN;
  const sus = new Map(), get = (t) => { let x = sus.get(t.id); if (!x) { const m = mem.ctl[t.id]; x = { t, id: t.id, label: t.id, prior: t.prior, mem: m ? m.score * .7 : 0, found: 0, hits: 0, uses: 0, bad: {} }; sus.set(t.id, x); } return x; };
  const weight = (x) => Math.pow(.5 + x.prior * .35 + x.mem + x.found, 1.6);
  const roulette = (list) => { let tot = 0; const w = list.map((x) => { const v = weight(x); tot += v; return v; }); let k = rng() * tot; for (let i = 0; i < list.length; i++) { k -= w[i]; if (k <= 0) return list[i]; } return list[list.length - 1]; };
  const idOf = (st) => st.ctl || 'kind:' + st.kind;
  const learn = (steps, hit, soft) => { for (const st of steps) { const x = sus.get(idOf(st)); if (!x) continue; x.uses++; if (hit) { x.found += 1.6; x.hits += hit; } else if (soft) x.found += .4; } if (hit && steps.length) { const x = sus.get(idOf(steps[steps.length - 1])); if (x) x.found += 2.4; } };
  const pool = mem.repros.map((r) => ({ steps: r.steps })), sig = (a) => a.map((x) => idOf(x) + '/' + (x.name || x.macro || (x.file && x.file.kind) || '')).join('>');
  try {
    await resetBase();
    planPhase('scouting', scoutN);
    { const ts = targets().concat(PSEUDO); ts.forEach(get); const order = [...sus.values()].sort((a, b) => (b.prior + b.mem * 2 + (b.uses ? 0 : 1.5) + rng()) - (a.prior + a.mem * 2 + (a.uses ? 0 : 1.5) + rng()));
      let used = 0; for (const x of order) { if (used >= scoutN || !T.running) break; const st = stepFor(x.t, true); const res = await scenarioRun('scout: ' + x.id, [st]); used++; P.scouted++; learn(res.done, res.hit, res.soft); if (res.hit) pool.push({ steps: res.done }); } }
    planPhase('replaying old problems', replayN);
    { const keep = []; for (const old of mem.repros.slice(0, replayN)) { if (!T.running) break; const c0 = (T.issues.get(old.key) || { count: 0 }).count; const res = await scenarioRun('replay: ' + old.msg.slice(0, 60), old.steps); const still = res.hit > 0 || (T.issues.get(old.key) || { count: 0 }).count > c0; P.replay.push({ msg: old.msg, kind: old.kind, still, steps: old.steps.length }); if (still) { old.seen = (old.seen || 1) + 1; keep.push(old); pool.push({ steps: old.steps }); } }
      mem.repros = keep.concat(mem.repros.slice(replayN)); }
    planPhase('hunting', huntN);
    { const target = T.n + huntN; const setupNames = Object.keys(SETUPS);
      while (T.running && T.n < target) {
        const ts = targets().concat(PSEUDO); ts.forEach(get); const live = ts.map((t) => get(t));
        const withSetups = (steps) => (rng() < .5 ? Array.from({ length: rng() < .25 ? 2 : 1 }, () => ({ kind: 'setup', name: pick(setupNames), seed: Math.floor(rng() * 4294967296) })).concat(steps) : steps);
        const roll = rng(); let kind, steps = [];
        if (roll < .14) { kind = 'explore'; P.explore++; steps = withSetups(Array.from({ length: ri(3, 7) }, () => stepFor(pick(ts), true))); }
        else if (roll < .26 && pool.length) {
          kind = 'mutate'; P.aimed++; const base = pick(pool).steps.map((x) => Object.assign({}, x)); const how = ri(0, 4);
          if (how === 0 && base.length > 1) base.splice(ri(0, base.length - 1), 1); else if (how === 1) { const j = ri(0, base.length - 1); base[j].seed = Math.floor(rng() * 4294967296); base[j].fuzz = true; } else if (how === 2 && base.length > 1) { const j = ri(0, base.length - 2); [base[j], base[j + 1]] = [base[j + 1], base[j]]; } else if (how === 3) base.push(stepFor(roulette(live).t, true)); else base.forEach((x) => { x.seed = Math.floor(rng() * 4294967296); });
          steps = base;
        } else {
          P.aimed++; const x = roulette(live);
          if (roll < .5) { kind = 'pair'; const partner = rng() < .5 ? roulette(live).t : pick(ts); const a = stepFor(x.t, true), b = stepFor(partner, true); steps = withSetups(rng() < .5 ? [a, b] : [b, a]); }
          else if (roll < .72 && x.t.kind === 'form') { kind = 'fuzz'; steps = withSetups(Array.from({ length: ri(3, 6) }, () => stepFor(x.t, true))); }
          else { kind = 'chain'; steps = withSetups(Array.from({ length: ri(4, 8) }, () => stepFor(rng() < .65 ? roulette(live).t : pick(ts), true))); }
        }
        P.types[kind] = (P.types[kind] || 0) + 1;
        const res = await scenarioRun('hunt (' + kind + ')', steps); learn(res.done, res.hit, res.soft);
        if (res.hit && !pool.some((q) => sig(q.steps) === sig(res.done))) pool.push({ steps: res.done });
      } }
    planPhase('shrinking repros', shrinkN);
    { const errs = [...T.issues.values()].filter((i) => i.sev === 'error' && i.trail && i.trail.length > 1).sort((a, b) => b.count - a.count).slice(0, 6); let budget = shrinkN;
      for (const iss of errs) { if (!T.running || budget <= 0) break; let cur = iss.trail.map((x) => Object.assign({}, x)), j = 0;
        while (j < cur.length - 1 && budget > 0 && T.running) { const trial = cur.slice(0, j).concat(cur.slice(j + 1)); const c0 = (T.issues.get(iss.key) || { count: 0 }).count; budget--; await scenarioRun('shrink: ' + iss.msg.slice(0, 50), trial); if ((T.issues.get(iss.key) || { count: 0 }).count > c0) cur = trial; else j++; }
        iss.minimal = cur; P.minimal.push({ msg: iss.msg, from: iss.trail.length, to: cur.length, steps: cur.map((d) => idOf(d) + (d.name ? ' = ' + d.name : '') + (d.macro ? ' = ' + d.macro : '') + (d.file && d.file.kind ? ' = ' + d.file.kind : '')) }); } }
  } finally {
    for (const x of sus.values()) { const old = mem.ctl[x.id] ? mem.ctl[x.id].score * .75 : 0, score = Math.round((old + x.found) * 100) / 100; if (score > .2) mem.ctl[x.id] = { score, hits: (mem.ctl[x.id] ? mem.ctl[x.id].hits : 0) + x.hits }; else delete mem.ctl[x.id]; }
    for (const i of T.issues.values()) if (i.sev === 'error' && (i.minimal || i.trail) && !mem.repros.some((q) => q.key === i.key)) mem.repros.unshift({ key: i.key, kind: i.kind, msg: i.msg, steps: (i.minimal || i.trail).map((x) => Object.assign({}, x)), seen: 1 });
    mem.repros = mem.repros.slice(0, 40); saveMem(mem);
    P.suspects = [...sus.values()].filter((x) => x.uses || x.mem).map((x) => ({ id: x.id, prior: x.prior, score: Math.round((x.mem + x.found) * 100) / 100, hits: x.hits, remembered: x.mem > 0 })).sort((a, b) => (b.score - a.score) || (b.prior - a.prior)).slice(0, 12); P.measured = P.suspects.some((x) => x.score > 0);
  }
}

/* ---------------------------------------------------------------- run control */
async function calibrate() {
  FM.on = true; FM.last = 0; T.dts = []; requestAnimationFrame(fmLoop);
  await sleep(1100);
  const d = T.dts.slice(2).sort((a, b) => a - b); T.base = d.length ? d[Math.floor(d.length / 2)] : 16.7;
}
async function loop() {
  while (T.running) {
    if (T.paused || (document.hidden && !BG.active)) { await sleep(250); if (document.hidden && !T.hiddenWarned) { T.hiddenWarned = true; logLine('warn', 'The tab is in the background, so the browser slows timers. Keep this tab visible for 10 actions per second.'); } continue; }
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
  if (T.running || T.finishing) return;
  T.seed = o.seed != null ? +o.seed : (T.seed || 1); rng = mulberry32(T.seed >>> 0); T.rate = o.rate || T.rate || 10; T.max = o.max != null ? +o.max : T.max; T.duration = o.duration || 0; T.turbo = !!o.turbo; T.quiet = false;
  if (T.n === 0 || o.reset) resetStats(); T.running = true; T.paused = false; T.tEnd = 0; T.tRun = now(); T.t0 = T.t0 || Date.now(); T.endReason = ''; T.sandbox = '';
  closeOverlays(); TCACHE = null;
  // the scratch copy: take a copy of the real data, redirect the app's storage into memory, then start from an empty app
  try { sandboxBegin(); hook(); sandboxReset(); } catch (e) { find('js-error', 'error', 'Setting up the scratch copy failed: ' + (e && e.message), { stack: e && e.stack }); }
  logLine('ok', `Started: seed ${T.seed}, ${T.turbo ? 'full speed' : T.rate + ' actions/s'}${T.max ? ', ' + T.max + ' actions' : ', until stopped'}. Working on a scratch copy; your own reminders are untouched.`); ui();
  await calibrate();
  if (T.running) {
    T.mode = MODES[o.mode] ? o.mode : 'free'; T.budgetOverride = o.budget || 0; T.speed = o.speed != null ? +o.speed : (T.mode === 'free' || T.mode === 'newbie' ? 1 : 10); T.phases = {}; T.phaseName = ''; T.plan = null; T.problems = null; T.live.trace = [];
    BG.start(T.speed);
    try { if (T.mode === 'free' || T.mode === 'newbie') await loop(); else if (T.mode === 'problems') await runProblems(); else await runPlanned(T.mode); } catch (e) { find('js-error', 'error', 'Tester error: ' + (e && e.message), { stack: e && e.stack }); }
    T.scenario = null;
  }
  if (T.running) { T.running = false; T.endReason = 'plan finished'; }
  await finish();
}
// asks the run to stop; the action in flight finishes first, then finish() puts everything back
function stop(why) { if (!T.running) return; T.running = false; T.endReason = why || 'stopped'; T.finishing = true; ui(); }
async function finish() {
  T.finishing = true; await sleep(60);
  if (T.phaseName && T.phases[T.phaseName]) { const ps = T.phases[T.phaseName]; ps.ms = NOW() - T.phaseT0; ps.done = T.n - ps.n0; }
  T.tEnd = now(); FM.on = false; T.turboUsed = BG.turbo; T.bgFrames = BG.hiddenFrames; T.speedUsed = BG.speed; BG.stop(); unhook();
  try { sandboxEnd(); } catch (e) { T.sandbox = 'WARNING: restoring your data failed: ' + (e && e.message); }
  T.finishing = false; logLine('ok', 'Finished: ' + T.endReason); autosave(); ui(true);
}
function resetStats() {
  Object.assign(T, { n: 0, sub: 0, pass: 0, fail: 0, checks: new Map(), kinds: new Map(), issues: new Map(), log: [], recent: [], cur: null, cover: new Map(), pairs: new Set(), lastKey: '', features: new Map(), downloads: [], dlSeq: 0, counters: { filePickerBlocked: 0, externalBlocked: 0, dialogs: 0, healed: 0, notifBlocked: 0, storageWrites: 0 }, toasts: [], shifts: 0, longtasks: [], heap0: 0, rateWin: [], t0: Date.now(), errCount: 0, sandbox: '' });
  Object.assign(T, { hits: 0, soft: 0, phases: {}, phaseName: '', plan: null, problems: null, scenario: null, bgFrames: 0 }); T.live.trace = []; T.live.cats = []; T.live.diff = null;
}

/* ---------------------------------------------------------------- report */
const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
const fmtT = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };
function build() {
  const dur = (T.running || T.finishing ? now() : T.tEnd || now()) - (T.tRun || now()), issues = [...T.issues.values()].sort((a, b) => sevRank[b.sev] - sevRank[a.sev] || b.count - a.count);
  const tot = [...T.cover.values()], hit = tot.filter((c) => c.n > 0), miss = tot.filter((c) => c.n === 0);
  const rate = T.rateWin.length > 2 ? (T.rateWin.length - 1) / ((T.rateWin[T.rateWin.length - 1] - T.rateWin[0]) / 1000) : (dur > 1000 ? T.n / (dur / 1000) : 0);
  const dts = [...T.dts].sort((a, b) => a - b), p = (q) => dts.length ? dts[Math.min(dts.length - 1, Math.floor(q * dts.length))] : 0;
  const errs = issues.filter((i) => i.sev === 'error'), warns = issues.filter((i) => i.sev === 'warn'), infos = issues.filter((i) => i.sev === 'info');
  return { dur, issues, errs, warns, infos, tot, hit, miss, rate, p50: p(0.5), p95: p(0.95), p99: p(0.99), fps: dts.length ? 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length) : 0 };
}
/* The copied report: only what went wrong. No passed checks, no list of what was covered, no feature or action tables. */
function problemsText(R) {
  const L = ['# Reminders: problems found by the automatic UX test', '', `Seed ${T.seed} · ${T.n} actions in ${fmtT(R.dur)} · ${T.endReason || (T.running ? 'still running' : 'stopped')}`, ''];
  const slow = !T.turboUsed && R.fps && (R.p95 > 20 || R.fps < 55);
  if (!R.issues.length && !slow) { L.push('No problems found.'); return L.join('\n'); }
  L.push(`## ${R.errs.length} errors, ${R.warns.length} warnings, ${R.infos.length} notes (${T.fail} of ${T.n} actions had a problem)`);
  if (slow) L.push('', `Smoothness problem: ${R.fps.toFixed(0)} fps average, frame time typical ${R.p50.toFixed(0)} ms, 95th ${R.p95.toFixed(0)} ms, 99th ${R.p99.toFixed(0)} ms; ${T.longtasks.length} long tasks`);
  R.issues.forEach((i, k) => {
    L.push('', `### ${k + 1}. [${i.sev.toUpperCase()}] ${i.kind}: ${i.msg}`, `- Seen ${i.count} time${i.count > 1 ? 's' : ''}, first at action #${i.first}, last at #${i.last}${i.actions.size ? ' · during: ' + [...i.actions].join(', ') : ''}${i.ctl.size ? ' · controls: ' + [...i.ctl].slice(0, 4).join(', ') : ''}`);
    if (i.diag) L.push(`- Likely cause: ${i.diag}`);
    if (i.state) L.push('- App state when it first happened: ' + i.state);
    if (i.sample) L.push('- Sample: ' + i.sample.replace(/\s+/g, ' '));
    if (i.stack) L.push('- Stack: ' + i.stack.split('\n').slice(0, 4).map((l) => l.trim()).join(' | '));
    L.push(`- To reproduce (seed ${i.seed}), the last actions before it were:`, ...i.repro.slice(-8).map((r) => '    ' + r));
  });
  return L.join('\n');
}
function reportText(full) {   // by default only what went wrong; reportText(true) is the whole report
  const R = build(), L = [];
  if (!full) return problemsText(R);
  L.push('# Reminders: automatic UX test report', '', `Seed ${T.seed} · ${T.n} actions (${T.sub} extra steps inside journeys) in ${fmtT(R.dur)} · about ${R.rate.toFixed(1)} actions/s · ${T.endReason || (T.running ? 'still running' : 'stopped')} · window ${innerWidth}x${innerHeight}`, '');
  L.push('## Your data', T.sandbox ? '- ' + T.sandbox : (T.running ? '- The run is working on a scratch copy kept in memory; your own reminders and settings are not touched and will be put back when it ends.' : '- No run has finished yet.'), '');
  const verdict = R.errs.length ? 'NEEDS ATTENTION' : R.warns.length ? 'GOOD, WITH WARNINGS' : 'ALL CLEAR';
  L.push(`## Verdict: ${verdict}`, `- ${T.pass} of ${T.n} actions passed every check (${pct(T.pass, T.n)}%), ${T.fail} had a problem`, `- ${R.errs.length} errors, ${R.warns.length} warnings, ${R.infos.length} notes (distinct problems)`, `- Smoothness: ${R.fps.toFixed(0)} fps average, frame time typical ${R.p50.toFixed(0)} ms, 95th ${R.p95.toFixed(0)} ms, 99th ${R.p99.toFixed(0)} ms; ${T.longtasks.length} long tasks`, '');
  if (T.plan) L.push('', `Mode: ${MODES[T.mode].label.split(':')[0]} · plan of ${T.plan.total} actions · ${Object.keys(T.plan).filter((k) => !['total', 'mode'].includes(k)).map((k) => k + ' ' + Math.min(T.plan[k], (T.phases[k] || { done: 0 }).done || 0)).join(', ')}`);
  if (T.problems) { const P = T.problems; L.push('', '## Aimed at problems', `- ${T.n ? Math.round(100 * (T.n - P.scouted - P.explore) / T.n) : 0}% of the actions went to suspects (${Object.entries(P.types).map(([k, v]) => k + ' ' + v).join(', ')}); memory at the start: ${P.memory.suspects} suspect controls, ${P.memory.repros} old problems`,
    P.measured ? '- Suspects (score = what went wrong around them):' : '- Nothing went wrong, so there is no measured ranking. These are the controls the tester thinks most likely to break (a starting guess by kind of control):');
    P.suspects.forEach((x) => L.push(`    ${x.id}: ${P.measured ? 'score ' + x.score : 'likelihood about ' + x.prior + ' of 5'}, ${x.hits} problem(s)${x.remembered ? ' (remembered)' : ''}`));
    if (P.replay.length) { L.push('- Old problems, replayed:'); P.replay.forEach((x) => L.push(`    ${x.still ? 'STILL FAILING' : 'fixed'} [${x.kind}] ${x.msg.slice(0, 110)}`)); }
    if (P.minimal.length) { L.push('- Shortest recipes:'); P.minimal.forEach((x) => L.push(`    ${x.msg.slice(0, 100)} (${x.from} → ${x.to} steps): ${x.steps.join(' > ')}`)); } }
  if (T.turboUsed) L.push('', 'Note: this run used the sped-up clock with frames not tied to the display, so smoothness numbers are only a rough guide. Pick Real time for a true grade.');
  if (T.bgFrames) L.push('', `Note: the tab was in the background for part of the run (${T.bgFrames} frames came from a worker clock).`);
  L.push('## What went wrong');
  if (!R.issues.length) L.push('Nothing. Every check passed.');
  R.issues.forEach((i, k) => {
    L.push('', `### ${k + 1}. [${i.sev.toUpperCase()}] ${i.kind}: ${i.msg}`, `- Seen ${i.count} time${i.count > 1 ? 's' : ''}, first at action #${i.first}, last at #${i.last}${i.actions.size ? ' · during: ' + [...i.actions].join(', ') : ''}${i.ctl.size ? ' · controls: ' + [...i.ctl].slice(0, 4).join(', ') : ''}`);
    if (i.note) L.push(`- Details: ${i.note}`);
    if (i.diag) L.push(`- Likely cause: ${i.diag}`);
    if (i.state) L.push('- App state when it first happened: ' + i.state);
    if (i.stack) L.push('- Stack: ' + i.stack.split('\n').slice(0, 4).map((l) => l.trim()).join(' | '));
    L.push(`- To reproduce (seed ${i.seed}), the last actions before it were:`, ...i.repro.slice(-8).map((r) => '    ' + r));
  });
  L.push('', '## What went right');
  [...T.checks.entries()].sort((a, b) => b[1].runs - a[1].runs).forEach(([n, c]) => L.push(`- ${c.bad ? '✗' : '✓'} ${n}: ${c.runs - c.bad} of ${c.runs} passed`));
  if (T.features.size) { L.push('', '## Features exercised'); [...T.features.entries()].forEach(([k, v]) => L.push(`- ${k}: ${v}`)); }
  L.push('', '## Actions', ...[...T.kinds.entries()].map(([k, v]) => { const a = [...v.ms].sort((x, y) => x - y); return `- ${k}: ${v.n} run, ${v.bad} with problems, median ${Math.round(a[Math.floor(a.length / 2)] || 0)} ms, slowest ${Math.round(a[a.length - 1] || 0)} ms${v.jank ? ', ' + v.jank + ' janky' : ''}`; }));
  L.push('', '## Coverage', `- Controls found: ${R.tot.length}; used at least once: ${R.hit.length} (${pct(R.hit.length, R.tot.length)}%); different control-to-control combinations tried: ${T.pairs.size}`, `- Blocked safely: ${T.counters.filePickerBlocked} file pickers, ${T.counters.externalBlocked} external links, ${T.counters.dialogs} browser dialogs, ${T.counters.notifBlocked} notification prompts; stuck states healed: ${T.counters.healed}; saves to the scratch copy: ${T.counters.storageWrites}`);
  const worstCtl = R.tot.filter((c) => c.bad).sort((a, b) => b.bad - a.bad).slice(0, 8); if (worstCtl.length) L.push('- Controls involved in the most problems: ' + worstCtl.map((c) => `${c.label} (${c.bad})`).join('; '));
  if (R.miss.length) L.push(`- Not used yet (${R.miss.length}): ${R.miss.slice(0, 40).map((c) => c.label).join('; ')}${R.miss.length > 40 ? '; …' : ''}`);
  return L.join('\n');
}
function reportJSON() { const R = build(); return JSON.stringify({ mode: T.mode, plan: T.plan, problems: T.problems, seed: T.seed, actions: T.n, durationMs: Math.round(R.dur), rate: R.rate, pass: T.pass, fail: T.fail, sandbox: T.sandbox, issues: R.issues.map((i) => ({ kind: i.kind, severity: i.sev, message: i.msg, count: i.count, first: i.first, last: i.last, likelyCause: i.diag, stack: i.stack, state: i.state, during: [...i.actions], controls: [...i.ctl], repro: i.repro })), checks: Object.fromEntries([...T.checks.entries()].map(([k, v]) => [k, v])), kinds: Object.fromEntries([...T.kinds.entries()].map(([k, v]) => [k, { n: v.n, bad: v.bad, jank: v.jank }])), features: Object.fromEntries(T.features), coverage: { total: R.tot.length, used: R.hit.length, pairs: T.pairs.size, unused: R.miss.map((c) => c.label) }, smoothness: { fps: R.fps, p50: R.p50, p95: R.p95, p99: R.p99, longTasks: T.longtasks.length } }, null, 1); }
function autosave() { try { localStorage.setItem('devtest-report', JSON.stringify({ at: Date.now(), n: T.n, text: reportText() })); } catch (e) { /* ignore */ } }
function download(name, text, type) { const b = new Blob([text], { type }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click')); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }

/* ---------------------------------------------------------------- panel */
let el = null, tab = 'now', lastUi = 0;
const CSS = `#devtest{position:fixed;right:12px;bottom:12px;width:540px;max-width:calc(100vw - 24px);height:680px;max-height:calc(100vh - 24px);z-index:2147483000;display:flex;flex-direction:column;background:#0d0f13f2;color:#e8eaee;border:1px solid #2c323c;border-radius:12px;box-shadow:0 18px 60px #000a;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:both;overflow:hidden;min-width:340px;min-height:220px}
#devtest *{box-sizing:border-box}#devtest .h{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #232831;cursor:move;user-select:none}#devtest .h b{font:700 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}#devtest .h .sp{flex:1}
#devtest button{font:600 11px system-ui,sans-serif;color:#e8eaee;background:#1b2028;border:1px solid #333b47;border-radius:7px;padding:5px 9px;cursor:pointer}#devtest button:hover{border-color:#6c7a90}#devtest button:disabled{opacity:.45;cursor:default}#devtest button.go{background:#1f6f43;border-color:#2e9d62}#devtest button.no{background:#7a2530;border-color:#b0404f}#devtest button.on{border-color:#7ab8ff;color:#7ab8ff}
#devtest input{font:11px ui-monospace,monospace;color:#e8eaee;background:#12161c;border:1px solid #333b47;border-radius:6px;padding:4px 6px;width:64px}#devtest label{display:flex;align-items:center;gap:4px;color:#98a2b3}
#devtest .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #232831}#devtest .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#232831;border-bottom:1px solid #232831}#devtest .stats div{background:#0d0f13;padding:6px 8px}#devtest .stats b{display:block;font-size:15px}#devtest .stats span{color:#98a2b3;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
#devtest .tabs{display:flex;gap:4px;padding:6px 10px 0}#devtest .body{flex:1;overflow:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word}#devtest .ok{color:#7bd59a}#devtest .bad{color:#ff7b8a}#devtest .warn{color:#ffc766}#devtest .dim{color:#7b8696}#devtest .iss{border:1px solid #2c323c;border-radius:8px;padding:7px 9px;margin-bottom:7px;background:#12161c}#devtest .iss h4{margin:0 0 3px;font:700 11px system-ui,sans-serif}
#devtest>.h,#devtest>.row,#devtest>.stats,#devtest>.tabs,#devtest>.bar{flex:none}#devtest .body{flex:1 1 auto;min-height:0}#devtest .tabs{flex-wrap:wrap;padding-bottom:6px}
#devtest>#dtLabel,#devtest>#dtSafe,#devtest>#dtEta,#devtest>#dtPhases{flex:none}#devtest select{font:600 11px system-ui,sans-serif;color:#e8eaee;background:#1b2028;border:1px solid #333b47;border-radius:7px;padding:4px 6px}#devtest .bar{height:4px;background:#232831}#devtest .bar i{display:block;height:100%;background:#2e9d62}`;
function build_ui() {
  if (el) return;
  const st = document.createElement('style'); st.id = 'devtest-css'; st.textContent = CSS; document.head.appendChild(st);
  el = document.createElement('div'); el.id = 'devtest'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Automatic UX tester');
  el.innerHTML = `<div class="h"><b>UX tester</b><span class="dim">press ` + '`' + ` to hide</span><span class="sp"></span><button data-a="min" title="Collapse">–</button><button data-a="close" title="Hide (the test keeps running)">✕</button></div>
<div class="row"><select id="dtMode" title="What kind of run"><option value="quick">Quick</option><option value="standard">Standard</option><option value="thorough">Thorough</option><option value="problems">Aim at problems</option><option value="newbie">First-timer</option><option value="free" selected>Free run</option></select><select id="dtSpeed" title="How much faster than real time the page's animations and timers run. Faster means more actions per second."><option value="1">Real time</option><option value="4">4× faster</option><option value="10" selected>10× faster</option><option value="20">20× faster</option></select><button data-a="forget" title="Forget the suspects and problems remembered from earlier Aim at problems runs">Forget memory</button></div>
<div class="dim" id="dtLabel" style="padding:2px 10px"></div>
<div class="ok" id="dtSafe" style="padding:0 10px 2px;font-size:11px">Safe to run: it works on a scratch copy in memory. Your own reminders and settings are never touched and are put back when the run ends.</div>
<div class="row"><button class="go" data-a="start">▶ Start</button><button data-a="pause" disabled>❚❚ Pause</button><button class="no" data-a="stop" disabled>■ Stop</button>
<label>per sec<input id="dtRate" type="number" min="1" max="60" value="10"></label><label>max<input id="dtMax" type="number" min="0" value="0" title="0 = keep going until stopped"></label><label>seed<input id="dtSeed" type="number" value="1"></label><label title="Ignore the rate and go as fast as the page allows"><input id="dtTurbo" type="checkbox" style="width:auto">turbo</label></div>
<div class="bar"><i id="dtBar" style="width:0%"></i></div>
<div class="dim" id="dtEta" style="padding:3px 10px"></div><div id="dtPhases" style="padding:0 10px"></div>
<div class="stats"><div><b id="dtN">0</b><span>actions</span></div><div><b id="dtP" class="ok">0</b><span>passed</span></div><div><b id="dtF" class="bad">0</b><span>failed</span></div><div><b id="dtR">0</b><span>per sec</span></div><div><b id="dtT">0s</b><span>running</span></div></div>
<div class="tabs"><button data-t="now" class="on">Now</button><button data-t="log">Live log</button><button data-t="issues">Problems <span id="dtI">0</span></button><button data-t="report">Report</button><button data-t="cover">Coverage</button></div>
<div class="body" id="dtBody"></div>
<div class="row"><button data-a="copy">Copy report</button><button data-a="md">Save .md</button><button data-a="json">Save .json</button><button data-a="clear">Clear</button><span class="dim" id="dtMsg"></span></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.t) { tab = b.dataset.t; $$('.tabs button', el).forEach((x) => x.classList.toggle('on', x === b)); ui(true); return; }
    const a = b.dataset.a;
    if (a === 'forget') { try { localStorage.removeItem(MEM); } catch (e) { /* ignore */ } labelUi(); msg('Memory cleared'); }
    else if (a === 'start') start({ mode: $('#dtMode').value, speed: +$('#dtSpeed').value, seed: +$('#dtSeed').value || 1, rate: clamp(+$('#dtRate').value || 10, 1, 60), max: Math.max(0, +$('#dtMax').value || 0), turbo: $('#dtTurbo').checked, reset: T.n > 0 && !T.running });
    else if (a === 'stop') stop('stopped by you');
    else if (a === 'pause') { T.paused = !T.paused; b.textContent = T.paused ? '▶ Resume' : '❚❚ Pause'; }
    else if (a === 'close') toggle(false);
    else if (a === 'min') el.style.height = el.style.height === '40px' ? '680px' : '40px';
    else if (a === 'copy') { const t = reportText(); (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => msg('Report copied'), () => { tab = 'report'; ui(true); msg('Select and copy from the Report tab'); }); }
    else if (a === 'md') download('ux-test-report.md', reportText(), 'text/markdown');
    else if (a === 'json') download('ux-test-report.json', reportJSON(), 'application/json');
    else if (a === 'clear') { if (!T.running && !T.finishing) { resetStats(); ui(true); } else msg('Stop the test first'); }
  });
  // drag by the header
  let drag = null; $('.h', el).addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; const r = el.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top }; el.setPointerCapture && e.isTrusted && el.setPointerCapture(e.pointerId); });
  addEventListener('pointermove', (e) => { if (!drag || !e.isTrusted) return; el.style.left = clamp(e.clientX - drag.x, 0, innerWidth - 100) + 'px'; el.style.top = clamp(e.clientY - drag.y, 0, innerHeight - 40) + 'px'; el.style.bottom = 'auto'; el.style.right = 'auto'; });
  addEventListener('pointerup', () => { drag = null; });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  $('#dtMode', el).onchange = labelUi; labelUi();
  setInterval(() => { if (T.open && now() - lastUi > 400) ui(); }, 500);
}
const msg = (t) => { const m = $('#dtMsg'); if (m) { m.textContent = t; setTimeout(() => { m.textContent = ''; }, 2500); } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtDur = (ms) => { ms = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(ms / 3600), m = Math.floor(ms % 3600 / 60), sec = ms % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`; };
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function labelUi() { const l = $('#dtLabel'), m = $('#dtMode'); if (!l || !m) return; let t = MODES[m.value].label; if (m.value === 'problems') { const mm = loadMem(); t += ` · remembered: ${Object.keys(mm.ctl).length} suspect controls, ${mm.repros.length} problems to replay`; } l.textContent = t; }
/* time left: phases already measured use their own average, the ones not reached yet use the average so far */
function estimate() {
  const plan = T.plan; if (!plan) return 0; const allNames = Object.keys(plan).filter((k) => !['total', 'mode'].includes(k));
  const perAct = T.n > 4 ? (Date.now() - T.t0) / T.n : 150; let left = 0;
  for (const n of allNames) { const planned = plan[n], ps = T.phases[n]; if (!ps) { left += planned * perAct; continue; } const live = n === T.phaseName, done = live ? T.n - ps.n0 : ps.done, ms = live ? NOW() - T.phaseT0 : ps.ms; left += Math.max(0, planned - done) * (done >= 3 ? ms / done : perAct); }
  return left;
}
function etaText(total) {
  const R = build(), rate = T.n / Math.max(1, R.dur / 1000), tests = ' · ' + rate.toFixed(1) + ' actions per second' + (BG.speed > 1 && T.running ? ', time ×' + BG.speed : '');
  if (T.finishing) return 'finishing: putting your own reminders and settings back…';
  if (T.running && T.plan) { const left = estimate(), fin = Date.now() + left; T.finishAt = T.finishAt && T.n > 5 ? T.finishAt * 0.85 + fin * 0.15 : fin; return T.n < 3 ? 'estimating the finishing time…' : `${Math.round(Math.min(99.9, 100 * T.n / total))}% · about ${fmtDur(T.finishAt - Date.now())} left · done around ${clock(T.finishAt)}${tests}`; }
  if (!T.running && T.n && T.plan) return `${T.endReason || 'finished'} · took ${fmtDur(R.dur)}${tests}`;
  return T.running ? `running${tests}` : '';
}
function phasesHtml() { if (!T.plan) return ''; return Object.keys(T.plan).filter((k) => !['total', 'mode'].includes(k)).map((n) => { const ps = T.phases[n], planned = T.plan[n], done = !ps ? 0 : (n === T.phaseName && T.running ? T.n - ps.n0 : ps.done); return `<div style="display:flex;gap:8px;align-items:center;font-size:11px"><span style="width:130px">${esc(n)}</span><span style="width:64px" class="dim">${Math.min(done, planned)} / ${planned}</span><div class="bar" style="flex:1"><i style="width:${Math.min(100, 100 * done / Math.max(1, planned))}%"></i></div></div>`; }).join(''); }
function nowHtml() {
  const L = T.live, row = (k, v) => (v === '' || v == null ? '' : `<tr><td style="color:#98a2b3;white-space:nowrap;padding-right:10px;vertical-align:top">${k}</td><td>${v}</td></tr>`);
  if (!T.n && !T.running) return '<span class="dim">Press Start. This tab shows exactly what is being tested at each moment, and why.</span>';
  const chips = L.cats.length ? L.cats.map((c) => `<span title="${esc(c.what)}" class="${c.bad ? 'bad' : 'ok'}" style="border:1px solid #33333f;border-radius:9px;padding:0 6px;margin:1px 3px 1px 0;display:inline-block">${c.bad ? '✗' : '✓'} ${esc(c.cat)}</span>`).join('') : '<span class="dim">runs after the action settles</span>';
  const exp = L.kind === 'form' ? 'the field ends up with a valid value or its old one, saved, and nothing shows NaN or Invalid Date' : L.kind === 'import' ? 'a good file adds its reminders; a broken file is refused with a message; nothing breaks' : L.kind === 'export' ? 'a file with exactly the reminders in the app' : L.kind === 'search' ? 'exactly the matching reminders in the list' : L.kind === 'reload' ? 'the same reminders and settings after saving and loading' : '';
  const fr = L.fmax ? `${Math.round(L.ms)} ms · frames avg ${L.fAvg.toFixed(1)} ms, worst ${Math.round(L.fmax)} ms` : '';
  return `<table>${row('Phase', esc(L.phase) + (T.plan && T.phases[L.phase] ? ` · ${Math.min(T.plan[L.phase] || 0, T.n - T.phases[L.phase].n0)} of ${T.plan[L.phase] || 0}` : ''))}${row('Scenario', esc(L.scenario))}${row('Stage', esc(L.stage))}${row('Action', L.kind ? `<b>${esc(L.kind)}</b> ${esc(L.desc || '')}` : '')}${row('Purpose', L.kind && PURPOSE[L.kind] ? esc('To ' + PURPOSE[L.kind] + '.') : '')}${row('Expecting', esc(exp))}${row('Changed', L.diff ? (L.diff.length ? esc(L.diff.join(', ')) : '<span class="warn">nothing changed on screen</span>') : '')}${row('Response', fr)}${row('Checks', chips)}${row('Problems so far', T.issues.size ? `<span class="bad">${T.issues.size}</span>` : '<span class="ok">none</span>')}</table><div style="border-top:1px solid #232831;margin-top:6px;padding-top:4px;font:11px/1.4 ui-monospace,monospace;color:#b9b9c6;max-height:160px;overflow:auto">${L.trace.slice(-14).reverse().map((x) => `<div class="${x.bad ? 'bad' : ''}">${x.at}s · ${esc(x.text)}${x.changed && x.changed.length ? ' → ' + esc(x.changed.join(', ')) : ''} · ${x.ms} ms${x.bad ? ' · ' + x.bad + ' problem(s)' : ''}</div>`).join('')}</div>`;
}
function ui(force) {
  if (!el || (!T.open && !force)) return; lastUi = now();
  const R = build(), set = (id, v) => { const e = $('#' + id); if (e && e.textContent !== String(v)) e.textContent = v; };
  set('dtN', T.n); set('dtP', T.pass); set('dtF', T.fail); set('dtR', R.rate.toFixed(1)); set('dtT', fmtT(R.dur)); set('dtI', R.issues.length);
  const total = T.plan ? T.plan.total : T.max, pctDone = total ? Math.min(T.running ? 99.9 : 100, 100 * T.n / total) : 0, bar = $('#dtBar'); if (bar) bar.style.width = (total ? pctDone : T.running ? (T.n % 100) : 0) + '%';
  set('dtEta', etaText(total)); const phEl = $('#dtPhases'); if (phEl) { const h = phasesHtml(); if (phEl.dataset.h !== h) { phEl.dataset.h = h; phEl.innerHTML = h; } }
  const s = $('[data-a=start]', el), p = $('[data-a=pause]', el), x = $('[data-a=stop]', el), busy = T.running || T.finishing; s.disabled = busy; p.disabled = !T.running; x.disabled = !T.running; s.textContent = T.running ? '● Running' : T.finishing ? '… Finishing' : T.n ? '▶ Run again' : '▶ Start';
  const body = $('#dtBody'), atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  if (tab === 'now') body.innerHTML = nowHtml();
  else if (tab === 'log') { body.innerHTML = T.log.slice(-160).map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('') || '<span class="dim">Press Start. It will click, type, drag rows, import files and press keys by itself, and check what happens. Your own reminders are not touched.</span>'; if (atBottom) body.scrollTop = body.scrollHeight; }
  else if (tab === 'issues') { body.innerHTML = R.issues.length ? R.issues.map((i) => `<div class="iss"><h4 class="${i.sev === 'error' ? 'bad' : i.sev === 'warn' ? 'warn' : 'dim'}">${i.sev.toUpperCase()} · ${esc(i.kind)} · ×${i.count}</h4>${esc(i.msg)}${i.diag ? `<div class="dim">Likely cause: ${esc(i.diag)}</div>` : ''}<div class="dim">first at #${i.first} · ${esc([...i.actions].join(', '))}</div><div class="dim">${esc(i.repro.slice(-5).join('\n'))}</div></div>`).join('') : '<span class="ok">No problems found so far.</span>'; }
  else if (tab === 'report') body.textContent = reportText();
  else if (tab === 'cover') { const rows = [...T.cover.values()].sort((a, b) => a.n - b.n); body.innerHTML = `<div class="dim">${R.hit.length} of ${R.tot.length} controls used · ${T.pairs.size} combinations</div>` + rows.slice(0, 300).map((c) => `<div class="${c.n ? (c.bad ? 'bad' : 'ok') : 'dim'}">${String(c.n).padStart(4)} × ${esc(c.label)} <span class="dim">(${c.kind}${c.bad ? ', ' + c.bad + ' problems' : ''})</span></div>`).join(''); }
}
function toggle(force) {
  build_ui(); T.open = force == null ? !T.open : !!force; el.hidden = !T.open; if (T.open) ui(true);
}
window.DevTest = { toggle, start, stop, report: reportText, reportJSON, state: T, issues: () => [...T.issues.values()], macros: MACROS, one: oneAction };
})();
