/**
 * Evidence toku dílů → Google tabulka: živé propojení (verze 1.3.1)
 *
 * Skript najde ve sloupci s barcody (nebo s odkazy, ve kterých je barcode) průvodky, pošle jejich
 * seznam do Evidence a do výsledkového sloupce zapíše poslední záznam. Když pak někdo průvodku
 * přijme, exportuje nebo stornuje, Evidence změnu do pár sekund pošle sama (funkce doPost).
 *
 * Návod je v Evidenci: Správa → API pro IT → Google tabulka. Krátce:
 *   1. Rozšíření → Apps Script, vlož tenhle kód, ulož.
 *   2. Nasadit → Nové nasazení → Webová aplikace; spustit jako „Já“, přístup „Kdokoli“. Zkopíruj adresu …/exec.
 *   3. V tabulce (po obnovení stránky) menu Evidence → Nastavit API klíč, pak Zapnout živé propojení.
 * Při úpravě kódu: Nasadit → Spravovat nasazení → upravit → Verze: Nová verze (adresa zůstane).
 */

// <nastaveni>
const ETD = {
  api: 'https://SERVER/evidence_toku_dilu/api/v1/', // adresa API Evidence
  list: 'List 1',                                   // název listu (záložka dole)
  sloupecBarcode: 'D',                              // sloupec s barcodem nebo s odkazem
  parametrOdkazu: 'activeBarcode',                  // barcode je v odkazu za „activeBarcode=“; '' = barcode je přímo text buňky
  sloupecVysledek: 'K',                             // sem se zapíše poslední záznam
  prvniRadek: 2,                                    // řádek 1 je záhlaví
};
// </nastaveni>

/* ------------------------------------------------------------------ menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Evidence')
    .addItem('Zapnout živé propojení', 'etdZapnout')
    .addItem('Aktualizovat vše teď', 'etdAktualizovatVse')
    .addItem('Stav propojení', 'etdStav')
    .addSeparator()
    .addItem('Nastavit API klíč', 'etdNastavitKlic')
    .addItem('Vypnout živé propojení', 'etdVypnout')
    .addToUi();
}

function etdNastavitKlic() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('API klíč Evidence', 'Vlož klíč etd_… (vytvoří ho správce v Evidenci: Správa → API klíče).', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!/^etd_[0-9a-f]{40}$/.test(key)) {
    ui.alert('Tohle nevypadá jako klíč Evidence (etd_ a 40 znaků). Nic se neuložilo.');
    return;
  }
  etdProps().setProperty('ETD_KEY', key);
  try {
    const ping = etdApi('get', 'ping');
    ui.alert('Klíč funguje ✔', 'Klíč „' + ping.key + '“, Evidence verze ' + ping.version + '.\n\nTeď dej Evidence → Zapnout živé propojení.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Klíč je uložený, ale Evidence ho nepřijala', String(err.message || err), ui.ButtonSet.OK);
  }
}

function etdZapnout() {
  const ui = SpreadsheetApp.getUi();
  const props = etdProps();
  if (!props.getProperty('ETD_KEY')) {
    ui.alert('Nejdřív Evidence → Nastavit API klíč.');
    return;
  }
  etdList();   // ověří název listu dřív, než se cokoli zapne
  let url = props.getProperty('ETD_WEBAPP') || '';
  if (!url) {
    try { url = ScriptApp.getService().getUrl() || ''; } catch (err) { url = ''; }
    if (!/\/exec$/.test(url)) url = '';
  }
  const r = ui.prompt('Adresa webové aplikace',
    'Vlož adresu z Nasadit → Spravovat nasazení → Webová aplikace (končí /exec).' + (url ? '\n\nPrázdné = ponechat:\n' + url : ''),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const typed = r.getResponseText().trim();
  if (typed) url = typed;
  if (!/^https?:\/\/\S+\/exec$/.test(url)) {
    ui.alert('Adresa musí končit /exec. Najdeš ji v Apps Scriptu: Nasadit → Spravovat nasazení → Webová aplikace.');
    return;
  }
  props.setProperty('ETD_WEBAPP', url);
  props.setProperty('ETD_SHEET_ID', SpreadsheetApp.getActive().getId());
  if (!props.getProperty('ETD_SECRET')) {
    props.setProperty('ETD_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }

  etdSpoustece(true);
  const res = etdSync(true);
  const lines = [
    'Sleduje se ' + res.watching + ' průvodek, v Evidenci je z nich ' + res.found + '.',
    'Sloupec ' + ETD.sloupecVysledek + ' je aktuální.',
    '',
  ];
  if (res.ping && res.ping.ok) {
    lines.push('Zkouška spojení Evidence → tabulka: v pořádku ✔');
    lines.push('Každý příjem, export i storno sledované průvodky se tu objeví do pár sekund.');
  } else {
    lines.push('⚠ Evidence se k tabulce nedostala: ' + (res.ping ? res.ping.error : 'bez odpovědi'));
    lines.push('Dokud se to nevyřeší, tabulka se aktualizuje jen při změně ve sloupci ' + ETD.sloupecBarcode + ' a jednou za hodinu.');
  }
  if (res.worker && !res.worker.running) {
    lines.push('', '⚠ Na serveru Evidence neběží odesílání změn (cron). Správce ho zapne instalací (deploy/install.sh).');
  }
  ui.alert(res.ping && res.ping.ok ? 'Živé propojení je zapnuté ✔' : 'Propojení je zapnuté jen napůl', lines.join('\n'), ui.ButtonSet.OK);
}

function etdAktualizovatVse() {
  const res = etdSync(false);
  SpreadsheetApp.getActive().toast('Sledováno ' + res.watching + ' průvodek, v Evidenci ' + res.found + '. Sloupec ' + ETD.sloupecVysledek + ' je aktuální.', 'Evidence', 6);
}

function etdStav() {
  const ui = SpreadsheetApp.getUi();
  const props = etdProps();
  const s = etdApi('get', 'watch');
  const lines = [];
  if (!s.connected) {
    lines.push('Živé propojení je vypnuté. Zapneš ho v menu Evidence → Zapnout živé propojení.');
  } else {
    const st = s.status;
    const label = { ok: 'v pořádku ✔', waiting: 'zapnuté, čeká na první změnu', error: 'CHYBA ⚠', off: 'vypnuté' }[st.status] || st.status;
    lines.push('Propojení: ' + label);
    lines.push('Sledováno: ' + st.watching + ' průvodek · čeká na odeslání: ' + st.queued + ' · odesláno celkem: ' + st.sent);
    if (st.lastOkAt) lines.push('Naposledy doručeno: ' + etdCas(st.lastOkAt));
    if (st.lastError) lines.push('', 'Chyba (' + etdCas(st.lastErrorAt) + '): ' + st.lastError, st.retryAt ? 'Další pokus: ' + etdCas(st.retryAt) : '');
    lines.push('Odesílání na serveru: ' + (s.worker.running ? 'běží' : 'NEBĚŽÍ (správce: deploy/install.sh)'));
  }
  const log = JSON.parse(props.getProperty('ETD_LOG') || '[]');
  if (log.length) {
    lines.push('', 'Poslední živé změny:');
    log.slice(0, 8).forEach(l => lines.push('• ' + l));
  }
  ui.alert('Evidence: stav propojení', lines.join('\n'), ui.ButtonSet.OK);
}

function etdVypnout() {
  const ui = SpreadsheetApp.getUi();
  etdSpoustece(false);
  try { etdApi('delete', 'watch'); } catch (err) { /* klíč může být zrušený; spouštěče jsou pryč tak jako tak */ }
  etdProps().deleteProperty('ETD_SECRET');
  ui.alert('Živé propojení je vypnuté. Sloupec ' + ETD.sloupecVysledek + ' zůstal, jak byl, a už se nemění.');
}

/* ------------------------------------------------------------------ spouštěče */

/** Po změně ve sloupci s barcody pošle Evidenci nový seznam (a doplní výsledky). */
function etdPriUprave(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== etdList().getName()) return;
  const col = etdSloupec(ETD.sloupecBarcode);
  if (r.getColumn() > col || r.getLastColumn() < col) return;
  etdSync(false);
}

/** Pojistka jednou za hodinu: celý seznam znovu a kontrola, že se Evidence k tabulce dostane. */
function etdHodinova() {
  try {
    etdSync(false);
    etdProps().deleteProperty('ETD_ERROR');
  } catch (err) {
    etdProps().setProperty('ETD_ERROR', new Date().toISOString() + ' ' + (err.message || err));
    throw err;
  }
}

function etdSpoustece(zapnout) {
  ScriptApp.getProjectTriggers()
    .filter(t => ['etdPriUprave', 'etdHodinova'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (!zapnout) return;
  ScriptApp.newTrigger('etdPriUprave').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  ScriptApp.newTrigger('etdHodinova').timeBased().everyHours(1).create();
}

/* ------------------------------------------------------------------ webová aplikace (Evidence → tabulka) */

function doPost(e) {
  let msg;
  try { msg = JSON.parse(e.postData.contents); } catch (err) { return etdOdpoved({ ok: false, error: 'json' }); }
  const props = etdProps();
  const secret = props.getProperty('ETD_SECRET');
  if (!secret || !msg || typeof msg.data !== 'string' || etdHmac(msg.data, secret) !== msg.sig) {
    return etdOdpoved({ ok: false, error: 'signature' });
  }
  const data = JSON.parse(msg.data);
  if (Math.abs(Date.now() / 1000 - data.sent_at) > 3600) return etdOdpoved({ ok: false, error: 'expired' });
  const sheet = etdList();
  if (data.type === 'ping') {
    return etdOdpoved({ ok: true, ping: true, spreadsheet: sheet.getParent().getName(), sheet: sheet.getName(), rows: Math.max(0, sheet.getLastRow() - ETD.prvniRadek + 1) });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const mapa = {};
    (data.items || []).forEach(it => { mapa[String(it.barcode).toLowerCase()] = it.found ? it.text : ''; });
    const zmeneno = etdZapis(sheet, etdNactiBarcody(sheet), mapa, true);
    const log = JSON.parse(props.getProperty('ETD_LOG') || '[]');
    const kdy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'd.M. H:mm:ss');
    (data.items || []).slice(0, 10).forEach(it => log.unshift(kdy + '  ' + it.barcode + ': ' + (it.found ? it.text : 'bez záznamu')));
    props.setProperty('ETD_LOG', JSON.stringify(log.slice(0, 20)));
    return etdOdpoved({ ok: true, updated: zmeneno });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return etdOdpoved({ ok: true, app: 'Evidence toku dílů → Google tabulka', note: 'Tahle adresa přijímá změny z Evidence (POST).' });
}

/* ------------------------------------------------------------------ jádro */

/** Seznam barcodů do Evidence a výsledky do tabulky. ping = Evidence zkusí poslat zkušební zprávu. */
function etdSync(ping) {
  const props = etdProps();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = etdList();
    const codes = etdNactiBarcody(sheet);
    const unique = [];
    const seen = {};
    codes.forEach(c => { if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = true; unique.push(c); } });
    const res = etdApi('post', 'watch', {
      url: props.getProperty('ETD_WEBAPP'),
      secret: props.getProperty('ETD_SECRET'),
      barcodes: unique,
      ping: !!ping,
    });
    const mapa = {};
    (res.results || []).forEach(it => { mapa[String(it.barcode).toLowerCase()] = it.text; });
    etdZapis(sheet, codes, mapa, false);
    return res;
  } finally {
    lock.releaseLock();
  }
}

/** Barcode v každém řádku od prvniRadek (nebo '' když tam žádný není). */
function etdNactiBarcody(sheet) {
  const n = sheet.getLastRow() - ETD.prvniRadek + 1;
  if (n < 1) return [];
  const range = sheet.getRange(ETD.prvniRadek, etdSloupec(ETD.sloupecBarcode), n, 1);
  const display = range.getDisplayValues();
  if (!ETD.parametrOdkazu) return display.map(r => String(r[0]).trim());
  const rich = range.getRichTextValues();
  const formulas = range.getFormulas();
  const re = new RegExp('[?&]' + ETD.parametrOdkazu.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^&#"\\s]+)', 'i');
  return display.map((r, i) => {
    const texty = [formulas[i][0], r[0]];
    const rt = rich[i][0];
    if (rt) {
      texty.push(rt.getLinkUrl());
      rt.getRuns().forEach(run => texty.push(run.getLinkUrl()));
    }
    const m = re.exec(texty.filter(Boolean).join(' '));
    if (!m) return '';
    try { return decodeURIComponent(m[1]).trim(); } catch (err) { return m[1].trim(); }
  });
}

/**
 * Zapíše výsledky do sloupce. jenZnam = true: jen řádky, jejichž barcode je v mapě (živá změna);
 * jinak všechny řádky s barcodem (bez shody se buňka vyprázdní). Řádky bez barcodu zůstanou
 * beze změny, i se vzorci. Vrací počet změněných buněk.
 */
function etdZapis(sheet, codes, mapa, jenZnam) {
  if (!codes.length) return 0;
  const range = sheet.getRange(ETD.prvniRadek, etdSloupec(ETD.sloupecVysledek), codes.length, 1);
  const values = range.getValues();
  const formulas = range.getFormulas();
  let zmeneno = 0;
  const out = values.map((row, i) => {
    const keep = formulas[i][0] || row[0];
    const code = codes[i];
    if (!code) return [keep];
    const key = code.toLowerCase();
    if (jenZnam && !(key in mapa)) return [keep];
    const text = mapa[key] || '';
    if (text !== row[0] || formulas[i][0]) zmeneno++;
    return [text];
  });
  if (zmeneno) range.setValues(out);
  return zmeneno;
}

function etdApi(method, endpoint, body) {
  const key = etdProps().getProperty('ETD_KEY');
  if (!key) throw new Error('Chybí API klíč: Evidence → Nastavit API klíč.');
  const opts = { method: method, headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true };
  if (body) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(ETD.api + endpoint, opts);
  const text = res.getContentText();
  let data;
  try { data = JSON.parse(text); } catch (err) {
    throw new Error('Na adrese ' + ETD.api + ' neodpovídá Evidence (HTTP ' + res.getResponseCode() + ', přišla stránka místo dat). Zkontroluj ETD.api nahoře ve skriptu.');
  }
  if (res.getResponseCode() >= 400) throw new Error(data.message || data.error || ('HTTP ' + res.getResponseCode()));
  return data;
}

/* ------------------------------------------------------------------ pomocné */

function etdProps() {
  return PropertiesService.getScriptProperties();
}

function etdList() {
  const id = etdProps().getProperty('ETD_SHEET_ID');
  let ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (err) { ss = null; }
  if (!ss && id) ss = SpreadsheetApp.openById(id);
  if (!ss) throw new Error('Tabulku se nepodařilo otevřít. V tabulce dej znovu Evidence → Zapnout živé propojení.');
  let sheet = ss.getSheetByName(ETD.list);
  if (!sheet) {
    // „List1“ najde i „List 1“ (česká tabulka má mezeru) a nehraje roli velikost písmen
    const norm = name => String(name).toLowerCase().replace(/\s+/g, '');
    const found = ss.getSheets().filter(s => norm(s.getName()) === norm(ETD.list));
    sheet = found.length === 1 ? found[0] : null;
  }
  if (!sheet) {
    const names = ss.getSheets().map(s => '„' + s.getName() + '“').join(', ');
    throw new Error('List „' + ETD.list + '“ v tabulce není. Listy v tabulce: ' + names + '. Oprav ETD.list nahoře ve skriptu (přesně jako záložka dole) a ulož (Ctrl+S).');
  }
  return sheet;
}

/** 'K' → 11, 'AA' → 27 */
function etdSloupec(pismeno) {
  return String(pismeno).toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function etdHmac(data, secret) {
  return Utilities.computeHmacSha256Signature(data, secret)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function etdCas(iso) {
  return iso ? Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'd.M.yyyy H:mm:ss') : '—';
}

function etdOdpoved(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
