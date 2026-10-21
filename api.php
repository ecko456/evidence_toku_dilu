<?php
declare(strict_types=1);

/*
 * JSON API pro stránku aplikace (api.php?action=…). Volá ho jen static/app.js
 * s hlavičkou X-Etd: 1 a cookie relace. API pro IT je zvlášť v api/v1/ (klíče, viz API.md).
 */

require __DIR__ . '/lib/etd.php';

etd_json_errors();
etd_security_headers();
etd_require_https(true);

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$action = (string)($_GET['action'] ?? '');
etd_require_app_request($method);

const ETD_POST_ACTIONS = ['setup', 'login', 'first_password', 'logout', 'dept', 'password', 'scan', 'cancel', 'user_save', 'apikey_create', 'apikey_revoke'];
if (in_array($action, ETD_POST_ACTIONS, true) && $method !== 'POST') {
    etd_fail('Tahle akce vyžaduje POST.', 405);
}
if ($method === 'POST' && !in_array($action, ['setup', 'login', 'first_password', 'logout'], true)) {
    etd_require_client();
}

/** Stav pro stránku: kdo je přihlášený, na jakém oddělení a co smí. */
function etd_state(): array
{
    $session = etd_session();
    $base = [
        'version' => ETD_VERSION,
        'depts' => array_map(static fn(string $code, string $name): array => ['code' => $code, 'name' => $name], array_keys(ETD_DEPTS), ETD_DEPTS),
        'actions' => ETD_ACTIONS,
        'roles' => ETD_ROLES,
        'limits' => ['batch' => ETD_MAX_BATCH, 'barcode' => ETD_MAX_BARCODE, 'position' => ETD_MAX_POSITION, 'qty' => ETD_MAX_QTY,
            'password' => ETD_MIN_PASSWORD, 'inviteDays' => ETD_INVITE_DAYS, 'cancelMinutes' => intdiv(ETD_CANCEL_OWN_SECONDS, 60), 'duplicateMinutes' => intdiv(ETD_DUPLICATE_SECONDS, 60)],
    ];
    if ($session === null) {
        return $base + ['setup' => etd_setup_required(), 'user' => null];
    }
    $dept = $session['dept'];
    return $base + [
        'setup' => false,
        'user' => etd_user_public($session),
        'dept' => $dept,
        'deptName' => $dept === null ? null : etd_dept_name($dept),
        'canWrite' => $dept !== null && $dept !== ETD_VISITOR && $session['role'] !== 'visitor' && !$session['must_change'],
        'isAdmin' => $session['role'] === 'admin',
    ];
}

function etd_limit(mixed $value, int $default, int $max): int
{
    $n = is_numeric($value) ? (int)$value : $default;
    return max(1, min($max, $n));
}

switch ($action) {
    case 'state':
        etd_json(etd_state());

    case 'setup':
        $input = etd_input();
        if (!etd_setup_required()) {
            etd_fail('Aplikace už je nastavená. Přihlas se.', 409);
        }
        etd_throttle_login('');
        $token = strtoupper(trim((string)($input['token'] ?? '')));
        if ($token === '' || !hash_equals(etd_setup_token(), $token)) {
            etd_login_failed('');
            etd_fail('Kód pro první spuštění nesedí. Najdeš ho na serveru (viz README).', 403);
        }
        $login = etd_login_name($input['login'] ?? '');
        $name = etd_text($input['name'] ?? '', 80);
        if ($login === null) {
            etd_fail('Přihlašovací jméno: 2 až 40 znaků, malá písmena bez diakritiky, číslice, tečka, pomlčka nebo podtržítko.');
        }
        if ($name === '') {
            etd_fail('Vyplň jméno.');
        }
        if ($error = etd_password_error($input['password'] ?? null)) {
            etd_fail($error);
        }
        $now = time();
        $id = etd_tx(static function () use ($login, $name, $input, $now): int {
            if (!etd_setup_required()) {
                etd_fail('Aplikace už je nastavená. Přihlas se.', 409);
            }
            etd_exec("INSERT INTO users (login, name, pass_hash, role, depts, active, must_change, created_at, updated_at) VALUES (?, ?, ?, 'admin', '', 1, 0, ?, ?)",
                [$login, $name, password_hash((string)$input['password'], PASSWORD_DEFAULT), $now, $now]);
            return (int)etd_db()->lastInsertId();
        });
        @unlink(etd_setup_token_path());
        etd_log($name, "Založen první správce {$name} ({$login}).");
        etd_start_session($id);
        etd_json(etd_state());

    case 'login':
        $input = etd_input();
        $login = strtolower(trim((string)($input['login'] ?? '')));
        etd_throttle_login(mb_substr($login, 0, 60));
        $password = (string)($input['password'] ?? '');
        $user = etd_login_name($login) === null ? null : etd_one('SELECT * FROM users WHERE login = ?', [$login]);
        // účet bez hesla (založil ho správce): heslo si uživatel nastaví teď (first_password)
        if ($user !== null && $user['active'] && etd_user_pending($user)) {
            if (!etd_invite_valid($user)) {
                etd_fail('Čas na první přihlášení vypršel (' . ETD_INVITE_DAYS . ' dní od založení účtu). Požádej správce, ať ti ho obnoví.', 403);
            }
            etd_json(['needPassword' => true, 'login' => $user['login'], 'minPassword' => ETD_MIN_PASSWORD]);
        }
        if ($password === '') {
            etd_fail('Vyplň heslo.', 400);
        }
        // u neexistujícího jména se heslo zahešuje (trvá stejně dlouho), ať se jména nedají zkoušet
        $ok = $user !== null ? password_verify($password, (string)$user['pass_hash']) : (bool)password_hash($password, PASSWORD_DEFAULT) && false;
        if (!$ok || !$user['active']) {
            etd_login_failed(mb_substr($login, 0, 60));
            etd_fail($ok ? 'Účet je vypnutý. Obrať se na správce.' : 'Přihlašovací jméno nebo heslo nesedí.', 401);
        }
        if (password_needs_rehash($user['pass_hash'], PASSWORD_DEFAULT)) {
            etd_exec('UPDATE users SET pass_hash = ? WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), (int)$user['id']]);
        }
        etd_start_session((int)$user['id']);
        etd_json(etd_state());

    case 'first_password':
        // první přihlášení účtu bez hesla: uživatel si heslo nastaví sám a rovnou se přihlásí
        $input = etd_input();
        $login = strtolower(trim((string)($input['login'] ?? '')));
        etd_throttle_login(mb_substr($login, 0, 60));
        $user = etd_login_name($login) === null ? null : etd_one('SELECT * FROM users WHERE login = ?', [$login]);
        if ($user === null || !$user['active'] || !etd_invite_valid($user)) {
            etd_login_failed(mb_substr($login, 0, 60));
            etd_fail('Tenhle účet si heslo nastavit nemůže. Přihlas se svým heslem, nebo požádej správce.', 403);
        }
        if ($error = etd_password_error($input['password'] ?? null)) {
            etd_fail($error);
        }
        $changed = etd_exec("UPDATE users SET pass_hash = ?, must_change = 0, pending_until = NULL, updated_at = ? WHERE id = ? AND pass_hash = ''",
            [password_hash((string)$input['password'], PASSWORD_DEFAULT), time(), (int)$user['id']]);
        if ($changed !== 1) {
            etd_fail('Heslo k tomuhle účtu už je nastavené. Přihlas se jím.', 409);
        }
        etd_log((string)$user['name'], "{$user['name']} ({$user['login']}) si při prvním přihlášení nastavil(a) heslo.");
        etd_start_session((int)$user['id']);
        etd_json(etd_state());

    case 'logout':
        etd_end_session();
        etd_json(['ok' => true]);

    case 'dept':
        $session = etd_require_session();
        $dept = (string)(etd_input()['dept'] ?? '');
        if ($dept !== ETD_VISITOR && !in_array($dept, etd_user_depts($session), true)) {
            etd_fail($session['role'] === 'visitor' ? 'Tvůj účet smí do systému jen nahlížet (Visitor).' : 'Na tohle oddělení nemáš přístup. Obrať se na správce.', 403);
        }
        etd_exec('UPDATE sessions SET dept = ? WHERE id = ?', [$dept, $session['session_id']]);
        unset($GLOBALS['etd_session']);
        etd_json(etd_state());

    case 'password':
        $session = etd_require_session();
        $input = etd_input();
        if (!password_verify((string)($input['old'] ?? ''), (string)$session['pass_hash'])) {
            etd_login_failed((string)$session['login']);
            etd_throttle_login((string)$session['login']);
            etd_fail('Současné heslo nesedí.', 403);
        }
        if ($error = etd_password_error($input['new'] ?? null)) {
            etd_fail($error);
        }
        if (hash_equals((string)$input['old'], (string)$input['new'])) {
            etd_fail('Nové heslo musí být jiné než současné.');
        }
        etd_exec('UPDATE users SET pass_hash = ?, must_change = 0, updated_at = ? WHERE id = ?', [password_hash((string)$input['new'], PASSWORD_DEFAULT), time(), (int)$session['id']]);
        // ostatní přihlášení tohoto uživatele (jiné počítače) se odhlásí
        etd_exec('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [(int)$session['id'], $session['session_id']]);
        unset($GLOBALS['etd_session']);
        etd_json(etd_state());

    case 'scan':
        $session = etd_require_writer();
        $input = etd_input();
        $kind = (string)($input['action'] ?? '');
        if (!isset(ETD_ACTIONS[$kind])) {
            etd_fail('Neznámá akce.');
        }
        $items = $input['items'] ?? null;
        if (!is_array($items) || !array_is_list($items) || $items === []) {
            etd_fail('Není co zapsat.');
        }
        if (count($items) > ETD_MAX_BATCH) {
            etd_fail('V jedné dávce může být nejvýš ' . ETD_MAX_BATCH . ' průvodek.');
        }
        $position = $kind === 'prijem' ? etd_text($input['position'] ?? '', ETD_MAX_POSITION) : '';
        if ($kind === 'prijem' && !empty($input['definePosition']) && $position === '') {
            etd_fail('Vyplň pozici, kam se díly umístí.');
        }
        $results = etd_scan($session, $kind, $items, $position, !empty($input['force']));
        $written = count(array_filter($results, static fn(array $r): bool => $r['status'] === 'ok'));
        etd_json(['results' => $results, 'written' => $written]);

    case 'cancel':
        $session = etd_require_session();
        if ($session['role'] === 'visitor' || $session['dept'] === ETD_VISITOR && $session['role'] !== 'admin') {
            etd_fail('Visitor do systému jen nahlíží.', 403);
        }
        $input = etd_input();
        $id = (int)($input['id'] ?? 0);
        $reason = etd_text($input['reason'] ?? '', 200);
        $record = etd_tx(static function () use ($session, $id, $reason): array {
            $record = etd_one('SELECT * FROM records WHERE id = ?', [$id]);
            if ($record === null) {
                etd_fail('Záznam neexistuje.', 404);
            }
            if ($record['cancelled_at'] !== null) {
                etd_fail('Záznam už je stornovaný.', 409);
            }
            if (!etd_can_cancel($session, $record)) {
                etd_fail('Tenhle záznam stornovat nemůžeš. Vlastní záznam jde stornovat ' . intdiv(ETD_CANCEL_OWN_SECONDS, 60) . ' minut na stejném pracovišti, starší jen správce.', 403);
            }
            etd_exec('UPDATE records SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?', [time(), (string)$session['name'], $reason === '' ? null : $reason, $id]);
            etd_refresh_part((string)$record['barcode']);
            return etd_one('SELECT * FROM records WHERE id = ?', [$id]);
        });
        $last = etd_last((string)$record['barcode']);
        etd_json(['record' => etd_record_public($record), 'last' => $last === null ? null : etd_record_public($last)]);

    case 'last':
        etd_require_session();
        $code = etd_barcode($_GET['barcode'] ?? '');
        if ($code === null) {
            etd_fail('Neplatný barcode.');
        }
        $last = etd_last($code);
        etd_json(['barcode' => $code, 'last' => $last === null ? null : etd_record_public($last)]);

    case 'recent':
        // poslední záznamy na pracovišti přihlášeného (pod skenováním)
        $session = etd_require_session();
        $dept = (string)$session['dept'];
        $rows = isset(ETD_DEPTS[$dept]) ? etd_all('SELECT * FROM records WHERE dept = ? ORDER BY id DESC LIMIT ?', [$dept, etd_limit($_GET['limit'] ?? null, 30, 100)]) : [];
        etd_json(['records' => etd_records_for($session, $rows)]);

    case 'records':
        // přehled: všechny záznamy od nejnovějšího, filtr podle oddělení a typu, stránkování podle id
        $session = etd_require_session();
        $where = [];
        $params = [];
        $dept = (string)($_GET['dept'] ?? '');
        if (isset(ETD_DEPTS[$dept])) {
            $where[] = 'dept = ?';
            $params[] = $dept;
        }
        $kind = (string)($_GET['type'] ?? '');
        if (isset(ETD_ACTIONS[$kind])) {
            $where[] = 'action = ?';
            $params[] = $kind;
        }
        $before = (int)($_GET['before'] ?? 0);
        if ($before > 0) {
            $where[] = 'id < ?';
            $params[] = $before;
        }
        $limit = etd_limit($_GET['limit'] ?? null, 50, 200);
        $params[] = $limit + 1;
        $rows = etd_all('SELECT * FROM records' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT ?', $params);
        $more = count($rows) > $limit;
        etd_json(['records' => etd_records_for($session, array_slice($rows, 0, $limit)), 'more' => $more]);

    case 'search':
        // vyhledávač v přehledu: přesná shoda (historie od nejnovějšího) a průvodky, které hledaný text obsahují
        $session = etd_require_session();
        $q = etd_text($_GET['q'] ?? '', ETD_MAX_BARCODE);
        if ($q === '') {
            etd_json(['q' => '', 'exact' => null, 'matches' => [], 'more' => false]);
        }
        $exact = null;
        $history = etd_all('SELECT * FROM records WHERE barcode = ? COLLATE NOCASE ORDER BY id DESC LIMIT 500', [$q]);
        if ($history) {
            $last = etd_last($q);
            $exact = ['barcode' => $last['barcode'] ?? $history[0]['barcode'], 'last' => $last === null ? null : etd_record_public($last) + ['canCancel' => etd_can_cancel($session, $last)],
                'history' => etd_records_for($session, $history), 'count' => (int)(etd_one('SELECT COUNT(*) AS n FROM records WHERE barcode = ? COLLATE NOCASE', [$q])['n'] ?? 0)];
        }
        $rows = etd_all("SELECT r.* FROM parts p JOIN records r ON r.id = p.last_id WHERE p.barcode LIKE ? ESCAPE '\\' AND p.barcode <> ? ORDER BY p.updated_at DESC, p.last_id DESC LIMIT 51", [etd_like($q), $q]);
        etd_json(['q' => $q, 'exact' => $exact, 'matches' => array_map('etd_record_public', array_slice($rows, 0, 50)), 'more' => count($rows) > 50]);

    case 'onsite':
        // průvodky, jejichž poslední záznam je příjem na daném pracovišti (jsou tam a ještě neodešly)
        etd_require_session();
        $out = [];
        foreach (ETD_DEPTS as $code => $name) {
            $total = (int)(etd_one("SELECT COUNT(*) AS n FROM parts WHERE last_dept = ? AND last_action = 'prijem'", [$code])['n'] ?? 0);
            $rows = etd_all("SELECT r.* FROM parts p JOIN records r ON r.id = p.last_id WHERE p.last_dept = ? AND p.last_action = 'prijem' ORDER BY p.updated_at DESC LIMIT 500", [$code]);
            $out[] = ['code' => $code, 'name' => $name, 'total' => $total, 'records' => array_map('etd_record_public', $rows)];
        }
        etd_json(['depts' => $out]);

    case 'positions':
        // pozice použité na pracovišti za posledních 90 dní (návrhy do pole Pozice)
        $session = etd_require_session();
        $rows = etd_all("SELECT position, MAX(id) AS last FROM records WHERE dept = ? AND position IS NOT NULL AND position <> '' AND created_at >= ? GROUP BY position ORDER BY last DESC LIMIT 60",
            [(string)$session['dept'], time() - 90 * 86400]);
        etd_json(['positions' => array_column($rows, 'position')]);

    /* ---------------------------------------------------------------- správa */

    case 'users':
        etd_require_admin();
        $rows = etd_all('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE');
        etd_json(['users' => array_map('etd_user_public', $rows)]);

    case 'user_save':
        $admin = etd_require_admin();
        $input = etd_input();
        $id = (int)($input['id'] ?? 0);
        $name = etd_text($input['name'] ?? '', 80);
        $login = etd_login_name($input['login'] ?? '');
        $role = (string)($input['role'] ?? '');
        $active = !empty($input['active']);
        $password = is_string($input['password'] ?? null) ? $input['password'] : '';
        $mustChange = !empty($input['mustChange']);
        // self = heslo si nastaví sám při (příštím) přihlášení, set = heslo zadá správce, keep = beze změny
        $mode = (string)($input['passwordMode'] ?? '');
        if (!in_array($mode, ['self', 'set', 'keep'], true)) {
            $mode = $password !== '' ? 'set' : ($id === 0 ? 'self' : 'keep');
        }
        if ($id === 0 && $mode === 'keep') {
            $mode = 'self';
        }
        if ($name === '') {
            etd_fail('Vyplň jméno.');
        }
        if ($login === null) {
            etd_fail('Přihlašovací jméno: 2 až 40 znaků, malá písmena bez diakritiky, číslice, tečka, pomlčka nebo podtržítko.');
        }
        if (!isset(ETD_ROLES[$role])) {
            etd_fail('Vyber roli.');
        }
        $depts = $role === 'operator' && is_array($input['depts'] ?? null)
            ? array_values(array_intersect(array_keys(ETD_DEPTS), array_map('strval', $input['depts']))) : [];
        if ($role === 'operator' && $depts === []) {
            etd_fail('Vyber aspoň jedno oddělení, na kterém smí pracovat.');
        }
        $deptsText = count($depts) === count(ETD_DEPTS) ? '' : implode(',', $depts);
        if ($mode === 'set' && ($error = etd_password_error($password))) {
            etd_fail($error);
        }
        if ($mode === 'self' && $id === (int)$admin['id']) {
            etd_fail('Vlastní heslo si změníš v menu (Změnit heslo).', 409);
        }
        $saved = etd_tx(static function () use ($admin, $id, $name, $login, $role, $active, $password, $mustChange, $deptsText, $mode): array {
            $other = etd_one('SELECT id FROM users WHERE login = ? AND id <> ?', [$login, $id]);
            if ($other !== null) {
                etd_fail('Přihlašovací jméno už má někdo jiný.', 409);
            }
            $now = time();
            if ($id === 0) {
                $set = $mode === 'set';
                etd_exec('INSERT INTO users (login, name, pass_hash, role, depts, active, must_change, pending_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [$login, $name, $set ? password_hash($password, PASSWORD_DEFAULT) : '', $role, $deptsText, $active ? 1 : 0, $set && $mustChange ? 1 : 0,
                        $set ? null : $now + ETD_INVITE_DAYS * 86400, $now, $now]);
                $id = (int)etd_db()->lastInsertId();
                etd_log((string)$admin['name'], "Nový uživatel {$name} ({$login}), role " . ETD_ROLES[$role] . ($set ? ', heslo zadal správce.' : ', heslo si nastaví při prvním přihlášení.'));
            } else {
                $old = etd_one('SELECT * FROM users WHERE id = ?', [$id]);
                if ($old === null) {
                    etd_fail('Uživatel neexistuje.', 404);
                }
                $admins = (int)(etd_one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [$id])['n'] ?? 0);
                if ($old['role'] === 'admin' && $old['active'] && ($role !== 'admin' || !$active) && $admins === 0) {
                    etd_fail('Musí zůstat aspoň jeden aktivní správce.', 409);
                }
                if ($id === (int)$admin['id'] && (!$active || $role !== 'admin')) {
                    etd_fail('Sám sobě roli správce ani účet vypnout nemůžeš. Požádej jiného správce.', 409);
                }
                etd_exec('UPDATE users SET login = ?, name = ?, role = ?, depts = ?, active = ?, updated_at = ? WHERE id = ?',
                    [$login, $name, $role, $deptsText, $active ? 1 : 0, $now, $id]);
                $changes = [];
                if ($mode === 'set') {
                    etd_exec('UPDATE users SET pass_hash = ?, must_change = ?, pending_until = NULL WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $mustChange ? 1 : 0, $id]);
                    $changes[] = 'nové heslo od správce';
                } elseif ($mode === 'self') {
                    etd_exec("UPDATE users SET pass_hash = '', must_change = 0, pending_until = ? WHERE id = ?", [$now + ETD_INVITE_DAYS * 86400, $id]);
                    $changes[] = 'heslo si nastaví sám při příštím přihlášení';
                }
                if ($mode !== 'keep' || !$active || $old['role'] !== $role || $old['depts'] !== $deptsText) {
                    // změna hesla, role nebo přístupů platí hned: přihlášení uživatele skončí
                    etd_exec('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [$id, (string)$admin['session_id']]);
                }
                if ($old['role'] !== $role) {
                    $changes[] = 'role ' . ETD_ROLES[$role];
                }
                if ((bool)$old['active'] !== $active) {
                    $changes[] = $active ? 'zapnut' : 'vypnut';
                }
                if ($old['depts'] !== $deptsText) {
                    $changes[] = 'oddělení ' . ($deptsText === '' ? 'všechna' : implode(', ', array_map('etd_dept_name', explode(',', $deptsText))));
                }
                if ($old['name'] !== $name || $old['login'] !== $login) {
                    $changes[] = "jméno {$name} ({$login})";
                }
                etd_log((string)$admin['name'], "Uživatel {$old['name']}: " . ($changes ? implode(', ', $changes) : 'beze změny') . '.');
            }
            return etd_one('SELECT * FROM users WHERE id = ?', [$id]);
        });
        etd_json(['user' => etd_user_public($saved)]);

    case 'apikeys':
        etd_require_admin();
        $rows = etd_all('SELECT * FROM api_keys ORDER BY revoked_at IS NOT NULL, id DESC');
        etd_json(['keys' => array_map(static fn(array $k): array => [
            'id' => (int)$k['id'], 'name' => $k['name'], 'prefix' => $k['prefix'], 'createdBy' => $k['created_by'],
            'createdAt' => etd_iso((int)$k['created_at']), 'lastUsedAt' => etd_iso($k['last_used_at'] === null ? null : (int)$k['last_used_at']),
            'revokedAt' => etd_iso($k['revoked_at'] === null ? null : (int)$k['revoked_at']), 'revokedBy' => $k['revoked_by'],
        ], $rows)]);

    case 'apikey_create':
        $admin = etd_require_admin();
        $name = etd_text(etd_input()['name'] ?? '', 80);
        if ($name === '') {
            etd_fail('Pojmenuj klíč (např. podle systému, který ho bude používat).');
        }
        if ((int)(etd_one('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL')['n'] ?? 0) >= 50) {
            etd_fail('Platných klíčů je už 50. Nepoužívané nejdřív zruš.', 409);
        }
        $created = etd_api_key_new($name, (string)$admin['name']);
        etd_log((string)$admin['name'], "Nový API klíč „{$name}“ (" . substr($created['key'], 0, 12) . '…).');
        etd_json($created + ['name' => $name]);

    case 'apikey_revoke':
        $admin = etd_require_admin();
        $id = (int)(etd_input()['id'] ?? 0);
        $key = etd_one('SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL', [$id]);
        if ($key === null) {
            etd_fail('Klíč neexistuje nebo už je zrušený.', 404);
        }
        etd_exec('UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', [time(), (string)$admin['name'], $id]);
        etd_log((string)$admin['name'], "Zrušen API klíč „{$key['name']}“ ({$key['prefix']}…).");
        etd_json(['ok' => true]);

    case 'adminlog':
        etd_require_admin();
        $rows = etd_all('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100');
        etd_json(['log' => array_map(static fn(array $r): array => ['at' => etd_iso((int)$r['at']), 'by' => $r['by_name'], 'text' => $r['text']], $rows)]);

    default:
        etd_fail('Neznámá akce.', 404);
}
