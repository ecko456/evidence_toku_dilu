'use strict';
/*
 * Živé propojení s Google tabulkou od začátku do konce (verze 1.3):
 *   node tests/e2e_sheets.js
 * Skutečný skript static/google-tabulka.js běží v náhradě Apps Scriptu (tests/gas_mock.js),
 * jeho webová aplikace v náhradním „Googlu“ (tests/fake_google.js), Evidence v php -S
 * a odesílání změn je skutečná úloha bin/hook-worker.php. Nic nejde ven z tohoto stroje.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { makeEnv, load, save } = require('./gas_mock');

const APP = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'etd-sheets-'));
const DATA = path.join(TMP, 'data');
const STATE = path.join(TMP, 'state.json');
const SCRIPT = path.join(TMP, 'google-tabulka.js');
const ENV = { ...process.env, ETD_DATA_DIR: DATA, ETD_HOOK_TEST: '1', NO_PROXY: '*', no_proxy: '*' };
const procs = [];

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise(res => { const c = net.connect(port, '127.0.0.1', () => { c.end(); res(true); }); c.on('error', () => res(false)); });
    if (ok) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('port ' + port + ' se neotevřel');
}

let cookie = '';
let BASE = '';
async function page(action, body) {
  const res = await fetch(`${BASE}/api.php?action=${action}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Etd': '1', 'X-Etd-Client': '9', 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json();
  if (res.status !== 200) throw new Error(`${action}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const php = (...args) => execFileSync('php', args, { cwd: APP, env: ENV }).toString();
const worker = () => php('bin/hook-worker.php', '--once');
const sheetK = row => (load(STATE).sheets.List1['K' + row] || {});
const run = (fn, ...args) => makeEnv(STATE, fs.readFileSync(SCRIPT, 'utf8'))[fn](...args);
const lastAlert = () => { const a = load(STATE).alerts || []; return a[a.length - 1] || ''; };
const answer = (...a) => { const s = load(STATE); s.answers = a; save(STATE, s); };
const setState = fn => { const s = load(STATE); fn(s); save(STATE, s); };

(async () => {
  const phpPort = await freePort();
  const gPort = await freePort();
  BASE = `http://127.0.0.1:${phpPort}`;
  const WEBAPP = `http://127.0.0.1:${gPort}/macros/s/AKfycbTESTtestTESTtest123/exec`;

  // skript s nastavením, jaké vyrobí generátor v aplikaci
  const template = fs.readFileSync(path.join(APP, 'static/google-tabulka.js'), 'utf8');
  assert(/\/\/ <nastaveni>[\s\S]*\/\/ <\/nastaveni>/.test(template), 'šablona má blok nastavení');
  fs.writeFileSync(SCRIPT, template.replace(/\/\/ <nastaveni>[\s\S]*\/\/ <\/nastaveni>/, `// <nastaveni>
const ETD = { api: '${BASE}/api/v1/', list: 'List1', sloupecBarcode: 'D', parametrOdkazu: 'activeBarcode', sloupecVysledek: 'K', prvniRadek: 2 };
// </nastaveni>`));

  const link = code => `http://is.example/commission.production.detail/default/10001?activeBarcode=${code}&componentProductionId=678901`;
  save(STATE, {
    props: {}, triggers: [], answers: [], alerts: [], googleMode: 'ok',
    sheets: {
      List1: {
        D1: { v: 'Odkaz' }, K1: { v: 'Evidence' },
        D2: { v: 'Zakázka 1', link: link('12345.678901.23456') },                 // odkaz vložený přes Ctrl+K
        D3: { f: `=HYPERLINK("${link('12345.678901.23457')}";"Zakázka 2")`, computed: 'Zakázka 2' },
        D4: { v: 'bez odkazu' }, K4: { f: '=1+1', computed: 2 },                  // vlastní vzorec zůstane
        D5: { v: 'Zakázka 5', runs: [null, link('NOVA.1')] },                     // odkaz jen v části textu
        D6: { v: 'Zakázka 6', link: link('12345.678901.23456') },                 // stejná průvodka dvakrát
      },
    },
  });

  procs.push(spawn('php', ['-S', `127.0.0.1:${phpPort}`, 'router.php'], { cwd: APP, env: ENV, stdio: 'ignore' }));
  procs.push(spawn('node', [path.join(__dirname, 'fake_google.js'), String(gPort), STATE, SCRIPT], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] }));
  await waitPort(phpPort);
  await waitPort(gPort);

  // Evidence: správce, oddělení, příjem dvou průvodek, API klíč
  const token = php('bin/setup-token.php').trim();
  await page('setup', { token, login: 'spravce', name: 'Jana Správcová', password: 'tajneheslo1' });
  await page('dept', { dept: 'hala' });
  await page('scan', { action: 'prijem', items: [{ barcode: '12345.678901.23456' }, { barcode: '12345.678901.23457' }], position: 'R3', definePosition: true });
  const key = (await page('apikey_create', { name: 'Kooperace Hala 2' })).key;

  // 1) klíč
  answer('etd_' + '0'.repeat(39));
  run('etdNastavitKlic');
  assert(/nevypadá/.test(lastAlert()), 'špatný tvar klíče se neuloží');
  answer(key);
  run('etdNastavitKlic');
  assert(/Klíč funguje/.test(lastAlert()), lastAlert());

  // 2) zapnutí: seznam do Evidence, výsledky hned do K, zkouška spojení Evidence → tabulka
  answer(WEBAPP);
  run('etdZapnout');
  let alert = lastAlert();
  assert(/Živé propojení je zapnuté/.test(alert), alert);
  assert(/Sleduje se 3 průvodek, v Evidenci je z nich 2/.test(alert), alert);
  assert(/NEBĚŽÍ|neběží odesílání/.test(alert), 'úloha odesílání ještě neběžela, tabulka na to upozorní');
  assert.match(sheetK(2).v, /^Příjem na pracoviště · Hala 2 · pozice R3 · \d+\. \d+\. 20\d\d \d+:\d\d · Jana Správcová$/);
  assert.strictEqual(sheetK(3).v, sheetK(2).v);
  assert.strictEqual(sheetK(5).v, '', 'NOVA.1 zatím v evidenci není');
  assert.strictEqual(sheetK(6).v, sheetK(2).v, 'stejná průvodka ve dvou řádcích');
  assert.strictEqual(sheetK(4).f, '=1+1', 'řádek bez odkazu (i se vzorcem) zůstal');
  assert.deepStrictEqual(load(STATE).triggers.map(t => t.fn + ':' + t.kind).sort(), ['etdHodinova:hours:1', 'etdPriUprave:edit']);

  // 3) živá změna: export průvodky z jiného oddělení → úloha → doPost → K
  await page('dept', { dept: 'elox' });
  await page('scan', { action: 'export', items: [{ barcode: '12345.678901.23456', qty: '48' }] });
  await page('scan', { action: 'prijem', items: [{ barcode: 'nova.1' }], position: '' });   // jiná velikost písmen
  await page('scan', { action: 'prijem', items: [{ barcode: 'NESLEDOVANA-9' }], position: '' });
  assert.match(worker(), /Odesláno průvodek: 2/);
  assert.match(sheetK(2).v, /^Export z pracoviště · Elox · 48 ks · .* · Jana Správcová$/);
  assert.strictEqual(sheetK(6).v, sheetK(2).v);
  assert.match(sheetK(3).v, /^Příjem na pracoviště · Hala 2/, 'druhá průvodka beze změny');
  assert.match(sheetK(5).v, /^Příjem na pracoviště · Elox · \d/);
  assert.match(worker(), /Odesláno průvodek: 0/, 'fronta je prázdná');

  // 4) storno: tabulka dostane předchozí platný záznam
  const recent = await page('recent');
  const exportRec = recent.records.find(r => r.action === 'export');
  await page('cancel', { id: exportRec.id, reason: 'omyl' });
  assert.match(worker(), /Odesláno průvodek: 1/);
  assert.match(sheetK(2).v, /^Příjem na pracoviště · Hala 2 · pozice R3/);

  // 5) nový odkaz ve sloupci D: spouštěč při úpravě pošle nový seznam a doplní výsledek
  setState(s => { s.sheets.List1.D7 = { v: 'Zakázka 7', link: link('NESLEDOVANA-9') }; });
  run('etdPriUprave', { range: makeEnv(STATE, fs.readFileSync(SCRIPT, 'utf8')).__range('List1', 7, 4, 1) });
  assert.match(sheetK(7).v, /^Příjem na pracoviště · Elox/);
  run('etdPriUprave', { range: makeEnv(STATE, fs.readFileSync(SCRIPT, 'utf8')).__range('List1', 7, 5, 1) });   // jiný sloupec: nic

  // 6) Správa vidí propojení a jeho stav
  let hooks = await page('hooks');
  assert.strictEqual(hooks.hooks.length, 1);
  assert.strictEqual(hooks.hooks[0].status, 'ok');
  assert.strictEqual(hooks.hooks[0].watching, 4);
  assert.strictEqual(hooks.hooks[0].keyName, 'Kooperace Hala 2');
  assert.ok(hooks.worker.running, 'úloha odesílání běžela před chvílí');

  // 7) chyby: cizí podpis, přihlášení Googlu, chyba ve skriptu. Zápis zůstane ve frontě.
  const secret = load(STATE).props.ETD_SECRET;
  setState(s => { s.props.ETD_SECRET = 'x'.repeat(64); });
  await page('scan', { action: 'export', items: [{ barcode: 'NOVA.1', qty: 5 }] });
  assert.match(worker(), /Odesláno průvodek: 0/);
  hooks = await page('hooks');
  assert.strictEqual(hooks.hooks[0].status, 'error');
  assert.match(hooks.hooks[0].lastError, /podpis/);
  assert.strictEqual(hooks.hooks[0].queued, 1);
  assert.match(sheetK(5).v, /^Příjem/, 'nepodepsaná zpráva nic nezapsala');
  setState(s => { s.props.ETD_SECRET = secret; s.googleMode = 'login'; });
  let ping = await page('hook_ping', { id: hooks.hooks[0].id });
  assert.ok(!ping.ok && /Kdokoli/.test(ping.error), ping.error);
  setState(s => { s.googleMode = 'error'; });
  ping = await page('hook_ping', { id: hooks.hooks[0].id });
  assert.ok(!ping.ok && /TypeError/.test(ping.error), ping.error);
  setState(s => { s.googleMode = 'ok'; });
  ping = await page('hook_ping', { id: hooks.hooks[0].id });
  assert.ok(ping.ok, JSON.stringify(ping));
  assert.match(worker(), /Odesláno průvodek: 1/, 'po opravě se fronta doručí (ping zrušil čekání)');
  assert.match(sheetK(5).v, /^Export z pracoviště · Elox · 5 ks/);

  // 8) Poslat znovu vše, stav v tabulce
  const resend = await page('hook_resend', { id: hooks.hooks[0].id });
  assert.strictEqual(resend.queued, 4);
  assert.match(worker(), /Odesláno průvodek: 4/);
  run('etdStav');
  alert = lastAlert();
  assert.match(alert, /Propojení: v pořádku/);
  assert.match(alert, /Sledováno: 4 průvodek/);
  assert.match(alert, /Poslední živé změny/);
  run('etdAktualizovatVse');
  assert.match(load(STATE).toasts.pop(), /Sledováno 4 průvodek, v Evidenci 4/);

  // 9) zrušený API klíč: nic se neposílá
  const keys = (await page('apikeys')).keys;
  await page('apikey_revoke', { id: keys[0].id });
  await page('scan', { action: 'prijem', items: [{ barcode: 'NOVA.1' }], position: 'X9' });
  assert.match(worker(), /Odesláno průvodek: 0/);
  assert.match(sheetK(5).v, /^Export/);

  // 10) vypnutí z tabulky (s novým klíčem): spouštěče pryč, propojení pryč
  const key2 = (await page('apikey_create', { name: 'Kooperace 2' })).key;
  answer(key2);
  run('etdNastavitKlic');
  answer('');
  run('etdZapnout');
  assert.match(lastAlert(), /Živé propojení je zapnuté/);
  assert.match(sheetK(5).v, /pozice X9/, 'zapnutí s novým klíčem hned srovná tabulku');
  run('etdVypnout');
  assert.deepStrictEqual(load(STATE).triggers, []);
  hooks = await page('hooks');
  assert.deepStrictEqual(hooks.hooks.map(h => h.keyName), ['Kooperace Hala 2'], 'zůstalo jen propojení starého (zrušeného) klíče');
  await page('hook_delete', { id: hooks.hooks[0].id });
  assert.deepStrictEqual((await page('hooks')).hooks, []);
  const log = (await page('adminlog')).log.map(l => l.text).join('\n');
  assert.match(log, /Zapnuto živé propojení s Google tabulkou \(klíč „Kooperace Hala 2“\), sleduje 3 průvodek/);
  assert.match(log, /Vypnuto živé propojení/);

  console.log('e2e_sheets: vše v pořádku (' + load(STATE).fetches.length + ' volání API z tabulky, ' + load(STATE).writes + ' zápisů do listu)');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  procs.forEach(p => p.kill());
  fs.rmSync(TMP, { recursive: true, force: true });
});
