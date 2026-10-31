# API pro IT (v1)

Záznamy API jen čte. Vrací poslední platný záznam průvodky (příjem nebo export, pracoviště, pozice,
počet kusů, kdo a kdy), případně celou historii. Od verze 1.3 umí i **živé propojení**: systém pošle
seznam sledovaných průvodek a Evidence mu každou jejich změnu sama pošle (endpoint `watch`). Stejný návod je v aplikaci v záložce
**API pro IT** (vidí ji správce) i s adresou serveru.

## Přístup

- Adresa: `https://<server>/evidence_toku_dilu/api/v1/`
- Klíč vytvoří správce v aplikaci: **Správa → API klíče → Nový klíč**. Ukáže se jen jednou;
  v databázi je uložený jen jeho otisk (SHA-256). Zrušený klíč přestane fungovat hned.
- Klíč se posílá v hlavičce (v adrese se nebere, zůstal by v logách):

```
Authorization: Bearer etd_0123…
```

nebo `X-Api-Key: etd_0123…`. API běží jen přes HTTPS.

## Endpointy

| metoda | cesta | co vrací |
|---|---|---|
| GET | `last?barcode=…` | poslední platný záznam průvodky; `404`, když v evidenci není |
| POST | `last` s tělem `{"barcodes": ["…", …]}` | poslední záznamy až 500 průvodek najednou (`results` ve stejném pořadí) |
| GET | `history?barcode=…&limit=100` | platné záznamy průvodky od nejnovějšího (nejvýš 1000) |
| GET | `ping` | ověření klíče |
| POST | `watch` | živé propojení: seznam sledovaných průvodek (viz níže) |
| GET | `watch` | stav živého propojení |
| DELETE | `watch` | vypnutí živého propojení |

Bez přepisu cest na serveru jde i `api/v1/index.php?endpoint=last&barcode=…`.

## Odpověď

```json
{
  "barcode": "PR-2026-004512",
  "found": true,
  "record": {
    "id": 1842,
    "barcode": "PR-2026-004512",
    "action": "export",
    "action_label": "Export z pracoviště",
    "department": "brush_wpa",
    "department_label": "Brush WPA",
    "position": null,
    "quantity": 48,
    "user": "Jan Novák",
    "user_login": "novak",
    "recorded_at": "2026-10-21T14:05:09+02:00",
    "recorded_at_utc": "2026-10-21T12:05:09Z",
    "recorded_at_unix": 1792591509
  }
}
```

- `action`: `prijem` (Příjem na pracoviště) nebo `export` (Export z pracoviště).
- `department`: `brouseni_wpa` (Broušení WPA), `brush_wpa` (Brush WPA), `hala` (Hala 2; do verze 1.2 se jmenovala Hala, kód zůstal),
  `montaz` (Montáž), `elox` (Elox), `studio` (Studio), `cnc_hala2` (CNC Hala2).
- `position`: pozice, kam se díly umístily (jen u příjmu, jinak `null`).
- `quantity`: počet kusů (jen u exportu, jinak `null`).
- `recorded_at` je v pražském čase s posunem (ISO 8601), `recorded_at_utc` v UTC,
  `recorded_at_unix` v sekundách.
- Velikost písmen v barcodu nehraje roli. Stornované záznamy se do posledního stavu ani do
  historie nepočítají.

## Živé propojení (`watch`, od verze 1.3)

Je určené pro Google tabulku; hotový skript vygeneruje aplikace (API pro IT → Google tabulka).
Od verze 1.4 jde na jeden klíč připojit víc tabulek (nejvýš 20), rozlišených polem `ref`, a tabulka
může být typu `urgent`.
Příjemce musí být webová aplikace Google Apps Script (`https://script.google.com/macros/s/…/exec`,
u Google Workspace i `…/a/macros/<doména>/s/…/exec`). Jiné adresy server odmítne, aby neposílal
data jinam. Jeden API klíč = jedno propojení.

```
POST api/v1/watch
{"url": "https://script.google.com/macros/s/…/exec", "secret": "<32 až 128 znaků A-Z a-z 0-9 - _>",
 "barcodes": ["12345.678901.23456", …], "ping": true}
```

- `barcodes` (nejvýš 10 000) nahradí předchozí seznam. Prázdné a příliš dlouhé se přeskočí (`skipped`).
- `ref` (od 1.4): stálé označení tabulky (skript posílá ID tabulky a listu). Bez `ref` = jedna tabulka
  na klíč jako ve verzi 1.3. `name`: název pro Správu.
- `kind` (od 1.4): `status` (výchozí, stav průvodek) nebo `urgent` (průvodky jsou urgentní: na pracovišti,
  kde leží, svítí pracovníkům upozornění, dokud odtamtud neodejdou exportem). `notes`: objekt
  `{"barcode": "poznámka"}` k urgentům. `family: true`: urgentní jsou i poddíly sestavy (liší se jen
  posledním dvojčíslím ve 2. a 3. části: `12345.678901.23456` → `12345.6789xx.234xx`).
- `GET watch?ref=…` a `DELETE watch?ref=…` platí pro jednu tabulku; bez `ref` pro všechny tabulky klíče
  (`sheets` v odpovědi GET).
- Odpověď: `watching`, `found` a `results` = poslední záznamy nalezených průvodek
  (`barcode`, `found`, `text` = jeden řádek pro buňku, `record` jako u `last`).
- `ping: true`: server hned pošle zkušební zprávu a vrátí `ping: {"ok": …, "error": …}`.
- `worker.running`: běží na serveru úloha odesílání (cron)?

Při každém příjmu, exportu nebo stornu sledované průvodky pošle server do pár sekund na `url`:

```
POST <url>
{"etd": 1, "data": "<JSON jako text>", "sig": "<HMAC-SHA256(data, secret) hex>"}
data = {"type": "update" | "ping", "hook": 1, "sent_at": 1792591509, "app": "Evidence toku dílů 1.3",
        "items": [{"barcode": "…", "found": true, "text": "Export z pracoviště · Elox · 48 ks · 21. 10. 2026 14:05 · Jan Novák", "record": {…}}]}
```

- Příjemce ověří podpis nad textem `data` (jen ASCII) a stáří `sent_at` (Apps Script: do hodiny)
  a odpoví JSON `{"ok": true}`. Jinak server zprávu nepovažuje za doručenou.
- `found: false` = průvodka nemá žádný platný záznam (např. po stornu jediného záznamu).
- Ve zprávě je vždy aktuální stav. Více změn téže průvodky se může slít do jedné zprávy,
  v jedné zprávě je nejvýš 200 průvodek.
- Když příjemce neodpoví, server zkouší znovu po 10 s, 20 s, 40 s … nejdéle po 15 minutách. Stav
  a poslední chyba jsou v `GET watch` a ve Správě.

## Chyby

Odpověď je vždy JSON v UTF-8. Chyba má `error` (kód) a `message` (česky).

| stav | `error` | kdy |
|---|---|---|
| 400 | `bad_request` | chybí nebo je špatně parametr |
| 401 | `unauthorized` | chybí klíč, je neplatný nebo zrušený |
| 403 | `https_required` | požadavek přišel bez HTTPS |
| 404 | `not_found` | průvodka v evidenci není (u `last` i `"found": false`), nebo neznámý endpoint |
| 409 | `too_many_sheets` | na klíč je připojeno už 20 tabulek |
| 405 | `method_not_allowed` | metoda, kterou endpoint nepodporuje (`watch` bere i DELETE) |
| 429 | `too_many_attempts` | víc než 60 požadavků s neplatným klíčem za čtvrt hodiny z jedné adresy |

## Příklady

```bash
curl -H "Authorization: Bearer etd_…" "https://<server>/evidence_toku_dilu/api/v1/last?barcode=PR-2026-004512"

curl -H "Authorization: Bearer etd_…" -H "Content-Type: application/json" \
  -d '{"barcodes":["PR-2026-004512","PR-2026-004513"]}' "https://<server>/evidence_toku_dilu/api/v1/last"
```

```powershell
Invoke-RestMethod -Uri "https://<server>/evidence_toku_dilu/api/v1/last?barcode=PR-2026-004512" -Headers @{ Authorization = "Bearer etd_…" }
```
