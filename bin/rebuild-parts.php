<?php
declare(strict_types=1);

// Přepočítá poslední stav všech průvodek (tabulka parts) ze záznamů. Hodí se po ruční obnově
// zálohy nebo opravě v databázi; běžně to není potřeba.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/lib/etd.php';

fwrite(STDOUT, 'Poslední stav přepočítán: ' . etd_rebuild_parts() . " průvodek.\n");
