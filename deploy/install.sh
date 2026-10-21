#!/usr/bin/env bash
set -euo pipefail

# Instalace i aktualizace Evidence toku dílů (Ubuntu + Apache):
#   sudo bash /root/evidence_toku_dilu/deploy/install.sh
# Aplikace běží na adrese /evidence_toku_dilu/ s vlastním kódem (/var/www/evidence_toku_dilu),
# vlastními daty (/var/lib/evidence_toku_dilu) a vlastní konfigurací Apache. Ostatních aplikací
# na serveru (Trading Desk, Odměny) se instalace nedotkne.
#
# Aktualizace data nemaže: před každou aktualizací se databáze zazálohuje do
# /var/lib/evidence_toku_dilu/backups (posledních 20 kopií). Nové tabulky a sloupce si databáze
# doplní sama při prvním otevření (lib/etd.php, etd_migrate).

if [[ "${EUID}" -ne 0 ]]; then
  echo "Spusť instalaci přes sudo: sudo bash /root/evidence_toku_dilu/deploy/install.sh"
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="/var/www/evidence_toku_dilu"
DATA_DIR="/var/lib/evidence_toku_dilu"
APACHE_CONF="/etc/apache2/conf-available/evidence_toku_dilu.conf"
DB_FILE="${DATA_DIR}/evidence.sqlite3"

UPDATE=0
if [[ -f "${DB_FILE}" ]]; then
  UPDATE=1
fi

apt-get update
apt-get install -y apache2 php php-cli php-sqlite3 php-mbstring rsync

install -d -m 0750 -o root -g www-data "${TARGET_DIR}"
install -d -m 0700 -o www-data -g www-data "${DATA_DIR}"

BACKUP_FILE=""
if [[ "${UPDATE}" -eq 1 ]]; then
  echo "Nalezena existující data, dělám zálohu databáze…"
  install -d -m 0700 -o root -g root "${DATA_DIR}/backups"
  BACKUP_FILE="$(ETD_DATA_DIR="${DATA_DIR}" php "${SOURCE_DIR}/bin/backup-db.php" "${DATA_DIR}/backups")"
  # Záloha běžela jako root: soubory databáze musí dál patřit webovému serveru.
  chown www-data:www-data "${DATA_DIR}"/evidence.sqlite3* 2>/dev/null || true
  if [[ ! -s "${BACKUP_FILE}" ]]; then
    echo "Záloha databáze se nepovedla, aktualizaci přerušuji. Data zůstala beze změny."
    exit 1
  fi
fi

rsync -a --delete \
  --exclude '/data/' \
  --exclude '/tests/' \
  --exclude '/deploy/' \
  --exclude '/router.php' \
  --exclude '*.md' \
  --exclude '.*' \
  "${SOURCE_DIR}/" "${TARGET_DIR}/"

chown -R root:www-data "${TARGET_DIR}"
find "${TARGET_DIR}" -type d -exec chmod 0750 {} +
find "${TARGET_DIR}" -type f -exec chmod 0640 {} +
chown www-data:www-data "${DATA_DIR}"
find "${DATA_DIR}" -maxdepth 1 -type f -name 'evidence.sqlite3*' -exec chown www-data:www-data {} +
chmod 0700 "${DATA_DIR}"

install -m 0644 "${SOURCE_DIR}/deploy/apache-evidence_toku_dilu.conf" "${APACHE_CONF}"
# Ochranné hlavičky pro statické soubory potřebují mod_headers.
a2enmod headers >/dev/null
a2enconf evidence_toku_dilu >/dev/null

apache2ctl configtest

if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl enable apache2 >/dev/null 2>&1 || true
  systemctl reload apache2 || systemctl restart apache2
else
  service apache2 reload || service apache2 start
fi

# Databáze se otevře (a případně doplní o nové tabulky) pod uživatelem webového serveru.
runuser -u www-data -- env ETD_DATA_DIR="${DATA_DIR}" php -r 'require "/var/www/evidence_toku_dilu/lib/etd.php"; etd_db(); echo "Databáze v pořádku.\n";'

# Dokud neexistuje žádný uživatel, vypíše se jednorázový kód pro první spuštění.
SETUP_CODE="$(runuser -u www-data -- env ETD_DATA_DIR="${DATA_DIR}" php "${TARGET_DIR}/bin/setup-token.php" 2>/dev/null || true)"

echo
if [[ "${UPDATE}" -eq 1 ]]; then
  echo "Evidence toku dílů je aktualizovaná. Data zůstala zachovaná."
  echo "Záloha databáze před změnou: ${BACKUP_FILE}"
else
  echo "Evidence toku dílů je nainstalovaná: https://<adresa-serveru>/evidence_toku_dilu/"
fi
echo "Data: ${DATA_DIR}. Ostatní aplikace na serveru zůstaly beze změny."
if [[ -n "${SETUP_CODE}" && "${SETUP_CODE}" != *"nastavená"* ]]; then
  echo
  echo "První spuštění: otevři https://<adresa-serveru>/evidence_toku_dilu/, zadej tento kód a založ správce:"
  echo "  ${SETUP_CODE}"
  echo
  echo "Kód znovu vypíše:"
  echo "  sudo runuser -u www-data -- env ETD_DATA_DIR=${DATA_DIR} php ${TARGET_DIR}/bin/setup-token.php"
fi
