'use strict';
/*
 * Náhradní „Google“ pro testy živého propojení: webová aplikace Apps Script na tomhle stroji.
 *   node tests/fake_google.js PORT STAV.json SKRIPT.js
 * Jako skutečný Google: POST …/exec spustí doPost a odpoví přesměrováním 302 na výsledek,
 * který se přečte GETem. Režim ze souboru stavu (googleMode): 'ok', 'login' (přihlašovací stránka
 * Googlu, když webová aplikace nemá přístup „Kdokoli“), 'error' (chyba ve skriptu, HTML).
 */
const http = require('http');
const fs = require('fs');
const { makeEnv, load } = require('./gas_mock');

const [port, stateFile, scriptFile] = process.argv.slice(2);
const code = fs.readFileSync(scriptFile, 'utf8');
const results = new Map();
let n = 0;

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const mode = load(stateFile).googleMode || 'ok';
    if (req.method === 'POST' && /\/exec$/.test(req.url)) {
      if (mode === 'login') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><head><title>Přihlášení – Účty Google</title></head><body><a href="https://accounts.google.com/ServiceLogin">Přihlásit</a></body></html>');
        return;
      }
      if (mode === 'error') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><head><title>Chyba</title></head><body><div style="x">TypeError: Cannot read properties of null (reading \'getRange\')</div></body></html>');
        return;
      }
      let out;
      try {
        out = makeEnv(stateFile, code).doPost({ postData: { contents: body } }).text;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body><div>${String(err.message)}</div></body></html>`);
        return;
      }
      const id = ++n;
      results.set(String(id), out);
      res.writeHead(302, { Location: `/macros/echo?user_content_key=${id}` });
      res.end();
      return;
    }
    const m = /user_content_key=(\d+)/.exec(req.url);
    if (req.method === 'GET' && m && results.has(m[1])) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(results.get(m[1]));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html><title>Nenalezeno</title></html>');
  });
}).listen(+port, '127.0.0.1', () => process.stdout.write('ready\n'));
