// "How do I use this?": a hands-on walkthrough of making a first reminder, in the style of the Shop Tool Sim walkthroughs.
// Everything is dimmed except the one thing being shown, a card beside it says what to do, and each step waits for you to
// do it (or you can skip it, or let the card do it for you). Esc or the X leaves at any time. It works on the real app, so the
// practice reminder is a real one: the last step offers to delete it.
(function(){
  const $ = id => document.getElementById(id);
  const btn = $('guideBtn'); if (!btn) return;
  const R = () => (typeof reminders !== 'undefined' && Array.isArray(reminders) ? reminders : []);
  const cur = () => { try { return R().find(r => r.id === selectedId) || null; } catch (e) { return null; } };
  const q = sel => { try { return document.querySelector(sel); } catch (e) { return null; } };
  const shown = el => !!el && el.isConnected && el.getBoundingClientRect().width > 1 && getComputedStyle(el).visibility !== 'hidden';
  const setVal = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d && d.set ? d.set.call(el, v) : (el.value = v); };
  const press = (el, k) => { const o = { key: k, code: k, bubbles: true, cancelable: true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); };

  /* ---------- the first words: warm and confident, a different one each time ---------- */
  const OPENERS = [
    'Hi, and welcome. A reminder takes one sentence to write.\nI’ll show you where it goes, and you’ll have your first one saved in about a minute.',
    'Hello. Nobody remembers everything, and that’s exactly what this is for.\nLet’s make your first reminder together.',
    'Hey there. This is easier than it looks.\nFour small steps and you’ll have a reminder you can rely on.',
    'Welcome. You can type a reminder the way you’d say it out loud.\nI’ll show you how, one small step at a time.',
    'Hi. Reminders is simple once you’ve seen it once.\nLet’s make one, and you’ll be doing it on your own in no time.'
  ];
  let lastQ = -1; try { lastQ = +(localStorage.getItem('reminders.guideQuip.v1') || -1); } catch (e) {}
  const opener = () => { let i; do { i = Math.floor(Math.random() * OPENERS.length); } while (i === lastQ && OPENERS.length > 1); lastQ = i; try { localStorage.setItem('reminders.guideQuip.v1', String(i)); } catch (e) {} return OPENERS[i]; };

  /* ---------- the steps ---------- */
  const PHASES = { prep: { name: 'Get ready', c: '#5b93ea' }, do: { name: 'Try it yourself', c: '#5fcf8a' }, own: { name: 'Make it yours', c: '#e8c547' } };
  const STEPS = [
    { phase: 'prep', title: 'Let’s make your first reminder', text: () => opener() + '\nEverything except what I’m pointing at is dimmed. Skip any step, or press [[Esc]] to leave whenever you like.', next: 'Let’s go' },
    { phase: 'do', target: '#addBtn', title: 'Start a new reminder', text: 'Click <b>New Reminder</b>.\nA fresh, empty reminder opens on the right, ready for you to type.',
      enter: s => { s.n0 = R().length; }, waitFor: s => R().length > s.n0 && !!$('d-title'),
      assist: ['Click it for me', () => $('addBtn').click()], said: 'Nice. Your new reminder is open.',
      leave: s => { if (R().length > s.n0 && R()[0]) practiceId = R()[0].id; } },
    { phase: 'do', target: '#d-title', title: 'Say what it’s for', text: 'Type what you want to be reminded of, the way you’d say it out loud.\nTry: <b>Call mom tomorrow at 9am</b>\nWords like <b>tomorrow</b>, <b>at 9am</b> or <b>every Friday</b> are picked up as the date.',
      waitFor: () => { const t = $('d-title'); return !!t && t.value.trim().length >= 3; },
      assist: ['Type it for me', () => { const t = $('d-title'); if (!t) return; t.focus(); setVal(t, 'Call mom tomorrow at 9am'); t.dispatchEvent(new Event('input', { bubbles: true })); }], said: 'Perfect.' },
    { phase: 'do', target: '#d-title', title: 'Press Enter', text: 'Press [[Enter]].\nThe app reads the date out of your words, fills it in below, and tidies the title.\nNo date in your words? No problem. You can pick one in the next step.',
      waitFor: () => { const r = cur(); return !!r && !!r.due; },
      assist: ['Press it for me', () => { const t = $('d-title'); if (t) { t.focus(); press(t, 'Enter'); } }], said: 'There it is. The date is filled in.' },
    { phase: 'do', target: '#d-due-text', title: 'Check the date', text: 'Here’s the date it understood.\nNot right? Type it again, or pick a quick choice from the list beside it.' },
    { phase: 'own', target: '#d-urgency', title: 'How important is it?', text: 'Click one: <b>Low</b>, <b>Medium</b>, <b>High</b> or <b>Critical</b>.\nIt colors the dot beside the reminder in your list.',
      enter: s => { const r = cur(); s.u0 = r && r.urgency; }, waitFor: s => { const r = cur(); return !!r && r.urgency !== s.u0; },
      assist: ['Pick High for me', () => { const p = q('#d-urgency [data-urg="high"]'); if (p) p.click(); }], said: 'Nice.' },
    { phase: 'own', target: '#d-notes', title: 'Add notes or a checklist', text: 'Anything extra goes in <b>Notes</b>.\nFor a checklist, type an item under <b>Checklist</b> and press [[Enter]] for the next one.' },
    { phase: 'own', target: '.reminder-item.active .ri-check', title: 'Tick it off when it’s done', text: 'Click the <b>circle</b> beside your reminder.\nDone reminders move to a <b>Completed</b> section. Click the circle again to bring one back.',
      waitFor: () => { const r = cur(); return !!r && !!r.completed; },
      assist: ['Tick it for me', () => { const c = q('.reminder-item.active .ri-check'); if (c) c.click(); }], said: 'Done. That’s how it feels to finish one.' },
    { phase: 'own', target: '#search', title: 'Find anything fast', text: 'Type a word here to filter your reminders.\nIt looks in titles and notes. Clear the box to see everything again.' },
    { phase: 'own', target: '#settingsBtn', title: 'Make it yours', text: 'Open <b>Settings</b> for themes and layout, or to export a backup.\nYour reminders are saved in this browser, on this device.' },
    { phase: 'own', title: 'You’re all set', final: true, text: 'That’s all there is to it: <b>New Reminder</b>, type it, press [[Enter]].\nRun <b>How do I use this?</b> again any time.' }
  ];

  /* ---------- look ---------- */
  const css = `
.guide-row{padding:0 16px 12px;display:flex}
#guideBtn{flex:1;display:flex;align-items:center;justify-content:center;gap:9px;padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent);font-size:13px;font-weight:600;cursor:pointer;transition:var(--transition)}
#guideBtn:hover,#guideBtn:focus-visible{background:var(--accent);color:#fff;outline:none}
[data-theme="carbon"] #guideBtn:hover,[data-theme="carbon"] #guideBtn:focus-visible{color:#0a0a0a}
#guideBtn .gd-q{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;font-weight:800}
[data-theme="carbon"] #guideBtn .gd-q{color:#0a0a0a}
#guideBtn:hover .gd-q,#guideBtn:focus-visible .gd-q{background:rgba(255,255,255,.28)}
.gd{position:fixed;inset:0;z-index:900;pointer-events:none}
.gd-b{position:fixed;background:transparent;pointer-events:auto}
.gd-hole{position:fixed;left:0;top:0;width:0;height:0;border-radius:10px;pointer-events:none;box-shadow:0 0 0 2px var(--gd-c,var(--accent)),0 0 0 100vmax rgba(4,5,7,.74);transition:left .3s ease,top .3s ease,width .3s ease,height .3s ease}
.gd-hole.none{box-shadow:0 0 0 100vmax rgba(4,5,7,.74)}
.gd-hole.act::after{content:"";position:absolute;inset:-6px;border-radius:14px;border:2px solid var(--gd-c,var(--accent));animation:gd-pulse 1.4s ease-out infinite}
@keyframes gd-pulse{from{opacity:.9;transform:scale(.98)}to{opacity:0;transform:scale(1.08)}}
.gd-hand{position:fixed;left:0;top:0;width:34px;height:34px;font-size:30px;line-height:1;color:#fff;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));animation:gd-tap 1.3s ease-in-out infinite}
.gd-hand[hidden]{display:none}
@keyframes gd-tap{0%,100%{margin:0}45%{margin:-6px 0 0 -6px}60%{margin:-2px 0 0 -2px}}
.gd-card{position:fixed;left:0;top:0;width:min(340px,calc(100vw - 24px));pointer-events:auto;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);padding:16px 18px 14px;font-size:13.5px;line-height:1.55;animation:pop 180ms cubic-bezier(.2,.8,.3,1)}
.gd-badge{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gd-c,var(--accent));margin-bottom:6px}
.gd-badge::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--gd-c,var(--accent))}
.gd-card h4{margin:0 28px 8px 0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.gd-l{display:block;color:var(--text-dim)}
.gd-l + .gd-l{margin-top:7px}
.gd-l b{color:var(--text)}
.gd-l.act{color:var(--text);padding-left:11px;border-left:3px solid var(--gd-c,var(--accent))}
.gd-card kbd{display:inline-block;min-width:22px;padding:0 6px;border-radius:5px;border:1px solid var(--border);border-bottom-width:2px;background:var(--bg-elev-2);font:600 11.5px var(--font);color:var(--text);text-align:center}
.gd-said{margin-top:10px;padding:7px 10px;border-radius:8px;background:rgba(95,207,138,.14);color:#5fcf8a;font-weight:600;font-size:12.5px}
.gd-said[hidden]{display:none}
.gd-assist{display:block;width:100%;margin-top:10px;padding:7px 10px}
.gd-assist[hidden]{display:none}
.gd-bar{display:flex;gap:3px;margin-top:12px}
.gd-bar i{flex:1;height:4px;border-radius:2px;background:var(--border)}
.gd-foot{display:flex;align-items:center;gap:6px;margin-top:10px}
.gd-count{flex:1;font-size:11.5px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.gd-card .btn{padding:6px 12px;font-size:12.5px;border-radius:7px}
.gd-x{position:absolute;top:10px;right:10px;width:26px;height:26px;padding:0;display:grid;place-items:center;border-radius:50%;border:none;background:transparent;color:var(--text-dim);cursor:pointer}
.gd-x:hover,.gd-x:focus-visible{background:var(--bg-hover);color:var(--text);outline:none}
body.guiding{overflow:hidden}
@media (prefers-reduced-motion: reduce){.gd-hole{transition:none}.gd-hole.act::after,.gd-hand{animation:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ---------- running it ---------- */
  let root, hole, card, blockers, hand, i = 0, s = {}, raf = 0, practiceId = null, doneAt = 0, cardW = 0, cardH = 0, lastKey = '';
  const mk = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; (parent || root).appendChild(e); return e; };
  const fn = v => typeof v === 'function' ? v(s) : v;
  const lines = text => String(text).split('\n').map((l, n) => {
    const h = l.replace(/\[\[([^\]]+)\]\]/g, '<kbd>$1</kbd>');
    const act = /^(click|type|press|tick|try|pick)\b/i.test(l.replace(/<[^>]+>/g, '').trim());
    return `<span class="gd-l${act ? ' act' : ''}">${h}</span>`;
  }).join('');

  function open(){
    if (root) return;
    practiceId = null; i = 0;
    root = mk('div', 'gd', document.body); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'How do I use this? walkthrough');
    blockers = [0, 1, 2, 3].map(() => mk('div', 'gd-b'));
    hole = mk('div', 'gd-hole none'); hand = mk('i', 'gd-hand fa-solid fa-hand-pointer'); hand.hidden = true; hand.setAttribute('aria-hidden', 'true');
    card = mk('div', 'gd-card');
    document.body.classList.add('guiding'); document.addEventListener('keydown', onKey, true); window.addEventListener('resize', () => { lastKey = ''; });
    go(0); raf = requestAnimationFrame(tick);
  }
  function close(){
    if (!root) return;
    cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true);
    if (s.leave) { try { s.leave(s); } catch (e) {} }
    root.remove(); root = hole = card = hand = null; blockers = null; document.body.classList.remove('guiding'); btn.focus && btn.focus({ preventScroll: true });
  }
  function onKey(e){ if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } }

  function go(n){
    if (s.leave) { try { s.leave(s); } catch (e) {} }
    i = Math.max(0, Math.min(STEPS.length - 1, n)); const def = STEPS[i]; s = Object.assign({}, def); s.done = false; doneAt = 0; lastKey = '';
    if (s.enter) s.enter(s);
    const ph = PHASES[def.phase]; root.style.setProperty('--gd-c', ph.c);
    const final = !!def.final, had = !!practiceId && R().some(r => r.id === practiceId);
    card.innerHTML = `<div class="gd-badge">${ph.name}</div><button class="gd-x" type="button" aria-label="Close the walkthrough"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`
      + `<h4>${def.title}</h4>${lines(fn(def.text))}<div class="gd-said" hidden>${def.said || ''}</div>`
      + (def.assist ? `<button class="btn gd-assist" type="button">${def.assist[0]}</button>` : '')
      + (final && had ? `<button class="btn gd-assist gd-del" type="button">Delete my practice reminder</button>` : '')
      + `<div class="gd-bar">${STEPS.map((x, k) => `<i style="${k <= i ? 'background:' + PHASES[x.phase].c : ''}"></i>`).join('')}</div>`
      + `<div class="gd-foot"><span class="gd-count">Step ${i + 1} of ${STEPS.length}</span>${i ? '<button class="btn gd-back" type="button">Back</button>' : ''}<button class="btn btn-primary gd-next" type="button">${final ? 'Done' : def.next || (def.waitFor ? 'Skip this step' : 'Next')}</button></div>`;
    card.querySelector('.gd-x').onclick = close;
    card.querySelector('.gd-next').onclick = () => final ? close() : go(i + 1);
    const back = card.querySelector('.gd-back'); if (back) back.onclick = () => go(i - 1);
    const as = card.querySelector('.gd-assist:not(.gd-del)'); if (as) as.onclick = () => { try { def.assist[1](); } catch (e) {} };
    const del = card.querySelector('.gd-del'); if (del) del.onclick = () => { try { doDelete(practiceId); } catch (e) {} practiceId = null; del.remove(); };
    cardW = cardH = 0; const t = q(def.target || '#nope'); if (t) { try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
    const nx = card.querySelector('.gd-next'); if (nx) nx.focus({ preventScroll: true });
  }

  function place(box){
    const vw = innerWidth, vh = innerHeight; if (!cardW) { cardW = card.offsetWidth; cardH = card.offsetHeight; }
    let x, y; const g = 14, m = 12;
    if (!box) { x = (vw - cardW) / 2; y = (vh - cardH) / 2; }
    else if (vw < 720) { y = box.top + box.height / 2 > vh / 2 ? m : vh - cardH - m; x = (vw - cardW) / 2; }
    else {
      const spots = [[box.left + box.width + g, box.top], [box.left - cardW - g, box.top], [box.left, box.top + box.height + g], [box.left, box.top - cardH - g]];
      const fit = spots.find(([a, b]) => a >= m && b >= m && a + cardW <= vw - m && b + cardH <= vh - m) || spots[0]; [x, y] = fit;
    }
    x = Math.max(m, Math.min(vw - cardW - m, x)); y = Math.max(m, Math.min(vh - cardH - m, y));
    card.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }

  function tick(){
    if (!root) return; raf = requestAnimationFrame(tick);
    const blockedByDialog = !!document.querySelector('.overlay.show');   // a dialog (for example the first-reminder note) comes first
    root.style.visibility = blockedByDialog ? 'hidden' : 'visible'; if (blockedByDialog) return;
    const el = s.target ? q(s.target) : null, ok = shown(el); let box = null;
    if (ok) { const r = el.getBoundingClientRect(), p = 6; box = { left: r.left - p, top: r.top - p, width: r.width + p * 2, height: r.height + p * 2 }; }
    const key = box ? [box.left, box.top, box.width, box.height].map(Math.round).join() : 'none';
    if (key !== lastKey) {
      lastKey = key;
      if (box) { hole.className = 'gd-hole' + (s.waitFor || s.assist ? ' act' : ''); Object.assign(hole.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
        const [a, b, c, d] = blockers, W = innerWidth, H = innerHeight, set = (e, l, t, w, h) => Object.assign(e.style, { left: l + 'px', top: t + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px' });
        set(a, 0, 0, W, box.top); set(b, 0, box.top + box.height, W, H - box.top - box.height); set(c, 0, box.top, box.left, box.height); set(d, box.left + box.width, box.top, W - box.left - box.width, box.height);
        hand.hidden = !(s.waitFor || s.assist) || s.done; hand.style.transform = `translate(${Math.round(box.left + box.width - 22)}px,${Math.round(box.top + box.height - 14)}px)`;
      } else { hole.className = 'gd-hole none'; Object.assign(hole.style, { width: '0px', height: '0px' }); blockers.forEach(e => Object.assign(e.style, { left: '0px', top: '0px', width: '100vw', height: '100vh' })); hand.hidden = true; }
      place(box);
    }
    if (s.waitFor && !s.done) {
      let yes = false; try { yes = !!s.waitFor(s); } catch (e) {}
      if (yes) { s.done = true; doneAt = performance.now(); hand.hidden = true; const said = card.querySelector('.gd-said'); if (said && STEPS[i].said) said.hidden = false; const nx = card.querySelector('.gd-next'); if (nx) nx.textContent = 'Next'; const as = card.querySelector('.gd-assist:not(.gd-del)'); if (as) as.hidden = true; cardW = cardH = 0; lastKey = ''; }
    }
    if (s.done && doneAt && performance.now() - doneAt > 1300 && !s.final) { doneAt = 0; go(i + 1); }
  }

  btn.addEventListener('click', () => (root ? close() : open()));
  window.__guide = { open, close, get isOpen() { return !!root; }, get step() { return i; }, steps: STEPS.length };
})();
