<?php
declare(strict_types=1);

// Odesílání změn do Google tabulek (živé propojení, lib/hooks.php). Spouští ho cron každou minutu:
//   /etc/cron.d/evidence_toku_dilu (zakládá deploy/install.sh)
// Jeden běh trvá asi minutu a frontu kontroluje každou sekundu, takže změna je v tabulce
// za pár sekund. Souběžně běží vždy jen jeden (zámek hook-worker.lock v datovém adresáři).
//   --once   jen jeden průchod frontou (ruční spuštění, testy)
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/lib/etd.php';

$once = in_array('--once', $argv, true);
etd_db();
$lock = fopen(etd_data_dir() . DIRECTORY_SEPARATOR . 'hook-worker.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    exit(0);   // předchozí běh ještě pracuje
}

$until = time() + ETD_WORKER_SECONDS;
$sent = 0;
$beat = 0;
do {
    try {
        if (time() - $beat >= 15) {   // „úloha běží“ pro Správu, bez zápisu každou sekundu
            $beat = time();
            etd_meta_set('worker_seen_at', (string)$beat);
        }
        $n = etd_hooks_deliver();
        $sent += $n;
    } catch (Throwable $error) {
        // databáze zaneprázdněná apod.: zkusí se za chvíli znovu
        error_log('Evidence toku dílů (odesílání): ' . $error->getMessage());
        $n = 0;
    }
    if ($once) {
        break;
    }
    if ($n === 0) {
        sleep(1);
    }
} while (time() < $until);

flock($lock, LOCK_UN);
if ($once) {
    fwrite(STDOUT, "Odesláno průvodek: {$sent}\n");
}
