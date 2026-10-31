'use strict';
/*
 * Náhrada prostředí Google Apps Script pro testy skriptu static/google-tabulka.js.
 *
 * Stav (buňky listu, vlastnosti skriptu, spouštěče, odpovědi na dotazy v okně) leží v JSON
 * souboru, aby ho sdílel test i náhradní „Google“ (tests/fake_google.js) v jiném procesu.
 * UrlFetchApp je synchronní jako v Googlu: volá curl.
 */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, st) { fs.writeFileSync(file, JSON.stringify(st, null, 1)); }

const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function makeEnv(stateFile, scriptCode) {
  const st = () => load(stateFile);
  const upd = fn => { const s = load(stateFile); fn(s); save(stateFile, s); };

  function cell(sheetName, row, col) {
    return (st().sheets[sheetName] || {})[colName(col) + row] || {};
  }

  function range(sheetName, row, col, rows) {
    const cells = () => Array.from({ length: rows }, (_, i) => cell(sheetName, row + i, col));
    return {
      getSheet: () => sheet(sheetName),
      getColumn: () => col,
      getLastColumn: () => col,
      getRow: () => row,
      getValues: () => cells().map(c => [c.f ? (c.computed ?? '') : (c.v ?? '')]),
      getDisplayValues: () => cells().map(c => [String(c.f ? (c.computed ?? '') : (c.v ?? ''))]),
      getFormulas: () => cells().map(c => [c.f || '']),
      getRichTextValues: () => cells().map(c => [{
        getLinkUrl: () => c.link || null,
        getRuns: () => (c.runs || []).map(u => ({ getLinkUrl: () => u })),
      }]),
      setValues: values => upd(s => {
        s.writes = (s.writes || 0) + 1;
        values.forEach((v, i) => {
          const key = colName(col) + (row + i);
          const val = v[0];
          s.sheets[sheetName][key] = typeof val === 'string' && val.startsWith('=') ? { f: val, computed: (s.sheets[sheetName][key] || {}).computed } : { v: val };
        });
      }),
    };
  }

  function sheet(name) {
    return {
      getName: () => name,
      getParent: () => spreadsheet(),
      getLastRow: () => Math.max(0, ...Object.keys(st().sheets[name] || {}).map(k => +k.replace(/^[A-Z]+/, ''))),
      getRange: (row, col, rows) => range(name, row, col, rows || 1),
    };
  }

  function spreadsheet() {
    return {
      getId: () => 'tabulka-1',
      getName: () => 'Kooperace',
      getSheetByName: n => (st().sheets[n] ? sheet(n) : null),
      toast: (text) => upd(s => { (s.toasts = s.toasts || []).push(text); }),
    };
  }

  const ui = {
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
    Button: { OK: 'OK', CANCEL: 'CANCEL' },
    createMenu: () => { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => upd(s => { s.menu = true; }) }; return m; },
    prompt: () => {
      let answer = null;
      upd(s => { answer = (s.answers || []).shift(); });
      if (answer === undefined || answer === null) throw new Error('test: chybí odpověď na prompt');
      return { getSelectedButton: () => (answer === false ? 'CANCEL' : 'OK'), getResponseText: () => String(answer) };
    },
    alert: (title, text) => upd(s => { (s.alerts = s.alerts || []).push(text === undefined ? String(title) : title + '\n' + text); }),
  };

  const globals = {
    console,
    SpreadsheetApp: {
      getActive: () => (st().noActive ? null : spreadsheet()),
      getActiveSpreadsheet: () => spreadsheet(),
      openById: () => spreadsheet(),
      getUi: () => ui,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (st().props[k] ?? null),
        setProperty: (k, v) => upd(s => { s.props[k] = String(v); }),
        deleteProperty: k => upd(s => { delete s.props[k]; }),
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts = {}) => {
        const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', String(opts.method || 'get').toUpperCase(), '--max-time', '60'];
        Object.entries(opts.headers || {}).forEach(([k, v]) => args.push('-H', `${k}: ${v}`));
        if (opts.contentType) args.push('-H', `Content-Type: ${opts.contentType}`);
        if (opts.payload !== undefined) args.push('--data-binary', '@-');
        args.push(url);
        const out = execFileSync('curl', args, { input: opts.payload || '', env: { ...process.env, NO_PROXY: '*', no_proxy: '*' }, maxBuffer: 64 << 20 }).toString();
        const i = out.lastIndexOf('\n');
        const code = +out.slice(i + 1);
        const body = out.slice(0, i);
        upd(s => { (s.fetches = s.fetches || []).push(`${String(opts.method || 'get').toUpperCase()} ${url.replace(/^.*\/api\/v1\//, '')} ${code}`); });
        return { getResponseCode: () => code, getContentText: () => body };
      },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', key).update(data).digest()].map(b => (b > 127 ? b - 256 : b)),
      formatDate: (d) => d.toISOString(),
    },
    Session: { getScriptTimeZone: () => 'Europe/Prague' },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => st().serviceUrl || null }),
      getProjectTriggers: () => (st().triggers || []).map(t => ({ getHandlerFunction: () => t.fn, id: t.id })),
      deleteTrigger: t => upd(s => { s.triggers = (s.triggers || []).filter(x => x.id !== t.id); }),
      newTrigger: fn => {
        const t = { fn, id: crypto.randomUUID() };
        const b = {
          forSpreadsheet: () => b, onEdit: () => { t.kind = 'edit'; return b; }, onChange: () => { t.kind = 'change'; return b; },
          timeBased: () => b, everyHours: h => { t.kind = 'hours:' + h; return b; }, everyMinutes: m => { t.kind = 'minutes:' + m; return b; },
          create: () => upd(s => { (s.triggers = s.triggers || []).push(t); }),
        };
        return b;
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
    },
  };
  const ctx = vm.createContext(globals);
  vm.runInContext(scriptCode, ctx, { filename: 'google-tabulka.js' });
  ctx.__range = range;
  return ctx;
}

module.exports = { makeEnv, load, save };
