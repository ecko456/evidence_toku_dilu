/*
 * Načítání QR kódu fotoaparátem (telefon a tablet) v Chromiu s falešnou kamerou: video
 * s QR kódy průvodek vyrobí ZXing (stejná knihovna jako v aplikaci) do souboru .y4m.
 *
 *   node tests/e2e_camera.js        (SHOTS=/adresář uloží snímky obrazovky)
 *
 * Chromium na Linuxu nemá BarcodeDetector, takže se tu ověřuje cesta přes ZXing (iPhone, iPad).
 * Cesta přes BarcodeDetector (Android) běží s náhradní třídou, chyby fotoaparátu s náhradním getUserMedia.
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
const Z = require(path.join(APP, 'static/vendor/zxing.min.js'));
const CODES = ['PR-QR-0001', 'PR-QR-0002', 'PR-QR-0003'];

let failures = 0;
function check(ok, what) {
  if (ok) console.log('ok   ' + what);
  else { failures++; console.log('FAIL ' + what); }
}
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }

/** Video 640×480 (Y4M, 4:2:0): každý kód z CODES 1,2 s na bílém pozadí, pak se smyčka opakuje. */
function qrVideo(file) {
  const W = 640, H = 480, FPS = 10, PER = 12, SIZE = 330;
  const frames = [];
  for (const code of CODES) {
    const m = new Z.QRCodeWriter().encode(code, Z.BarcodeFormat.QR_CODE, SIZE, SIZE, new Map([[Z.EncodeHintType.MARGIN, 2]]));
    const y = Buffer.alloc(W * H, 235);
    const x0 = (W - m.getWidth()) >> 1, y0 = (H - m.getHeight()) >> 1;
    for (let yy = 0; yy < m.getHeight(); yy++) for (let xx = 0; xx < m.getWidth(); xx++) if (m.get(xx, yy)) y[(y0 + yy) * W + x0 + xx] = 16;
    const uv = Buffer.alloc((W / 2) * (H / 2), 128);
    const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv]);
    for (let i = 0; i < PER; i++) frames.push(frame);
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`), ...frames]));
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'etd-cam-'));
  const video = path.join(data, 'qr.y4m');
  qrVideo(video);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ETD_DATA_DIR: data };
  const php = spawn('php', ['-S', `127.0.0.1:${port}`, 'router.php'], { cwd: APP, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/'); break; } catch (e) { await new Promise(r => setTimeout(r, 50)); } }
  const token = execFileSync('php', ['bin/setup-token.php'], { cwd: APP, env }).toString().trim();
  const setup = await fetch(base + '/api.php?action=setup', { method: 'POST', headers: { 'X-Etd': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, login: 'spravce', name: 'Jana Správcová', password: 'tajneheslo1' }) });
  check(setup.ok, 'první správce');

  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  const problems = [];
  const phoneOpts = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] };
  async function login(opts, init) {
    const ctx = await browser.newContext(opts);
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
    await page.goto(base + '/');
    await page.fill('[name=login]', 'spravce'); await page.fill('[name=password]', 'tajneheslo1');
    await page.click('#loginForm [type=submit]');
    await page.click('.tile.dept-hala');
    await page.waitForSelector('#scanInput');
    return page;
  }
  const api = (page, action, query) => page.evaluate(async ([a, q]) => (await fetch('api.php?' + new URLSearchParams({ action: a, ...(q || {}) }), { headers: { 'X-Etd': '1' } })).json(), [action, query]);

  try {
    /* --- telefon: ZXing --- */
    const page = await login(phoneOpts);
    check(await page.locator('[data-cam]').count() === 1, 'telefon: vedle pole pro barcode je tlačítko Načíst QR');
    await shot(page, 'cam-01-tlacitko');
    await page.click('[data-cam]');
    await page.waitForSelector('dialog.cam-dlg video');
    await page.waitForFunction(() => { const v = document.querySelector('dialog.cam-dlg video'); return v && v.videoWidth > 0; }, null, { timeout: 10000 });
    await shot(page, 'cam-02-fotoaparat');
    await page.waitForSelector('dialog.cam-dlg', { state: 'detached', timeout: 15000 });
    await page.waitForFunction(() => /Přijato na pracoviště Hala 2/.test(document.querySelector('#scanResult').innerText), null, { timeout: 8000 });
    const first = (await page.locator('#scanResult .code').innerText()).trim();
    check(CODES.includes(first), `jeden příjem: fotoaparát přečetl QR (${first}), zavřel se a příjem se zapsal`);
    check(await page.evaluate(() => typeof window.ZXing === 'object'), 'bez BarcodeDetectoru se načetla knihovna ZXing');
    check(await page.evaluate(() => document.activeElement.id !== 'scanInput'), 'po fotoaparátu se nefokusuje pole (na telefonu by vyjela klávesnice)');

    // vícenásobný příjem s pozicí: fotoaparát čte dál, každý kód jen jednou
    await page.check('#optPos'); await page.fill('#posInput', 'Regál Q1');
    await page.check('#optMulti', { force: true });
    await page.click('[data-cam]');
    await page.waitForFunction(() => /Přidáno: .*v seznamu 3/.test(document.querySelector('dialog.cam-dlg .cam-state')?.textContent || ''), null, { timeout: 20000 });
    check(true, 'vícenásobný příjem: fotoaparát zůstal otevřený a přidal všechny 3 průvodky');
    await shot(page, 'cam-03-vicenasobny');
    await page.waitForTimeout(1500);
    await page.click('dialog.cam-dlg .cam-acts [data-camclose]');
    await page.waitForSelector('dialog.cam-dlg', { state: 'detached' });
    check(await page.locator('#batchBox tbody tr').count() === 3, 'v seznamu jsou 3 průvodky (žádná dvakrát)');
    await page.click('[data-bsave]');
    // první kód se před chvílí přijal jednotlivě: zapíšou se 2, třetí čeká na „Zapsat přesto“
    await page.waitForFunction(() => /Přijato 2 průvodky/.test(document.querySelector('#scanResult').innerText));
    check(await page.locator('#batchBox tr.st-duplicate').count() === 1, 'průvodka přijatá před chvílí zůstala v seznamu jako dvojí načtení');
    await page.click('[data-bforce]');
    await page.waitForFunction(() => /Přijato 1 průvodka/.test(document.querySelector('#scanResult').innerText));
    const s2 = await api(page, 'search', { q: 'PR-QR-0002' });
    check(s2.exact.last.position === 'Regál Q1', 'průvodky z fotoaparátu mají pozici pro všechny');
    await shot(page, 'cam-04-zapsano');

    // vícenásobný příjem bez vyplněné pozice: fotoaparát se neotevře
    await page.fill('#posInput', '');
    await page.click('[data-cam]');
    check(await page.locator('dialog.cam-dlg').count() === 0 && /Vyplň pozici/.test(await page.locator('#scanResult').innerText()), 'bez pozice se fotoaparát neotevře');
    await page.uncheck('#optPos');
    await page.uncheck('#optMulti', { force: true });

    // export: po načtení fotoaparátem se ptá na počet kusů
    await page.click('[data-tab=export]');
    await page.waitForSelector('.scan.a-export [data-cam]');
    await page.click('[data-cam]');
    await page.waitForSelector('#qtyInput', { timeout: 15000 });
    check(await page.evaluate(() => document.activeElement.id) === 'qtyInput', 'export: po QR je fokus v počtu kusů');
    await page.keyboard.type('25'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => /25 ks/.test(document.querySelector('#scanResult').innerText));
    check(true, 'export z fotoaparátu zapsal 25 ks');

    // přehled: vyhledání podle QR
    await page.click('[data-tab=prehled]');
    await page.waitForSelector('#searchForm [data-cam]');
    await page.click('#searchForm [data-cam]');
    await page.waitForSelector('.last-card', { timeout: 15000 });
    check(CODES.includes((await page.inputValue('#searchInput')).trim()), 'přehled: QR kód vyhledal průvodku');
    await shot(page, 'cam-05-prehled');

    /* --- tablet: BarcodeDetector (Android) --- */
    const nativeInit = () => {
      window.BarcodeDetector = class {
        static async getSupportedFormats() { return ['qr_code', 'code_128']; }
        constructor(opts) { window.__bdFormats = opts.formats; }
        async detect(source) { return source && source.videoWidth ? [{ rawValue: 'PR-NATIVE-1', format: 'qr_code' }] : []; }
      };
    };
    const tablet = await login({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, permissions: ['camera'] }, nativeInit);
    await shot(tablet, 'cam-06-tablet');
    await tablet.click('[data-cam]');
    await tablet.waitForFunction(() => /PR-NATIVE-1/.test(document.querySelector('#scanResult').innerText), null, { timeout: 15000 });
    check(await tablet.evaluate(() => typeof window.ZXing === 'undefined'), 'tablet s BarcodeDetectorem: ZXing se nenačítá');
    check((await tablet.evaluate(() => window.__bdFormats)).join(',') === 'qr_code,code_128', 'BarcodeDetector čte QR i čárové kódy, které zařízení umí');

    /* --- chyby fotoaparátu --- */
    const deniedInit = () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    };
    const denied = await login(phoneOpts, deniedInit);
    await denied.click('[data-cam]');
    await denied.waitForFunction(() => /povolení k fotoaparátu/.test(document.querySelector('dialog.cam-dlg .cam-state')?.textContent || ''));
    check(true, 'bez povolení: srozumitelná hláška, jak fotoaparát povolit');
    await denied.keyboard.press('Escape');
    await denied.waitForSelector('dialog.cam-dlg', { state: 'detached' });
    check(true, 'Esc fotoaparát zavře');

    /* --- počítač: čte se čtečkou, tlačítko není --- */
    const desktop = await login({ viewport: { width: 1360, height: 900 } });
    check(await desktop.locator('[data-cam]').count() === 0, 'počítač (myš): tlačítko Načíst QR není');
    await desktop.click('[data-tab=prehled]');
    check(await desktop.locator('[data-cam]').count() === 0, 'ani v přehledu');

    check(problems.length === 0, 'žádné chyby v konzoli ani HTTP chyby' + (problems.length ? ':\n  ' + problems.join('\n  ') : ''));
  } catch (error) {
    failures++;
    console.log('FAIL výjimka: ' + (error.stack || error));
  } finally {
    await browser.close();
    php.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(failures ? `e2e fotoaparát: ${failures} chyb` : 'e2e fotoaparát ok');
  process.exit(failures ? 1 : 0);
})();
