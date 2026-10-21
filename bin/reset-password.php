<?php
declare(strict_types=1);

// Nouzové nové heslo (třeba když správce zapomene svoje):
//   sudo runuser -u www-data -- env ETD_DATA_DIR=/var/lib/evidence_toku_dilu php /var/www/evidence_toku_dilu/bin/reset-password.php LOGIN
// Vypíše dočasné heslo; po přihlášení si uživatel musí nastavit vlastní. Účet se zároveň zapne.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/lib/etd.php';

$login = strtolower(trim((string)($argv[1] ?? '')));
if ($login === '') {
    fwrite(STDERR, "Použití: php bin/reset-password.php LOGIN\n");
    $users = etd_all('SELECT login, name, role, active FROM users ORDER BY login');
    foreach ($users as $user) {
        fwrite(STDERR, sprintf("  %-20s %s (%s)%s\n", $user['login'], $user['name'], ETD_ROLES[$user['role']] ?? $user['role'], $user['active'] ? '' : ', vypnutý'));
    }
    exit(1);
}
$user = etd_one('SELECT * FROM users WHERE login = ?', [$login]);
if ($user === null) {
    fwrite(STDERR, "Uživatel {$login} neexistuje.\n");
    exit(1);
}
$password = implode('-', str_split(bin2hex(random_bytes(6)), 4));
etd_exec('UPDATE users SET pass_hash = ?, must_change = 1, active = 1, updated_at = ? WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), time(), (int)$user['id']]);
etd_exec('DELETE FROM sessions WHERE user_id = ?', [(int)$user['id']]);
etd_log('server', "Nouzové nové heslo pro {$user['name']} ({$login}) z příkazové řádky.");
fwrite(STDOUT, "Dočasné heslo pro {$user['name']} ({$login}): {$password}\n");
