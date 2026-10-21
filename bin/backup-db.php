<?php
declare(strict_types=1);

// Záloha databáze před aktualizací: php bin/backup-db.php [adresář]
// Kopie je konzistentní i za běhu (VACUUM INTO). Nechává se posledních 20 záloh.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/lib/etd.php';

$source = etd_db_file();
if (!is_file($source)) {
    fwrite(STDOUT, "Databáze zatím neexistuje, není co zálohovat.\n");
    exit(0);
}
$target = $argv[1] ?? (etd_data_dir() . DIRECTORY_SEPARATOR . 'backups');
if (!is_dir($target) && !mkdir($target, 0700, true) && !is_dir($target)) {
    fwrite(STDERR, "Nelze vytvořit adresář pro zálohy: $target\n");
    exit(1);
}
$file = $target . DIRECTORY_SEPARATOR . 'evidence-' . gmdate('Ymd-His') . '.sqlite3';
// Záloha čte databázi přímo, bez etd_db(): aktualizace schématu proběhne až v nové verzi.
$pdo = new PDO('sqlite:' . $source);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('PRAGMA busy_timeout = 10000');
try {
    $statement = $pdo->prepare('VACUUM INTO ?');
    $statement->execute([$file]);
} catch (Throwable $error) {
    // Starší SQLite bez VACUUM INTO: přepsat WAL do souboru a zkopírovat.
    $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (!copy($source, $file)) {
        fwrite(STDERR, 'Záloha selhala: ' . $error->getMessage() . "\n");
        exit(1);
    }
}
@chmod($file, 0600);

$all = glob($target . DIRECTORY_SEPARATOR . 'evidence-*.sqlite3') ?: [];
sort($all);
foreach (array_slice($all, 0, max(0, count($all) - 20)) as $old) {
    @unlink($old);
}
fwrite(STDOUT, $file . "\n");
