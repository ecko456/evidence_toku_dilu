# Evidence toku dílů: poznámky pro Clauda

Claude Code si tenhle soubor načte sám na začátku každé session. Je v něm, kde jsme skončili,
jak je projekt poskládaný a jak s ním pracovat. Dokumentace pro uživatele je v `README.md`,
pro IT v `API.md`.

Samostatný projekt (repozitář `ecko456/evidence_toku_dilu`, adresa `/evidence_toku_dilu/`, klon na
serveru `/root/evidence_toku_dilu`). Ostatní projekty na stejném serveru mají vlastní repozitáře:
Trading Desk (`ecko456/trading_desk`, `/trading/`), Odměny (`ecko456/odmeny`, `/odmeny/`) a
Odměny verze 2 (`ecko456/odmeny_v2`, `/odmeny_v2/`). Instalace se navzájem nedotýkají.

Po každé větší práci **aktualizuj sekci „Kde jsme skončili“**.

## Kde jsme skončili

Stav k 21. 10. 2026, verze **1.2** (schéma databáze 2):

- 1.2: „v mobilní verzi a tabletu přidej k barcode tlačítko pro čtečku QR kódů“. Tlačítko
  **Načíst QR** (`[data-cam]`) vedle pole v Příjmu, Exportu a Přehledu, jen když
  `(any-pointer: coarse)` a `getUserMedia` v zabezpečeném kontextu (`camAvailable`). Dialog
  `openCamera` přes celou obrazovku: zadní fotoaparát, každých 150 ms `codeDecoder` =
  BarcodeDetector (všechny podporované formáty z `CAM_FORMATS`), jinak ZXing
  (`static/vendor/zxing.min.js` = `@zxing/library` 0.23.0 z Odměn, Apache-2.0, bez eval, načte se
  až při prvním otevření). Jednotlivě se po kódu zavře a kód jde do `handleCode` (stejná cesta
  jako čtečka, bez opravy klávesnice); vícenásobně čte dál a stejný kód za otevření bere jednou.
  Po kódu z fotoaparátu se pole nefokusuje (`viaCamera`), na telefonu by vyjela klávesnice.
  Permissions-Policy `camera=(self)`. Se skutečným telefonem nikdo nezkoušel; ověřeno falešnou
  kamerou v Chromiu (`tests/e2e_camera.js`, video s QR vyrobí ZXing), BarcodeDetector náhradní třídou.

- 1.1: uživatel na přání „Admin bude moct vygenerovat uživatele bez hesla a heslo si nastaví
  uživatel po prvním přihlášení“. V dialogu uživatele je volba hesla `passwordMode`: `self`
  (výchozí u nového: `pass_hash = ''`, `pending_until` = teď + `ETD_INVITE_DAYS` = 7 dní),
  `set` (heslo zadá správce, volitelně `must_change`) a `keep` (úprava beze změny). `self`
  u existujícího účtu = zapomenuté heslo (staré přestane platit, relace skončí); sám sobě ho
  správce nastavit nemůže. Přihlášení účtu bez hesla vrátí `needPassword` (bez relace), stránka
  ukáže „Nastav si heslo“ a `first_password` heslo uloží (jen když je pořád prázdné) a přihlásí.
  Prázdné heslo u ostatních jmen = „Vyplň heslo.“ (400, nepočítá se jako pokus). Riziko: do
  nastavení hesla si ho může nastavit kdokoli se jménem, proto 7 dní a stav v seznamu
  uživatelů. Aktualizace 1.0 → 1.1 ověřena na lokálním Apachi (schéma 1 → 2, data zůstala).

- Zadání uživatele: přihlášení na uvítací stránce, pak výběr oddělení (Broušení WPA, Brush WPA,
  Hala, Visitor; hned potom doplnil Montáž, Elox, Studio, CNC Hala2). Visitor jen nahlíží.
  Tlačítka **Příjem na pracoviště** a **Export z pracoviště**, skenuje se čtečkou hlavní barcode
  průvodky. Vždy jde zapnout **vícenásobný příjem** (jen se načítá) a u příjmu zaškrtnout
  **Definovat pozici kam se umístí** (platí pro všechny načtené). U exportu **počet ks**.
  V přehledu vyhledávač podle barcodu, od nejnovějšího, „vždy mě zajímá poslední záznam“.
  Pro IT API s posledním záznamem barcodu.
- Navíc (rozhodnuto bez dotazu, uživatel to může změnit): role Pracovník / Správce / Jen
  nahlížení s povolenými odděleními u pracovníka; storno místo mazání (autor 30 min na stejném
  pracovišti, správce vždy); dvojí načtení stejného záznamu do 10 min se nezapíše bez potvrzení;
  pohled **Na pracovištích** (poslední záznam = příjem); vícenásobný režim i u exportu (ks u každé
  průvodky); oprava české klávesnice u čtečky s anglickým rozložením; historie správy.
- **Se skutečnou čtečkou ani na serveru uživatele to nikdo nezkoušel.** Ověřeno HTTP testy,
  Node testem, průchodem v Chromiu (čtečka simulovaná psaním + Enter) a instalací/aktualizací na
  lokálním Apachi v kontejneru (FallbackResource pro api/v1 i hlavička Authorization přes mod_php).
- Od uživatele se čeká: založit repozitář na GitHubu (aplikace Claude ho založit nesmí), první
  instalace, zkouška se čtečkou (Enter/Tab na konci, rozložení klávesnice) a zpětná vazba
  k rolím, stornu a pohledu Na pracovištích.

## Uživatel a pravidla spolupráce

- Komunikace **česky**, věcně. UI texty a komentáře v kódu jsou česky.
- Uživatel nasazuje sám podle přesných příkazů. Na konci práce vždy napiš: co se změnilo
  a výsledek testů, přesný příkaz pro server (viz Nasazení) a že je potřeba Ctrl+Shift+R.
- **Nikdy se nepřipojuj na server uživatele.** Do repa nedávej IP ani adresu serveru, ani žádná
  data (ani vzorky průvodek z provozu). **Repozitář je veřejný.**
- Opatrně, ať nic nerozbiješ. **Nepushuj neotestovaný kód** a v prohlížeči ověř i vzhled
  (screenshot). **Při aktualizaci se nesmí ztratit data.**
- Do commitů, PR, kódu ani dokumentace nepiš identifikátor modelu. Patičku commitu
  (Co-Authored-By, Claude-Session) ber z pokynů aktuální session.
- Commit message česky: `Evidence: co se změnilo (verze X)`, v těle proč a odrážky.
- PR otevírej jen na výslovné přání uživatele.

## Nasazení (dělá uživatel)

```bash
cd /root/evidence_toku_dilu && git pull origin claude/elegant-clarke-vl5n7d && sudo bash deploy/install.sh
```

- Kód `/var/www/evidence_toku_dilu`, data `/var/lib/evidence_toku_dilu` (`evidence.sqlite3`,
  zálohy v `backups/`), Apache `deploy/apache-evidence_toku_dilu.conf` →
  `/etc/apache2/conf-available/evidence_toku_dilu.conf`.
- Instalace před aktualizací zazálohuje databázi (`bin/backup-db.php`, VACUUM INTO) a přeruší se,
  když záloha selže. Kopíruje rsyncem bez `tests/`, `deploy/`, `router.php`, `*.md` a skrytých
  souborů. Apache navíc odmítá `lib/`, `bin/`, `.md`, `.sqlite3` a podobné.
- Server je Ubuntu 22.04 (PHP 8.1, SQLite 3.37): nepoužívej nic z PHP 8.2+.

## Mapa repozitáře

- `index.php`: stránka (jen kostra, vše kreslí `static/app.js`).
- `api.php`: JSON API pro stránku (`?action=…`). Hlavička `X-Etd: 1`, u zápisů kontrola původu
  a verze stránky (`X-Etd-Client` ≥ `ETD_MIN_CLIENT`, jinak 426 a výzva k obnovení).
- `api/v1/index.php`: API pro IT s klíčem (viz `API.md`). Na Apachi cesty `api/v1/<endpoint>`
  obsluhuje `FallbackResource`, ve vývoji `router.php`.
- `lib/etd.php`: jádro. Konstanty (`ETD_DEPTS` = pracoviště v pořadí na úvodní obrazovce,
  `ETD_ACTIONS`, `ETD_ROLES`, limity), databáze a migrace (`etd_migrate`, `PRAGMA user_version`),
  relace, uživatelé, záznamy (`etd_scan`, `etd_last`, `etd_refresh_part`), API klíče.
- `static/app.js`: celé rozhraní (obrazovky, záložky, dialogy). `static/scan.js`: čisté funkce
  pro čtečku (`ETDScan`: čištění, oprava české klávesnice, počet kusů). `static/app.css`: vzhled,
  barvy jako tokeny na `:root` (tmavý režim přes `prefers-color-scheme`).
- `bin/`: `setup-token.php` (kód prvního spuštění), `backup-db.php`, `reset-password.php`,
  `rebuild-parts.php`. Jen z příkazové řádky.
- `deploy/`: `install.sh` a konfigurace Apache. `router.php`: router pro `php -S`.
- `tests/`: `test_http.py` (server, API, nástroje, aktualizace databáze verze 1.0), `test_scan.js`,
  `e2e.js` (Playwright), `e2e_camera.js` (QR fotoaparátem s falešnou kamerou).
- `static/vendor/`: `zxing.min.js` a `LICENSE-zxing.txt` (licence se z webu nevydává, `.txt`).

## Datový model (SQLite, `lib/etd.php`)

- `users`: login (bez diakritiky, NOCASE), jméno, `pass_hash` (password_hash; prázdný = účet
  bez hesla), `role` (`operator`/`admin`/`visitor`), `depts` (čárkami; prázdné = všechna),
  `active`, `must_change`, `pending_until` (schéma 2: do kdy si uživatel bez hesla heslo nastaví).
- `sessions`: id = SHA-256 tokenu z cookie `etd_session` (HttpOnly, SameSite=Strict, cesta
  aplikace), vybrané oddělení `dept` (kód nebo `visitor`). Nečinnost 12 h, nejdéle 24 h.
  Změna hesla, role, oddělení nebo vypnutí účtu přihlášení uživatele ukončí.
- `records`: záznamy příjmu a exportu, **nemažou se**. `barcode` jak ho poslala čtečka, `action`
  `prijem`/`export`, `dept`, `position` (jen příjem), `qty` (jen export), jméno a login uživatele
  v době zápisu, `batch` (dávka z vícenásobného režimu), `created_at` (unix, UTC), storno
  (`cancelled_at`, `cancelled_by`, `cancel_reason`).
- `parts`: poslední platný záznam každé průvodky (odvozené; barcode NOCASE). Udržuje ho
  `etd_scan` a po stornu `etd_refresh_part`. Kdykoli jde přepočítat (`bin/rebuild-parts.php`).
  Na něm stojí poslední záznam, částečné hledání i Na pracovištích.
- `api_keys` (jen otisk klíče, prefix pro zobrazení), `attempts` (neúspěšná přihlášení a klíče),
  `admin_log` (historie správy).
- Nová verze schématu: přidej blok `if ($version < N)` do `etd_migrate` a zvyš `ETD_SCHEMA`.
  Jen přidávat (tabulky, sloupce s výchozí hodnotou), nic nemazat. Nové oddělení = nový řádek
  v `ETD_DEPTS` (kód se ukládá do záznamů, neměň ho), barva `--d-N` a třída `.dept-<kód>`
  v `app.css`, seznam v `README.md` a `API.md`.
- Pozor: PDO posílá parametry jako text. `etd_run` proto váže celá čísla jako INTEGER.

## Vývoj a testy v cloudové session

```bash
python3 -m unittest discover -s tests     # 32 testů, asi 25 s
node tests/test_scan.js
node tests/e2e.js                         # SHOTS=/adresář uloží snímky
node tests/e2e_camera.js                  # fotoaparát (Chromium s --use-file-for-fake-video-capture)
php -l lib/etd.php                        # a další změněné PHP soubory
```

- Lokálně: `ETD_DATA_DIR=$S/etd php -S 127.0.0.1:8480 router.php`, kód prvního spuštění
  vypíše `ETD_DATA_DIR=$S/etd php bin/setup-token.php`.
- Playwright: `require('/opt/node22/lib/node_modules/playwright')`, Chromium
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `playwright install` nespouštěj.
- Apache v kontejneru (jen tady, nikdy na ostrém serveru): `sudo bash deploy/install.sh`, pak
  `http://127.0.0.1/evidence_toku_dilu/` (z localhostu aplikace pustí i bez HTTPS).
- Pozor na `pkill -f "php -S …"`: vzor najde i vlastní shell a zabije ho.
- CSP nepovoluje `style="…"` v HTML: pro rozestupy jsou pomocné třídy na konci `app.css`.
- Barvy oddělení jsou kategorická paleta v pevném pořadí, ověřená validátorem dataviz (světlý
  i tmavý režim). Barva je vždy u názvu oddělení, nikdy sama.
