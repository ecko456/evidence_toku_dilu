/*
 * Evidence toku dílů: čisté funkce pro načítání barcodů (bez DOM, testuje tests/test_scan.js).
 *
 * Čtečka se k počítači chová jako klávesnice: napíše kód a pošle Enter (některé Tab).
 * Když je čtečka nastavená na anglickou klávesnici a Windows mají českou, napíše místo
 * číslic „+ěščřžýáíé“ a prohodí Y se Z. fixLayout() to pozná a opraví.
 */
(function (root) {
  'use strict';

  // znak na české klávesnici → co čtečka s anglickým rozložením myslela
  const CZ_TO_US = {
    '+': '1', 'ě': '2', 'š': '3', 'č': '4', 'ř': '5', 'ž': '6', 'ý': '7', 'á': '8', 'í': '9', 'é': '0',
    '=': '-', '-': '/', 'y': 'z', 'z': 'y', 'Y': 'Z', 'Z': 'Y',
  };
  const CZ_DIGIT = /[ěščřžýáíé]/;
  // povolené znaky „přehozeného“ kódu: tisknutelné ASCII a znaky číselné řady české klávesnice
  const CZ_SCAN = /^[\x21-\x7Eěščřžýáíé]+$/;

  /** Bez řídicích znaků a okrajových mezer (čtečka občas přidá CR, LF nebo Tab). */
  function clean(raw) {
    return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]+/g, '').trim();
  }

  /**
   * Opraví kód napsaný čtečkou s anglickým rozložením do české klávesnice. Opravuje jen,
   * když je to jisté: kód bez mezer, s „číslicí“ z české řady (ěšč…) a bez jiné diakritiky.
   */
  function fixLayout(code) {
    if (!CZ_DIGIT.test(code) || !CZ_SCAN.test(code)) return code;
    let out = '';
    for (const ch of code) out += Object.prototype.hasOwnProperty.call(CZ_TO_US, ch) ? CZ_TO_US[ch] : ch;
    return out;
  }

  /** Načtený kód: { code, fixed } – fixed říká, že se opravovalo rozložení klávesnice. */
  function normalize(raw, opts) {
    const fix = !opts || opts.fix !== false;
    const base = clean(raw);
    const code = fix ? fixLayout(base) : base;
    return { code, fixed: code !== base, original: base };
  }

  /** Počet kusů: celé číslo 1 až max, jinak null. Mezery (tisíce) se ignorují. */
  function qty(value, max) {
    const text = String(value == null ? '' : value).replace(/[\s ]/g, '');
    if (!/^\d{1,7}$/.test(text)) return null;
    const n = parseInt(text, 10);
    return n >= 1 && n <= (max || 1000000) ? n : null;
  }

  /** Stejná průvodka? Velikost písmen nehraje roli (stejně jako na serveru). */
  function same(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  function plural(n, one, few, many) {
    return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
  }

  /** „právě teď“, „před 5 min“, „před 2 h“, „před 3 dny“ (sekundy od teď). */
  function ago(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 45) return 'právě teď';
    const m = Math.round(s / 60);
    if (m < 60) return `před ${m} min`;
    const h = Math.round(s / 3600);
    if (h < 24) return `před ${h} h`;
    const d = Math.round(s / 86400);
    return `před ${d} ${d === 1 ? 'dnem' : 'dny'}`;
  }

  const api = { clean, fixLayout, normalize, qty, same, plural, ago };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ETDScan = api;
})(typeof window !== 'undefined' ? window : globalThis);
