/* Čisté funkce pro čtečku (static/scan.js): node tests/test_scan.js */
'use strict';
const assert = require('assert');
const SC = require('../static/scan.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok   ' + name); }

t('clean: řídicí znaky a okrajové mezery ze čtečky pryč', () => {
  assert.strictEqual(SC.clean('  PR-1\r\n'), 'PR-1');
  assert.strictEqual(SC.clean('PR\t-1'), 'PR-1');
  assert.strictEqual(SC.clean(null), '');
});

t('fixLayout: čtečka s anglickou klávesnicí ve Windows s českou', () => {
  assert.strictEqual(SC.fixLayout('+ěščřžýáíé'), '1234567890');
  assert.strictEqual(SC.fixLayout('PR=ěééí'), 'PR-2009');
  assert.strictEqual(SC.fixLayout('PR-ěéěž-éé+'), 'PR/2026/001');
  assert.strictEqual(SC.fixLayout('yZ+'.replace('+', 'ě')), 'zY2', 'Y a Z jsou na české klávesnici prohozené');
});

t('fixLayout: bez jistoty se nic neopravuje', () => {
  assert.strictEqual(SC.fixLayout('PR-2009'), 'PR-2009', 'správný kód zůstane');
  assert.strictEqual(SC.fixLayout('AB=CD'), 'AB=CD', 'bez české číslice to nejde poznat');
  assert.strictEqual(SC.fixLayout('Šroub č. 5'), 'Šroub č. 5', 'text s mezerou a diakritikou (QR s popisem) zůstane');
  assert.strictEqual(SC.fixLayout('čů1'), 'čů1', 'jiná diakritika než číselná řada');
});

t('normalize: vrátí kód a jestli se opravovalo', () => {
  assert.deepStrictEqual(SC.normalize(' PR=ěééí\n'), { code: 'PR-2009', fixed: true, original: 'PR=ěééí' });
  assert.deepStrictEqual(SC.normalize('PR=ěééí', { fix: false }), { code: 'PR=ěééí', fixed: false, original: 'PR=ěééí' });
  assert.deepStrictEqual(SC.normalize('PR-1'), { code: 'PR-1', fixed: false, original: 'PR-1' });
});

t('qty: celé kladné číslo, mezery v tisících', () => {
  assert.strictEqual(SC.qty('48'), 48);
  assert.strictEqual(SC.qty(' 1 200 '), 1200);
  assert.strictEqual(SC.qty('1 000'), 1000);
  for (const bad of ['', '0', '-1', '1,5', '1.5', 'PR-1', '12345678', null]) assert.strictEqual(SC.qty(bad), null, String(bad));
  assert.strictEqual(SC.qty('1000001'), null, 'nad maximum');
  assert.strictEqual(SC.qty('50', 40), null, 'vlastní maximum');
});

t('same: velikost písmen nehraje roli', () => {
  assert.ok(SC.same('pr-1', 'PR-1'));
  assert.ok(!SC.same('PR-1', 'PR-10'));
});

t('ago a plural', () => {
  assert.strictEqual(SC.ago(10), 'právě teď');
  assert.strictEqual(SC.ago(5 * 60), 'před 5 min');
  assert.strictEqual(SC.ago(2 * 3600), 'před 2 h');
  assert.strictEqual(SC.ago(86400), 'před 1 dnem');
  assert.strictEqual(SC.ago(3 * 86400), 'před 3 dny');
  assert.strictEqual([1, 3, 5].map(k => SC.plural(k, 'průvodka', 'průvodky', 'průvodek')).join(' '), 'průvodka průvodky průvodek');
});

console.log(`scan ok (${n} testů)`);
