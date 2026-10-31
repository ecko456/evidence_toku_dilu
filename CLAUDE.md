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

Stav k 31. 10. 2026, verze **1.6** (schéma databáze 5):

- 1.6: „pokud systém dokáže přiřadit číslo objednávky, EAN, index, ať ve vizualizaci upřednostní tyto
  data a barcode minimalizuje; v přehledu ať jsou vidět a jde podle nich vyhledávat“.
  - `partTitle(barcode, info)` (seznamy: objednávka · EAN · idx nahoře, klik = Přehled, barcode
    `.pt-code` malý), `partBig` (výsledek skenu, okno počtu kusů, Přehled), `partExtra` (zbytek:
    EAN sestavy a odkaz). Bez údajů z tabulky se ukazuje barcode jako dřív. Sloupce „Průvodka“.
  - Server: `etd_records_for` přidává `info` (recent, records, historie); `etd_family_parts` taky.
    Hledání (`search`): `etd_info_search` (objednávka/EAN dílu/EAN sestavy obsahuje, od 3 znaků;
    index přesně); přesná shoda údaje na jednu průvodku = `exact` s `via`, ostatní v `matches`
    s `matchedBy`.

- 1.5.1: „Sloupec s barcodem je EAN (dílu) s odkazem; u tabulky Urgenty to je EAN, nebo EAN
  vrcholné sestavy, nejde poznat; údaje k průvodce ber z tabulek Stav průvodek“. Text buňky
  s barcodem se posílá vždy jako `ean` (volba `textJeEan` zrušena), údaje se ukládají a čtou jen
  z tabulek `kind = 'status'` (skript u urgentů `info` neposílá, server ho i tak zahodí), štítek
  „EAN dílu“, generátor: „Sloupec s EAN dílu“, část Údaje k průvodce u urgentů skrytá.

- 1.5: „pokud bude shoda v tabulce Stav průvodek, doplní k položce číslo objednávky, EAN, EAN
  sestavy a index; EAN je hypertextový odkaz, ať se jde v aplikaci prokliknout“ a „u urgentní
  sestavy s více poddíly rozevírací menu, kde budou vidět i ostatní poddíly“.
  - Schéma 5: `hook_watch.info` (JSON). Skript posílá `info` {barcode: {order, ean, eanAssembly,
    index, link}} (sloupce `sloupecObjednavka`, `sloupecEanSestavy`, `sloupecIndex`, `textJeEan`;
    odkaz a text z buňky s barcodem, `etdNactiRadky`). Server čistí `etd_info_clean` (jen známá
    pole, odkaz jen http/https), čte `etd_part_info` (cache na požadavek). Tělo `watch` až 12 MB
    (`etd_input($max)`, Apache `post_max_size 16M` pro api/v1); ověřeno 10 000 řádků (2,7 MB) na Apachi.
  - Stránka: `partInfo()` ve výsledku skenu, v okně počtu kusů, Přehledu, hledání, Na pracovištích,
    pásu urgentů; odkaz `target=_blank rel=noopener noreferrer`.
  - Díly sestavy: `etd_family_parts` (LIKE `a.bbbb__.ccc__` + kontrola `etd_family`),
    `etd_urgent_list` vrací `parts`, nový `etd_urgent_overview` (řádek na urgent z tabulky, poddíly
    v `parts`, `onsite`). Stránka: `assemblyParts()` = `<details>` „Díly sestavy“, otevřené
    zůstanou i po obnovení pásu (`asmOpen`).

- 1.4: „připojit více google tabulek“ a „tabulka s urgenty: pracovníkům pro dané oddělení vyskočí
  upozornění, že mají urgent na pracovišti, a svítí, dokud neprovedou export z pracoviště“; pak
  doplnil „některé urgenty jsou sestavy a mají poddíl … hledat shody podle AAAAA.BBBBXX.CCCXX,
  systém mění poslední dvojčíslí“ (jeho skutečná čísla do repa nedávej).
  - Schéma 4: `hooks` přestavěná (SQLite neumí odebrat UNIQUE(api_key_id)): nově `kind`
    (`status`/`urgent`), `name`, `ref` (ID tabulky#ID listu; UNIQUE(api_key_id, ref), '' = skript 1.3),
    `match_family`; `hook_watch.note`. Migrace s `PRAGMA foreign_keys = OFF` mimo transakci,
    kopie řádků se stejnými id, pak `foreign_key_check`. Ověřeno testem (schéma 3 → 4) i na Apachi.
  - Urgenty (`lib/hooks.php`): `etd_urgent_index` (všechny urgenty z aktivních tabulek, cache na
    požadavek), `etd_urgent_match` (přesně, nebo poddíl přes `etd_family`: 2. a 3. část bez
    posledního dvojčíslí), `etd_urgent_list($dept)` = průvodky s příjmem na pracovišti, které
    sedí; bez dept i urgenty, které nikde neleží. Párování v PHP (bez SQL funkcí).
  - Stránka: `api.php?action=urgent` (here/all/counts), `scan` vrací `urgent` (`note`, u poddílu
    `of`, `mask`), `onsite` `urgent` + `urgentCounts`, `search` `urgent`/`urgentOf`. Pás
    `#urgentBar` pod záložkami (`loadUrgent`, každých 20 s, po skenu urgentu; nový = zvuk + toast),
    odznaky na výběru oddělení, karta Urgentní průvodky v Na pracovištích, barva `--urgent`.
  - Skript: `typ`, `sloupecPoznamka`, `podDily`, `sloupecVysledek` může být ''; posílá `ref`, `name`,
    `kind`, `notes`, `family`; GET/DELETE `watch?ref=`. Generátor: typ tabulky, poznámka, poddíly.

- 1.3.4: v pásu na úvodní stránce zůstala jen řada štítků („nechal bych tam jen tu jednu verzi
  v těch buňkách“); obrysové velké názvy pryč.

- 1.3.3: úvodní stránka („pás, kde poběží názvy oddělení do ztracena, ať to je mrda na oko“).
  Funkce `ticker` v `app.js`: řada štítků s barevnou tečkou, obsah dvakrát + posun o −50 % = smyčka bez skoku, na krajích maska do ztracena, při
  najetí myší stojí, `prefers-reduced-motion` = jen statický výčet (`.rep` skryté). Opraveno:
  v 1.3 přejmenování `.flow` → `.gflow` omylem rozbilo řadu oddělení na úvodní stránce.

- 1.3.2: server odmítl adresu webové aplikace. `etd_hook_url_normalize` (a stejně skript) odstraní
  `/u/0/` (Google ho přidá při víc účtech v prohlížeči), `?…`, `#…`, mezery; chyba 400 teď ukáže,
  co přišlo (ID zkrácené), a poradí u `/dev` a u adresy editoru (`/home/projects/…`).

- 1.3.1: uživateli skript hlásil „List „List1“ v tabulce není“: česká Google tabulka má první
  list **„List 1“** (s mezerou). Výchozí název v generátoru je teď „List 1“, `etdList` najde list
  i bez ohledu na mezery a velikost písmen a v chybě vyjmenuje listy tabulky. Pozor: po změně
  kódu v Apps Scriptu musí uživatel udělat novou verzi nasazení (doPost jede z nasazené verze).

- 1.3: **živé propojení s Google tabulkou** („ať google tabulka přes API sdílí soupis barcodů a při
  shodě se propíšou data“, „ať je to šupa“). Uživatel měl předtím ruční Apps Script (barcode
  z odkazu `…?activeBarcode=12345.678901.23456&…` ve sloupci D, poslední záznam do K).
  - Tabulka (skript `static/google-tabulka.js`) pošle `POST api/v1/watch` s API klíčem: adresu své
    webové aplikace (`…/exec`, jen script.google.com, `etd_hook_url_valid`), tajný kód a barcody.
    Odpověď vrátí poslední záznamy (`text` = řádek do buňky, `etd_record_text`), `ping` vyzkouší
    spojení zpět. Jeden klíč = jedno propojení (`hooks`), seznam `hook_watch`.
  - `etd_scan` a `etd_refresh_part` (storno) volají `etd_hook_touch` → `hook_queue` (jen barcode
    a `ver`, obsah se bere až při odeslání, takže se posílá vždy aktuální stav). Úloha
    `bin/hook-worker.php` (cron `/etc/cron.d/evidence_toku_dilu` každou minutu, uvnitř smyčka 55 s
    po 1 s, zámek `hook-worker.lock`) posílá podepsané zprávy (HMAC-SHA256 nad `data`), Apps Script
    odpoví 302 → výsledek se čte GETem (`etd_http` přes PHP streamy, bez curl). Chyba = backoff
    10 s … 15 min (`hooks.fails`, `retry_at`), české hlášky (`etd_hook_send`, `etd_net_error`).
  - Správa: karta Google tabulky (stav, Vyzkoušet spojení, Poslat znovu vše, Odpojit, „Odesílání
    běží“ podle `meta.worker_seen_at`), obnovuje se každých 5 s. API pro IT: generátor skriptu
    (formulář list/sloupce/parametr → blok `// <nastaveni>` v šabloně), ukázka a pět kroků.
  - Skript: menu Evidence (klíč, zapnout, aktualizovat, stav, vypnout), spouštěče onEdit (změna ve
    sloupci s barcody → nový seznam) a každou hodinu, `doPost` ověří podpis a zapíše jen řádky
    s barcodem (vzorce v ostatních zůstanou). Kód v Googlu nikdo neviděl běžet: ověřeno náhradou
    Apps Scriptu (`tests/gas_mock.js`) a náhradním Googlem (`tests/fake_google.js`, POST → 302 → GET)
    v `tests/e2e_sheets.js`. `ETD_HOOK_TEST=1` povolí adresu 127.0.0.1 (jen testy).
  - Aktualizace 1.2.1 → 1.3 ověřena na lokálním Apachi (schéma 2 → 3, data zůstala, cron, watch
    přes FallbackResource i s DELETE).
  - Čeká se od uživatele: nasazení, vytvoření skriptu v tabulce podle návodu v aplikaci a zpráva,
    jestli se server dostane na script.google.com (instalace upozorní).

- 1.2.1: oddělení 3 se jmenuje **Hala 2** („Akorát 3. se jmenuje Hala a má to být Hala 2“).
  Změnil se jen název v `ETD_DEPTS`, kód `hala` zůstal (je v uložených záznamech a v API),
  takže starší záznamy se ukážou jako Hala 2 a nic se nepřepisuje.

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
- `api/v1/index.php`: API pro IT s klíčem (viz `API.md`), od 1.3 i `watch` (živé propojení). Na Apachi cesty `api/v1/<endpoint>`
  obsluhuje `FallbackResource`, ve vývoji `router.php`.
- `lib/etd.php`: jádro. Konstanty (`ETD_DEPTS` = pracoviště v pořadí na úvodní obrazovce,
  `ETD_ACTIONS`, `ETD_ROLES`, limity), databáze a migrace (`etd_migrate`, `PRAGMA user_version`),
  relace, uživatelé, záznamy (`etd_scan`, `etd_last`, `etd_refresh_part`), API klíče.
- `lib/hooks.php`: živé propojení s Google tabulkou (fronta, odeslání, podpis, stav).
- `static/google-tabulka.js`: šablona Apps Scriptu pro tabulku (stránka ji načte do generátoru;
  nespouští ji). Blok `// <nastaveni>` … `// </nastaveni>` nahrazuje generátor, neměň značky.
- `static/app.js`: celé rozhraní (obrazovky, záložky, dialogy). `static/scan.js`: čisté funkce
  pro čtečku (`ETDScan`: čištění, oprava české klávesnice, počet kusů). `static/app.css`: vzhled,
  barvy jako tokeny na `:root` (tmavý režim přes `prefers-color-scheme`).
- `bin/`: `setup-token.php` (kód prvního spuštění), `backup-db.php`, `reset-password.php`,
  `rebuild-parts.php`, `hook-worker.php` (odesílání do tabulek, cron). Jen z příkazové řádky.
- `deploy/`: `install.sh`, konfigurace Apache a `cron-evidence_toku_dilu` (→ `/etc/cron.d/`). `router.php`: router pro `php -S`.
- `tests/`: `test_http.py` (server, API, nástroje, aktualizace databáze verze 1.0), `test_scan.js`,
  `e2e.js` (Playwright), `e2e_camera.js` (QR fotoaparátem s falešnou kamerou), `e2e_sheets.js`
  (Google tabulka: `gas_mock.js` + `fake_google.js`).
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
- Schéma 3 (1.3): `hooks` (propojení: url, `secret` v čitelné podobě kvůli podpisu, počítadla,
  `fails`, `retry_at`), `hook_watch` (sledované barcody, NOCASE), `hook_queue` (co poslat, `ver`),
  `meta` (`worker_seen_at`). Schéma 4 (1.4): `hooks.kind/name/ref/match_family`, `hook_watch.note`;
  propojení = API klíč + `ref` (víc tabulek na klíč). Schéma 5 (1.5): `hook_watch.info` (údaje
  k průvodce z tabulky jako JSON).
- Nová verze schématu: přidej blok `if ($version < N)` do `etd_migrate` a zvyš `ETD_SCHEMA`.
  Jen přidávat (tabulky, sloupce s výchozí hodnotou), nic nemazat. Nové oddělení = nový řádek
  v `ETD_DEPTS` (kód se ukládá do záznamů, neměň ho), barva `--d-N` a třída `.dept-<kód>`
  v `app.css`, seznam v `README.md` a `API.md`.
- Pozor: PDO posílá parametry jako text. `etd_run` proto váže celá čísla jako INTEGER.

## Vývoj a testy v cloudové session

```bash
python3 -m unittest discover -s tests     # 42 testů, asi 20 s
node tests/test_scan.js
node tests/e2e.js                         # SHOTS=/adresář uloží snímky
node tests/e2e_camera.js                  # fotoaparát (Chromium s --use-file-for-fake-video-capture)
node tests/e2e_sheets.js                  # Google tabulka (náhradní Apps Script a Google, curl)
php -l lib/etd.php                        # a další změněné PHP soubory
```

- Lokálně: `ETD_DATA_DIR=$S/etd php -S 127.0.0.1:8480 router.php`, kód prvního spuštění
  vypíše `ETD_DATA_DIR=$S/etd php bin/setup-token.php`.
- Playwright: `require('/opt/node22/lib/node_modules/playwright')`, Chromium z `/opt/pw-browsers`
  (testy cestu `chromium-1194` použijí, jen když existuje; jinak výchozí); `playwright install` nespouštěj.
- Apache v kontejneru (jen tady, nikdy na ostrém serveru): `sudo bash deploy/install.sh`, pak
  `http://127.0.0.1/evidence_toku_dilu/` (z localhostu aplikace pustí i bez HTTPS).
- Pozor na `pkill -f "php -S …"`: vzor najde i vlastní shell a zabije ho.
- CSP nepovoluje `style="…"` v HTML: pro rozestupy jsou pomocné třídy na konci `app.css`.
- Barvy oddělení jsou kategorická paleta v pevném pořadí, ověřená validátorem dataviz (světlý
  i tmavý režim). Barva je vždy u názvu oddělení, nikdy sama.
