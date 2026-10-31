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
const sheetK = row => (load(STATE).sheets['List 1']['K' + row] || {});
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
const ETD = { api: '${BASE}/api/v1/', list: 'List1', sloupecBarcode: 'D', parametrOdkazu: 'activeBarcode', sloupecVysledek: 'K', prvniRadek: 2,
  sloupecObjednavka: 'A', sloupecEanSestavy: 'B', sloupecIndex: 'C', textJeEan: true };
// </nastaveni>`));

  const link = code => `http://is.example/commission.production.detail/default/10001?activeBarcode=${code}&componentProductionId=678901`;
  save(STATE, {
    props: {}, triggers: [], answers: [], alerts: [], googleMode: 'ok',
    sheets: {
      Poznámky: { A1: { v: 'jiný list' } },
      'List 1': {   // česká tabulka: s mezerou; ve skriptu je 'List1', najde se i tak
        D1: { v: 'Odkaz' }, K1: { v: 'Evidence' },
        A2: { v: 'OBJ-2026-001' }, B2: { v: '8590000000024' }, C2: { v: '03' },     // údaje k průvodce (objednávka, EAN sestavy, index)
        D2: { v: '8590000000017', link: link('12345.678901.23456') },             // odkaz vložený přes Ctrl+K, text = EAN
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

  // 0) špatný název listu: chyba vyjmenuje listy v tabulce
  const wrong = fs.readFileSync(SCRIPT, 'utf8').replace("list: 'List1'", "list: 'Kooperace'");
  try {
    require('./gas_mock').makeEnv(STATE, wrong).etdList();
    assert.fail('chybný list měl skončit chybou');
  } catch (err) {
    assert.match(err.message, /List „Kooperace“ v tabulce není\. Listy v tabulce: „Poznámky“, „List 1“\./, err.message);
  }

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
  // údaje z tabulky Stav průvodek: v aplikaci u průvodky i s odkazem do IS
  const li = (await page('last&barcode=12345.678901.23456')).info;
  assert.deepStrictEqual(li, { order: 'OBJ-2026-001', ean: '8590000000017', eanAssembly: '8590000000024', index: '03', link: link('12345.678901.23456') });
  assert.deepStrictEqual((await page('last&barcode=12345.678901.23457')).info, { ean: 'Zakázka 2', link: link('12345.678901.23457') }, 'odkaz i ze vzorce HYPERLINK, bez sloupců údajů jen EAN a odkaz');
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
  setState(s => { s.sheets['List 1'].D7 = { v: 'Zakázka 7', link: link('NESLEDOVANA-9') }; });
  run('etdPriUprave', { range: makeEnv(STATE, fs.readFileSync(SCRIPT, 'utf8')).__range('List 1', 7, 4, 1) });
  assert.match(sheetK(7).v, /^Příjem na pracoviště · Elox/);
  run('etdPriUprave', { range: makeEnv(STATE, fs.readFileSync(SCRIPT, 'utf8')).__range('List 1', 7, 5, 1) });   // jiný sloupec: nic

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
  assert.match(log, /Připojena tabulka „Kooperace \/ List 1“ \(klíč „Kooperace Hala 2“\), sleduje 3 průvodek/);
  assert.match(log, /Odpojena tabulka „Kooperace \/ List 1“ \(klíč „Kooperace 2“\)/);

  // 11) víc tabulek se stejným klíčem: stav (List 1) + urgenty (druhá tabulka, vlastní skript a webová aplikace)
  answer('');
  run('etdZapnout');
  const STATE2 = path.join(TMP, 'state2.json');
  const SCRIPT2 = path.join(TMP, 'urgenty.js');
  fs.writeFileSync(SCRIPT2, template.replace(/\/\/ <nastaveni>[\s\S]*\/\/ <\/nastaveni>/, `// <nastaveni>
const ETD = { api: '${BASE}/api/v1/', list: 'Urgenty', sloupecBarcode: 'A', parametrOdkazu: '', sloupecVysledek: '', prvniRadek: 2, typ: 'urgent', sloupecPoznamka: 'B', podDily: false };
// </nastaveni>`));
  save(STATE2, {
    props: {}, triggers: [], answers: [], alerts: [], googleMode: 'ok', spreadsheetId: 'tabulka-urgenty', spreadsheetName: 'Urgenty týdne',
    sheets: { Urgenty: {
      A1: { v: 'Barcode' }, B1: { v: 'Poznámka' },
      A2: { v: 'NOVA.1' }, B2: { v: 'do pátku, zákazník čeká' },
      A3: { v: 'URG-7' },
      A4: { v: '12345.678901.23457' }, B4: { v: 'expres' },
    } },
  });
  const g2Port = await freePort();
  const WEBAPP2 = `http://127.0.0.1:${g2Port}/macros/s/AKfycbURGENTurgentURGENT1/exec`;
  procs.push(spawn('node', [path.join(__dirname, 'fake_google.js'), String(g2Port), STATE2, SCRIPT2], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] }));
  await waitPort(g2Port);
  const run2 = (fn, ...args) => makeEnv(STATE2, fs.readFileSync(SCRIPT2, 'utf8'))[fn](...args);
  const alert2 = () => { const a = load(STATE2).alerts || []; return a[a.length - 1] || ''; };
  const answer2 = (...a) => { const st = load(STATE2); st.answers = a; save(STATE2, st); };
  answer2(key2); run2('etdNastavitKlic');
  answer2(WEBAPP2); run2('etdZapnout');
  assert.match(alert2(), /Živé propojení je zapnuté/, alert2());
  assert.match(alert2(), /Urgentních průvodek: 3, v Evidenci je z nich 2/, alert2());
  hooks = (await page('hooks')).hooks;
  assert.deepStrictEqual(hooks.map(h => [h.name, h.kind, h.keyName]).sort(),
    [['Kooperace / List 1', 'status', 'Kooperace 2'], ['Urgenty týdne / Urgenty', 'urgent', 'Kooperace 2']], 'dvě tabulky na jednom klíči');
  assert.deepStrictEqual(Object.keys(load(STATE2).sheets.Urgenty).sort(), ['A1', 'A2', 'A3', 'A4', 'B1', 'B2'].concat(['B4']).sort(), 'bez výsledkového sloupce se do tabulky urgentů nic nezapisuje');

  // urgent na pracovišti: NOVA.1 leží na Eloxu (příjem s pozicí X9), 23457 na Hale 2
  await page('dept', { dept: 'elox' });
  let urg = await page('urgent');
  assert.deepStrictEqual(urg.here.map(u => [u.barcode, u.note, u.last.position]), [['NOVA.1', 'do pátku, zákazník čeká', 'X9']]);
  assert.deepStrictEqual(urg.counts, { elox: 1, hala: 1 });
  await page('dept', { dept: 'hala' });
  urg = await page('urgent', null);
  assert.deepStrictEqual(urg.here.map(u => u.barcode), ['12345.678901.23457']);
  // příjem urgentu jinde: výsledek skenu ho označí, svítí na novém pracovišti
  await page('dept', { dept: 'montaz' });
  const scanned = await page('scan', { action: 'prijem', items: [{ barcode: 'urg-7' }], position: 'M1' });
  assert.deepStrictEqual(scanned.results[0].urgent, { note: '' });
  assert.deepStrictEqual((await page('urgent')).here.map(u => u.barcode), ['urg-7']);
  // export z pracoviště: urgent zhasne
  const out = await page('scan', { action: 'export', items: [{ barcode: 'URG-7', qty: 2 }] });
  assert.ok(out.results[0].urgent, 'i export urgentu se ve výsledku označí');
  assert.deepStrictEqual((await page('urgent')).here, []);
  const all = await page('urgent&all=1');
  assert.deepStrictEqual(all.all.map(u => [u.barcode.toLowerCase(), u.last.action]).sort(), [['12345.678901.23457', 'prijem'], ['nova.1', 'prijem'], ['urg-7', 'export']]);
  // obyčejná (stavová) tabulka urgenty nedělá
  const plain = await page('scan', { action: 'prijem', items: [{ barcode: '12345.678901.23456' }], position: '' });
  assert.strictEqual(plain.results[0].urgent, undefined);
  // urgent smazaný z tabulky přestane svítit
  const s2 = load(STATE2); delete s2.sheets.Urgenty.A2; delete s2.sheets.Urgenty.B2; save(STATE2, s2);
  run2('etdPriUprave', { range: makeEnv(STATE2, fs.readFileSync(SCRIPT2, 'utf8')).__range('Urgenty', 2, 1, 1) });
  await page('dept', { dept: 'elox' });
  assert.deepStrictEqual((await page('urgent')).here, []);
  // stav každé tabulky zvlášť, vypnutí jen té jedné
  run2('etdStav');
  assert.match(alert2(), /tabulka s urgenty/);
  run2('etdVypnout');
  assert.match(alert2(), /už v Evidenci nejsou urgentní/);
  assert.deepStrictEqual((await page('hooks')).hooks.map(h => h.kind), ['status'], 'tabulka stavu zůstala připojená');
  assert.deepStrictEqual((await page('urgent')).counts, {});

  console.log('e2e_sheets: vše v pořádku (' + load(STATE).fetches.length + ' volání API z tabulky, ' + load(STATE).writes + ' zápisů do listu)');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  procs.forEach(p => p.kill());
  fs.rmSync(TMP, { recursive: true, force: true });
});
