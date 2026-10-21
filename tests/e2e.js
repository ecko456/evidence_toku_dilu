/*
 * Průchod aplikací v Chromiu (Playwright): první spuštění, příjem a export jednotlivě
 * i vícenásobně, pozice, počet kusů, oprava rozložení klávesnice, přehled, na pracovištích,
 * storno, správa uživatelů a API klíčů, API pro IT, Visitor a telefon.
 *
 *   node tests/e2e.js              (SHOTS=/adresář uloží snímky obrazovky)
 *
 * Spouští vlastní PHP server s dočasnými daty. Chyby v konzoli i HTTP odpovědi ≥ 400 jsou chyba testu.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const APP = path.resolve(__dirname, '..');
const PW = fs.existsSync('/opt/node22/lib/node_modules/playwright') ? '/opt/node22/lib/node_modules/playwright' : 'playwright';
const { chromium } = require(PW);
const CHROME = process.env.CHROME || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => fs.existsSync(p));
const SHOTS = process.env.SHOTS || '';

let failures = 0;
function check(ok, what) {
  if (ok) console.log('ok   ' + what);
  else { failures++; console.log('FAIL ' + what); }
}
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } }

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'etd-e2e-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ETD_DATA_DIR: data };
  const php = spawn('php', ['-S', `127.0.0.1:${port}`, 'router.php'], { cwd: APP, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/'); break; } catch (e) { await new Promise(r => setTimeout(r, 50)); } }

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const problems = [];
  async function newPage(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...opts });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
    return page;
  }
  const scan = async (page, code, sel = '#scanInput') => { await page.focus(sel); await page.keyboard.type(code, { delay: 5 }); await page.keyboard.press('Enter'); };
  const resultText = page => page.locator('#scanResult').innerText();
  const waitResult = async (page, re) => { await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#scanResult')?.innerText || ''), re.source, { timeout: 8000 }); };
  const api = async (page, action, query) => page.evaluate(async ([a, q]) => { const r = await fetch('api.php?' + new URLSearchParams({ action: a, ...(q || {}) }), { headers: { 'X-Etd': '1' } }); return r.json(); }, [action, query]);

  try {
    /* --- první spuštění --- */
    const page = await newPage();
    await page.goto(base + '/');
    await page.waitForSelector('#setupForm');
    const token = execFileSync('php', ['bin/setup-token.php'], { cwd: APP, env }).toString().trim();
    await page.fill('[name=token]', token.toLowerCase());
    await page.fill('[name=name]', 'Jana Správcová');
    await page.fill('[name=login]', 'spravce');
    await page.fill('[name=password]', 'tajneheslo1');
    await page.fill('[name=password2]', 'tajneheslo1');
    await shot(page, '01-prvni-spusteni');
    await page.click('#setupForm [type=submit]');
    await page.waitForSelector('.tiles');
    check(await page.locator('.tile').count() === 8, 'výběr oddělení: 7 pracovišť a Visitor');
    check((await page.locator('.tile b').allInnerTexts()).join('|') === 'Broušení WPA|Brush WPA|Hala|Montáž|Elox|Studio|CNC Hala2|Visitor', 'pořadí oddělení');
    await shot(page, '02-oddeleni');
    await page.keyboard.press('3');
    await page.waitForSelector('#scanInput');
    check((await page.locator('.dept-pill').innerText()).includes('Hala'), 'klávesa 3 vybrala Halu');

    /* --- příjem jedné průvodky --- */
    await scan(page, 'PR-1001');
    await waitResult(page, /Přijato na pracoviště Hala/);
    check((await resultText(page)).includes('První záznam této průvodky'), 'příjem: první záznam');
    await page.waitForSelector('#recentBox .code-btn');
    check((await page.locator('#recentBox').innerText()).includes('PR-1001'), 'příjem je v posledních záznamech');
    check(await page.evaluate(() => document.activeElement.id) === 'scanInput', 'po příjmu je fokus zpět v poli pro barcode');

    await scan(page, 'pr-1001');
    await waitResult(page, /Už je zapsáno/);
    check(true, 'dvojí načtení do 10 minut se nezapíše (stejná průvodka bez ohledu na velikost písmen)');
    await page.click('[data-force]');
    await waitResult(page, /Přijato na pracoviště Hala/);
    check((await resultText(page)).includes('Předtím: Příjem na pracoviště'), 'Zapsat znovu zapíše a ukáže předchozí záznam');

    // znaky mimo pole pro barcode: čtečka píše, i když fokus utekl na tlačítko
    await page.click('#recentReload');
    await page.keyboard.type('PR-1002', { delay: 5 }); await page.keyboard.press('Enter');
    await waitResult(page, /PR-1002/);
    check(true, 'načtení funguje i s fokusem na tlačítku');

    /* --- pozice a vícenásobný příjem --- */
    await page.check('#optPos');
    await page.fill('#posInput', 'Regál A3');
    await page.check('#optMulti', { force: true });
    await page.waitForSelector('#batchBox:not([hidden])');
    for (const c of ['PR-2001', 'PR-2002', 'PR-2003']) await scan(page, c);
    await scan(page, 'pr-2002');
    await waitResult(page, /Už je v seznamu/);
    check(await page.locator('#batchBox tbody tr').count() === 3, 'vícenásobný příjem: 3 průvodky, opakované načtení se nepřidá');
    check((await page.locator('#batchBox').innerText()).includes('Pozice pro všechny: Regál A3'), 'pozice platí pro všechny načtené');
    await page.waitForFunction(() => !document.querySelector('#batchBox').innerText.includes('…'));
    await shot(page, '03-vicenasobny-prijem');
    await page.click('[data-bsave]');
    await waitResult(page, /Přijato 3 průvodky/);
    check(await page.locator('#batchBox tbody tr').count() === 0, 'po zapsání je seznam prázdný');
    const s2002 = await api(page, 'search', { q: 'PR-2002' });
    check(s2002.exact && s2002.exact.last.position === 'Regál A3' && s2002.exact.last.action === 'prijem', 'průvodka z dávky má pozici Regál A3');

    // seznam přežije obnovení stránky
    await scan(page, 'PR-2004');
    await page.reload();
    await page.waitForSelector('#batchBox tbody tr');
    check((await page.locator('#batchBox').innerText()).includes('PR-2004'), 'rozpracovaný seznam zůstane po obnovení stránky');
    await page.click('[data-bdel="0"]');

    // čtečka s anglickou klávesnicí ve Windows s českou: „PR=ěééí“ je PR-2009
    await page.uncheck('#optMulti', { force: true });
    await scan(page, 'PR=ěééí');
    await waitResult(page, /Přijato/);
    check((await resultText(page)).includes('PR-2009'), 'oprava české klávesnice: PR=ěééí → PR-2009');
    check((await page.locator('#toasts').innerText()).includes('Opraveno rozložení'), 'o opravě dá aplikace vědět');

    // zapnutá pozice bez vyplnění se nezapíše
    await page.fill('#posInput', '');
    await scan(page, 'PR-2010');
    await waitResult(page, /Vyplň pozici/);
    check((await api(page, 'search', { q: 'PR-2010' })).exact === null, 'bez vyplněné pozice se příjem nezapsal');
    await page.uncheck('#optPos');

    /* --- export: jedna průvodka s počtem kusů --- */
    await page.click('[data-tab=export]');
    await page.waitForSelector('.scan.a-export');
    await scan(page, 'PR-2001');
    await page.waitForSelector('#qtyInput');
    check(await page.evaluate(() => document.activeElement.id) === 'qtyInput', 'export: po načtení je fokus v počtu kusů');
    await page.waitForFunction(() => /Poslední záznam: Příjem/.test(document.querySelector('#qtyInfo').innerText));
    await shot(page, '04-export-ks');
    await page.keyboard.type('48'); await page.keyboard.press('Enter');
    await waitResult(page, /Export z pracoviště Hala/);
    check((await resultText(page)).includes('48 ks'), 'export zapsal 48 ks');

    await scan(page, 'PR-2002');
    await page.waitForSelector('#qtyInput');
    await page.keyboard.type('PR-2003'); await page.keyboard.press('Enter');
    await waitResult(page, /Nejdřív zadej počet kusů/);
    check(!(await page.locator('#qtyPanel').isHidden()), 'barcode místo počtu kusů: export čeká dál');
    await page.keyboard.type('1 200'); await page.keyboard.press('Enter');
    await waitResult(page, /1\s200 ks/);
    check(true, 'počet kusů s mezerou (1 200)');

    /* --- vícenásobný export --- */
    await page.check('#optMulti', { force: true });
    await scan(page, 'PR-2003');
    check(await page.evaluate(() => document.activeElement.matches('.row-qty')), 'vícenásobný export: fokus na počtu kusů nové průvodky');
    await page.keyboard.type('5'); await page.keyboard.press('Enter');
    check(await page.evaluate(() => document.activeElement.id) === 'scanInput', 'Enter v počtu kusů vrátí fokus na barcode');
    await scan(page, 'PR-1001');
    await page.focus('#scanInput');
    await page.click('[data-bsave]');
    await waitResult(page, /Chybí počet kusů/);
    await page.fill('#fillQty', '7');
    await page.click('[data-fill]');
    check(await page.locator('[data-q="1"]').inputValue() === '7', 'Doplnit vyplní prázdný počet kusů');
    await shot(page, '05-vicenasobny-export');
    await page.click('[data-bsave]');
    await waitResult(page, /Exportováno 2 průvodky/);

    /* --- přehled a vyhledávání --- */
    await page.click('[data-tab=prehled]');
    await page.waitForSelector('#searchInput');
    await scan(page, 'pr-2001', '#searchInput');
    await page.waitForSelector('.last-card');
    const lastCard = await page.locator('.last-card').innerText();
    check(/Export z pracoviště/.test(lastCard) && /48 ks/.test(lastCard), 'poslední záznam PR-2001: export 48 ks');
    const rows = await page.locator('#searchOut .tbl tbody tr').allInnerTexts();
    check(rows.length === 2 && /Export/.test(rows[0]) && /poslední záznam/.test(rows[0]) && /Příjem/.test(rows[1]), 'historie od nejnovějšího, nahoře poslední záznam');
    await page.fill('#searchInput', 'PR-20');
    await page.waitForFunction(() => /obsahující/.test(document.querySelector('#searchOut').innerText));
    const matches = await page.locator('#searchOut').innerText();
    check(['PR-2001', 'PR-2002', 'PR-2003', 'PR-2009'].every(c => matches.includes(c)) && !matches.includes('PR-1001'), 'částečné hledání najde PR-20…');
    await shot(page, '06-prehled-hledani');
    await page.click('#searchOut [data-find="PR-2009"]');
    await page.waitForFunction(() => document.querySelector('.last-card')?.innerText.includes('PR-2009'));
    check(true, 'klik na barcode otevře jeho historii');

    /* --- na pracovištích --- */
    await page.click('[data-tab=onsite]');
    await page.waitForSelector('.onsite-card');
    const hala = await page.locator('.onsite-card.dept-hala').innerText();
    check(await page.locator('.onsite-card.dept-hala .big-n').innerText() === '2', 'na Hale zůstaly 2 průvodky (PR-1002 a PR-2009, ostatní odešly exportem)');
    check(hala.includes('PR-2009') && hala.includes('Regál A3'), 'na pracovišti je vidět pozice');
    await shot(page, '07-na-pracovistich');

    /* --- storno --- */
    await page.click('.onsite-card.dept-hala [data-find="PR-2009"]');
    await page.waitForSelector('.last-card [data-cancel-rec]');
    await page.click('.last-card [data-cancel-rec]');
    await page.fill('dialog [name=reason]', 'špatně načtená průvodka');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => /všechny záznamy jsou stornované/.test(document.querySelector('#searchOut').innerText));
    check((await page.locator('#searchOut .tbl tr.cancelled').count()) === 1, 'stornovaný záznam zůstane v historii přeškrtnutý');
    await page.click('[data-tab=onsite]');
    await page.waitForSelector('.onsite-card');
    check(await page.locator('.onsite-card.dept-hala .big-n').innerText() === '1', 'po stornu PR-2009 zmizela z Haly');

    /* --- správa: uživatelé a API klíč --- */
    await page.click('[data-tab=admin]');
    await page.click('#userAdd');
    await page.fill('dialog [name=name]', 'Petr Dvořák');
    await page.fill('dialog [name=login]', 'dvorak');
    await page.uncheck('dialog [name=dept][value=brouseni_wpa]');
    for (const d of ['brush_wpa', 'hala', 'elox', 'studio', 'cnc_hala2']) await page.uncheck(`dialog [name=dept][value=${d}]`);
    const dvorakPw = await page.inputValue('dialog [name=password]');
    check(/^[a-z2-9]{5}-[a-z2-9]{5}$/.test(dvorakPw), 'nový uživatel dostane dočasné heslo');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.querySelector('#usersBox').innerText.includes('Petr Dvořák'));
    await page.click('#userAdd');
    await page.fill('dialog [name=name]', 'Návštěva');
    await page.fill('dialog [name=login]', 'navsteva');
    await page.check('dialog [name=role][value=visitor]');
    check(await page.locator('dialog [data-depts]').isHidden(), 'u role Jen nahlížení se oddělení nevybírají');
    const visitorPw = await page.inputValue('dialog [name=password]');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.querySelector('#usersBox').innerText.includes('Návštěva'));
    await page.click('#keyAdd');
    await page.fill('dialog [name=name]', 'ERP test');
    await page.click('dialog [type=submit]');
    await page.waitForSelector('dialog .key-box input');
    const key = await page.inputValue('dialog .key-box input');
    check(/^etd_[0-9a-f]{40}$/.test(key), 'API klíč se ukáže jednou po vytvoření');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.querySelector('#keysBox').innerText.includes('ERP test'));
    await shot(page, '08-sprava');
    await page.click('[data-tab=api]');
    await page.waitForSelector('.endpoint');
    check((await page.locator('.doc').innerText()).includes(base + '/api/v1/'), 'API pro IT ukazuje adresu API');
    await shot(page, '09-api');

    /* --- API pro IT s klíčem --- */
    const j = async (url, opt = {}) => { const r = await fetch(base + url, opt); return [r.status, await r.json()]; };
    let [st, body] = await j('/api/v1/last?barcode=pr-2001', { headers: { Authorization: 'Bearer ' + key } });
    check(st === 200 && body.record.action === 'export' && body.record.quantity === 48 && body.record.department === 'hala', 'API: poslední záznam PR-2001');
    [st, body] = await j('/api/v1/last?barcode=PR-2009', { headers: { 'X-Api-Key': key } });
    check(st === 404 && body.found === false, 'API: průvodka jen se stornovanými záznamy vrátí 404');
    [st, body] = await j('/api/v1/last', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ barcodes: ['PR-2002', 'neni'] }) });
    check(st === 200 && body.results[0].record.quantity === 1200 && body.results[1].found === false, 'API: více průvodek najednou');
    [st] = await j('/api/v1/last?barcode=PR-2001');
    check(st === 401, 'API bez klíče: 401');

    /* --- pracovník: vlastní heslo, jen jeho oddělení --- */
    await page.click('[data-menu]');
    await page.click('[data-m=logout]');
    await page.waitForSelector('#loginForm');
    await page.fill('[name=login]', 'dvorak'); await page.fill('[name=password]', dvorakPw);
    await page.click('#loginForm [type=submit]');
    await page.waitForSelector('#pwForm');
    await page.fill('[name=old]', dvorakPw); await page.fill('[name=new]', 'mojeheslo1'); await page.fill('[name=new2]', 'mojeheslo1');
    await page.click('#pwForm [type=submit]');
    await page.waitForSelector('.tiles');
    const enabled = await page.locator('.tile:not(:disabled) b').allInnerTexts();
    check(enabled.join('|') === 'Montáž|Visitor', 'pracovník vidí jen svoje oddělení (Montáž) a Visitor');
    await page.click('.tile.dept-montaz');
    await page.waitForSelector('#scanInput');
    check(await page.locator('[data-tab=admin]').count() === 0, 'pracovník nemá Správu');
    await scan(page, 'PR-2001');
    await waitResult(page, /Přijato na pracoviště Montáž/);
    check((await resultText(page)).includes('Předtím: Export z pracoviště · Hala · 48 ks'), 'příjem na Montáži ukáže, že díly přišly exportem z Haly');

    /* --- Visitor jen nahlíží --- */
    await page.click('[data-menu]');
    await page.click('[data-m=logout]');
    await page.fill('[name=login]', 'navsteva'); await page.fill('[name=password]', visitorPw);
    await page.click('#loginForm [type=submit]');
    await page.waitForSelector('#pwForm');
    await page.fill('[name=old]', visitorPw); await page.fill('[name=new]', 'navsteva123'); await page.fill('[name=new2]', 'navsteva123');
    await page.click('#pwForm [type=submit]');
    await page.waitForSelector('.tiles');
    check((await page.locator('.tile:not(:disabled) b').allInnerTexts()).join('|') === 'Visitor', 'role Jen nahlížení smí jen Visitor');
    await page.keyboard.press('8');
    await page.waitForSelector('#searchInput');
    check((await page.locator('.tab').allInnerTexts()).join('|') === 'Přehled|Na pracovištích', 'Visitor vidí jen Přehled a Na pracovištích');
    const denied = await page.evaluate(async () => (await fetch('api.php?action=scan', { method: 'POST', headers: { 'X-Etd': '1', 'X-Etd-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prijem', items: [{ barcode: 'X' }] }) })).status);
    const at = problems.findIndex(p => p.startsWith('HTTP 403') && p.includes('action=scan'));
    if (at >= 0) problems.splice(at, 1);
    const logged = problems.findIndex(p => p.includes('status of 403'));
    if (logged >= 0) problems.splice(logged, 1);
    check(denied === 403, 'Visitor nemůže zapisovat ani přímo přes API');
    await page.click('[data-tab=onsite]');
    await page.waitForSelector('.onsite-card');
    const montaz = await page.locator('.onsite-card.dept-montaz').innerText();
    check(montaz.includes('PR-2001'), 'Visitor vidí PR-2001 na Montáži');
    await shot(page, '10-visitor');

    /* --- telefon a tmavý režim --- */
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.goto(base + '/');
    await phone.waitForSelector('#loginForm');
    await shot(phone, '11-telefon-prihlaseni');
    await phone.fill('[name=login]', 'spravce'); await phone.fill('[name=password]', 'tajneheslo1');
    await phone.click('#loginForm [type=submit]');
    await phone.waitForSelector('.tiles');
    await shot(phone, '12-telefon-oddeleni');
    await phone.click('.tile.dept-hala');
    await phone.waitForSelector('#scanInput');
    await phone.check('#optPos'); await phone.fill('#posInput', 'B2');
    await phone.check('#optMulti', { force: true });
    await scan(phone, 'PR-3001'); await scan(phone, 'PR-3002');
    await phone.waitForFunction(() => !document.querySelector('#batchBox').innerText.includes('…'));
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, 'telefon: stránka se neposouvá do strany');
    await shot(phone, '13-telefon-prijem');
    const dark = await newPage({ colorScheme: 'dark', viewport: { width: 1280, height: 860 } });
    await dark.goto(base + '/#prehled?q=PR-2001');
    await dark.waitForSelector('#loginForm');
    await dark.fill('[name=login]', 'spravce'); await dark.fill('[name=password]', 'tajneheslo1');
    await dark.click('#loginForm [type=submit]');
    await dark.click('.tile.dept-brouseni_wpa');
    await dark.click('[data-tab=prehled]');
    await scan(dark, 'PR-2001', '#searchInput');
    await dark.waitForSelector('.last-card');
    check(await dark.inputValue('#searchInput') === 'PR-2001', 'načtení do předvyplněného vyhledávače text nahradí, nepřipíše');
    await shot(dark, '14-tmavy-prehled');

    check(problems.length === 0, 'žádné chyby v konzoli ani neočekávané HTTP chyby' + (problems.length ? ':\n  ' + problems.join('\n  ') : ''));
  } catch (error) {
    failures++;
    console.log('FAIL výjimka: ' + (error.stack || error));
  } finally {
    await browser.close();
    php.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(failures ? `e2e: ${failures} chyb` : 'e2e ok');
  process.exit(failures ? 1 : 0);
})();
