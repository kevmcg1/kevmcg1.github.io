// Shows the version (version.js) as a small chip right under the logo, and opens the changelog when it is clicked,
// the same way Shop Tool Sim does. The list opens in the app's own dialog (#changelogOverlay), so Esc and a click on the dark area close it.
(function(){
  const V = window.__REM, ov = document.getElementById('changelogOverlay'), mark = document.querySelector('.logo-mark'); if (!V || !ov || !mark) return;
  const css = document.createElement('style');
  css.textContent = `
.rem-vrow{display:flex;margin:8px 0 0}
.rem-vchip{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;font:600 11px/1.3 var(--font);letter-spacing:.03em;color:var(--text-dim);background:transparent;border:1px solid var(--border);border-radius:999px;cursor:pointer;transition:color .22s ease,border-color .22s ease}
.rem-vchip:hover,.rem-vchip:focus-visible{color:var(--text);border-color:var(--text-dim);outline:none}
#changelogOverlay .modal{max-width:480px;max-height:calc(100% - 24px);overflow-y:auto;position:relative}
.rem-cl h3{margin:0 34px 0 0;font-size:18px;font-weight:600}
.rem-cl-sub{margin:2px 0 14px;color:var(--text-dim);font-size:12.5px}
.rem-cl h4{margin:16px 0 2px;font-size:14px;font-weight:600;display:flex;align-items:baseline;gap:8px}
.rem-cl h4 small{font-size:11.5px;font-weight:500;color:var(--text-dim)}
.rem-cl h4 em{font-style:normal;font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:1px 6px;border-radius:999px;background:var(--accent-soft);color:var(--accent)}
.rem-cl .t{margin:0 0 4px;color:var(--text-dim);font-size:12.5px}
.rem-cl ul{margin:0;padding-left:18px}
.rem-cl li{margin:0 0 4px;color:var(--text);font-size:13.5px;line-height:1.5}
.rem-cl-x{position:absolute;top:14px;right:14px}`;
  document.head.appendChild(css);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const modal = ov.querySelector('.modal');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Changelog');
  modal.innerHTML = '<div class="rem-cl"><button type="button" class="icon-btn rem-cl-x" id="changelogClose" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
    '<h3>What’s new</h3><p class="rem-cl-sub">Reminders · version ' + esc(V.version) + '</p>' +
    V.changelog.map((e, i) => '<h4>v' + esc(e.v) + (e.date ? ' <small>' + esc(e.date) + '</small>' : '') + (i === 0 ? ' <em>current</em>' : '') + '</h4>' +
      '<p class="t">' + esc(e.title) + '</p><ul>' + e.items.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>').join('') + '</div>';
  const open = () => { ov.classList.add('show'); modal.querySelector('#changelogClose').focus({ preventScroll: true }); };
  const close = () => ov.classList.remove('show');
  modal.querySelector('#changelogClose').addEventListener('click', close);
  const chip = document.createElement('button');
  chip.type = 'button'; chip.id = 'versionChip'; chip.className = 'rem-vchip'; chip.textContent = 'v' + V.version + ' · What’s new'; chip.title = 'Version ' + V.version + ' and the changelog';
  chip.addEventListener('click', open);
  const row = document.createElement('div'); row.className = 'rem-vrow'; row.appendChild(chip); mark.insertAdjacentElement('afterend', row);
})();
