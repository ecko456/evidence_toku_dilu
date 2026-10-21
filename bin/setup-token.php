<?php
declare(strict_types=1);

// Vypíše kód pro první spuštění (jen dokud neexistuje žádný uživatel).
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/lib/etd.php';

if (!etd_setup_required()) {
    fwrite(STDOUT, "Aplikace už je nastavená. Přihlas se jménem a heslem.\n");
    exit(0);
}
fwrite(STDOUT, etd_setup_token() . "\n");
