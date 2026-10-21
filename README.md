# Evidence toku dílů

Webová aplikace pro evidenci toku dílů mezi pracovišti. Pracovník načte čtečkou hlavní barcode
průvodky a zapíše **Příjem na pracoviště** nebo **Export z pracoviště**. Přehled vždy ukáže
poslední záznam průvodky (kde je, kdo ji převzal, kolik kusů odešlo) a celou historii od
nejnovějšího. Pro IT je k dispozici API pro čtení posledního záznamu (viz [API.md](API.md)).

PHP 8.1+ a SQLite, bez dalších knihoven. Běží na adrese `/evidence_toku_dilu/` vedle ostatních
aplikací na serveru a má vlastní data i přihlášení.

## Oddělení a role

Po přihlášení si každý vybere oddělení, na kterém pracuje (klikem nebo klávesou 1 až 8):

1. Broušení WPA
2. Brush WPA
3. Hala
4. Montáž
5. Elox
6. Studio
7. CNC Hala2
8. Visitor: do systému jen nahlíží, nic nezapíše

Role uživatele určuje správce:

| role | co smí |
|---|---|
| Pracovník | příjem a export na odděleních, která mu správce povolí, a Visitor |
| Správce | všechna oddělení, uživatelé, API klíče, storno i starších záznamů |
| Jen nahlížení | přihlásí se jen jako Visitor (Přehled a Na pracovištích) |

## Jak se pracuje

**Příjem na pracoviště.** Načti barcode průvodky; příjem se hned zapíše a ukáže se, odkud díly
přišly (předchozí záznam). Zaškrtnutím **Definovat pozici kam se umístí** se k příjmu zapíše
pozice (např. „Regál A3“). Aplikace nabízí pozice použité na pracovišti v posledních 90 dnech.

**Export z pracoviště.** Po načtení barcodu zadej **počet kusů** a potvrď Enterem. Bez počtu
kusů se export nezapíše. Když čtečka místo počtu kusů načte další průvodku, aplikace na to
upozorní a export čeká dál.

**Vícenásobný příjem / export.** Přepínač nahoře. Průvodky se jen načítají do seznamu (stejná
průvodka podruhé se nepřidá) a nakonec se zapíšou tlačítkem **Zapsat vše**. U příjmu platí
pozice pro všechny průvodky v seznamu. U exportu má každá průvodka svůj počet kusů; „Počet ks
všem prázdným“ vyplní stejné číslo všem, které ho ještě nemají. Rozpracovaný seznam přežije
obnovení stránky.

**Dvojí načtení.** Stejný záznam (stejná průvodka, stejné pracoviště, stejný typ) do 10 minut se
bere jako omyl a nezapíše se. Když jde opravdu o další záznam, tlačítko **Zapsat znovu**
(u seznamu **Zapsat přesto**) ho zapíše.

**Storno.** Záznamy se nemažou. Chybný záznam se stornuje: zůstane v historii přeškrtnutý
s důvodem a do posledního stavu průvodky se nepočítá. Vlastní záznam jde stornovat 30 minut na
stejném pracovišti, starší jen správce.

**Přehled.** Vyhledávač podle barcodu (čtečkou nebo ručně, stačí i část). Nahoře je vždy
**poslední záznam**, pod ním historie od nejnovějšího. Při částečném hledání se ukážou všechny
odpovídající průvodky s jejich posledním záznamem. Pod vyhledávačem jsou poslední záznamy všech
pracovišť s filtrem podle oddělení a typu.

**Na pracovištích.** Průvodky, jejichž poslední záznam je příjem na daném pracovišti: díly tam
jsou a ještě neodešly exportem, i s pozicí.

## Čtečka čárových kódů

Čtečka se chová jako klávesnice: napíše kód a pošle Enter (nebo Tab, i ten aplikace bere).
Znaky jdou do pole pro barcode, i když má fokus jiné tlačítko. Velikost písmen v barcodu nehraje
roli. QR kód musí obsahovat jen jeden řádek (Enter uprostřed by ho rozdělil na dvě čtení).

Když je čtečka nastavená na anglickou klávesnici a Windows mají českou, napíše místo číslic
„+ěščřžýáíé“ a prohodí Y se Z. Aplikace to pozná a opraví (dá o tom vědět). Vypíná se v menu
uživatele (Oprava české klávesnice). Trvale to vyřeší nastavení čtečky na české rozložení nebo
na zadávání přes Alt-kódy.

## Instalace a aktualizace (Ubuntu + Apache)

```bash
cd /root && git clone https://github.com/ecko456/evidence_toku_dilu.git
cd /root/evidence_toku_dilu && git checkout claude/elegant-clarke-vl5n7d && sudo bash deploy/install.sh
```

Aktualizace:

```bash
cd /root/evidence_toku_dilu && git pull origin claude/elegant-clarke-vl5n7d && sudo bash deploy/install.sh
```

- Kód: `/var/www/evidence_toku_dilu`, data: `/var/lib/evidence_toku_dilu`, Apache:
  `/etc/apache2/conf-available/evidence_toku_dilu.conf`. Ostatních aplikací se instalace nedotkne.
- Aplikace běží jen přes HTTPS (stejný virtuální host jako ostatní aplikace).
- Před každou aktualizací se databáze zazálohuje do `/var/lib/evidence_toku_dilu/backups`
  (posledních 20). Nové tabulky si databáze doplní sama, data zůstanou.
- **První spuštění:** instalace vypíše jednorázový kód. Otevři `https://<server>/evidence_toku_dilu/`,
  zadej ho a založ prvního správce. Kód znovu vypíše:
  `sudo runuser -u www-data -- env ETD_DATA_DIR=/var/lib/evidence_toku_dilu php /var/www/evidence_toku_dilu/bin/setup-token.php`

### Nástroje na serveru

```bash
# zapomenuté heslo (vypíše dočasné, po přihlášení se nastaví vlastní)
sudo runuser -u www-data -- env ETD_DATA_DIR=/var/lib/evidence_toku_dilu php /var/www/evidence_toku_dilu/bin/reset-password.php LOGIN
# ruční záloha databáze
sudo runuser -u www-data -- env ETD_DATA_DIR=/var/lib/evidence_toku_dilu php /var/www/evidence_toku_dilu/bin/backup-db.php
```

**Obnova zálohy:** zastav Apache, zkopíruj zálohu na `/var/lib/evidence_toku_dilu/evidence.sqlite3`
(vlastník `www-data`), smaž `evidence.sqlite3-wal` a `-shm`, spusť `bin/rebuild-parts.php`
(stejným příkazem jako výše) a Apache zase zapni.

## Vývoj a testy

```bash
ETD_DATA_DIR=/tmp/etd php -S 127.0.0.1:8480 router.php   # http://127.0.0.1:8480/
python3 -m unittest discover -s tests                      # server a API
node tests/test_scan.js                                    # funkce pro čtečku
node tests/e2e.js                                          # průchod v Chromiu (Playwright)
```
