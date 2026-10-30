/* =====================================================================
   Automatic UX tester (dev tool), shared by the small single-page apps (Speeds & Feeds, Speed Programmer, ...).
   Press the ` key (or Ctrl+` while typing in a text box) to open it; there is no button. Open the page with ?dev=quick|standard|thorough|problems|stress
   to start a run by itself. It clicks, types, fuzzes fields and presses keys on its own (about 10 actions a second, as many thousands as you like)
   while it checks that things work (script errors, rejected promises, console errors, the app's own state, independent re-calculations of what
   the app shows) and look right (controls covered or cut off, off-screen, low contrast, layout jumps, freezes), then tells you what went right
   and wrong, with the steps to reproduce each problem and a guess at the cause. Seeded: the same seed gives the same sequence of actions.
   Modes: Quick, Standard and Thorough follow a plan (every control, pairs, random runs, whole flows) with a percentage bar and a finishing time;
   "Aim at problems" remembers what broke before, replays it, hunts around the likeliest suspects and shrinks each failure to its shortest recipe;
   "Free run" is the open-ended mode. Runs keep going when the tab is in the background (worker timers + Web Lock), and time can be sped up.

   This file is the generic core. Each page registers a small adapter as window.__devApi BEFORE loading it:
     name        title used in the report                       covers     list of strings: what this adapter checks (shown in the report)
     selectors   extra CSS selector of clickable things          modal      selector: while it matches, cover / layout checks are skipped
     coverOk     selector of things allowed to sit on top of controls (menus, tooltips)
     computed    selector of elements that only ever show computed text: NaN / undefined / Infinity / [object ...] in them is a bug
     markup      { root, allowed }: inside root only these tags may exist (typed text must never turn into markup)
     busy()      true while the app is working                  heal(K)    close popups that are in the way
     baseline(K) put the app in a known state (async)           snapshot() / restore(saved)   keep the user's own work safe
     state()     {label: value} shown in "Changed" and in each problem report
     check(K)    oracles run after every action (use K.check(name, ok) and K.find(kind, severity, message, {where}))
     fields      { '#ctl': { gen(K) -> text, desc } } generators for text fields, used by the generic "form" action
     actions     [{ id, weight, purpose, expect, run(K, spec) -> description }]   app-specific actions
     flows       { name: async (K) => {} }  whole journeys       setups  { name: async (K) => {} }  risky starting states
     download(K, d)  check a file the page offered for download   alpha   selector of a start-up popup to dismiss, and its button
   K (the kit) gives the adapter the tester's helpers: $, $$, sleep, raf, pick, chance, ri, rf, check, find, feature, setValue, realClick, key,
   settle, visible and more (see the "kit" section below).
   ===================================================================== */
(() => {
'use strict';
if (window.DevTest) return;
const A = window.__devApi;
if (!A) return;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const NOW = performance.now.bind(performance);   // the real clock: while a run is on, the page's own performance.now() can be sped up
const now = NOW;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const APP = A.name || document.title || 'App';

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
  downloads: [], copied: [], blobs: new Map(), counters: { externalBlocked: 0, dialogs: 0, healed: 0, clipboard: 0, storageRestored: 0 },
  hits: 0, soft: 0, spec: {}, scenario: null, mode: 'free', plan: null, speed: 10, saved: null, store: null,
  shifts: 0, longtasks: [], dts: [], base: 16, heap0: 0, nodes0: 0, rateWin: [],
};
const sevRank = { error: 3, warn: 2, info: 1 };

/* ---------------------------------------------------------------- findings */
const norm = (m) => String(m).replace(/0x[0-9a-f]+/gi, '0x#').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 160);
function check(name, ok) { const c = T.checks.get(name) || { runs: 0, bad: 0 }; c.runs++; if (!ok) c.bad++; T.checks.set(name, c); return ok; }
function dumpState() { try { const s = A.state ? A.state() : {}; return Object.entries(s).map(([k, v]) => `${k} ${String(v).slice(0, 80)}`).join(' · '); } catch (e) { return ''; } }
function find(kind, sev, msg, extra = {}) {
  const sig = kind + '|' + norm(extra.sigKey != null ? extra.sigKey : msg + (extra.where || ''));
  let it = T.issues.get(sig);
  if (!it) {
    if (T.issues.size > 600) return;
    it = { sig, kind, sev, msg: String(msg).slice(0, 500), count: 0, first: T.n, last: T.n, ctl: new Set(), actions: new Set(), repro: T.recent.slice(-12), seed: T.seed, state: dumpState(), diag: extra.diag || diagnose(kind, msg, extra), stack: extra.stack || '', sample: extra.sample ? String(extra.sample).slice(0, 600) : '' };
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
    if (/undefined|null/.test(m) && /read|reading|of/.test(m)) return 'A value was missing when the code used it (null or undefined). Likely a handler running before its data exists, or after it was cleared. ' + (top ? 'Look at: ' + top : '');
    if (/not a function/.test(m)) return 'Something was called that is not a function, often a handler wired to the wrong element or a missing API. ' + (top ? 'Look at: ' + top : '');
    if (/NaN|Infinity|finite|Invalid array length|out of range/i.test(m)) return 'A number went bad (NaN, Infinity or out of range). Check the input validation of whatever the last action fed in. ' + (top ? 'Look at: ' + top : '');
    return top ? 'Look at: ' + top : 'No stack was available; reproduce with the steps shown.';
  }
  if (kind === 'stuck-busy') return 'The busy state stayed on: an async job started but never finished or threw before it cleared the busy flag. Wrap that job in try/finally.';
  if (kind === 'state') return 'The app state disagrees with what the controls show (or itself). A handler changed one without updating the other.';
  if (kind === 'oracle') return 'A number the app shows disagrees with an independent re-calculation from the same inputs. Either the formula in the app is wrong, or the input was read differently from how it was typed (see the sample).';
  if (kind === 'bad-number') return 'NaN, undefined, Infinity or [object] is showing in the page where a number should be. Validate the input before calculating, or fall back to a blank / default value.';
  if (kind === 'gcode') return 'The G-code the app produced breaks a basic rule (malformed word, missing number, out-of-range value or unsafe order of blocks). Check the conversion rule that produced it.';
  if (kind === 'visual-covered') return 'Another element sits on top of this control, so a person could not click it. Check z-index, a stuck overlay, or panel overflow.';
  if (kind === 'visual-clipped') return 'This text is wider than its box and is cut off. Give it room, let it wrap, or add an ellipsis with a tooltip.';
  if (kind === 'visual-offscreen') return 'This control is partly outside the window or its panel, so it cannot be reached. Check the layout at this size.';
  if (kind === 'visual-overflow') return 'The page is wider than the window, so a horizontal scrollbar appears. Find the element that sticks out.';
  if (kind === 'visual-contrast') return 'Text color and its background are too close, so it is hard to read. Raise the contrast to at least 4.5:1 (3:1 for large text).';
  if (kind === 'visual-icon') return 'An icon rendered with no size, so the button shows nothing. The icon font or SVG did not load.';
  if (kind === 'jank' || kind === 'freeze') return 'A frame took far longer than normal right after this action: the main thread was busy (heavy rebuild, layout thrash, or a long synchronous loop such as a regular expression that backtracks). Break the work up or simplify the pattern.';
  if (kind === 'slow') return 'This kind of action takes a long time to finish. Add progress feedback or speed up the slow part.';
  if (kind === 'leak') return 'Memory (JS heap or page elements) keeps growing as the app is used and reset. Something is not being released.';
  if (kind === 'layout-shift') return 'Things on the page jumped around right after this action. Reserve space for content that appears later.';
  if (kind === 'a11y') return 'A control has no accessible name, so screen readers cannot describe it. Add aria-label or visible text.';
  if (kind === 'xss') return 'Text typed into the app showed up as live HTML. Escape user text before putting it in innerHTML (a typed <img onerror=...> would run).';
  if (kind === 'stuck-overlay') return 'A popup or overlay stayed open and did not close the way a person would expect (its close button, a click outside, or Escape).';
  if (kind === 'crash-input') return 'The app threw while handling this input instead of refusing it politely.';
  return '';
}
function logLine(cls, text) { T.log.push({ cls, text, t: Date.now() }); if (T.log.length > 800) T.log.splice(0, 200); }

/* ---------------------------------------------------------------- hooks */
const HK = { on: false, undo: [] };
function swap(obj, key, fn) { const o = obj[key]; obj[key] = fn(o); HK.undo.push(() => { obj[key] = o; }); }
const onErr = (e) => {
  if (!T.running) return;
  if (e.target && e.target !== window && e.target.tagName) { find('resource', 'warn', 'A resource failed to load: ' + (e.target.src || e.target.href || e.target.tagName), { where: e.target.src || e.target.href }); return; }
  find('js-error', 'error', e.message || 'Script error', { stack: e.error && e.error.stack });
};
const onRej = (e) => { if (T.running) find('promise', 'error', 'Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason), { stack: e.reason && e.reason.stack }); };
/* everything in localStorage / sessionStorage is copied before a run and put back afterwards, so a run leaves the person's real data alone
   (keys that start with "devtest" are the tester's own and are left out) */
const ownKey = (k) => /^devtest/.test(k);
function snapStore(st) { const o = {}; try { for (let i = 0; i < st.length; i++) { const k = st.key(i); if (!ownKey(k)) o[k] = st.getItem(k); } } catch (e) { return null; } return o; }
function putStore(st, snap) {
  if (!snap) return; try {
    for (let i = st.length - 1; i >= 0; i--) { const k = st.key(i); if (!ownKey(k) && !(k in snap)) { st.removeItem(k); T.counters.storageRestored++; } }
    for (const k of Object.keys(snap)) if (st.getItem(k) !== snap[k]) { st.setItem(k, snap[k]); T.counters.storageRestored++; }
  } catch (e) { /* storage blocked */ }
}
function hook() {
  if (HK.on) return; HK.on = true;
  try { T.store = { l: snapStore(localStorage), s: snapStore(sessionStorage) }; } catch (e) { T.store = null; }
  HK.undo.push(() => { if (T.store) { try { putStore(localStorage, T.store.l); putStore(sessionStorage, T.store.s); } catch (e) { /* ignore */ } } });
  window.addEventListener('error', onErr, true); window.addEventListener('unhandledrejection', onRej);
  HK.undo.push(() => { window.removeEventListener('error', onErr, true); window.removeEventListener('unhandledrejection', onRej); });
  swap(console, 'error', (o) => function () { if (T.running && !T.quiet) find('console-error', 'error', [...arguments].map((a) => (a && a.message) || String(a)).join(' ').slice(0, 300), { stack: arguments[0] && arguments[0].stack }); return o.apply(this, arguments); });
  swap(console, 'warn', (o) => function () { if (T.running && !T.quiet) find('console-warn', 'warn', [...arguments].map((a) => String(a)).join(' ').slice(0, 300)); return o.apply(this, arguments); });
  swap(HTMLInputElement.prototype, 'click', (o) => function () { if (this.type === 'file') return; return o.apply(this, arguments); });
  swap(URL, 'createObjectURL', (o) => function (b) { const u = o.call(URL, b); T.blobs.set(u, b); if (T.blobs.size > 20) T.blobs.delete(T.blobs.keys().next().value); return u; });
  swap(HTMLAnchorElement.prototype, 'click', (o) => function () {
    if (this.download) { T.downloads.push({ name: this.download, blob: T.blobs.get(this.href), n: T.n, checked: false }); if (T.downloads.length > 30) T.downloads.shift(); return; }
    if (this.getAttribute('href') && !/^#/.test(this.getAttribute('href')) && (this.target && this.target !== '_self' || this.origin !== location.origin || this.pathname !== location.pathname)) { T.counters.externalBlocked++; return; }
    return o.apply(this, arguments);
  });
  try { if (navigator.clipboard && navigator.clipboard.writeText) swap(navigator.clipboard, 'writeText', () => function (t) { T.counters.clipboard++; T.copied.push({ text: String(t), n: T.n, checked: false }); if (T.copied.length > 30) T.copied.shift(); return Promise.resolve(); }); } catch (e) { /* read-only in this browser */ }
  swap(document, 'execCommand', (o) => function (c) { if (/^copy$/i.test(c)) { T.counters.clipboard++; return true; } return o.apply(this, arguments); });
  swap(window, 'open', () => function () { T.counters.externalBlocked++; return null; });
  swap(History.prototype, 'pushState', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* ignore */ } });
  swap(window, 'alert', () => function () { T.counters.dialogs++; });
  swap(window, 'confirm', () => function () { T.counters.dialogs++; return true; });
  swap(window, 'prompt', () => function () { T.counters.dialogs++; return ''; });
  swap(Element.prototype, 'setPointerCapture', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* synthetic pointer ids have no capture */ } });
  swap(Element.prototype, 'releasePointerCapture', (o) => function () { try { return o.apply(this, arguments); } catch (e) { /* same */ } });
  // the tester must never leave the page: no link that goes anywhere but a spot on this page may be followed (the portfolio link has the same origin as the app, so checking the origin is not enough)
  const leaves = (a) => { try { const u = new URL(a.getAttribute('href'), location.href); return (a.target && a.target !== '_self') || (u.origin + u.pathname + u.search) !== (location.origin + location.pathname + location.search); } catch (e) { return true; } };
  const blockNav = (e) => { if (!T.running || e.isTrusted) return; const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a && !a.hasAttribute('download') && leaves(a)) { e.preventDefault(); e.stopImmediatePropagation(); T.counters.externalBlocked++; } };
  const guard = (e) => { if (T.running) { e.preventDefault(); e.returnValue = 'The UX test is still running.'; return e.returnValue; } };
  window.addEventListener('beforeunload', guard); HK.undo.push(() => window.removeEventListener('beforeunload', guard));
  document.addEventListener('click', blockNav, true); HK.undo.push(() => document.removeEventListener('click', blockNav, true));
  try { const po = new PerformanceObserver((l) => l.getEntries().forEach((en) => { if (en.hadRecentInput) return; T.shifts += en.value; })); po.observe({ type: 'layout-shift', buffered: false }); HK.undo.push(() => po.disconnect()); } catch (e) { /* not supported */ }
  try { const po = new PerformanceObserver((l) => l.getEntries().forEach((en) => { T.longtasks.push({ d: en.duration, n: T.n }); if (T.longtasks.length > 200) T.longtasks.shift(); })); po.observe({ type: 'longtask', buffered: false }); HK.undo.push(() => po.disconnect()); } catch (e) { /* not supported */ }
}
function unhook() { HK.undo.reverse().forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); HK.undo = []; HK.on = false; }
// frame monitor: how long between frames, so a stall shows up as a long gap
const FM = { on: false, last: 0, max: 0 };
function fmLoop() { if (!FM.on) return; const t = NOW(); if (FM.last) { const dt = t - FM.last; T.dts.push(dt); if (T.dts.length > 900) T.dts.shift(); if (dt > FM.max) FM.max = dt; } FM.last = t; requestAnimationFrame(fmLoop); }

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
  const t = el.tagName.toLowerCase(), cls = (el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => c && !/^(hv|on|off|run|sm|big|primary|ghost|icon|show|active|selected|visible)$/.test(c))[0] : '') || '';
  const d = el.dataset ? Object.entries(el.dataset).filter(([k]) => !/tip/.test(k)).slice(0, 1).map(([k, v]) => `[data-${k}=${String(v).slice(0, 14)}]`).join('') : '';
  const tx = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
  const par = el.closest('[id]') && el.closest('[id]') !== el ? '@' + el.closest('[id]').id : '';
  return t + (cls ? '.' + cls : '') + d + (tx ? `"${tx}"` : '') + par;
}
function kindOf(el) {
  const t = el.tagName;
  if (t === 'SELECT') return 'select'; if (t === 'TEXTAREA') return 'text';
  if (t === 'INPUT') { const y = el.type; return y === 'checkbox' || y === 'radio' ? 'check' : y === 'range' ? 'range' : y === 'number' ? 'number' : y === 'color' ? 'color' : y === 'file' ? 'file' : y === 'button' || y === 'submit' ? 'button' : 'text'; }
  if (t === 'A') return 'link';
  return 'button';
}
const SEL = 'button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=switch], [tabindex]:not([tabindex="-1"])' + (A.selectors ? ', ' + A.selectors : '');
function scan() {
  const out = [], seen = new Set();
  $$(SEL).forEach((el) => {
    if (seen.has(el) || inDev(el)) return; seen.add(el);
    const k = kindOf(el);
    if (k === 'file') return;
    if (!visible(el)) return;
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
/* type into a field the way a browser reports it: focus, new value, input, then keyup (some pages listen to keyup), change on leaving */
function typeInto(el, v, o = {}) {
  try { el.focus && el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  setValue(el, v);
  try { if (el.setSelectionRange && o.caret !== 'keep') { const p = o.caret != null ? o.caret : v.length; el.setSelectionRange(p, p); } } catch (e) { /* not a text field */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (o.keyup !== false) el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true, view: window }));
  if (o.change !== false) el.dispatchEvent(new Event('change', { bubbles: true }));
}
function key(k, o = {}, target) {
  const t = target || document.activeElement || document.body, code = /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : /^\d$/.test(k) ? 'Digit' + k : k === ' ' ? 'Space' : k;
  const init = { key: k, code, bubbles: true, cancelable: true, composed: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, metaKey: false, view: window };
  const down = new KeyboardEvent('keydown', init); t.dispatchEvent(down); t.dispatchEvent(new KeyboardEvent('keyup', init));
  return down.defaultPrevented;
}

/* ---------------------------------------------------------------- waiting and settling */
async function settle(maxMs = 12000) {
  await raf(); await raf();
  const t0 = now(); let stuck = false;
  while (now() - t0 < maxMs) { if (!(A.busy && A.busy())) break; await sleep(40); }
  if (A.busy && A.busy()) { stuck = true; find('stuck-busy', 'error', `The app was still busy ${Math.round(maxMs / 1000)} s after: ${T.cur ? T.cur.desc : 'an action'}`); try { A.unbusy && A.unbusy(); } catch (e) { /* ignore */ } T.counters.healed++; }
  await raf();
  return !stuck;
}
function heal() {
  // get the app back to a state where the next action means something: popups that have been in the way for a few actions in a row are closed
  const blocked = !!(A.modal && $(A.modal)); T.stuck = blocked ? (T.stuck || 0) + 1 : 0;
  if (T.stuck >= 4) { try { A.heal && A.heal(K, true); } catch (e) { /* ignore */ } T.counters.healed++; T.stuck = 0; }
  else { try { A.heal && A.heal(K, false); } catch (e) { /* ignore */ } }
}

/* ---------------------------------------------------------------- the kit handed to the adapter */
const FINDINGS_FEATURE = (n) => T.features.set(n, (T.features.get(n) || 0) + 1);
const feature = FINDINGS_FEATURE;
const K = {
  $, $$, sleep, raf, clamp, now, visible, showing, inDev, scan, ctlKey, realClick, setValue, typeInto, key, fire, center, settle, check, find, feature, note,
  pick: (a) => pick(a), chance: (p) => chance(p), ri: (a, b) => ri(a, b), rf: (a, b) => rf(a, b), rand: () => rng(), wpick: (a, w) => wpick(a, w),
  allowSlow: (ms) => { if (T.cur) T.cur.allow = Math.max(T.cur.allow || 0, ms); },
  get spec() { return T.spec; }, get T() { return T; }, get running() { return T.running; },
  /* a shared pool of awkward text and numbers */
  TEXTS: ['', ' ', 'part', 'My Part 2', '<img src=x onerror=alert(1)>', '<b>bold</b>', '"quote\'s"', 'x'.repeat(3000), '日本語のテスト', '😀🔩', '../../etc/passwd', 'a;b,c|d', '-1', '1e309', 'NaN', '0'.repeat(400), '‮\u0000﻿', 'null', 'undefined', '[object Object]', '</script>', '${1+1}', '{{7*7}}', '%s%d%n'],
  NUMS: ['', '0', '-0', '1', '-1', '0.5', '45', '90', '180', '359.99', '360', '-360', '1000', '1e6', '1e12', '-1e12', '0.0000001', '1.', '.5', '1,5', 'abc', '+', 'e', '999999999999999999999'],
  FUZZ: ['1e-300', '1e300', '-0', '0.0000001', '9'.repeat(30), '1/0', '1,5,5', '1e', 'e5', '--5', '5 5', '0x10', '1_000', '   ', '٣', '\u0000', '.', '-.', '+', '1e999', '-1e999', '90.00000000001', '359.99999999', '0.00001', '1e-12', '99999999', '-99999999', '<b>x</b>', 'NaN', 'Infinity'],
  shuffle: (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
};
window.DevKit = K;

/* ---------------------------------------------------------------- oracles */
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
function parseRGBA(s) { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
function bgOf(el) { let a = el; const stack = []; while (a && a.nodeType === 1) { const cs0 = getComputedStyle(a); if (cs0.backgroundImage && cs0.backgroundImage !== 'none') return null; const c = parseRGBA(cs0.backgroundColor); if (c && c[3] > 0.05) { stack.push(c); if (c[3] >= 0.98) break; } a = a.parentElement; } let base = [10, 10, 12]; for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; base = base.map((v, k) => k < 3 ? c[k] * c[3] + v * (1 - c[3]) : 1); } return base; }
let scanBusy = false;
async function checkDom(deep) {
  if (scanBusy) return; scanBusy = true;
  const later = [];   // layout problems are only reported if they are still there a moment later (animations move things)
  const maybe = (kind, sev, msg, where, test) => { later.push({ kind, sev, msg, where, test }); };
  try {
    const modalOpen = !!(A.modal && $(A.modal));
    if (!check('page fits the window width', document.documentElement.scrollWidth <= innerWidth + 1)) maybe('visual-overflow', 'warn', `The page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`, 'page', () => document.documentElement.scrollWidth > innerWidth + 1);
    const list = scan(); seenControls(list);
    const ids = new Map(); $$('[id]').forEach((e) => { if (!inDev(e)) ids.set(e.id, (ids.get(e.id) || 0) + 1); });
    ids.forEach((n, id) => { if (n > 1) find('a11y', 'warn', `The id "${id}" is used ${n} times on the page`, { where: id }); });
    const limit = deep ? 400 : 60, sample = deep ? list : list.filter(() => chance(Math.min(1, limit / Math.max(1, list.length))));
    sample.slice(0, limit).forEach(({ el, key: kk, k }) => {
      if (!visible(el) || !showing(el)) return;
      const r = el.getBoundingClientRect(), name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() || el.getAttribute('alt') || el.getAttribute('placeholder') || (el.labels && el.labels[0] && el.labels[0].textContent.trim()) || el.dataset.tip || '';
      if (!check('every control has a name', !!name || el.type === 'hidden')) find('a11y', 'warn', `A ${k} has no accessible name: ${kk}`, { where: kk });
      const ico = el.querySelector('svg, i'); if (ico && !el.textContent.trim()) { const ir = ico.getBoundingClientRect(); if (!check('button icons render', ir.width > 1 && ir.height > 1)) find('visual-icon', 'warn', `The icon on ${kk} has no size`, { where: kk }); }
      if (!modalOpen && r.width > 2) {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const fading = (n) => { for (let p = n; p && p !== document.body; p = p.parentElement) if (p.getAnimations && p.getAnimations().length) return true; return false; };   // a popup that is still fading out does not count
        const coverTest = () => { if (!el.isConnected || !showing(el)) return false; const q = el.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2; if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return false; const top = document.elementFromPoint(x, y); coverTest.by = top; if (top && fading(top)) return false; return !!top && !(top === el || el.contains(top) || top.contains(el) || el.tagName === 'LABEL' || top.closest('#devtest' + (A.coverOk ? ', ' + A.coverOk : '') + (A.modal ? ', ' + A.modal : ''))); };
        if (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
          const covered = coverTest(); check('controls are not covered by something else', !covered);
          if (covered) maybe('visual-covered', 'warn', `${kk} is covered by ${coverTest.by ? ctlKey(coverTest.by) : 'something'}`, kk, coverTest);
        }
        const sideTest = () => { if (!el.isConnected) return false; const q = el.getBoundingClientRect(); return q.width > 2 && (q.right > innerWidth + 1 || q.left < -1); };
        const out = sideTest(); check('controls are inside the window', !out);
        if (out) maybe('visual-offscreen', 'warn', `${kk} sticks out of the window sideways (${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth})`, kk, sideTest);
      }
      const clipTest = () => el.isConnected && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).textOverflow !== 'ellipsis' && el.clientWidth > 0;
      if (name && !el.matches('input, textarea, select') && clipTest()) { check('text is not cut off', false); maybe('visual-clipped', 'warn', `Text is cut off in ${kk} (${el.scrollWidth}px of text in ${el.clientWidth}px)`, kk, clipTest); } else check('text is not cut off', true);
    });
    if (deep) {
      const tx = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim().length > 1 && n.parentElement && !inDev(n.parentElement) && !/^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
      for (let n; (n = w.nextNode()) && tx.length < 250;) { const p = n.parentElement; if (p && visible(p) && showing(p)) tx.push(p); }
      new Set(tx).forEach((p) => {
        const cs = getComputedStyle(p), fg = parseRGBA(cs.color), bg = bgOf(p); if (!fg || !bg) return;   // (a gradient or image behind the text can't be measured this way)
        const fl = lum(fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]))), bl = lum(bg), ratio = (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
        const faint = p.closest('[disabled], .disabled, [aria-disabled=true], :disabled');
        const ok = !!faint || ratio >= 3; check('text is readable (contrast)', ok);
        if (!ok) maybe('visual-contrast', 'info', `Low contrast ${ratio.toFixed(1)}:1 for "${p.textContent.trim().slice(0, 30)}" in ${ctlKey(p)} (and everything styled like it)`, 'contrast ' + p.tagName + '.' + String(p.className).split(/\s+/)[0] + ' ' + (p.closest('[id]') || {}).id + Math.round(ratio * 4), () => { if (!p.isConnected) return false; const c2 = getComputedStyle(p), f2 = parseRGBA(c2.color), b2 = bgOf(p); if (!f2 || !b2) return false; const l1 = lum(f2.slice(0, 3).map((v, i) => v * f2[3] + b2[i] * (1 - f2[3]))), l2 = lum(b2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) < 3; });
      });
      if (document.getAnimations().length > 250) find('jank', 'warn', 'More than 250 animations are running at once', { where: 'animations' });
    }
    if (later.length) { await sleep(400); later.forEach((q) => { let still = false; try { still = q.test(); } catch (e) { /* element went away */ } if (still) find(q.kind, q.sev, q.msg, { where: q.where, sigKey: q.kind === 'visual-contrast' ? q.where : undefined }); }); }
  } finally { scanBusy = false; }
}
const BADNUM = /(^|[^A-Za-z])(NaN|undefined|Infinity)([^A-Za-z]|$)|\[object |\bnull\b/;
/* generic checks after every action: computed text never shows NaN / undefined / Infinity, typed text never becomes markup */
function checkGeneric() {
  if (A.computed) $$(A.computed).forEach((e) => {
    if (inDev(e)) return; const t = e.textContent || '';
    if (!check('no NaN / undefined / Infinity shown', !BADNUM.test(t))) find('bad-number', 'error', `"${t.trim().replace(/\s+/g, ' ').slice(0, 80)}" is showing in ${ctlKey(e)}`, { where: ctlKey(e) + t.trim().slice(0, 30), sample: t });
  });
  if (A.markup) [].concat(A.markup).forEach((mk) => {
    const rootEl = $(mk.root);
    if (rootEl) { const bad = $$('*', rootEl).filter((e) => !e.matches(mk.allowed) && !inDev(e));
      if (!check('typed text never turns into page markup', bad.length === 0)) find('xss', 'error', `Typed text became live HTML inside ${mk.root}: <${bad[0].tagName.toLowerCase()}> ${bad[0].outerHTML.slice(0, 100)}`, { where: bad[0].tagName, sample: bad[0].outerHTML }); }
  });
  const live = $$('[onerror], [onload], [onmouseover], [onfocus]').filter((e) => !inDev(e)), extra = document.scripts.length > (T.scripts0 || 99);
  if (!check('no injected event handlers or scripts', live.length === 0 && !extra)) find('xss', 'error', `Typed text created a live element: ${(live[0] || document.scripts[document.scripts.length - 1]).outerHTML.slice(0, 100)}`, { where: 'inject' });
}
function leakCheck() {
  if (performance.memory) { const mb = performance.memory.usedJSHeapSize / 1048576; if (!T.heap0) T.heap0 = mb; if (!check('JS memory stays bounded', mb < T.heap0 + 700)) find('leak', 'warn', `JS heap grew from ${T.heap0.toFixed(0)} MB to ${mb.toFixed(0)} MB`, { where: 'heap' }); }
}
function nodeCheck() {
  const n = document.getElementsByTagName('*').length; if (!T.nodes0) { T.nodes0 = n; return; }
  if (!check('page elements stay bounded after a reset', n < T.nodes0 + 4000)) find('leak', 'warn', `The page has ${n} elements after a reset (${T.nodes0} at the start)`, { where: 'nodes' });
}

/* ---------------------------------------------------------------- actions */
async function aClick(c) {
  const o = {}; const r = rng(); if (r < 0.04) o.shift = true; else if (r < 0.07) o.ctrl = true; else if (r < 0.09) o.button = 2;
  await realClick(c.el, o);
}
async function aForm(c) {
  const el = c.el; const k = c.k; let d = '';
  const fld = A.fields && A.fields[c.key];
  if (k === 'select') { const opts = [...el.options]; const o = pick(opts); setValue(el, o.value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); d = o.text; }
  else if (k === 'range') { const mn = +el.min || 0, mx = +el.max || 100, st = +el.step || 1; const v = pick([mn, mx, (mn + mx) / 2, mn + Math.round(rf(0, (mx - mn) / st)) * st, mn - 1, mx + 1]); setValue(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); if (chance(0.6)) el.dispatchEvent(new Event('change', { bubbles: true })); d = String(v); }
  else if (k === 'number') { const v = T.spec.fuzz && chance(0.6) ? pick(K.FUZZ) : chance(0.5) ? pick(K.NUMS) : String(rf(-500, 500).toFixed(ri(0, 4))); typeInto(el, v); if (chance(0.5)) el.blur(); d = v; }
  else if (k === 'text') {
    const v = fld && fld.gen && chance(0.85) ? fld.gen(K) : T.spec.fuzz && chance(0.6) ? pick(K.FUZZ.concat(K.TEXTS)) : pick(K.TEXTS);
    typeInto(el, v); if (chance(0.5)) el.blur(); d = String(v).replace(/\s+/g, ' ').slice(0, 40);
  }
  else if (k === 'color') { const v = '#' + ((rng() * 0xffffff) | 0).toString(16).padStart(6, '0'); setValue(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); if (chance(0.5)) el.dispatchEvent(new Event('change', { bubbles: true })); d = v; }
  else if (k === 'check') { await realClick(el); d = el.checked ? 'on' : 'off'; }
  return d;
}
const KEYS = [['Escape'], ['Enter'], ['Delete'], ['Backspace'], ['ArrowLeft'], ['ArrowRight'], ['ArrowUp'], ['ArrowDown'], ['Tab'], ['Tab', { shift: 1 }], [' '], ['z', { ctrl: 1 }], ['y', { ctrl: 1 }], ['a', { ctrl: 1 }], ['c', { ctrl: 1 }], ['v', { ctrl: 1 }], ['x'], ['g'], ['m'], ['?'], ['h'], ['1'], ['0'], ['+'], ['-'], ['PageUp'], ['PageDown'], ['Home'], ['End'], ['F1'], ['ContextMenu']];
function aKey() { const [k, o] = pick(KEYS); const tgt = document.activeElement && !inDev(document.activeElement) ? document.activeElement : document.body; key(k, o || {}, tgt); return (o && o.ctrl ? 'Ctrl+' : '') + (o && o.shift ? 'Shift+' : '') + (k === ' ' ? 'Space' : k); }
const FLOWS = A.flows || {}, SETUPS = A.setups || {};
async function aMacro(forced) { const name = forced && FLOWS[forced] ? forced : pick(Object.keys(FLOWS)); if (!name) return 'none'; T.sub++; await FLOWS[name](K); feature('flow: ' + name); return name; }
async function aSetup(name) { const fn = SETUPS[name] || SETUPS[pick(Object.keys(SETUPS))]; if (fn) await fn(K); await settle(15000); return name; }
const wantCtl = (st, ok) => T.spec.ctl ? st.list.find((q) => q.key === T.spec.ctl) : wpick(st.list.filter((q) => ok.includes(q.k)), (q) => 1 / Math.pow(1 + (T.cover.get(q.key) ? T.cover.get(q.key).n : 0), 1.2));
const ACTS = A.actions || [];
const KINDS = [
  ['click', 30, async (st) => { const c = wantCtl(st, ['button', 'link']); if (!c) return null; T.cur.ctl = c.key; T.cur.desc = 'click ' + c.key; await aClick(c); note(c.key, c.key, c.k, false); return c.key; }],
  ['form', 16, async (st) => { const c = wantCtl(st, ['select', 'range', 'number', 'text', 'color', 'check']); if (!c) return null; T.cur.ctl = c.key; const d = await aForm(c); T.cur.desc = `${c.k} ${c.key} = ${d}`; note(c.key, c.key, c.k, false); return c.key; }],
  ['key', 6, async () => { const d = aKey(); T.cur.desc = 'key ' + d; return null; }],
  ['macro', Object.keys(FLOWS).length ? 3 : 0, async () => { const d = await aMacro(T.spec.macro); T.cur.desc = 'flow: ' + d; return null; }],
  ['setup', 0, async () => { const d = await aSetup(T.spec.name); T.cur.desc = 'start from ' + d; return null; }],
].concat(ACTS.map((a) => [a.id, a.weight == null ? 8 : a.weight, async () => { const d = await a.run(K, T.spec); T.cur.desc = a.id + (d ? ': ' + String(d).slice(0, 90) : ''); return null; }]));

/* ---------------------------------------------------------------- what is being tested right now */
const CATS = [['errors', /^(js-error|promise|console-error|resource|crash-input)$/, 'no script errors, rejected promises or console errors'], ['state', /^(state|stuck-busy|stuck-overlay)$/, 'the app state agrees with the controls and the app never gets stuck'], ['numbers', /^(oracle|bad-number|gcode)$/, 'every number or line of code the app shows matches an independent re-calculation and is well formed'], ['layout', /^(visual-|a11y)/, 'nothing is covered, clipped, off-screen or unreadable'], ['safety', /^xss$/, 'typed text never becomes live HTML or script'], ['smoothness', /^(jank|freeze|layout-shift)$/, 'no long freezes or jumping layout'], ['speed', /^slow$/, 'the action finished promptly'], ['memory', /^leak$/, 'memory and page size stay bounded']];
function stateParts() { try { const s = A.state ? A.state() : {}; const o = {}; for (const k of Object.keys(s)) o[k] = String(s[k]); return o; } catch (e) { return {}; } }
const diffParts = (a, b) => Object.keys(b).filter((k) => a && a[k] !== b[k]);
const PURPOSE = { click: 'press the button and check it does its job (or nothing) without breaking the page, its numbers or layout', form: 'set the field the way a person (or a careless one) would and check the app applies it or refuses it politely, never showing NaN or freezing', key: 'press the key and check the shortcut does what it says (or nothing)', macro: 'run a whole journey of connected steps with checks along the way', setup: 'put the app into a risky starting state before the next actions run' };
const EXPECT = { form: 'the field ends up with a valid value or its old one, and nothing shows NaN', macro: 'every step of the journey passes its own checks' };
ACTS.forEach((a) => { if (a.purpose) PURPOSE[a.id] = a.purpose; if (a.expect) EXPECT[a.id] = a.expect; });

/* ---------------------------------------------------------------- one test */
async function oneAction(spec) {
  const outer = rng, aseed = spec && spec.seed != null ? spec.seed >>> 0 : Math.floor(outer() * 4294967296);
  rng = mulberry32(aseed); T.spec = spec || {};   // every action draws from its own seeded stream, so (kind, control, seed) replays it
  /* watchdog: one action that never finishes (a hung wait, a promise nothing resolves) must not stall a run that is meant to go on for hours */
  const hangMs = T.hangMs || 60000; let timer;
  try {
    const guard = new Promise((res) => { timer = window.setTimeout(() => res('hung'), hangMs); });
    const r = await Promise.race([oneAction0(aseed), guard]);
    if (r === 'hung') {
      find('freeze', 'error', `An action did not finish within ${Math.round(hangMs / 1000)} s and was abandoned: ${T.cur ? T.cur.desc : 'unknown'}`, { where: 'hang ' + (T.cur ? T.cur.kind + ':' + (T.cur.ctl || '') : '') });
      logLine('bad', `#${T.n} an action hung for ${Math.round(hangMs / 1000)} s, abandoned it and carried on`); T.hangs = (T.hangs || 0) + 1; T.cur = null; try { heal(); } catch (e) { /* ignore */ }
      return undefined;
    }
    return r;
  } finally { window.clearTimeout(timer); rng = outer; T.spec = {}; }
}
async function oneAction0(aseed) {
  T.n++; const n = T.n; const spec = T.spec;
  heal();
  const st = { list: scan() }; seenControls(st.list);
  const kind = (spec.kind && KINDS.find((k) => k[0] === spec.kind)) || wpick(KINDS, (k) => k[1]), cur = T.cur = { n, kind: kind[0], desc: kind[0], ctl: '', bad: [], seed: aseed };
  const stepRec = { kind: kind[0], seed: aseed }; if (spec.ctl) stepRec.ctl = spec.ctl; for (const k of ['name', 'macro', 'fuzz']) if (spec[k] !== undefined) stepRec[k] = spec[k]; if (T.scenario) T.scenario.push(stepRec);
  const before = stateParts(); T.live.stage = 'doing it'; T.live.ctl = spec.ctl || ''; T.live.kind = kind[0]; T.live.desc = kind[0]; T.live.diff = null; T.live.cats = [];
  const sh0 = T.shifts, t0 = now();
  FM.max = 0;
  try { await kind[2](st); } catch (e) { find('crash-input', 'error', 'Action threw: ' + (e && e.message), { stack: e && e.stack }); }
  T.live.stage = 'settling'; await settle(15000);
  await raf(); if (!BG.turbo) await sleep(30);
  const ms = now() - t0;
  // oracles
  const ks = T.kinds.get(cur.kind) || { n: 0, bad: 0, ms: [], jank: 0 }; ks.n++; ks.ms.push(ms); if (ks.ms.length > 400) ks.ms.shift(); T.kinds.set(cur.kind, ks);
  T.live.stage = 'checking';
  try { if (A.check) await A.check(K); } catch (e) { find('js-error', 'error', 'The app-specific checks threw: ' + (e && e.message), { stack: e && e.stack }); }
  checkGeneric();
  if (n % 6 === 0) await checkDom(false);
  if (n % 60 === 0) await checkDom(true);
  if (n % 40 === 0) leakCheck();
  // smoothness
  const allow = Math.max(cur.allow || 0, A.allowance ? A.allowance() : 0, cur.kind === 'macro' ? 1500 : 0);   // big inputs are allowed to take longer
  const worst = FM.max, jank = Math.max(80, T.base * 3.2, allow), freeze = Math.max(500, T.base * 9, allow);
  if (!check('no long freezes', worst < freeze)) find('freeze', T.mode === 'stress' && worst < 3000 ? 'warn' : 'error', `The page froze for ${Math.round(worst)} ms after: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || ''), sample: cur.desc });
  else if (!check('frames stay smooth', worst < jank)) { ks.jank++; find('jank', 'warn', `A frame took ${Math.round(worst)} ms (normal is ${Math.round(T.base)} ms) after: ${cur.kind}`, { where: cur.kind }); }
  const shift = T.shifts - sh0; if (!check('layout does not jump', shift < 0.25)) find('layout-shift', 'info', `The layout shifted (score ${shift.toFixed(2)}) after: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || '') });
  const slow = cur.kind === 'macro' || (A.slowKinds && A.slowKinds.includes(cur.kind)) ? 30000 : Math.max(3000, allow * 4);
  if (!check('actions finish promptly', ms < slow)) find('slow', 'warn', `${cur.kind} took ${(ms / 1000).toFixed(1)} s: ${cur.desc}`, { where: cur.kind + ':' + (cur.ctl || '') });
  if (A.downloads !== false) await checkDownloads();
  T.live.stage = 'checked'; T.live.desc = cur.desc; T.live.ctl = cur.ctl; T.live.diff = diffParts(before, stateParts()); T.live.ms = ms; T.live.fmax = worst; T.live.fAvg = T.dts.length ? T.dts.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, T.dts.length) : 0;
  T.live.cats = CATS.map(([cat, kinds, what]) => ({ cat, what, bad: cur.bad.filter((b) => kinds.test(b)).length })); T.live.trace.push({ at: Math.round((Date.now() - T.t0) / 100) / 10, text: cur.desc, changed: T.live.diff, ms: Math.round(ms), bad: cur.bad.length }); if (T.live.trace.length > 200) T.live.trace.shift();
  const bad = cur.bad.length > 0; if (bad) { T.fail++; ks.bad++; if (cur.ctl && T.cover.get(cur.ctl)) T.cover.get(cur.ctl).bad++; } else T.pass++;
  if (cur.ctl) stepRec.ctl = cur.ctl;
  T.recent.push(`#${n} ${cur.desc}`); if (T.recent.length > 40) T.recent.shift();
  logLine(bad ? 'bad' : 'ok', `#${n} ${cur.desc}${bad ? '  <- ' + cur.bad.join(', ') : ''}`);
  T.cur = null;
}
/* files the page offered for download and text it copied to the clipboard are handed to the adapter once */
async function checkDownloads() {
  if (!A.download && !A.copied) return;
  for (const d of T.downloads) if (!d.checked) { d.checked = true; try { if (A.download) await A.download(K, d); } catch (e) { find('js-error', 'error', 'Checking a download threw: ' + (e && e.message), { stack: e && e.stack }); } feature('downloads checked'); }
  for (const c of T.copied) if (!c.checked) { c.checked = true; try { if (A.copied) await A.copied(K, c); } catch (e) { find('js-error', 'error', 'Checking copied text threw: ' + (e && e.message), { stack: e && e.stack }); } feature('copied text checked'); }
}

/* ---------------------------------------------------------------- plans: Quick, Standard, Thorough, and Aim at problems */
const MODES = {
  quick: { label: 'Quick: about 250 actions, every control once, pairs, random runs and each whole flow', budget: 250 },
  standard: { label: 'Standard: about 900 actions with awkward values, pairs, random runs and every flow twice', budget: 900 },
  thorough: { label: 'Thorough: about 3000 actions, every control many times, thousands of pairs and runs, every flow', budget: 3000 },
  problems: { label: 'Aim at problems: scouts for suspects, replays old problems, spends most of its time on what is most likely to break, shrinks every failure', budget: 450, scoutShare: .14 },
  stress: { label: 'Stress test: pushes the app with bigger and bigger inputs, hammers it with back-to-back actions and repeats whole journeys, timing each step, to find where it slows down, freezes or breaks', budget: 0 },
  endless: { label: 'Endless: runs Quick, Standard, Thorough, Aim at problems and Stress over and over with new seeds until you press Stop. Keeps going in a background tab, behind other windows or with the screen off, and saves its report after every round', budget: 0 },
  free: { label: 'Free run: the original open-ended run (your rate, max and seed below)', budget: 0 },
};
async function resetBaseline() {
  try {
    heal(); if (A.heal) { try { A.heal(K, true); } catch (e) { /* ignore */ } }
    if (A.baseline) await A.baseline(K);
    await settle(10000); nodeCheck();
  } catch (e) { find('js-error', 'error', 'Resetting the tester failed: ' + (e && e.message), { stack: e && e.stack }); }
}
function targets() {
  const out = [], seen = new Set();
  scan().forEach((c) => { if (seen.has(c.key)) return; seen.add(c.key); const form = ['select', 'range', 'number', 'text', 'color', 'check'].includes(c.k); out.push({ id: c.key, kind: form ? 'form' : 'click', k: c.k, prior: c.k === 'number' || c.k === 'text' ? 5 : c.k === 'select' || c.k === 'range' ? 3.5 : c.k === 'color' ? 3 : c.k === 'check' ? 2.5 : c.k === 'link' ? 1 : 2 }); });
  return out;
}
const PSEUDO = ACTS.map((a) => ({ id: 'kind:' + a.id, kind: a.id, prior: a.prior != null ? a.prior : 3.5, pseudo: true })).concat(Object.keys(FLOWS).length ? [{ id: 'kind:macro', kind: 'macro', prior: 3, pseudo: true }] : [], [{ id: 'kind:key', kind: 'key', prior: 2, pseudo: true }]);
function stepFor(t, fuzz) {
  const st = { kind: t.kind, seed: Math.floor(rng() * 4294967296) };
  if (!t.pseudo) st.ctl = t.id; if (fuzz) st.fuzz = true;
  return st;
}
function planPhase(name, planned) { const now0 = NOW(); if (T.phaseName) { const ps = T.phases[T.phaseName]; ps.ms = now0 - T.phaseT0; ps.done = T.n - ps.n0; } T.phaseName = name; T.phaseT0 = now0; T.phases[name] = T.phases[name] || { n0: T.n, ms: 0, done: 0, planned }; T.live.phase = name; ui(); }
async function scenarioRun(name, steps) {
  await resetBaseline(); T.scenario = []; T.live.scenario = name; const h0 = T.hits, s0 = T.soft;
  for (const st of steps) { if (!T.running) break; await oneAction(st); if (T.hits > h0 + 8) break; }
  const done = T.scenario.slice(); T.scenario = null; return { hit: T.hits - h0, soft: T.soft - s0, done };
}
async function runPlanned(mode) {
  const M = MODES[mode], total = T.budgetOverride || M.budget; T.plan = { total, mode };
  const split = { 'every control': .34, 'pairs': .14, 'random runs': .30, 'flows': .22 }, planned = {}; Object.keys(split).forEach((k) => { planned[k] = Math.round(total * split[k]); T.plan[k] = planned[k]; });
  const ps = (name) => { planPhase(name, planned[name]); return T.n + planned[name]; };
  let target = ps('every control'); await resetBaseline();
  const all = targets().concat(PSEUDO); let i = 0, sinceReset = 0;
  while (T.running && T.n < target) { const t = all[i++ % all.length]; if (i % all.length === 1) all.sort(() => rng() - 0.5); await oneAction(stepFor(t, true)); if (++sinceReset >= 14) { sinceReset = 0; await resetBaseline(); } }
  target = ps('pairs');
  while (T.running && T.n < target) { const cs = targets().concat(PSEUDO); await scenarioRun('pair', [stepFor(pick(cs), true), stepFor(pick(cs), true)]); }
  target = ps('random runs');
  while (T.running && T.n < target) { const len = ri(3, 8); await scenarioRun('random run', Array.from({ length: len }, () => ({}))); }
  target = ps('flows');
  const flows = Object.keys(FLOWS).map((m) => ({ kind: 'macro', macro: m })).concat(ACTS.map((a) => ({ kind: a.id, fuzz: true })), Object.keys(SETUPS).map((s) => ({ kind: 'setup', name: s })));
  if (!flows.length) flows.push({ kind: 'click' });
  let f = 0; while (T.running && T.n < target) { const spec = Object.assign({}, flows[f++ % flows.length]); if (f % flows.length === 1) flows.sort(() => rng() - 0.5); spec.seed = Math.floor(rng() * 4294967296); await scenarioRun('flow: ' + (spec.macro || spec.name || spec.kind), spec.kind === 'setup' ? [spec, { kind: 'click' }, { kind: 'form', fuzz: true }] : [spec]); }
}


/* stress test: the adapter's A.stress = { name: async (K, level) => {} } scenarios are run at doubling sizes (level 1, 2, 4 ...), timed, and
   checked for slowing down faster than the input grows; then a hammer phase (long runs of back-to-back random actions with no resets) and a soak
   phase (every whole journey over and over, watching memory). */
const STRESS_MAX_MS = 8000;
async function runStress() {
  const hang0 = T.hangMs; T.hangMs = 300000;   // (the biggest sizes may honestly take a while)
  try { return await runStress0(); } finally { T.hangMs = hang0; }
}
async function runStress0() {
  const SC = A.stress || {}, names = Object.keys(SC), levels = clamp(T.budgetOverride || 9, 3, 14), hammerN = 480, soakN = 120;
  const S = T.stressRes = { rows: [], scaling: [], stopped: [], hammer: null, soak: null, levels };
  T.plan = { total: names.length * levels + hammerN + soakN, mode: 'stress' }; T.plan['bigger and bigger inputs'] = names.length * levels; T.plan['hammering'] = hammerN; T.plan['soak: journeys on repeat'] = soakN;
  const heap = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null);
  planPhase('bigger and bigger inputs', names.length * levels); const rampEnd = T.n + names.length * levels;
  for (const name of names) {
    let prev = null, stopped = false;
    for (let i = 0; i < levels && T.running; i++) {
      const level = 1 << i, key = 'stress: ' + name + ' (size ' + level + ')'; FLOWS[key] = async (KK) => { await SC[name](KK, level); };
      if (stopped) { T.n++; T.pass++; continue; }
      await resetBaseline(); const t0 = NOW(), n0 = T.n; await oneAction({ kind: 'macro', macro: key, seed: Math.floor(rng() * 4294967296) }); const ms = NOW() - t0;
      delete FLOWS[key]; const row = { name, level, ms: Math.round(ms), fmax: Math.round(FM.max) }; S.rows.push(row);
      if (prev && prev.ms >= 40 && ms >= 300) { const ratio = ms / prev.ms; if (ratio > 3.2) { S.scaling.push({ name, from: prev.level, to: level, ratio: Math.round(ratio * 10) / 10 }); find('scaling', 'warn', `${name}: doubling the input (${prev.level} to ${level}) made it ${ratio.toFixed(1)} times slower (${prev.ms} ms to ${Math.round(ms)} ms): it is slowing down faster than the input grows`, { where: name }); } }
      if (ms > STRESS_MAX_MS) { stopped = true; S.stopped.push({ name, level, ms: Math.round(ms) }); find('slow', 'warn', `${name} took ${(ms / 1000).toFixed(1)} s at size ${level}: the app is too slow here (stopped making it bigger)`, { where: name + ':' + level }); }
      prev = row;
    }
    if (!T.running) break;
  }
  if (T.running) {
    planPhase('hammering', hammerN); const hEnd = T.n + hammerN, h0 = NOW(), n0 = T.n; let longest = 0;
    while (T.running && T.n < hEnd) { const len = Math.min(hEnd - T.n, ri(40, 120)), t1 = NOW(); await scenarioRun('hammer', Array.from({ length: len }, () => ({}))); longest = Math.max(longest, len); if (T.n % 25 === 0) await raf(); }
    S.hammer = { actions: T.n - n0, ms: Math.round(NOW() - h0), perSec: Math.round((T.n - n0) / Math.max(.001, (NOW() - h0) / 1000) * 10) / 10, longest };
  }
  if (T.running) {
    planPhase('soak: journeys on repeat', soakN); const sEnd = T.n + soakN, m0 = heap(), s0 = NOW(), names2 = Object.keys(FLOWS).filter((k) => !k.startsWith('stress: ')); let rounds = 0, slowest = { name: '', ms: 0 };
    await resetBaseline();
    while (T.running && T.n < sEnd && names2.length) { const nm = names2[rounds++ % names2.length], t2 = NOW(); await scenarioRun('soak: ' + nm, [{ kind: 'macro', macro: nm, seed: Math.floor(rng() * 4294967296) }]); const d = NOW() - t2; if (d > slowest.ms) slowest = { name: nm, ms: Math.round(d) }; if (rounds % 12 === 0) await resetBaseline(); }
    const m1 = heap(); S.soak = { rounds, ms: Math.round(NOW() - s0), heapStart: m0 && Math.round(m0), heapEnd: m1 && Math.round(m1), slowest };
    if (m0 != null && m1 != null && m1 > m0 * 2 && m1 - m0 > 40) find('leak', 'warn', `JS memory grew from ${Math.round(m0)} MB to ${Math.round(m1)} MB while the same journeys ran over and over`, { where: 'soak' });
  }
}
function stressText() {
  const S = T.stressRes; if (!S) return [];
  const L = ['', '## Stress results', `- Sizes tried: ${S.levels} doublings per scenario (1, 2, 4 ... ${1 << (S.levels - 1)}). Times are for the whole scenario at that size.`];
  const by = {}; S.rows.forEach((r) => { (by[r.name] = by[r.name] || []).push(r); });
  Object.keys(by).forEach((n) => { const r = by[n], last = r[r.length - 1], bad = S.scaling.filter((x) => x.name === n); L.push(`- ${n}: ${r.map((x) => x.level + '→' + x.ms + ' ms').join(', ')}${bad.length ? '  ⚠ slows down faster than the input grows' : last.ms > 1500 ? '  (slow at the largest size)' : '  ✓'}`); });
  if (S.stopped.length) L.push('- Stopped growing (over ' + STRESS_MAX_MS / 1000 + ' s): ' + S.stopped.map((x) => `${x.name} at size ${x.level} (${(x.ms / 1000).toFixed(1)} s)`).join('; '));
  if (S.hammer) L.push(`- Hammering: ${S.hammer.actions} back-to-back random actions with no resets in ${(S.hammer.ms / 1000).toFixed(1)} s (${S.hammer.perSec} per second), runs of up to ${S.hammer.longest} in a row.`);
  if (S.soak) L.push(`- Soak: ${S.soak.rounds} journeys on repeat in ${(S.soak.ms / 1000).toFixed(1)} s; slowest was ${S.soak.slowest.name} (${S.soak.slowest.ms} ms)${S.soak.heapStart != null ? `; JS memory ${S.soak.heapStart} MB → ${S.soak.heapEnd} MB` : ''}.`);
  return L;
}


/* endless: the plan modes one after another, forever, each round with a new seed. Everything found stays in one report. It runs through worker timers and a
   Web Lock, so it does not need the tab visible or the window focused; a screen wake lock is asked for too. */
async function runEndless() {
  const order = ['quick', 'standard', 'thorough', 'problems'].concat(A.stress ? ['stress'] : []), E = T.endless = { round: 0, rounds: [], started: Date.now(), now: '' };
  let wake = null; const getWake = async () => { try { if (navigator.wakeLock && !document.hidden && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { wake = null; } };
  const onVis = () => { if (!document.hidden) getWake(); }; document.addEventListener('visibilitychange', onVis); getWake();
  try {
    while (T.running) {
      const mode = order[E.round % order.length]; E.round++; E.now = mode;
      const seed = (T.seed0 + E.round * 7919) >>> 0; rng = mulberry32(seed); T.seed = seed;
      const n0 = T.n, i0 = T.issues.size, t0 = NOW(), err0 = [...T.issues.values()].filter((i) => i.sev === 'error').length;
      T.cycleBase = T.n; T.phases = {}; T.phaseName = ''; T.plan = null; T.problems = null; T.stressRes = null; T.finishAt = 0; T.budgetOverride = 0;
      logLine('ok', `Round ${E.round}: ${mode} (seed ${seed})`); ui();
      try { if (mode === 'problems') await runProblems(); else if (mode === 'stress') await runStress(); else await runPlanned(mode); }
      catch (e) { find('js-error', 'error', 'Tester error: ' + (e && e.message), { stack: e && e.stack }); }
      T.scenario = null; if (!T.running) break;
      E.rounds.push({ round: E.round, mode, seed, actions: T.n - n0, ms: Math.round(NOW() - t0), newProblems: T.issues.size - i0, newErrors: [...T.issues.values()].filter((i) => i.sev === 'error').length - err0 });
      if (E.rounds.length > 200) E.rounds.shift();
      T.log.length > 400 && T.log.splice(0, 200); autosave(); await resetBaseline(); await sleep(50);
    }
  } finally { document.removeEventListener('visibilitychange', onVis); try { wake && wake.release(); } catch (e) { /* ignore */ } }
}
function endlessText() {
  const E = T.endless; if (!E) return [];
  const L = ['', '## Endless run', `- ${E.round} rounds started${T.running ? ` (round ${E.round} is ${E.now}, still running)` : ''} over ${fmtT(Date.now() - E.started)}; ${T.n} actions in all. Every problem below was found at some point in the run.`];
  E.rounds.slice(-30).forEach((r) => L.push(`    round ${r.round} ${r.mode} (seed ${r.seed}): ${r.actions} actions in ${fmtT(r.ms)}, ${r.newProblems} new problem(s)${r.newErrors ? `, ${r.newErrors} new error(s)` : ''}`));
  if (E.rounds.length > 30) L.push(`    (${E.rounds.length - 30} earlier rounds not listed)`);
  return L;
}

/* aim at problems: what is remembered, scouting, replay, hunting, shrinking */
const MEM = "devtest-problems.v1:" + APP;
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
  const pool = mem.repros.map((r) => ({ steps: r.steps })), sig = (a) => a.map((x) => idOf(x) + '/' + (x.name || x.macro || x.example || '')).join('>');
  try {
    await resetBaseline();
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
        iss.minimal = cur; P.minimal.push({ msg: iss.msg, from: iss.trail.length, to: cur.length, steps: cur.map((d) => idOf(d) + (d.name ? ' = ' + d.name : '') + (d.macro ? ' = ' + d.macro : '') + (d.example ? ' = ' + d.example : '')) }); } }
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
  if (T.running) return;
  T.seed = o.seed != null ? +o.seed : (T.seed || 1); rng = mulberry32(T.seed >>> 0); T.rate = o.rate || T.rate || 10; T.max = o.max != null ? +o.max : T.max; T.duration = o.duration || 0; T.turbo = !!o.turbo; T.quiet = false;
  if (T.n === 0 || o.reset) resetStats(); T.running = true; T.paused = false; T.tEnd = 0; T.tRun = now(); T.t0 = T.t0 || Date.now(); T.endReason = '';
  if (A.alpha) { const b = $(A.alpha.popup) && $(A.alpha.button); if (b) b.click(); }   // (a start-up popup in the way)
  T.scripts0 = document.scripts.length; try { T.saved = A.snapshot ? A.snapshot() : null; } catch (e) { T.saved = null; }   // the person's own work is put back when the run ends
  hook(); logLine('ok', `Started: seed ${T.seed}, ${T.turbo ? 'full speed' : T.rate + ' actions/s'}${T.max ? ', ' + T.max + ' actions' : ', until stopped'}`); ui();
  await calibrate(); if (!T.running) return;
  T.stressRes = null; T.endless = null; T.cycleBase = 0; T.seed0 = T.seed; T.mode = MODES[o.mode] ? o.mode : 'free'; T.budgetOverride = o.budget || 0; T.speed = o.speed != null ? +o.speed : (T.mode === 'free' ? 1 : 10); T.phases = {}; T.phaseName = ''; T.plan = null; T.problems = null; T.live.trace = [];
  BG.start(T.speed);
  if (T.mode === 'free') { loop(); return; }
  try { if (T.mode === 'problems') await runProblems(); else if (T.mode === 'stress') await runStress(); else if (T.mode === 'endless') await runEndless(); else await runPlanned(T.mode); } catch (e) { find('js-error', 'error', 'Tester error: ' + (e && e.message), { stack: e && e.stack }); }
  T.scenario = null; stop(T.running ? 'plan finished' : 'stopped');
}
function stop(why) { if (!T.running) return; T.running = false; if (T.phaseName && T.phases[T.phaseName]) { const ps = T.phases[T.phaseName]; ps.ms = NOW() - T.phaseT0; ps.done = T.n - ps.n0; } T.tEnd = now(); T.endReason = why || 'stopped'; FM.on = false; T.turboUsed = BG.turbo; T.bgFrames = BG.hiddenFrames; T.speedUsed = BG.speed; BG.stop(); logLine('ok', 'Finished: ' + T.endReason); autosave(); ui(); giveBack(); }
/* once the last action has finished: the app's own state and the browser storage are put back the way they were before the run */
async function giveBack() {
  for (let i = 0; i < 100 && T.cur; i++) await new Promise((r) => setTimeout(r, 50));
  unhook();
  try { if (A.restore && T.saved) A.restore(T.saved); } catch (e) { logLine('warn', 'Could not restore the page: ' + (e && e.message)); }
  T.saved = null; logLine('ok', 'The page and the browser storage were put back as they were before the run'); ui();
}
function resetStats() {
  Object.assign(T, { n: 0, sub: 0, pass: 0, fail: 0, checks: new Map(), kinds: new Map(), issues: new Map(), log: [], recent: [], cur: null, cover: new Map(), pairs: new Set(), lastKey: '', features: new Map(), downloads: [], copied: [], counters: { externalBlocked: 0, dialogs: 0, healed: 0, clipboard: 0, storageRestored: 0 }, shifts: 0, longtasks: [], heap0: 0, nodes0: 0, rateWin: [], t0: Date.now() });
  Object.assign(T, { hits: 0, soft: 0, phases: {}, phaseName: '', plan: null, problems: null, scenario: null, bgFrames: 0 }); T.live.trace = []; T.live.cats = []; T.live.diff = null;
}

/* ---------------------------------------------------------------- report */
const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
const fmtT = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };
function build() {
  const dur = (T.running ? now() : T.tEnd || now()) - (T.tRun || now()), issues = [...T.issues.values()].sort((a, b) => sevRank[b.sev] - sevRank[a.sev] || b.count - a.count);
  const tot = [...T.cover.values()], hit = tot.filter((c) => c.n > 0), miss = tot.filter((c) => c.n === 0);
  const rate = T.rateWin.length > 2 ? (T.rateWin.length - 1) / ((T.rateWin[T.rateWin.length - 1] - T.rateWin[0]) / 1000) : (T.n && dur > 500 ? T.n / (dur / 1000) : 0);
  const dts = [...T.dts].sort((a, b) => a - b), p = (q) => dts.length ? dts[Math.min(dts.length - 1, Math.floor(q * dts.length))] : 0;
  const errs = issues.filter((i) => i.sev === 'error'), warns = issues.filter((i) => i.sev === 'warn'), infos = issues.filter((i) => i.sev === 'info');
  return { dur, issues, errs, warns, infos, tot, hit, miss, rate, p50: p(0.5), p95: p(0.95), p99: p(0.99), fps: dts.length ? 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length) : 0 };
}
/* The copied report: only what went wrong. No passed checks, no list of what was covered, no feature or action tables. */
function problemsText(R) {
  const L = ['# ' + APP + ': problems found by the automatic UX test', '', `Seed ${T.seed} · ${T.n} actions in ${fmtT(R.dur)} · ${T.endReason || (T.running ? 'still running' : 'stopped')}`, ''];
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
function reportText(onlyBad) {
  const R = build(), L = [];
  if (onlyBad) return problemsText(R);
  L.push('# ' + APP + ': automatic UX test report', '', `Seed ${T.seed} · ${T.n} actions (${T.sub} extra steps inside macros) in ${fmtT(R.dur)} · about ${R.rate.toFixed(1)} actions/s · ${T.endReason || (T.running ? 'still running' : 'stopped')}`, '');
  const verdict = R.errs.length ? 'NEEDS ATTENTION' : R.warns.length ? 'GOOD, WITH WARNINGS' : 'ALL CLEAR';
  L.push(`## Verdict: ${verdict}`, `- ${T.pass} of ${T.n} actions passed every check (${pct(T.pass, T.n)}%), ${T.fail} had a problem`, `- ${R.errs.length} errors, ${R.warns.length} warnings, ${R.infos.length} notes (distinct problems)`, `- Smoothness: ${R.fps.toFixed(0)} fps average, frame time typical ${R.p50.toFixed(0)} ms, 95th ${R.p95.toFixed(0)} ms, 99th ${R.p99.toFixed(0)} ms; ${T.longtasks.length} long tasks`, '');
  if (T.plan && T.mode !== 'endless') L.push('', `Mode: ${MODES[T.mode].label.split(':')[0]} · plan of ${T.plan.total} actions · ${Object.keys(T.plan).filter((k) => !['total', 'mode'].includes(k)).map((k) => k + ' ' + Math.min(T.plan[k], (T.phases[k] || { done: 0 }).done || 0)).join(', ')}`);
  endlessText().forEach((l) => L.push(l));
  stressText().forEach((l) => L.push(l));
  if (T.problems) { const P = T.problems; L.push('', '## Aimed at problems', `- ${T.n ? Math.round(100 * (T.n - P.scouted - P.explore) / T.n) : 0}% of the actions went to suspects (${Object.entries(P.types).map(([k, v]) => k + ' ' + v).join(', ')}); memory at the start: ${P.memory.suspects} suspect controls, ${P.memory.repros} old problems`,
    P.measured ? '- Suspects (score = what went wrong around them):' : '- Nothing went wrong, so there is no measured ranking. These are the controls the tester thinks most likely to break (a starting guess by kind of control):');
    P.suspects.forEach((x) => L.push(`    ${x.id}: ${P.measured ? 'score ' + x.score : 'likelihood about ' + x.prior + ' of 5'}, ${x.hits} problem(s)${x.remembered ? ' (remembered)' : ''}`));
    if (P.replay.length) { L.push('- Old problems, replayed:'); P.replay.forEach((x) => L.push(`    ${x.still ? 'STILL FAILING' : 'fixed'} [${x.kind}] ${x.msg.slice(0, 110)}`)); }
    if (P.minimal.length) { L.push('- Shortest recipes:'); P.minimal.forEach((x) => L.push(`    ${x.msg.slice(0, 100)} (${x.from} → ${x.to} steps): ${x.steps.join(' > ')}`)); } }
  if (T.turboUsed) L.push('', 'Note: this run used the sped-up clock with frames not tied to the display, so smoothness numbers are only a rough guide. Pick Real time for a true grade.');
  if (T.bgFrames) L.push('', `Note: the tab was in the background for part of the run (${T.bgFrames} frames came from a worker clock).`);
  if (A.covers && A.covers.length) { L.push('## What this tester checks in ' + APP); A.covers.forEach((c) => L.push('- ' + c)); L.push(''); }
  L.push('## What went wrong');
  if (!R.issues.length) L.push('Nothing. Every check passed.');
  R.issues.forEach((i, k) => {
    L.push('', `### ${k + 1}. [${i.sev.toUpperCase()}] ${i.kind}: ${i.msg}`, `- Seen ${i.count} time${i.count > 1 ? 's' : ''}, first at action #${i.first}, last at #${i.last}${i.actions.size ? ' · during: ' + [...i.actions].join(', ') : ''}${i.ctl.size ? ' · controls: ' + [...i.ctl].slice(0, 4).join(', ') : ''}`);
    if (i.diag) L.push(`- Likely cause: ${i.diag}`);
    if (i.state) L.push('- App state when it first happened: ' + i.state);
    if (i.sample) L.push('- Sample: ' + i.sample.replace(/\s+/g, ' '));
    if (i.stack) L.push('- Stack: ' + i.stack.split('\n').slice(0, 4).map((l) => l.trim()).join(' | '));
    L.push(`- To reproduce (seed ${i.seed}), the last actions before it were:`, ...i.repro.slice(-8).map((r) => '    ' + r));
  });
  L.push('', '## What went right');
  [...T.checks.entries()].sort((a, b) => b[1].runs - a[1].runs).forEach(([n, c]) => L.push(`- ${c.bad ? '✗' : '✓'} ${n}: ${c.runs - c.bad} of ${c.runs} passed`));
  if (T.features.size) { L.push('', '## Features exercised'); [...T.features.entries()].filter(([k]) => !/^example: /.test(k)).forEach(([k, v]) => L.push(`- ${k}: ${v}`)); const ex = [...T.features.keys()].filter((k) => /^example: /.test(k)); if (ex.length) L.push(`- examples opened: ${ex.length} different (${ex.map((k) => k.slice(9)).join(', ')})`); }
  L.push('', '## Actions', ...[...T.kinds.entries()].map(([k, v]) => { const a = [...v.ms].sort((x, y) => x - y); return `- ${k}: ${v.n} run, ${v.bad} with problems, median ${Math.round(a[Math.floor(a.length / 2)] || 0)} ms, slowest ${Math.round(a[a.length - 1] || 0)} ms${v.jank ? ', ' + v.jank + ' janky' : ''}`; }));
  L.push('', '## Coverage', `- Controls found: ${R.tot.length}; used at least once: ${R.hit.length} (${pct(R.hit.length, R.tot.length)}%); different control-to-control combinations tried: ${T.pairs.size}`, `- Blocked safely: ${T.counters.externalBlocked} external links, ${T.counters.dialogs} browser dialogs, ${T.counters.clipboard} clipboard writes; stuck states healed: ${T.counters.healed}; storage entries put back: ${T.counters.storageRestored}`);
  const worstCtl = R.tot.filter((c) => c.bad).sort((a, b) => b.bad - a.bad).slice(0, 8); if (worstCtl.length) L.push('- Controls involved in the most problems: ' + worstCtl.map((c) => `${c.label} (${c.bad})`).join('; '));
  if (R.miss.length) L.push(`- Not used yet (${R.miss.length}): ${R.miss.slice(0, 40).map((c) => c.label).join('; ')}${R.miss.length > 40 ? '; …' : ''}`);
  return L.join('\n');
}
function reportJSON() { const R = build(); return JSON.stringify({ mode: T.mode, plan: T.plan, problems: T.problems, stress: T.stressRes, endless: T.endless, seed: T.seed, actions: T.n, durationMs: Math.round(R.dur), rate: R.rate, pass: T.pass, fail: T.fail, issues: R.issues.map((i) => ({ kind: i.kind, severity: i.sev, message: i.msg, count: i.count, first: i.first, last: i.last, likelyCause: i.diag, stack: i.stack, state: i.state, sample: i.sample, during: [...i.actions], controls: [...i.ctl], repro: i.repro })), checks: Object.fromEntries([...T.checks.entries()].map(([k, v]) => [k, v])), kinds: Object.fromEntries([...T.kinds.entries()].map(([k, v]) => [k, { n: v.n, bad: v.bad, jank: v.jank }])), features: Object.fromEntries(T.features), coverage: { total: R.tot.length, used: R.hit.length, pairs: T.pairs.size, unused: R.miss.map((c) => c.label) }, smoothness: { fps: R.fps, p50: R.p50, p95: R.p95, p99: R.p99, longTasks: T.longtasks.length } }, null, 1); }
function autosave() { try { localStorage.setItem('devtest-report:' + APP, JSON.stringify({ at: Date.now(), n: T.n, text: reportText() })); } catch (e) { /* ignore */ } }
function download(name, text, type) { const b = new Blob([text], { type }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click')); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }

/* ---------------------------------------------------------------- panel */
let el = null, tab = 'now', lastUi = 0;
const CSS = `#devtest{position:fixed;left:12px;bottom:12px;width:540px;max-width:calc(100vw - 24px);height:680px;max-height:calc(100vh - 24px);z-index:2147483000;display:flex;flex-direction:column;background:#0d0f13f2;color:#e8eaee;border:1px solid #2c323c;border-radius:12px;box-shadow:0 18px 60px #000a;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:both;overflow:hidden;min-width:340px;min-height:220px}
#devtest *{box-sizing:border-box}#devtest .h{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #232831;cursor:move;user-select:none}#devtest .h b{font:700 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}#devtest .h .sp{flex:1}
#devtest button{font:600 11px system-ui,sans-serif;color:#e8eaee;background:#1b2028;border:1px solid #333b47;border-radius:7px;padding:5px 9px;cursor:pointer}#devtest button:hover{border-color:#6c7a90}#devtest button.go{background:#1f6f43;border-color:#2e9d62}#devtest button.no{background:#7a2530;border-color:#b0404f}#devtest button.on{border-color:#7ab8ff;color:#7ab8ff}
#devtest input{font:11px ui-monospace,monospace;color:#e8eaee;background:#12161c;border:1px solid #333b47;border-radius:6px;padding:4px 6px;width:64px}#devtest label{display:flex;align-items:center;gap:4px;color:#98a2b3}
#devtest .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #232831}#devtest .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#232831;border-bottom:1px solid #232831}#devtest .stats div{background:#0d0f13;padding:6px 8px}#devtest .stats b{display:block;font-size:15px}#devtest .stats span{color:#98a2b3;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
#devtest .tabs{display:flex;gap:4px;padding:6px 10px 0}#devtest .body{flex:1;overflow:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word}#devtest .ok{color:#7bd59a}#devtest .bad{color:#ff7b8a}#devtest .warn{color:#ffc766}#devtest .dim{color:#7b8696}#devtest .iss{border:1px solid #2c323c;border-radius:8px;padding:7px 9px;margin-bottom:7px;background:#12161c}#devtest .iss h4{margin:0 0 3px;font:700 11px system-ui,sans-serif}#devtest .iss img{display:block;margin-top:5px;border-radius:5px;max-width:100%}
#devtest>.h,#devtest>.row,#devtest>.stats,#devtest>.tabs,#devtest>.bar{flex:none}#devtest .body{flex:1 1 auto;min-height:0}#devtest .tabs{flex-wrap:wrap;padding-bottom:6px}
#devtest>#dtLabel,#devtest>#dtEta,#devtest>#dtPhases{flex:none}#devtest select{font:600 11px system-ui,sans-serif;color:#e8eaee;background:#1b2028;border:1px solid #333b47;border-radius:7px;padding:4px 6px}#devtest .bar{height:4px;background:#232831}#devtest .bar i{display:block;height:100%;background:#2e9d62}`;
function build_ui() {
  if (el) return;
  const st = document.createElement('style'); st.id = 'devtest-css'; st.textContent = CSS; document.head.appendChild(st);
  el = document.createElement('div'); el.id = 'devtest'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Automatic UX tester');
  el.innerHTML = `<div class="h"><b>UX tester</b><span class="dim">press ` + '`' + ` to hide</span><span class="sp"></span><button data-a="min" title="Collapse">–</button><button data-a="close" title="Hide (the test keeps running)">✕</button></div>
<div class="row"><select id="dtMode" title="What kind of run"><option value="quick">Quick</option><option value="standard">Standard</option><option value="thorough">Thorough</option><option value="problems">Aim at problems</option><option value="stress">Stress test</option><option value="endless">Endless</option><option value="free" selected>Free run</option></select><select id="dtSpeed" title="How much faster than real time the page's animations and timers run. Faster means more actions per second."><option value="1">Real time</option><option value="4">4× faster</option><option value="10" selected>10× faster</option><option value="20">20× faster</option></select><button data-a="forget" title="Forget the suspects and problems remembered from earlier Aim at problems runs">Forget memory</button></div>
<div class="dim" id="dtLabel" style="padding:2px 10px"></div>
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
    else if (a === 'copy') { const t = reportText(true); (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => msg('Problems copied'), () => { tab = 'report'; ui(true); msg('Select and copy from the Report tab'); }); }
    else if (a === 'md') download(APP.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-ux-report.md', reportText(), 'text/markdown');
    else if (a === 'json') download(APP.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-ux-report.json', reportJSON(), 'application/json');
    else if (a === 'clear') { if (!T.running) { resetStats(); ui(true); } else msg('Stop the test first'); }
  });
  // drag by the header
  let drag = null; $('.h', el).addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; const r = el.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top }; el.setPointerCapture && e.isTrusted && el.setPointerCapture(e.pointerId); });
  addEventListener('pointermove', (e) => { if (!drag || !e.isTrusted) return; el.style.left = clamp(e.clientX - drag.x, 0, innerWidth - 100) + 'px'; el.style.top = clamp(e.clientY - drag.y, 0, innerHeight - 40) + 'px'; el.style.bottom = 'auto'; });
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
  const plan = T.plan; if (!plan) return 0; const names = Object.keys(T.phases), allNames = Object.keys(plan).filter((k) => !['total', 'mode'].includes(k));
  const perAct = T.n > 4 ? (Date.now() - T.t0) / T.n : 800; let left = 0;
  for (const n of allNames) { const planned = plan[n], ps = T.phases[n]; if (!ps) { left += planned * perAct; continue; } const live = n === T.phaseName, done = live ? T.n - ps.n0 : ps.done, ms = live ? NOW() - T.phaseT0 : ps.ms; left += Math.max(0, planned - done) * (done >= 3 ? ms / done : perAct); }
  return left;
}
function etaText(total) {
  const R = build(), rate = T.n / Math.max(1, R.dur / 1000), tests = ' · ' + rate.toFixed(1) + ' actions per second' + (BG.speed > 1 && T.running ? ', time ×' + BG.speed : '');
  if (T.running && T.plan) { const left = estimate(), fin = Date.now() + left; T.finishAt = T.finishAt && T.n > 5 ? T.finishAt * 0.85 + fin * 0.15 : fin; return T.n - (T.cycleBase || 0) < 3 ? 'estimating the finishing time…' : `${T.mode === 'endless' && T.endless ? 'Endless · round ' + T.endless.round + ' (' + T.endless.now + ') · ' : ''}${Math.round(Math.min(99.9, 100 * (T.n - (T.cycleBase || 0)) / total))}% of this round · about ${fmtDur(T.finishAt - Date.now())} left · done around ${clock(T.finishAt)}${tests}`; }
  if (!T.running && T.n && T.plan) return `${T.endReason || 'finished'} · took ${fmtDur(R.dur)}${tests}`;
  return T.running ? `running${tests}` : '';
}
function phasesHtml() { if (!T.plan) return ''; return Object.keys(T.plan).filter((k) => !['total', 'mode'].includes(k)).map((n) => { const ps = T.phases[n], planned = T.plan[n], done = !ps ? 0 : (n === T.phaseName && T.running ? T.n - ps.n0 : ps.done); return `<div style="display:flex;gap:8px;align-items:center;font-size:11px"><span style="width:130px">${esc(n)}</span><span style="width:64px" class="dim">${Math.min(done, planned)} / ${planned}</span><div class="bar" style="flex:1"><i style="width:${Math.min(100, 100 * done / Math.max(1, planned))}%"></i></div></div>`; }).join(''); }
function nowHtml() {
  const L = T.live, row = (k, v) => (v === '' || v == null ? '' : `<tr><td style="color:#98a2b3;white-space:nowrap;padding-right:10px;vertical-align:top">${k}</td><td>${v}</td></tr>`);
  if (!T.n && !T.running) return '<span class="dim">Press Start. This tab shows exactly what is being tested at each moment, and why.</span>';
  const chips = L.cats.length ? L.cats.map((c) => `<span title="${esc(c.what)}" class="${c.bad ? 'bad' : 'ok'}" style="border:1px solid #33333f;border-radius:9px;padding:0 6px;margin:1px 3px 1px 0;display:inline-block">${c.bad ? '✗' : '✓'} ${esc(c.cat)}</span>`).join('') : '<span class="dim">runs after the action settles</span>';
  const exp = EXPECT[L.kind] || '';
  const fr = L.fmax ? `${Math.round(L.ms)} ms · frames avg ${L.fAvg.toFixed(1)} ms, worst ${Math.round(L.fmax)} ms` : '';
  return `<table>${row('Phase', esc(L.phase) + (T.plan && T.phases[L.phase] ? ` · ${Math.min(T.plan[L.phase] || 0, T.n - T.phases[L.phase].n0)} of ${T.plan[L.phase] || 0}` : ''))}${row('Scenario', esc(L.scenario))}${row('Stage', esc(L.stage))}${row('Action', L.kind ? `<b>${esc(L.kind)}</b> ${esc(L.desc || '')}` : '')}${row('Purpose', L.kind && PURPOSE[L.kind] ? esc('To ' + PURPOSE[L.kind] + '.') : '')}${row('Expecting', esc(exp))}${row('Changed', L.diff ? (L.diff.length ? esc(L.diff.join(', ')) : '<span class="warn">nothing changed on screen</span>') : '')}${row('Response', fr)}${row('Checks', chips)}${row('Problems so far', T.issues.size ? `<span class="bad">${T.issues.size}</span>` : '<span class="ok">none</span>')}</table><div style="border-top:1px solid #232831;margin-top:6px;padding-top:4px;font:11px/1.4 ui-monospace,monospace;color:#b9b9c6;max-height:160px;overflow:auto">${L.trace.slice(-14).reverse().map((x) => `<div class="${x.bad ? 'bad' : ''}">${x.at}s · ${esc(x.text)}${x.changed && x.changed.length ? ' → ' + esc(x.changed.join(', ')) : ''} · ${x.ms} ms${x.bad ? ' · ' + x.bad + ' problem(s)' : ''}</div>`).join('')}</div>`;
}
function ui(force) {
  if (!el || (!T.open && !force)) return; lastUi = now();
  const R = build(), set = (id, v) => { const e = $('#' + id); if (e && e.textContent !== String(v)) e.textContent = v; };
  set('dtN', T.n); set('dtP', T.pass); set('dtF', T.fail); set('dtR', R.rate.toFixed(1)); set('dtT', fmtT(R.dur)); set('dtI', R.issues.length);
  const total = T.plan ? T.plan.total : T.max, pctDone = total ? Math.min(T.running ? 99.9 : 100, 100 * (T.n - (T.cycleBase || 0)) / total) : 0, bar = $('#dtBar'); if (bar) bar.style.width = (total ? pctDone : T.running ? (T.n % 100) : 0) + '%';
  set('dtEta', etaText(total)); const phEl = $('#dtPhases'); if (phEl) { const h = phasesHtml(); if (phEl.dataset.h !== h) { phEl.dataset.h = h; phEl.innerHTML = h; } }
  const s = $('[data-a=start]', el), p = $('[data-a=pause]', el), x = $('[data-a=stop]', el); s.disabled = T.running; p.disabled = !T.running; x.disabled = !T.running; s.textContent = T.running ? '● Running' : T.n ? '▶ Run again' : '▶ Start';
  const body = $('#dtBody'), atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  if (tab === 'now') body.innerHTML = nowHtml();
  else if (tab === 'log') { body.innerHTML = T.log.slice(-160).map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('') || '<span class="dim">Press Start. It will click, type, fuzz fields and press keys by itself, and check what happens. Leave this tab in front so the browser does not slow it.</span>'; if (atBottom) body.scrollTop = body.scrollHeight; }
  else if (tab === 'issues') { body.innerHTML = R.issues.length ? R.issues.map((i) => `<div class="iss"><h4 class="${i.sev === 'error' ? 'bad' : i.sev === 'warn' ? 'warn' : 'dim'}">${i.sev.toUpperCase()} · ${esc(i.kind)} · ×${i.count}</h4>${esc(i.msg)}${i.diag ? `<div class="dim">Likely cause: ${esc(i.diag)}</div>` : ''}<div class="dim">first at #${i.first} · ${esc([...i.actions].join(', '))}</div>${i.sample ? `<div class="dim">${esc(i.sample.slice(0, 200))}</div>` : ''}<div class="dim">${esc(i.repro.slice(-5).join('\n'))}</div></div>`).join('') : '<span class="ok">No problems found so far.</span>'; }
  else if (tab === 'report') body.textContent = reportText();
  else if (tab === 'cover') { const rows = [...T.cover.values()].sort((a, b) => a.n - b.n); body.innerHTML = `<div class="dim">${R.hit.length} of ${R.tot.length} controls used · ${T.pairs.size} combinations</div>` + rows.slice(0, 300).map((c) => `<div class="${c.n ? (c.bad ? 'bad' : 'ok') : 'dim'}">${String(c.n).padStart(4)} × ${esc(c.label)} <span class="dim">(${c.kind}${c.bad ? ', ' + c.bad + ' problems' : ''})</span></div>`).join(''); }
}
function toggle(force) {
  build_ui(); T.open = force == null ? !T.open : !!force; el.hidden = !T.open; if (T.open) ui(true);
}
window.DevTest = { toggle, start, stop, report: reportText, reportJSON, state: T, issues: () => [...T.issues.values()] };
})();
