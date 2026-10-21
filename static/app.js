/*
 * Evidence toku dílů: stránka aplikace (bez knihoven).
 *
 * Obrazovky: první spuštění → přihlášení → (nové heslo) → výběr oddělení → aplikace.
 * Záložky: Příjem na pracoviště, Export z pracoviště, Přehled, Na pracovištích, Správa, API pro IT.
 * Data jdou jen přes api.php (hlavička X-Etd). Čisté funkce pro čtečku jsou ve scan.js (ETDScan).
 */
(() => {
  'use strict';

  const CLIENT = 1;            // verze stránky pro server (ETD_MIN_CLIENT v lib/etd.php)
  const TZ = 'Europe/Prague';
  const SC = window.ETDScan;
  const app = document.getElementById('app');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let ST = null;               // stav ze serveru (api.php?action=state)
  let picking = false;         // otevřený výběr oddělení
  let loginNote = '';
  let pendingSearch = null;    // barcode, který se má otevřít v Přehledu

  /* ---------- místní nastavení (jen pohodlí na tomhle zařízení) ---------- */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('etd.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('etd.' + key, JSON.stringify(value)); } catch (e) { /* soukromé okno */ }
    },
    del(key) {
      try { localStorage.removeItem('etd.' + key); } catch (e) { /* soukromé okno */ }
    },
  };

  /* ---------- server ---------- */
  async function api(action, body, query) {
    const qs = new URLSearchParams({ action, ...(query || {}) });
    const opt = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Etd': '1', 'X-Etd-Client': String(CLIENT) } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('api.php?' + qs, opt); } catch (e) { throw new Error('Server je nedostupný. Zkontroluj připojení k síti a zkus to znovu.'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* prázdná odpověď */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Chyba serveru (${res.status}).`);
      err.status = res.status; err.data = data || {};
      if (res.status === 401 && err.data.login && action !== 'login' && action !== 'state') loggedOut(err.message);
      if (res.status === 403 && (err.data.pickDept || err.data.mustChange)) setTimeout(refreshState, 0);
      if (res.status === 426) toast(err.message, 'err', 12000);
      throw err;
    }
    return data;
  }

  async function refreshState() {
    try { ST = await api('state'); } catch (e) { /* zůstane poslední stav */ }
    route();
  }

  function loggedOut(message) {
    if (!ST || !ST.user) return;
    ST.user = null; loginNote = message; picking = false;
    route();
  }

  /* ---------- drobnosti ---------- */
  function toast(text, kind = '', ms = 4200) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    box.append(el);
    setTimeout(() => el.remove(), ms);
  }

  let actx = null;
  /** Krátký tón: ok (vysoký), warn (dva), err (hluboký). Vypíná se v menu. */
  function beep(kind) {
    if (!store.get('sound', true)) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const seq = kind === 'ok' ? [[1175, 0.09]] : kind === 'warn' ? [[740, 0.08], [740, 0.08]] : [[196, 0.32]];
      let t = actx.currentTime + 0.01;
      for (const [freq, dur] of seq) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = kind === 'err' ? 'square' : 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(kind === 'err' ? 0.12 : 0.22, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(actx.destination);
        o.start(t); o.stop(t + dur + 0.02);
        t += dur + 0.06;
      }
    } catch (e) { /* bez zvuku */ }
  }

  const fmtDay = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtFull = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const day = fmtDay.format(d), today = fmtDay.format(new Date());
    return (day === today ? 'dnes' : day) + ' ' + fmtTime.format(d);
  }
  const agoUnix = unix => SC.ago(Date.now() / 1000 - unix);
  const num = n => Number(n).toLocaleString('cs-CZ');
  const deptDot = code => `<span class="dot dept-${esc(code)}"></span>`;
  const deptTag = (code, name) => `<span class="dept-tag">${deptDot(code)}${esc(name)}</span>`;
  const actTag = r => `<span class="tag ${esc(r.action)}">${r.action === 'prijem' ? 'Příjem' : 'Export'}</span>`;
  const codeBtn = code => `<button class="code-btn" type="button" data-find="${esc(code)}">${esc(code)}</button>`;
  const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const logo = '<img class="logo" src="static/icon.svg" alt="">';
  const recLine = r => `${r.action_label} · ${esc(r.department_label)}${r.position ? ` · pozice <b>${esc(r.position)}</b>` : ''}${r.quantity != null ? ` · <b>${num(r.quantity)} ks</b>` : ''}`;

  /**
   * Dialog s formulářem. validate(form) vrátí chybu (text), nebo null; smí být async
   * (tam se dělá i uložení na server, ať dialog při chybě zůstane otevřený).
   */
  function dialog({ title, html, ok = 'Uložit', cancel = 'Zrušit', danger = false, wide = false, onOpen, validate }) {
    return new Promise(resolve => {
      const back = document.activeElement;
      const d = document.createElement('dialog');
      d.className = 'dlg' + (wide ? ' wide' : '');
      d.innerHTML = `<form class="dlg-form" novalidate><h2>${esc(title)}</h2><div class="dlg-body">${html}</div><p class="dlg-error" hidden></p>
        <div class="dlg-actions">${cancel ? `<button class="btn ghost" type="button" data-cancel>${esc(cancel)}</button>` : ''}${ok ? `<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(ok)}</button>` : ''}</div></form>`;
      document.body.append(d);
      const form = $('form', d), error = $('.dlg-error', d);
      let busy = false;
      const close = okay => { d.close(); d.remove(); resolve({ ok: okay, form }); if (back && back.focus) back.focus(); };
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        const submit = $('[type=submit]', d); if (submit) submit.disabled = true;
        let msg = null;
        try { msg = validate ? await validate(form) : null; } catch (err) { msg = err.message; }
        busy = false; if (submit) submit.disabled = false;
        if (msg) { error.textContent = msg; error.hidden = false; return; }
        close(true);
      });
      $('[data-cancel]', d)?.addEventListener('click', () => close(false));
      d.addEventListener('cancel', e => { e.preventDefault(); close(false); });
      d.showModal();
      if (onOpen) onOpen(d);
      const first = $('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea', d);
      if (first) first.focus();
    });
  }

  /** Dočasné heslo pro nového uživatele (bez znaků, které se pletou: 0/O, 1/l/I). */
  function randomPassword() {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const chars = [...bytes].map(b => abc[b % abc.length]);
    return chars.slice(0, 5).join('') + '-' + chars.slice(5).join('');
  }

  async function copyText(text, button) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch (err) { /* nic */ } t.remove();
    }
    if (button) { const old = button.textContent; button.textContent = 'Zkopírováno'; setTimeout(() => { button.textContent = old; }, 1600); }
  }

  /* ---------- směrování ---------- */
  function route() {
    document.body.className = '';
    if (!ST) return;
    if (ST.setup) return renderSetup();
    if (!ST.user) return renderLogin();
    if (ST.user.mustChange) return renderNewPassword();
    if (!ST.dept || picking) return renderPicker();
    renderApp();
  }

  function welcome(inner) {
    app.innerHTML = `<div class="welcome">
      <section class="welcome-hero">
        ${logo}
        <h1>Evidence toku dílů</h1>
        <p>Příjem a export průvodek na pracovištích. Načti barcode čtečkou a systém zapíše, kde díly jsou, kdo je převzal a kolik kusů odešlo.</p>
        <div class="flow" aria-label="Pracoviště">${(ST.depts || []).map(d => `<span>${deptDot(d.code)}${esc(d.name)}</span>`).join('')}</div>
      </section>
      <section class="welcome-side">${inner}</section></div>`;
  }

  function formError(form, message) {
    let box = $('.form-error', form);
    if (!box) { box = document.createElement('p'); box.className = 'form-error'; form.prepend(box); }
    box.textContent = message;
  }

  function renderSetup() {
    welcome(`<form class="login-card" id="setupForm" novalidate>
      <h2>První spuštění</h2>
      <p class="lead">Založ prvního správce. Ostatní uživatele pak přidáš ve Správě.</p>
      <p class="form-note">Kód pro první spuštění vypíše instalace na serveru. Znovu ho vypíše příkaz<br><code>sudo runuser -u www-data -- env ETD_DATA_DIR=/var/lib/evidence_toku_dilu php /var/www/evidence_toku_dilu/bin/setup-token.php</code></p>
      <label class="field"><span>Kód pro první spuštění</span><input type="text" name="token" autocomplete="off" required placeholder="XXXX-XXXX-XXXX"></label>
      <label class="field"><span>Jméno a příjmení</span><input type="text" name="name" autocomplete="name" maxlength="80" required></label>
      <label class="field"><span>Přihlašovací jméno</span><input type="text" name="login" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="40" required placeholder="např. novak"></label>
      <label class="field"><span>Heslo (aspoň ${ST.limits.password} znaků)</span><input type="password" name="password" autocomplete="new-password" required></label>
      <label class="field"><span>Heslo znovu</span><input type="password" name="password2" autocomplete="new-password" required></label>
      <button class="btn primary big" type="submit">Založit správce</button>
    </form>`);
    const form = $('#setupForm');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = form.elements;
      if (f.password.value !== f.password2.value) return formError(form, 'Hesla se neshodují.');
      try {
        ST = await api('setup', { token: f.token.value, name: f.name.value, login: f.login.value, password: f.password.value });
        route();
      } catch (err) { formError(form, err.message); }
    });
  }

  function renderLogin() {
    welcome(`<form class="login-card" id="loginForm" novalidate>
      <h2>Přihlášení</h2>
      <p class="lead">Po přihlášení si vybereš oddělení, na kterém pracuješ.</p>
      ${loginNote ? `<p class="form-error">${esc(loginNote)}</p>` : ''}
      <label class="field"><span>Přihlašovací jméno</span><input type="text" name="login" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="60" required value="${esc(store.get('lastLogin', ''))}"></label>
      <label class="field"><span>Heslo</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary big" type="submit">Přihlásit se</button>
      <p class="hint mt-14">Zapomenuté heslo nastaví nové správce.</p>
    </form>`);
    const form = $('#loginForm');
    const f = form.elements;
    (f.login.value ? f.password : f.login).focus();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!f.login.value.trim() || !f.password.value) return formError(form, 'Vyplň přihlašovací jméno a heslo.');
      const button = $('[type=submit]', form); button.disabled = true;
      try {
        ST = await api('login', { login: f.login.value.trim(), password: f.password.value });
        store.set('lastLogin', f.login.value.trim().toLowerCase());
        loginNote = ''; picking = false;
        route();
      } catch (err) {
        button.disabled = false; f.password.value = ''; f.password.focus();
        formError(form, err.message);
      }
    });
  }

  function passwordFields(current) {
    return `<label class="field"><span>${current}</span><input type="password" name="old" autocomplete="current-password" required></label>
      <label class="field"><span>Nové heslo (aspoň ${ST.limits.password} znaků)</span><input type="password" name="new" autocomplete="new-password" required></label>
      <label class="field"><span>Nové heslo znovu</span><input type="password" name="new2" autocomplete="new-password" required></label>`;
  }

  function renderNewPassword() {
    welcome(`<form class="login-card" id="pwForm" novalidate>
      <h2>Nastav si vlastní heslo</h2>
      <p class="lead">${esc(ST.user.name)}, heslo ti nastavil správce. Než začneš, změň ho na vlastní.</p>
      ${passwordFields('Heslo od správce')}
      <button class="btn primary big" type="submit">Uložit heslo</button>
      <p class="mt-12"><button class="linkish" type="button" data-logout>Odhlásit</button></p>
    </form>`);
    const form = $('#pwForm');
    $('[data-logout]', form).onclick = logout;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = form.elements;
      if (f.new.value !== f.new2.value) return formError(form, 'Nová hesla se neshodují.');
      try { ST = await api('password', { old: f.old.value, new: f.new.value }); toast('Heslo je uložené.'); route(); }
      catch (err) { formError(form, err.message); }
    });
  }

  async function changePassword() {
    await dialog({
      title: 'Změnit heslo', ok: 'Uložit heslo', html: passwordFields('Současné heslo') + '<p class="hint">Na ostatních počítačích tě změna hesla odhlásí.</p>',
      validate: async form => {
        const f = form.elements;
        if (f.new.value !== f.new2.value) return 'Nová hesla se neshodují.';
        try { ST = await api('password', { old: f.old.value, new: f.new.value }); } catch (err) { return err.message; }
        toast('Heslo je změněné.');
        return null;
      },
    });
  }

  async function logout() {
    try { await api('logout', {}); } catch (e) { /* i tak pryč */ }
    ST.user = null; ST.dept = null; loginNote = ''; picking = false;
    route();
  }

  /* ---------- výběr oddělení ---------- */
  function renderPicker() {
    const allowed = ST.user.depts;
    const tiles = [...ST.depts.map(d => ({ ...d, note: allowed.includes(d.code) ? 'příjem a export průvodek' : 'nemáš přístup', off: !allowed.includes(d.code) })),
      { code: 'visitor', name: 'Visitor', note: 'pouze nahlíží do systému', off: false }];
    app.innerHTML = `<header class="top"><div class="top-in"><div class="brand">${logo}<div><b>Evidence toku dílů</b><small>${esc(ST.user.name)}</small></div></div>
      <button class="btn ghost small on-dark" type="button" data-logout>Odhlásit</button></div></header>
      <main class="picker">
        <div class="picker-head"><div><h1>Na kterém oddělení pracuješ?</h1><p>Vyber kliknutím nebo klávesou 1 až ${tiles.length}. Oddělení jde kdykoli změnit nahoře v liště.</p></div>
          ${ST.dept ? '<button class="btn" type="button" data-back>Zpět</button>' : ''}</div>
        <div class="tiles">${tiles.map((t, i) => `<button class="tile dept-${t.code}${ST.dept === t.code ? ' current' : ''}" type="button" data-dept="${t.code}"${t.off ? ' disabled' : ''}>
          <span class="num">${i + 1}</span><b>${esc(t.name)}</b><small>${esc(t.note)}</small></button>`).join('')}</div>
      </main>`;
    $('[data-logout]').onclick = logout;
    const back = $('[data-back]'); if (back) back.onclick = () => { picking = false; route(); };
    $$('[data-dept]').forEach(b => { b.onclick = () => chooseDept(b.dataset.dept); });
    const first = $('.tile.current') || $('.tile:not(:disabled)'); if (first) first.focus();
  }

  async function chooseDept(code) {
    try {
      ST = await api('dept', { dept: code });
      picking = false;
      if (!location.hash || !allowedTab(location.hash.slice(1).split('?')[0])) history.replaceState(null, '', '#' + tabs()[0][0]);
      route();
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ---------- aplikace ---------- */
  function tabs() {
    const t = [];
    if (ST.canWrite) t.push(['prijem', 'Příjem na pracoviště'], ['export', 'Export z pracoviště']);
    t.push(['prehled', 'Přehled'], ['onsite', 'Na pracovištích']);
    if (ST.isAdmin) t.push(['admin', 'Správa'], ['api', 'API pro IT']);
    return t;
  }
  const allowedTab = id => tabs().some(t => t[0] === id);
  function currentTab() {
    const id = (location.hash || '').slice(1).split('?')[0];
    return allowedTab(id) ? id : tabs()[0][0];
  }

  function renderApp() {
    const sound = store.get('sound', true), fix = store.get('fixLayout', true);
    app.innerHTML = `<header class="top"><div class="top-in">
        <div class="brand">${logo}<div><b>Evidence toku dílů</b><small>${ST.canWrite ? 'příjem a export průvodek' : 'jen nahlížení'}</small></div></div>
        <button class="dept-pill" type="button" data-pick title="Změnit oddělení">${deptDot(ST.dept)}${esc(ST.deptName)} <small>změnit</small></button>
        <div class="user-box"><button class="user-btn" type="button" data-menu aria-haspopup="true" aria-expanded="false"><span class="avatar">${esc(initials(ST.user.name))}</span><span class="uname">${esc(ST.user.name)}</span> ▾</button>
          <div class="menu" hidden>
            <div class="who"><b>${esc(ST.user.name)}</b><small>${esc(ST.user.login)} · ${esc(ST.user.roleLabel)}</small></div>
            <button type="button" data-m="pick">Změnit oddělení <span>${esc(ST.deptName)}</span></button>
            <button type="button" data-m="password">Změnit heslo</button>
            <button type="button" data-m="sound">Zvuk při načtení <span>${sound ? 'zapnutý' : 'vypnutý'}</span></button>
            <button type="button" data-m="fix" title="Čtečka s anglickou klávesnicí píše v české klávesnici místo číslic ěščř…">Oprava české klávesnice <span>${fix ? 'zapnutá' : 'vypnutá'}</span></button>
            <button type="button" data-m="logout">Odhlásit</button>
          </div></div>
      </div></header>
      <nav class="tabs" aria-label="Části aplikace"><div class="tabs-in">${tabs().map(([id, label]) => `<button class="tab t-${id}" type="button" data-tab="${id}">${esc(label)}</button>`).join('')}</div></nav>
      <main id="view" class="wrap"></main>`;
    $('[data-pick]').onclick = () => { picking = true; route(); };
    const menuBtn = $('[data-menu]'), menu = $('.menu');
    menuBtn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.setAttribute('aria-expanded', String(!menu.hidden)); };
    menu.onclick = async e => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      menu.hidden = true;
      const m = b.dataset.m;
      if (m === 'pick') { picking = true; route(); }
      if (m === 'password') changePassword();
      if (m === 'logout') logout();
      if (m === 'sound') { store.set('sound', !store.get('sound', true)); renderApp(); if (store.get('sound', true)) beep('ok'); }
      if (m === 'fix') { store.set('fixLayout', !store.get('fixLayout', true)); renderApp(); }
    };
    $$('[data-tab]').forEach(b => { b.onclick = () => { if (location.hash.slice(1).split('?')[0] !== b.dataset.tab) location.hash = b.dataset.tab; else showTab(); }; });
    showTab();
  }

  function showTab() {
    const id = currentTab();
    $$('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
    const view = $('#view');
    if (!view) return;
    view.innerHTML = '';
    if (id === 'prijem' || id === 'export') scanView(view, id);
    else if (id === 'prehled') overviewView(view);
    else if (id === 'onsite') onsiteView(view);
    else if (id === 'admin') adminView(view);
    else if (id === 'api') apiView(view);
  }

  window.addEventListener('hashchange', () => { if (ST && ST.user && ST.dept && !picking && !ST.user.mustChange) showTab(); });
  document.addEventListener('click', e => {
    const menu = $('.menu');
    if (menu && !menu.hidden && !e.target.closest('.user-box')) menu.hidden = true;
    const find = e.target.closest('[data-find]');
    if (find) { pendingSearch = find.dataset.find; if (currentTab() === 'prehled') showTab(); else location.hash = 'prehled'; }
  });

  // Čtečka píše jako klávesnice: když nic nemá fokus, znaky jdou do pole pro barcode.
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || e.key === ' ') return;
    if (document.querySelector('dialog[open]')) return;
    const a = document.activeElement;
    if (a && a !== document.body && (a.matches('input, textarea, select, [contenteditable]') || a.closest('.menu'))) return;
    if (!a || a === document.body || a.matches('button, a, .tab')) {
      if (/^[1-9]$/.test(e.key) && $('.picker')) { const t = $$('.tile')[+e.key - 1]; if (t && !t.disabled) { e.preventDefault(); t.click(); } return; }
      const target = $('#scanInput') || $('#searchInput');
      // starý text se označí, ať ho další načtení přepíše a nepřipíše se za něj
      if (target && !target.disabled) { target.focus(); target.select(); }
    }
  });

  /* ---------- příjem a export ---------- */
  function scanView(view, action) {
    const isIn = action === 'prijem';
    const optKey = 'opts.' + action;
    const opts = { multi: false, pos: false, position: '', ...store.get(optKey, {}) };
    const batchKey = `batch.${ST.dept}.${action}`;
    let batch = (store.get(batchKey, []) || []).filter(x => x && typeof x.code === 'string').map(x => ({ code: x.code, qty: x.qty || '', info: undefined, status: '', msg: '' }));
    let pending = null;    // export jedné průvodky: čeká se na počet kusů
    let busy = false;
    const saveOpts = () => store.set(optKey, { multi: opts.multi, pos: opts.pos, position: opts.position });
    const saveBatch = () => { if (batch.length) store.set(batchKey, batch.map(x => ({ code: x.code, qty: x.qty }))); else store.del(batchKey); };
    const label = isIn ? 'Příjem na pracoviště' : 'Export z pracoviště';

    view.innerHTML = `<section class="card scan a-${action}">
        <div class="scan-top"><div><p class="eyebrow">${deptDot(ST.dept)}${esc(ST.deptName)}</p><h1>${label}</h1></div>
          <label class="switch"><input type="checkbox" id="optMulti"${opts.multi ? ' checked' : ''}><span class="track"></span><span>${isIn ? 'Vícenásobný příjem' : 'Vícenásobný export'}</span></label></div>
        <form id="scanForm" autocomplete="off" novalidate>
          <label class="scan-label" for="scanInput">Načti barcode průvodky čtečkou</label>
          <div class="scan-row"><input id="scanInput" class="scan-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="${ST.limits.barcode + 20}" placeholder="Barcode nebo QR průvodky" aria-describedby="scanHint">
            <button class="btn primary big" type="submit" id="scanBtn"></button></div>
          <p class="scan-hint" id="scanHint"></p>
          ${isIn ? `<div class="scan-opts"><label class="check"><input type="checkbox" id="optPos"${opts.pos ? ' checked' : ''}> Definovat pozici kam se umístí</label>
            <input id="posInput" class="pos-input" type="text" list="posList" maxlength="${ST.limits.position}" placeholder="Pozice, např. Regál A3" value="${esc(opts.position)}" aria-label="Pozice, kam se díly umístí"${opts.pos ? '' : ' hidden'}>
            <datalist id="posList"></datalist></div>` : ''}
        </form>
        <div id="qtyPanel" class="qty-panel" hidden></div>
        <div id="scanResult" aria-live="polite"></div>
      </section>
      <section class="card" id="batchBox" hidden></section>
      <section class="card"><div class="card-head"><h2>Poslední záznamy na pracovišti ${esc(ST.deptName)}</h2><button class="btn small" type="button" id="recentReload">Obnovit</button></div><div id="recentBox"><p class="empty">Načítám…</p></div></section>`;

    const input = $('#scanInput'), form = $('#scanForm'), result = $('#scanResult'), qtyPanel = $('#qtyPanel'), batchBox = $('#batchBox');
    const posBox = $('#posInput'), posCheck = $('#optPos');

    function syncTexts() {
      $('#scanBtn').textContent = opts.multi ? 'Přidat' : isIn ? 'Přijmout' : 'Pokračovat';
      $('#scanHint').textContent = opts.multi
        ? `Načítej průvodky jednu po druhé. ${isIn ? '' : 'U každé zadej počet kusů. '}Nakonec klikni na Zapsat vše.`
        : isIn ? 'Po načtení se příjem hned zapíše.' : 'Po načtení zadej počet kusů a potvrď Enterem.';
      batchBox.hidden = !opts.multi;
    }
    function focusScan() { if (!pending) input.focus(); }
    function position() { return isIn && opts.pos ? SC.clean(posBox.value).replace(/\s+/g, ' ') : ''; }
    function needPosition() {
      if (!isIn || !opts.pos || position()) return false;
      posBox.classList.add('need'); posBox.focus();
      showResult('err', 'Vyplň pozici', ['Je zapnuté „Definovat pozici kam se umístí“. Napiš pozici, nebo volbu vypni.']);
      beep('err');
      return true;
    }

    function showResult(kind, title, lines, code, actions) {
      result.innerHTML = `<div class="result ${kind}"><span class="ico">${kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '✕'}</span><div>
        <h3>${esc(title)}</h3>${code ? `<div class="code">${esc(code)}</div>` : ''}<div class="lines">${lines.map(l => `<span>${l}</span>`).join('')}</div>
        ${actions ? `<div class="acts">${actions}</div>` : ''}</div></div>`;
    }

    /** Výsledek jedné průvodky (jednotlivý režim). */
    function showOne(r, item) {
      if (r.status === 'ok') {
        const rec = r.record, prev = r.previous;
        showResult('ok', isIn ? `Přijato na pracoviště ${ST.deptName}` : `Export z pracoviště ${ST.deptName}`, [
          rec.position ? `Pozice: <b>${esc(rec.position)}</b>` : '', rec.quantity != null ? `Počet: <b>${num(rec.quantity)} ks</b>` : '',
          prev ? `Předtím: ${recLine(prev)} · ${esc(agoUnix(prev.recorded_at_unix))}` : 'První záznam této průvodky.',
        ].filter(Boolean), rec.barcode, `<span class="muted small">zapsáno ${esc(when(rec.recorded_at))}</span>`);
        beep('ok');
      } else if (r.status === 'duplicate') {
        const l = r.last;
        showResult('warn', 'Už je zapsáno', [`${recLine(l)} · ${esc(agoUnix(l.recorded_at_unix))} (${esc(l.user)}).`, 'Nejspíš dvojí načtení. Když jde opravdu o další záznam, zapiš ho znovu.'],
          r.barcode, '<button class="btn small" type="button" data-force>Zapsat znovu</button>');
        $('[data-force]', result).onclick = async () => {
          const data = await send([item], true);
          if (data) { showOne(data.results[0], item); loadRecent(); }
          focusScan();
        };
        beep('warn');
      } else {
        showResult('err', 'Nezapsáno', [esc(r.message || 'Neznámá chyba.')], r.barcode);
        beep('err');
      }
    }

    async function send(items, force) {
      if (busy) return;
      if (needPosition()) return;
      busy = true;
      try {
        const data = await api('scan', { action, items: items.map(x => ({ barcode: x.code, qty: isIn ? undefined : SC.qty(x.qty, ST.limits.qty) })), position: position(), definePosition: isIn && opts.pos, force: !!force });
        return data;
      } catch (err) {
        showResult('err', 'Nezapsáno', [esc(err.message)]);
        beep('err');
        return null;
      } finally {
        busy = false;
      }
    }

    async function single(code) {
      if (isIn) {
        const data = await send([{ code }]);
        if (data) { showOne(data.results[0], { code }); loadRecent(); loadPositions(); }
        focusScan();
        return;
      }
      askQty(code);
    }

    function askQty(code) {
      pending = { code };
      qtyPanel.hidden = false;
      qtyPanel.innerHTML = `<form id="qtyForm" novalidate><p class="eyebrow">Export průvodky</p><div class="code">${esc(code)}</div>
        <p class="small muted" id="qtyInfo">Načítám poslední záznam…</p>
        <div class="qty-row"><label for="qtyInput" class="unit">Počet kusů</label><input id="qtyInput" class="qty-input" type="text" inputmode="numeric" autocomplete="off" maxlength="9"><span class="unit">ks</span>
          <button class="btn primary big" type="submit">Zapsat export</button><button class="btn ghost" type="button" data-qcancel>Zrušit (Esc)</button></div></form>`;
      const qf = $('#qtyForm'), qi = $('#qtyInput');
      qi.focus();
      lastInfo(code).then(l => { const box = $('#qtyInfo'); if (box) box.innerHTML = l ? `Poslední záznam: ${recLine(l)} · ${esc(agoUnix(l.recorded_at_unix))}` : 'Průvodka zatím nemá žádný záznam.'; });
      const cancel = () => { pending = null; qtyPanel.hidden = true; qtyPanel.innerHTML = ''; input.focus(); };
      $('[data-qcancel]', qf).onclick = cancel;
      qi.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
      qf.addEventListener('submit', async e => {
        e.preventDefault();
        const raw = qi.value;
        const n = SC.qty(raw, ST.limits.qty);
        if (n === null) {
          // čtečka načetla další průvodku dřív, než se zadal počet kusů
          const looksLikeCode = SC.clean(raw).length > 7 || /[^\d\s]/.test(raw);
          qi.value = ''; qi.focus(); beep('err');
          showResult('err', looksLikeCode ? 'Nejdřív zadej počet kusů' : 'Neplatný počet kusů',
            [looksLikeCode ? `Pro průvodku ${esc(code)} chybí počet kusů. Načtená průvodka se nezapsala.` : `Zadej celé číslo od 1 do ${num(ST.limits.qty)}.`]);
          return;
        }
        const data = await send([{ code, qty: String(n) }]);
        if (!data) { qi.focus(); return; }
        const r = data.results[0];
        if (r.status === 'error') { showOne(r, { code, qty: String(n) }); qi.focus(); return; }
        pending = null; qtyPanel.hidden = true; qtyPanel.innerHTML = '';
        showOne(r, { code, qty: String(n) });
        loadRecent();
        input.focus();
      });
    }

    const infoCache = new Map();
    async function lastInfo(code) {
      const key = code.toLowerCase();
      if (infoCache.has(key)) return infoCache.get(key);
      try { const d = await api('last', undefined, { barcode: code }); infoCache.set(key, d.last); return d.last; } catch (e) { return undefined; }
    }

    /* --- dávka (vícenásobný příjem / export) --- */
    function addToBatch(code) {
      const dup = batch.findIndex(x => SC.same(x.code, code));
      if (dup >= 0) {
        beep('warn');
        showResult('warn', 'Už je v seznamu', ['Tahle průvodka už je mezi načtenými.'], batch[dup].code);
        renderBatch(dup);
        return;
      }
      if (batch.length >= ST.limits.batch) { beep('err'); showResult('err', 'Seznam je plný', [`Najednou jde zapsat nejvýš ${ST.limits.batch} průvodek. Nejdřív zapiš načtené.`]); return; }
      batch.push({ code, qty: '', info: undefined, status: '', msg: '' });
      saveBatch();
      beep('ok');
      result.innerHTML = '';
      renderBatch(batch.length - 1);
      const item = batch[batch.length - 1];
      lastInfo(code).then(l => { item.info = l === undefined ? undefined : l; updateInfo(item); });
      if (!isIn) { const q = $(`[data-q="${batch.length - 1}"]`); if (q) q.focus(); }
      else focusScan();
    }

    function infoHtml(item) {
      if (item.status === 'duplicate' || item.status === 'error') return `<b>${esc(item.msg)}</b>`;
      if (item.info === undefined) return '<span class="muted">…</span>';
      if (item.info === null) return '<span class="muted">bez záznamu</span>';
      return `${recLine(item.info)}<span class="sub">${esc(when(item.info.recorded_at))} · ${esc(item.info.user)}</span>`;
    }
    function updateInfo(item) {
      const i = batch.indexOf(item);
      const cell = $(`[data-info="${i}"]`);
      if (cell) cell.innerHTML = infoHtml(item);
    }

    function renderBatch(flash) {
      if (!opts.multi) { batchBox.hidden = true; return; }
      batchBox.hidden = false;
      const dupN = batch.filter(x => x.status === 'duplicate').length;
      const pos = position();
      batchBox.innerHTML = `<div class="card-head"><h2>${isIn ? 'Načtené průvodky k příjmu' : 'Načtené průvodky k exportu'}<span class="count">${batch.length}</span></h2>
          <div class="row">${batch.length ? '<button class="btn small" type="button" data-bclear>Vyprázdnit seznam</button>' : ''}</div></div>
        ${batch.length ? `<div class="tbl-wrap"><table class="tbl stack"><thead><tr><th>#</th><th>Barcode</th>${isIn ? '' : '<th class="num">Počet ks</th>'}<th>Poslední záznam</th><th></th></tr></thead><tbody>
          ${batch.map((x, i) => `<tr class="${x.status ? 'st-' + x.status : ''}${i === flash ? ' flash' : ''}"><td class="muted">${i + 1}</td><td class="code" data-wide>${esc(x.code)}</td>
            ${isIn ? '' : `<td class="num"><input class="row-qty${x.qtyBad ? ' need' : ''}" type="text" inputmode="numeric" autocomplete="off" maxlength="9" data-q="${i}" value="${esc(x.qty)}" aria-label="Počet kusů pro ${esc(x.code)}"> ks</td>`}
            <td data-info="${i}" data-wide>${infoHtml(x)}</td><td><button class="btn ghost small" type="button" data-bdel="${i}" aria-label="Odebrat ${esc(x.code)}">Odebrat</button></td></tr>`).join('')}
          </tbody></table></div>` : `<p class="empty">Zatím nic. Načti první průvodku čtečkou.</p>`}
        <div class="batch-foot"><div class="info">
            ${isIn ? (opts.pos ? (pos ? `<span>Pozice pro všechny: <b>${esc(pos)}</b></span>` : '<span class="tag crit">Vyplň pozici</span>') : '<span class="muted">Bez pozice (zapni „Definovat pozici kam se umístí“)</span>')
              : `<span class="fill-qty">Počet ks všem prázdným <input id="fillQty" type="text" inputmode="numeric" maxlength="9"><button class="btn small" type="button" data-fill>Doplnit</button></span>`}
          </div>
          <div class="row-8">${dupN ? `<button class="btn" type="button" data-bforce>Zapsat přesto (${dupN})</button>` : ''}
          <button class="btn primary big" type="button" data-bsave${batch.length ? '' : ' disabled'}>Zapsat vše (${batch.length})</button></div></div>`;
    }

    async function saveBatchNow(force) {
      const list = force ? batch.filter(x => x.status === 'duplicate') : batch;
      if (!list.length) return;
      if (!isIn) {
        let bad = 0;
        list.forEach(x => { x.qtyBad = SC.qty(x.qty, ST.limits.qty) === null; if (x.qtyBad) bad++; });
        if (bad) { renderBatch(); beep('err'); showResult('err', 'Chybí počet kusů', [`${bad} ${SC.plural(bad, 'průvodka nemá', 'průvodky nemají', 'průvodek nemá')} vyplněný počet kusů (celé číslo od 1).`]); const q = $('.row-qty.need'); if (q) q.focus(); return; }
      }
      const data = await send(list, force);
      if (!data) return;
      const done = new Set();
      data.results.forEach((r, i) => {
        const x = list[i];
        if (!x) return;
        if (r.status === 'ok' || r.status === 'repeat') done.add(x);
        else { x.status = r.status; x.msg = r.status === 'duplicate' ? `Už zapsáno ${agoUnix(r.last.recorded_at_unix)} (${r.last.user})` : r.message; }
      });
      batch = batch.filter(x => !done.has(x));
      saveBatch();
      const left = batch.length;
      const dupN = batch.filter(x => x.status === 'duplicate').length;
      const pos = position();
      if (data.written) {
        showResult(left ? 'warn' : 'ok', `${isIn ? 'Přijato' : 'Exportováno'} ${data.written} ${SC.plural(data.written, 'průvodka', 'průvodky', 'průvodek')}`,
          [`${isIn ? 'Na pracoviště' : 'Z pracoviště'} ${esc(ST.deptName)}${pos ? `, pozice <b>${esc(pos)}</b>` : ''}.`,
            left ? `V seznamu ${left === 1 ? 'zůstala 1 průvodka' : `zůstaly ${left} průvodky`}: ${dupN ? 'už zapsané před chvílí (Zapsat přesto)' : 'zkontroluj je'}.` : ''].filter(Boolean));
        beep(left ? 'warn' : 'ok');
      } else {
        showResult('warn', 'Nic se nezapsalo', [dupN ? 'Průvodky v seznamu už jsou zapsané před chvílí. Když jde opravdu o další záznam, klikni na Zapsat přesto.' : 'Zkontroluj průvodky v seznamu.']);
        beep('warn');
      }
      renderBatch();
      loadRecent(); loadPositions();
      focusScan();
    }

    batchBox.addEventListener('click', async e => {
      const del = e.target.closest('[data-bdel]');
      if (del) { batch.splice(+del.dataset.bdel, 1); saveBatch(); renderBatch(); focusScan(); return; }
      if (e.target.closest('[data-bclear]')) {
        const r = await dialog({ title: 'Vyprázdnit seznam?', html: `<p>Ze seznamu zmizí ${batch.length} ${SC.plural(batch.length, 'načtená průvodka', 'načtené průvodky', 'načtených průvodek')}. Nic se nezapíše.</p>`, ok: 'Vyprázdnit', danger: true });
        if (r.ok) { batch = []; saveBatch(); renderBatch(); result.innerHTML = ''; }
        focusScan(); return;
      }
      if (e.target.closest('[data-fill]')) {
        const n = SC.qty($('#fillQty').value, ST.limits.qty);
        if (n === null) { toast('Zadej počet kusů (celé číslo od 1).', 'err'); $('#fillQty').focus(); return; }
        batch.forEach(x => { if (!SC.qty(x.qty, ST.limits.qty)) { x.qty = String(n); x.qtyBad = false; } });
        saveBatch(); renderBatch(); focusScan(); return;
      }
      if (e.target.closest('[data-bsave]')) { saveBatchNow(false); return; }
      if (e.target.closest('[data-bforce]')) { saveBatchNow(true); }
    });
    batchBox.addEventListener('input', e => {
      const q = e.target.closest('[data-q]');
      if (!q) return;
      const x = batch[+q.dataset.q];
      if (x) { x.qty = q.value; x.qtyBad = false; q.classList.remove('need'); saveBatch(); }
    });
    batchBox.addEventListener('keydown', e => {
      const q = e.target.closest('[data-q]');
      if (q && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        if (SC.qty(q.value, ST.limits.qty) === null && q.value.trim() !== '') {
          // do pole pro kusy přišel barcode: přesuneme ho do seznamu
          const code = SC.normalize(q.value, { fix: store.get('fixLayout', true) }).code;
          const x = batch[+q.dataset.q]; if (x) x.qty = '';
          q.value = '';
          if (code.length > 7 || /\D/.test(code)) { addToBatch(code); return; }
          q.classList.add('need'); beep('err'); return;
        }
        input.focus();
      }
      if (e.target.id === 'fillQty' && e.key === 'Enter') { e.preventDefault(); $('[data-fill]').click(); }
    });

    /* --- formulář pro barcode --- */
    input.addEventListener('keydown', e => {
      // některé čtečky končí tabulátorem místo Enteru
      if (e.key === 'Tab' && !e.shiftKey && input.value.trim()) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const n = SC.normalize(input.value, { fix: store.get('fixLayout', true) });
      input.value = '';
      if (!n.code) { focusScan(); return; }
      if (n.code.length > ST.limits.barcode) { beep('err'); showResult('err', 'Barcode je příliš dlouhý', [`Nejvýš ${ST.limits.barcode} znaků. Načetla se možná dvě čtení najednou.`]); return; }
      if (n.fixed) toast(`Opraveno rozložení klávesnice čtečky: ${n.original} → ${n.code}`, 'warn', 6000);
      if (opts.multi) {
        if (isIn && opts.pos && !position()) { needPosition(); input.value = n.code; return; }
        addToBatch(n.code);
      } else {
        single(n.code);
      }
    });
    $('#optMulti').addEventListener('change', e => {
      opts.multi = e.target.checked; saveOpts(); syncTexts(); renderBatch();
      if (pending) { pending = null; qtyPanel.hidden = true; qtyPanel.innerHTML = ''; }
      result.innerHTML = '';
      focusScan();
    });
    if (isIn) {
      posCheck.addEventListener('change', () => {
        opts.pos = posCheck.checked; saveOpts();
        posBox.hidden = !opts.pos; posBox.classList.remove('need');
        renderBatch();
        if (opts.pos && !posBox.value) posBox.focus(); else focusScan();
      });
      posBox.addEventListener('input', () => { opts.position = posBox.value; posBox.classList.remove('need'); saveOpts(); if (opts.multi) renderBatchFootOnly(); });
      posBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.focus(); } });
    }
    function renderBatchFootOnly() {
      const info = $('.batch-foot .info', batchBox);
      if (!info) return;
      const pos = position();
      info.innerHTML = opts.pos ? (pos ? `<span>Pozice pro všechny: <b>${esc(pos)}</b></span>` : '<span class="tag crit">Vyplň pozici</span>') : '';
    }

    /* --- poslední záznamy na pracovišti --- */
    async function loadRecent() {
      const box = $('#recentBox');
      if (!box) return;
      try {
        const d = await api('recent', undefined, { limit: 30 });
        if (!$('#recentBox')) return;
        box.innerHTML = d.records.length ? recordsTable(d.records, { dept: false }) : '<p class="empty">Na tomhle pracovišti zatím nic.</p>';
      } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }
    async function loadPositions() {
      if (!isIn) return;
      try {
        const d = await api('positions');
        const list = $('#posList'); if (list) list.innerHTML = d.positions.map(p => `<option value="${esc(p)}">`).join('');
      } catch (e) { /* bez návrhů */ }
    }
    $('#recentReload').onclick = loadRecent;
    $('#recentBox').addEventListener('click', e => { const b = e.target.closest('[data-cancel-rec]'); if (b) cancelRecord(+b.dataset.cancelRec, loadRecent); });

    syncTexts();
    renderBatch();
    batch.forEach(item => lastInfo(item.code).then(l => { item.info = l; updateInfo(item); }));
    loadRecent(); loadPositions();
    focusScan();
  }

  /** Tabulka záznamů (od nejnovějšího). opts.dept = sloupec oddělení, opts.markLast = zvýraznit první platný. */
  function recordsTable(records, opts = {}) {
    const showDept = opts.dept !== false;
    let lastMarked = false;
    return `<div class="tbl-wrap"><table class="tbl stack"><thead><tr><th>Kdy</th><th>Barcode</th><th>Záznam</th>${showDept ? '<th>Oddělení</th>' : ''}<th>Pozice / ks</th><th>Kdo</th><th></th></tr></thead><tbody>
      ${records.map(r => {
        const isLast = opts.markLast && !r.cancelled && !lastMarked; if (isLast) lastMarked = true;
        return `<tr class="${r.cancelled ? 'cancelled' : ''}${isLast ? ' is-last' : ''}">
          <td class="nowrap" title="${esc(fmtFull.format(new Date(r.recorded_at)))}">${esc(when(r.recorded_at))}${isLast ? '<span class="sub"><b>poslední záznam</b></span>' : ''}</td>
          <td data-wide>${codeBtn(r.barcode)}</td>
          <td>${actTag(r)}${r.cancelled ? `<span class="sub">stornováno ${esc(when(r.cancelled.at))} (${esc(r.cancelled.by)})${r.cancelled.reason ? ': ' + esc(r.cancelled.reason) : ''}</span>` : ''}</td>
          ${showDept ? `<td>${deptTag(r.department, r.department_label)}</td>` : ''}
          <td class="strike">${r.position ? `pozice <b>${esc(r.position)}</b>` : ''}${r.quantity != null ? `<b>${num(r.quantity)} ks</b>` : ''}${!r.position && r.quantity == null ? '<span class="muted">—</span>' : ''}</td>
          <td>${esc(r.user)}</td>
          <td>${r.canCancel ? `<button class="btn ghost small" type="button" data-cancel-rec="${r.id}">Stornovat</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  async function cancelRecord(id, after) {
    const r = await dialog({
      title: 'Stornovat záznam?', ok: 'Stornovat', danger: true,
      html: `<p>Záznam zůstane v historii přeškrtnutý a do posledního stavu průvodky se nepočítá.</p>
        <label class="field mt-14"><span>Důvod (nepovinné)</span><input type="text" name="reason" maxlength="200" placeholder="např. načtená špatná průvodka"></label>`,
      validate: async form => {
        try { await api('cancel', { id, reason: form.elements.reason.value }); } catch (err) { return err.message; }
        return null;
      },
    });
    if (r.ok) { toast('Záznam je stornovaný.'); if (after) after(); }
  }

  /* ---------- přehled ---------- */
  function overviewView(view) {
    const filters = { dept: '', type: '', ...store.get('filters', {}) };
    view.innerHTML = `<section class="card">
        <div class="card-head"><div><h1>Přehled</h1><p class="hint mt-4">Vyhledej průvodku podle barcodu. Záznamy jsou od nejnovějšího, nahoře je vždy poslední záznam.</p></div></div>
        <form class="search-row" id="searchForm" role="search" autocomplete="off" novalidate>
          <input id="searchInput" class="scan-input" type="search" placeholder="Vyhledat barcode (načti čtečkou nebo napiš část)" autocapitalize="off" spellcheck="false" maxlength="${ST.limits.barcode + 20}" aria-label="Vyhledat barcode">
          <button class="btn primary big" type="submit">Vyhledat</button>
        </form>
      </section>
      <div id="searchOut" class="stack-18"></div>
      <section class="card" id="listCard">
        <div class="card-head"><h2>Poslední záznamy</h2>
          <div class="filters">
            <select id="fDept" aria-label="Oddělení"><option value="">Všechna oddělení</option>${ST.depts.map(d => `<option value="${d.code}"${filters.dept === d.code ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
            <select id="fType" aria-label="Typ záznamu"><option value="">Příjem i export</option><option value="prijem"${filters.type === 'prijem' ? ' selected' : ''}>Jen příjem</option><option value="export"${filters.type === 'export' ? ' selected' : ''}>Jen export</option></select>
            <button class="btn small" type="button" id="listReload">Obnovit</button>
          </div></div>
        <div id="listBox"><p class="empty">Načítám…</p></div>
        <div class="more-row"><button class="btn" type="button" id="listMore" hidden>Načíst starší</button></div>
      </section>`;
    const sInput = $('#searchInput'), out = $('#searchOut');
    let timer = null, seq = 0, oldest = 0;

    async function search(q, exactFocus) {
      const n = SC.normalize(q, { fix: store.get('fixLayout', true) });
      const my = ++seq;
      if (!n.code) { out.innerHTML = ''; return; }
      if (n.fixed) { sInput.value = n.code; toast(`Opraveno rozložení klávesnice čtečky: ${n.original} → ${n.code}`, 'warn', 6000); }
      try {
        const d = await api('search', undefined, { q: n.code });
        if (my !== seq || !$('#searchOut')) return;
        renderSearch(d);
        history.replaceState(null, '', '#prehled?q=' + encodeURIComponent(n.code));
        if (exactFocus) sInput.select();
      } catch (e) { out.innerHTML = `<section class="card"><p class="empty">${esc(e.message)}</p></section>`; }
    }

    function renderSearch(d) {
      let html = '';
      if (d.exact) {
        const l = d.exact.last;
        html += l ? `<section class="last-card" aria-label="Poslední záznam">
            <div class="lc-head"><p class="eyebrow">Poslední záznam</p><div class="code">${esc(d.exact.barcode)}</div><div>${actTag(l)} <span class="muted small">${esc(agoUnix(l.recorded_at_unix))}</span></div></div>
            <div class="lc-body">
              <div class="kv big"><small>Záznam</small><b>${esc(l.action_label)}</b></div>
              <div class="kv big"><small>Oddělení</small><b>${deptTag(l.department, l.department_label)}</b></div>
              <div class="kv"><small>${l.action === 'prijem' ? 'Pozice' : 'Počet kusů'}</small><b>${l.action === 'prijem' ? (l.position ? esc(l.position) : '<span class="muted">neuvedena</span>') : num(l.quantity) + ' ks'}</b></div>
              <div class="kv"><small>Kdy</small><b>${esc(fmtFull.format(new Date(l.recorded_at)))}</b></div>
              <div class="kv"><small>Kdo</small><b>${esc(l.user)}</b></div>
              ${l.canCancel ? `<div class="kv"><small>Oprava</small><button class="btn small" type="button" data-cancel-rec="${l.id}">Stornovat</button></div>` : ''}
            </div></section>`
          : `<section class="card"><p><b>${esc(d.exact.barcode)}</b>: všechny záznamy jsou stornované, průvodka nemá platný poslední záznam.</p></section>`;
        html += `<section class="card"><div class="card-head"><h2>Historie průvodky<span class="count">${d.exact.count}</span></h2><span class="hint">od nejnovějšího</span></div>${recordsTable(d.exact.history, { markLast: true })}</section>`;
      }
      if (d.matches.length) {
        html += `<section class="card"><div class="card-head"><h2>${d.exact ? 'Další průvodky' : 'Průvodky'} obsahující „${esc(d.q)}“<span class="count">${d.matches.length}${d.more ? '+' : ''}</span></h2><span class="hint">poslední záznam každé průvodky</span></div>
          <div class="tbl-wrap"><table class="tbl stack"><thead><tr><th>Barcode</th><th>Poslední záznam</th><th>Oddělení</th><th>Pozice / ks</th><th>Kdy</th></tr></thead><tbody>
          ${d.matches.map(r => `<tr><td data-wide>${codeBtn(r.barcode)}</td><td>${actTag(r)}</td><td>${deptTag(r.department, r.department_label)}</td>
            <td>${r.position ? `pozice <b>${esc(r.position)}</b>` : r.quantity != null ? `<b>${num(r.quantity)} ks</b>` : '<span class="muted">—</span>'}</td><td class="nowrap">${esc(when(r.recorded_at))}</td></tr>`).join('')}
          </tbody></table></div>${d.more ? '<p class="hint mt-10">Zobrazeno prvních 50. Zpřesni hledání.</p>' : ''}</section>`;
      }
      if (!d.exact && !d.matches.length) html = `<section class="card"><p class="empty">Průvodka „${esc(d.q)}“ v evidenci není.</p></section>`;
      out.innerHTML = html;
    }

    out.addEventListener('click', e => { const b = e.target.closest('[data-cancel-rec]'); if (b) cancelRecord(+b.dataset.cancelRec, () => search(sInput.value)); });
    $('#searchForm').addEventListener('submit', e => { e.preventDefault(); clearTimeout(timer); search(sInput.value, true); });
    sInput.addEventListener('input', () => {
      clearTimeout(timer);
      const v = sInput.value.trim();
      if (!v) { seq++; out.innerHTML = ''; history.replaceState(null, '', '#prehled'); return; }
      if (v.length >= 2) timer = setTimeout(() => search(sInput.value), 350);
    });

    async function loadList(more) {
      const box = $('#listBox');
      try {
        const q = { dept: filters.dept, type: filters.type, limit: 50 };
        if (more && oldest) q.before = oldest;
        const d = await api('records', undefined, q);
        if (!$('#listBox')) return;
        const rows = d.records;
        if (!more) box.innerHTML = rows.length ? recordsTable(rows) : '<p class="empty">Zatím žádné záznamy.</p>';
        else if (rows.length) box.insertAdjacentHTML('beforeend', recordsTable(rows));
        if (rows.length) oldest = rows[rows.length - 1].id;
        $('#listMore').hidden = !d.more;
      } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }
    const refilter = () => { filters.dept = $('#fDept').value; filters.type = $('#fType').value; store.set('filters', filters); oldest = 0; loadList(false); };
    $('#fDept').onchange = refilter; $('#fType').onchange = refilter;
    $('#listReload').onclick = () => { oldest = 0; loadList(false); };
    $('#listMore').onclick = () => loadList(true);
    $('#listBox').addEventListener('click', e => { const b = e.target.closest('[data-cancel-rec]'); if (b) cancelRecord(+b.dataset.cancelRec, () => { oldest = 0; loadList(false); }); });

    const fromHash = new URLSearchParams((location.hash.split('?')[1] || '')).get('q');
    const start = pendingSearch || fromHash || '';
    pendingSearch = null;
    if (start) { sInput.value = start; search(start); }
    loadList(false);
    sInput.focus();
    sInput.select();
  }

  /* ---------- na pracovištích ---------- */
  function onsiteView(view) {
    view.innerHTML = `<section class="card"><div class="card-head"><div><h1>Na pracovištích</h1>
        <p class="hint mt-4">Průvodky, jejichž poslední záznam je příjem na daném pracovišti: díly tam jsou a ještě neodešly exportem.</p></div>
        <div class="row"><input class="input onsite-filter" id="onsiteFilter" type="search" placeholder="Filtrovat barcode nebo pozici" aria-label="Filtrovat barcode nebo pozici"><button class="btn" type="button" id="onsiteReload">Obnovit</button></div></div></section>
      <div class="onsite-grid" id="onsiteGrid"><p class="empty">Načítám…</p></div>`;
    let data = null;
    const filter = $('#onsiteFilter');
    function draw() {
      const q = filter.value.trim().toLowerCase();
      $('#onsiteGrid').innerHTML = data.depts.map(d => {
        const rows = q ? d.records.filter(r => r.barcode.toLowerCase().includes(q) || (r.position || '').toLowerCase().includes(q)) : d.records;
        return `<section class="card onsite-card dept-${d.code}"><div class="card-head"><div><p class="eyebrow">${deptDot(d.code)}${esc(d.name)}</p><div class="big-n">${num(d.total)}</div>
            <p class="small muted">${SC.plural(d.total, 'průvodka', 'průvodky', 'průvodek')} na pracovišti</p></div></div>
          ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Barcode</th><th>Pozice</th><th>Od</th></tr></thead><tbody>
            ${rows.map(r => `<tr><td>${codeBtn(r.barcode)}<span class="sub">${esc(r.user)}</span></td><td>${r.position ? `<b>${esc(r.position)}</b>` : '<span class="muted">—</span>'}</td>
              <td class="nowrap" title="${esc(when(r.recorded_at))}">${esc(agoUnix(r.recorded_at_unix))}</td></tr>`).join('')}</tbody></table></div>`
            : `<p class="empty">${q ? 'Nic neodpovídá filtru.' : 'Žádná průvodka.'}</p>`}
          ${d.total > d.records.length ? `<p class="hint">Zobrazeno ${num(d.records.length)} nejnovějších z ${num(d.total)}.</p>` : ''}</section>`;
      }).join('');
    }
    async function load() {
      try { data = await api('onsite'); if ($('#onsiteGrid')) draw(); }
      catch (e) { $('#onsiteGrid').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }
    filter.addEventListener('input', () => { if (data) draw(); });
    $('#onsiteReload').onclick = load;
    load();
  }

  /* ---------- správa ---------- */
  function adminView(view) {
    view.innerHTML = `<section class="card"><div class="card-head"><div><h1>Uživatelé</h1><p class="hint mt-4">Kdo se smí přihlásit a na která oddělení. Visitor smí každý uživatel; role Jen nahlížení nic nezapíše.</p></div>
        <button class="btn primary" type="button" id="userAdd">+ Přidat uživatele</button></div><div id="usersBox"><p class="empty">Načítám…</p></div></section>
      <div class="grid-2">
        <section class="card"><div class="card-head"><div><h2>API klíče</h2><p class="hint mt-4">Pro napojení jiných systémů (jen čtení). Návod je v záložce API pro IT.</p></div>
          <button class="btn" type="button" id="keyAdd">+ Nový klíč</button></div><div id="keysBox"><p class="empty">Načítám…</p></div></section>
        <section class="card"><div class="card-head"><h2>Historie správy</h2></div><div id="logBox"><p class="empty">Načítám…</p></div></section>
      </div>`;
    let users = [];
    async function loadUsers() {
      try {
        users = (await api('users')).users;
        $('#usersBox').innerHTML = `<div class="tbl-wrap"><table class="tbl stack"><thead><tr><th>Jméno</th><th>Přihlášení</th><th>Role</th><th>Oddělení</th><th>Naposledy přihlášen</th><th></th></tr></thead><tbody>
          ${users.map(u => `<tr class="${u.active ? '' : 'cancelled'}"><td data-wide><b>${esc(u.name)}</b>${u.active ? '' : ' <span class="tag">vypnutý</span>'}${u.mustChange ? ' <span class="tag warn">čeká na vlastní heslo</span>' : ''}</td>
            <td class="mono">${esc(u.login)}</td><td>${esc(u.roleLabel)}</td>
            <td>${u.role === 'visitor' ? '<span class="muted">jen Visitor</span>' : u.deptsAll ? 'všechna' : u.depts.map(c => deptTag(c, ST.depts.find(d => d.code === c).name)).join('<br>')}</td>
            <td class="nowrap">${u.lastLoginAt ? esc(when(u.lastLoginAt)) : '<span class="muted">nikdy</span>'}</td>
            <td><button class="btn small" type="button" data-uedit="${u.id}">Upravit</button></td></tr>`).join('')}</tbody></table></div>`;
      } catch (e) { $('#usersBox').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }
    async function loadKeys() {
      try {
        const keys = (await api('apikeys')).keys;
        $('#keysBox').innerHTML = keys.length ? `<div class="tbl-wrap"><table class="tbl stack"><thead><tr><th>Název</th><th>Klíč</th><th>Naposledy použit</th><th></th></tr></thead><tbody>
          ${keys.map(k => `<tr class="${k.revokedAt ? 'cancelled' : ''}"><td data-wide><b class="strike">${esc(k.name)}</b><span class="sub">založil ${esc(k.createdBy)} ${esc(when(k.createdAt))}${k.revokedAt ? ` · zrušil ${esc(k.revokedBy)} ${esc(when(k.revokedAt))}` : ''}</span></td>
            <td class="mono small">${esc(k.prefix)}…</td><td class="nowrap">${k.lastUsedAt ? esc(when(k.lastUsedAt)) : '<span class="muted">zatím ne</span>'}</td>
            <td>${k.revokedAt ? '<span class="tag">zrušený</span>' : `<button class="btn ghost small" type="button" data-krevoke="${k.id}">Zrušit</button>`}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="empty">Zatím žádný klíč.</p>';
      } catch (e) { $('#keysBox').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }
    async function loadLog() {
      try {
        const log = (await api('adminlog')).log;
        $('#logBox').innerHTML = log.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${log.map(l => `<tr><td class="nowrap small muted">${esc(when(l.at))}</td><td class="small">${esc(l.text)}<span class="sub">${esc(l.by)}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Zatím nic.</p>';
      } catch (e) { $('#logBox').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }

    async function editUser(u) {
      const isNew = !u;
      u = u || { name: '', login: '', role: 'operator', depts: ST.depts.map(d => d.code), active: true };
      const res = await dialog({
        title: isNew ? 'Nový uživatel' : `Upravit: ${u.name}`, ok: isNew ? 'Přidat' : 'Uložit', wide: true,
        html: `<div class="grid-2 tight">
            <label class="field"><span>Jméno a příjmení</span><input type="text" name="name" maxlength="80" value="${esc(u.name)}" required></label>
            <label class="field"><span>Přihlašovací jméno</span><input type="text" name="login" maxlength="40" autocapitalize="off" spellcheck="false" value="${esc(u.login)}" placeholder="např. novak" required></label></div>
          <div class="field"><span>Role</span><div class="choice">
            ${[['operator', 'Pracovník', 'příjem a export na vybraných odděleních'], ['admin', 'Správce', 'všechna oddělení, uživatelé, API klíče, storno starších záznamů'], ['visitor', 'Jen nahlížení', 'přihlásí se jen jako Visitor, nic nezapíše']]
              .map(([v, t, s]) => `<label><input type="radio" name="role" value="${v}"${u.role === v ? ' checked' : ''}><span><b>${t}</b><small>${s}</small></span></label>`).join('')}</div></div>
          <div class="field" data-depts${u.role === 'operator' ? '' : ' hidden'}><span>Oddělení, na kterých smí pracovat</span><div class="checks">
            ${ST.depts.map(d => `<label class="check"><input type="checkbox" name="dept" value="${d.code}"${u.depts.includes(d.code) ? ' checked' : ''}> ${deptDot(d.code)}${esc(d.name)}</label>`).join('')}</div></div>
          <div class="grid-2 tight">
            <label class="field"><span>${isNew ? 'Heslo' : 'Nové heslo'} <span class="muted">(aspoň ${ST.limits.password} znaků${isNew ? '' : ', prázdné = beze změny'})</span></span><input type="text" name="password" autocomplete="off" spellcheck="false"></label>
            <div class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" name="mustChange" checked> Po přihlášení si nastaví vlastní heslo</label></div></div>
          ${isNew ? '' : `<label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}> Účet je zapnutý (vypnutý se nepřihlásí)</label>`}
          ${isNew ? '' : '<p class="hint mt-10">Změna hesla, role nebo oddělení uživatele hned odhlásí.</p>'}`,
        onOpen: d => {
          $$('[name=role]', d).forEach(r => r.addEventListener('change', () => { $('[data-depts]', d).hidden = $('[name=role]:checked', d).value !== 'operator'; }));
          const pw = $('[name=password]', d);
          if (isNew) pw.value = randomPassword();
        },
        validate: async form => {
          const f = form.elements;
          const body = {
            id: isNew ? 0 : u.id, name: f.name.value, login: f.login.value.trim().toLowerCase(), role: $('[name=role]:checked', form).value,
            depts: $$('[name=dept]:checked', form).map(x => x.value), password: f.password.value, mustChange: f.mustChange.checked, active: isNew ? true : f.active.checked,
          };
          try { await api('user_save', body); } catch (err) { return err.message; }
          toast(isNew ? `Uživatel ${body.name} je přidaný${body.password ? `, heslo: ${body.password}` : ''}.` : 'Uloženo.', '', isNew ? 9000 : 4000);
          return null;
        },
      });
      if (res.ok) { loadUsers(); loadLog(); }
    }

    $('#userAdd').onclick = () => editUser(null);
    $('#usersBox').addEventListener('click', e => { const b = e.target.closest('[data-uedit]'); if (b) editUser(users.find(u => u.id === +b.dataset.uedit)); });
    $('#keyAdd').onclick = async () => {
      let created = null;
      const r = await dialog({
        title: 'Nový API klíč', ok: 'Vytvořit klíč',
        html: `<label class="field"><span>Název (k čemu klíč je)</span><input type="text" name="name" maxlength="80" placeholder="např. ERP Helios, Power BI" required></label>
          <p class="hint">Klíč dovolí jen čtení záznamů přes API. Ukáže se jen jednou, hned po vytvoření.</p>`,
        validate: async form => {
          try { created = await api('apikey_create', { name: form.elements.name.value }); } catch (err) { return err.message; }
          return null;
        },
      });
      if (!r.ok || !created) return;
      loadKeys(); loadLog();
      await dialog({
        title: 'Klíč je vytvořený', ok: 'Hotovo', cancel: '', wide: true,
        html: `<p>Zkopíruj klíč a předej ho IT. <b>Znovu už se ukázat nedá</b>; když se ztratí, vytvoř nový a starý zruš.</p>
          <div class="key-box"><input class="input" type="text" readonly value="${esc(created.key)}" aria-label="API klíč"><button class="btn" type="button" data-copykey>Kopírovat</button></div>
          <p class="hint">Použití: hlavička <code>Authorization: Bearer ${esc(created.key.slice(0, 12))}…</code>. Podrobnosti v záložce API pro IT.</p>`,
        onOpen: d => { $('[data-copykey]', d).onclick = e => copyText(created.key, e.target); $('.key-box input', d).select(); },
      });
    };
    $('#keysBox').addEventListener('click', async e => {
      const b = e.target.closest('[data-krevoke]');
      if (!b) return;
      const r = await dialog({
        title: 'Zrušit API klíč?', ok: 'Zrušit klíč', cancel: 'Ponechat', danger: true, html: '<p>Systém, který klíč používá, se přestane připojovat. Zrušení nejde vrátit.</p>',
        validate: async () => { try { await api('apikey_revoke', { id: +b.dataset.krevoke }); } catch (err) { return err.message; } return null; },
      });
      if (r.ok) { toast('Klíč je zrušený.'); loadKeys(); loadLog(); }
    });
    loadUsers(); loadKeys(); loadLog();
  }

  /* ---------- API pro IT ---------- */
  function apiView(view) {
    const base = location.origin + location.pathname.replace(/[^/]*$/, '') + 'api/v1/';
    const sample = {
      barcode: 'PR-2026-004512', found: true,
      record: {
        id: 1842, barcode: 'PR-2026-004512', action: 'export', action_label: 'Export z pracoviště', department: 'brush_wpa', department_label: 'Brush WPA',
        position: null, quantity: 48, user: 'Jan Novák', user_login: 'novak', recorded_at: '2026-10-21T14:05:09+02:00', recorded_at_utc: '2026-10-21T12:05:09Z', recorded_at_unix: 1792591509,
      },
    };
    const pre = (text) => `<div class="pre"><pre>${esc(text)}</pre><button class="btn small copy" type="button" data-copy>Kopírovat</button></div>`;
    view.innerHTML = `<section class="card doc">
      <div class="card-head"><div><h1>API pro IT</h1><p class="hint mt-4">Napojení jiného systému (ERP, MES, Power BI…) na poslední záznam průvodky. API jen čte, nic nezapisuje.</p></div></div>
      <h3>1. Klíč</h3>
      <p>Klíč vytvoří správce v záložce <b>Správa → API klíče</b> a předá ho IT. Posílá se v hlavičce každého požadavku:</p>
      ${pre('Authorization: Bearer etd_…')}
      <p>Jde i hlavička <code>X-Api-Key: etd_…</code>. Klíč nikdy nedávej do adresy (zůstal by v logách). API běží jen přes HTTPS.</p>
      <h3>2. Adresa</h3>
      ${pre(base)}
      <h3>3. Endpointy</h3>
      <div class="endpoint"><span class="m">GET</span><div><code>last?barcode=…</code><p>Poslední platný záznam průvodky (stornované se nepočítají). Když průvodka v evidenci není, vrátí <code>404</code> a <code>"found": false</code>.</p></div></div>
      <div class="endpoint"><span class="m post">POST</span><div><code>last</code> s tělem <code>{"barcodes": ["…", "…"]}</code><p>Poslední záznamy až ${ST.limits.batch} průvodek najednou. Vrací <code>results</code> ve stejném pořadí, u každé <code>found</code> a <code>record</code>.</p></div></div>
      <div class="endpoint"><span class="m">GET</span><div><code>history?barcode=…&amp;limit=100</code><p>Všechny platné záznamy průvodky od nejnovějšího (nejvýš 1000).</p></div></div>
      <div class="endpoint"><span class="m">GET</span><div><code>ping</code><p>Ověření, že klíč funguje.</p></div></div>
      <h3>4. Odpověď</h3>
      ${pre(JSON.stringify(sample, null, 2))}
      <ul>
        <li><code>action</code>: <code>prijem</code> (Příjem na pracoviště) nebo <code>export</code> (Export z pracoviště).</li>
        <li><code>department</code>: ${ST.depts.map(d => `<code>${esc(d.code)}</code> (${esc(d.name)})`).join(', ')}.</li>
        <li><code>position</code>: pozice, kam se díly umístily (jen u příjmu, jinak <code>null</code>). <code>quantity</code>: počet kusů (jen u exportu).</li>
        <li><code>recorded_at</code> je v pražském čase s posunem (ISO 8601), <code>recorded_at_utc</code> v UTC, <code>recorded_at_unix</code> v sekundách.</li>
        <li>Velikost písmen v barcodu nehraje roli (<code>pr-1</code> = <code>PR-1</code>).</li>
      </ul>
      <h3>5. Příklady</h3>
      <p>curl:</p>
      ${pre(`curl -H "Authorization: Bearer etd_…" "${base}last?barcode=PR-2026-004512"`)}
      <p>PowerShell:</p>
      ${pre(`Invoke-RestMethod -Uri "${base}last?barcode=PR-2026-004512" -Headers @{ Authorization = "Bearer etd_…" }`)}
      <p>Více průvodek najednou:</p>
      ${pre(`curl -H "Authorization: Bearer etd_…" -H "Content-Type: application/json" \\\n  -d '{"barcodes":["PR-2026-004512","PR-2026-004513"]}' "${base}last"`)}
      <h3>6. Chyby</h3>
      <ul>
        <li><code>401 unauthorized</code>: chybí klíč, je neplatný nebo zrušený.</li>
        <li><code>404 not_found</code>: průvodka v evidenci není.</li>
        <li><code>400 bad_request</code>: chybí nebo je špatně parametr. <code>429</code>: příliš mnoho pokusů s neplatným klíčem (čtvrt hodiny pauza).</li>
      </ul>
      <p>Odpověď je vždy JSON v UTF-8, chyby mají <code>error</code> (kód) a <code>message</code> (česky).</p>
    </section>`;
    view.addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if (b) copyText(b.parentElement.querySelector('pre').textContent, b); });
  }

  /* ---------- start ---------- */
  (async () => {
    try { ST = await api('state'); }
    catch (e) { app.innerHTML = `<p class="boot">${esc(e.message)}</p>`; return; }
    route();
  })();
})();
