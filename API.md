# API pro IT (v1)

API jen čte. Vrací poslední platný záznam průvodky (příjem nebo export, pracoviště, pozice,
počet kusů, kdo a kdy), případně celou historii. Stejný návod je v aplikaci v záložce
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
- `department`: `brouseni_wpa` (Broušení WPA), `brush_wpa` (Brush WPA), `hala` (Hala),
  `montaz` (Montáž), `elox` (Elox), `studio` (Studio), `cnc_hala2` (CNC Hala2).
- `position`: pozice, kam se díly umístily (jen u příjmu, jinak `null`).
- `quantity`: počet kusů (jen u exportu, jinak `null`).
- `recorded_at` je v pražském čase s posunem (ISO 8601), `recorded_at_utc` v UTC,
  `recorded_at_unix` v sekundách.
- Velikost písmen v barcodu nehraje roli. Stornované záznamy se do posledního stavu ani do
  historie nepočítají.

## Chyby

Odpověď je vždy JSON v UTF-8. Chyba má `error` (kód) a `message` (česky).

| stav | `error` | kdy |
|---|---|---|
| 400 | `bad_request` | chybí nebo je špatně parametr |
| 401 | `unauthorized` | chybí klíč, je neplatný nebo zrušený |
| 403 | `https_required` | požadavek přišel bez HTTPS |
| 404 | `not_found` | průvodka v evidenci není (u `last` i `"found": false`), nebo neznámý endpoint |
| 405 | `method_not_allowed` | jiná metoda než GET/POST |
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
