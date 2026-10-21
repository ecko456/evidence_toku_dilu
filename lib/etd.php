<?php
declare(strict_types=1);

/*
 * Evidence toku dílů: jádro na serveru (PHP 8.1+ a SQLite).
 *
 * Databáze a její aktualizace, přihlášení a relace s vybraným oddělením, záznamy příjmu
 * a exportu průvodek, vyhledávání, stav na pracovištích a API klíče pro IT.
 * Časy jsou v databázi jako unixové sekundy (UTC), ven jdou v pražském čase (ISO 8601).
 */

const ETD_VERSION = '1.2';
/** Verze schématu databáze (PRAGMA user_version). Novou verzi doplň do etd_migrate(). */
const ETD_SCHEMA = 2;
/** Zapisovat smí jen stránka aspoň téhle verze (hlavička X-Etd-Client), viz etd_require_client(). */
const ETD_MIN_CLIENT = 1;
const ETD_SESSION_COOKIE = 'etd_session';
const ETD_SESSION_HOURS = 24;          // nejdéle od přihlášení
const ETD_IDLE_HOURS = 12;             // bez aktivity (směna)
const ETD_MAX_JSON_BYTES = 512 * 1024;
const ETD_MAX_BATCH = 500;             // průvodek v jedné dávce
const ETD_MAX_BARCODE = 200;
const ETD_MAX_POSITION = 60;
const ETD_MAX_QTY = 1000000;
const ETD_DUPLICATE_SECONDS = 600;     // stejný záznam znovu do 10 minut = nejspíš dvojí načtení
const ETD_CANCEL_OWN_SECONDS = 1800;   // vlastní záznam jde stornovat 30 minut
const ETD_MIN_PASSWORD = 8;
const ETD_INVITE_DAYS = 7;            // účet bez hesla: heslo si uživatel nastaví do 7 dní
const ETD_FAIL_WINDOW = 900;
const ETD_FAILS_PER_IP = 30;
const ETD_FAILS_PER_LOGIN = 8;
const ETD_TZ = 'Europe/Prague';

/** Pracoviště v pořadí na úvodní obrazovce. Kód se ukládá do záznamů, název jde jen ven. */
const ETD_DEPTS = [
    'brouseni_wpa' => 'Broušení WPA',
    'brush_wpa' => 'Brush WPA',
    'hala' => 'Hala',
    'montaz' => 'Montáž',
    'elox' => 'Elox',
    'studio' => 'Studio',
    'cnc_hala2' => 'CNC Hala2',
];
/** Visitor jen nahlíží: smí číst, nesmí zapisovat. */
const ETD_VISITOR = 'visitor';
const ETD_ACTIONS = ['prijem' => 'Příjem na pracoviště', 'export' => 'Export z pracoviště'];
const ETD_ROLES = ['operator' => 'Pracovník', 'admin' => 'Správce', 'visitor' => 'Jen nahlížení'];

/* ---------------------------------------------------------------- databáze */

function etd_data_dir(): string
{
    $configured = getenv('ETD_DATA_DIR');
    return $configured !== false && $configured !== ''
        ? rtrim($configured, DIRECTORY_SEPARATOR)
        : dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data';
}

function etd_db_file(): string
{
    return etd_data_dir() . DIRECTORY_SEPARATOR . 'evidence.sqlite3';
}

function etd_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $dir = etd_data_dir();
    if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) {
        throw new RuntimeException('Nelze vytvořit datový adresář.');
    }
    $pdo = new PDO('sqlite:' . etd_db_file());
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    etd_migrate($pdo);
    return $pdo;
}

/**
 * Aktualizace schématu bez ztráty dat: každá verze jen přidává (tabulky, sloupce, indexy).
 * Běží v transakci se zámkem, takže dva souběžné požadavky ji neudělají dvakrát.
 */
function etd_migrate(PDO $pdo): void
{
    if ((int)$pdo->query('PRAGMA user_version')->fetchColumn() >= ETD_SCHEMA) {
        return;
    }
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $version = (int)$pdo->query('PRAGMA user_version')->fetchColumn();
        if ($version < 1) {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    depts TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    must_change INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dept TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- Záznamy se nemažou. Chybný záznam se stornuje (cancelled_at) a do posledního stavu se nepočítá.
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    barcode TEXT NOT NULL,
    action TEXT NOT NULL,
    dept TEXT NOT NULL,
    position TEXT,
    qty INTEGER,
    user_id INTEGER,
    user_name TEXT NOT NULL,
    user_login TEXT NOT NULL,
    batch TEXT,
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    cancelled_by TEXT,
    cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_barcode ON records(barcode COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_records_dept ON records(dept, id);
-- Poslední platný záznam každé průvodky (odvozené z records, jde kdykoli přepočítat).
CREATE TABLE IF NOT EXISTS parts (
    barcode TEXT PRIMARY KEY COLLATE NOCASE,
    last_id INTEGER NOT NULL,
    last_action TEXT NOT NULL,
    last_dept TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_parts_state ON parts(last_dept, last_action, updated_at);
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_ip TEXT,
    revoked_at INTEGER,
    revoked_by TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(kind, subject, created_at);
CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    by_name TEXT NOT NULL,
    text TEXT NOT NULL
);
SQL);
        }
        if ($version < 2) {
            // 1.1: účet bez hesla (pass_hash = ''), heslo si uživatel nastaví při prvním přihlášení
            // do pending_until. Starší účty mají heslo, sloupec u nich zůstane prázdný.
            $columns = array_column($pdo->query('PRAGMA table_info(users)')->fetchAll(PDO::FETCH_ASSOC), 'name');
            if (!in_array('pending_until', $columns, true)) {
                $pdo->exec('ALTER TABLE users ADD COLUMN pending_until INTEGER');
            }
        }
        // Další verze schématu sem: if ($version < 3) { … }
        $pdo->exec('PRAGMA user_version = ' . ETD_SCHEMA);
        $pdo->exec('COMMIT');
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}

/**
 * Celá čísla se vážou jako INTEGER. PDO jinak pošle všechno jako text a SQLite pak
 * ve výrazech (např. `? - created_at`) porovnává číslo s textem.
 */
function etd_run(string $sql, array $params = []): PDOStatement
{
    $statement = etd_db()->prepare($sql);
    $i = 1;
    foreach ($params as $value) {
        $type = is_int($value) ? PDO::PARAM_INT : ($value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $statement->bindValue($i++, is_bool($value) ? (int)$value : $value, is_bool($value) ? PDO::PARAM_INT : $type);
    }
    $statement->execute();
    return $statement;
}

function etd_all(string $sql, array $params = []): array
{
    return etd_run($sql, $params)->fetchAll();
}

function etd_one(string $sql, array $params = []): ?array
{
    $row = etd_run($sql, $params)->fetch();
    return $row === false ? null : $row;
}

function etd_exec(string $sql, array $params = []): int
{
    return etd_run($sql, $params)->rowCount();
}

/** Zápis v transakci se zámkem (BEGIN IMMEDIATE): souběžné zápisy se seřadí za sebe. */
function etd_tx(callable $work): mixed
{
    $pdo = etd_db();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $result = $work();
        $pdo->exec('COMMIT');
        return $result;
    } catch (Throwable $error) {
        $pdo->exec('ROLLBACK');
        throw $error;
    }
}

/* ---------------------------------------------------------------- čas */

function etd_iso(?int $ts): ?string
{
    if ($ts === null) {
        return null;
    }
    return (new DateTimeImmutable('@' . $ts))->setTimezone(new DateTimeZone(ETD_TZ))->format(DATE_ATOM);
}

function etd_iso_utc(?int $ts): ?string
{
    return $ts === null ? null : gmdate('Y-m-d\TH:i:s\Z', $ts);
}

/* ---------------------------------------------------------------- HTTP */

function etd_from_loopback(): bool
{
    return in_array((string)($_SERVER['REMOTE_ADDR'] ?? ''), ['127.0.0.1', '::1'], true);
}

function etd_is_https(): bool
{
    $https = strtolower((string)($_SERVER['HTTPS'] ?? ''));
    if ($https !== '' && $https !== 'off') {
        return true;
    }
    // X-Forwarded-Proto může poslat kdokoli; věří se mu jen od proxy na stejném stroji.
    return etd_from_loopback() && strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

/** Vývoj na vlastním počítači: spojení i adresa musí být místní (hlavička Host sama nestačí). */
function etd_is_local(): bool
{
    $host = strtolower((string)parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST));
    return etd_from_loopback() && in_array($host, ['localhost', '127.0.0.1', '[::1]', '::1'], true);
}

/** Adresa aplikace (/evidence_toku_dilu/ na serveru, / ve vývoji), podle umístění index.php. */
function etd_base_path(): string
{
    $root = str_replace('\\', '/', dirname(__DIR__));
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_FILENAME'] ?? ''));
    $name = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? '/'));
    // api/v1/index.php leží o dvě úrovně níž než kořen aplikace
    if ($script !== '' && str_starts_with($script, $root . '/')) {
        $depth = substr_count(substr($script, strlen($root) + 1), '/');
        for ($i = 0; $i < $depth; $i++) {
            $name = dirname($name);
        }
    }
    return rtrim(str_replace('\\', '/', dirname($name)), '/') . '/';
}

function etd_security_headers(): void
{
    header_remove('X-Powered-By');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Cross-Origin-Resource-Policy: same-origin');
    header('X-Robots-Tag: noindex, nofollow, noarchive');
    header('Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (etd_is_https()) {
        header('Strict-Transport-Security: max-age=31536000');
    }
}

/** Bez HTTPS by heslo i klíč k API šly po síti čitelně. */
function etd_require_https(bool $json = false): void
{
    if (etd_is_https() || etd_is_local()) {
        return;
    }
    $host = (string)($_SERVER['HTTP_HOST'] ?? '');
    if ($json || $host === '' || !preg_match('/^[A-Za-z0-9.:\[\]-]+$/', $host)) {
        etd_json(['error' => 'https_required', 'message' => 'Aplikace běží jen přes HTTPS.'], 403);
    }
    header('Location: https://' . $host . (string)($_SERVER['REQUEST_URI'] ?? '/'), true, 301);
    exit;
}

function etd_json(mixed $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function etd_fail(string $message, int $status = 400, array $extra = []): never
{
    etd_json(['error' => $message] + $extra, $status);
}

/** Při nečekané chybě vrátí JSON s českou hláškou místo prázdné stránky. */
function etd_json_errors(bool $api = false): void
{
    ini_set('display_errors', '0');
    set_exception_handler(static function (Throwable $error) use ($api): void {
        error_log('Evidence toku dílů: ' . $error->getMessage() . ' @ ' . $error->getFile() . ':' . $error->getLine());
        $message = str_contains($error->getMessage(), 'database is locked')
            ? 'Databáze je právě zaneprázdněná. Zkus to prosím znovu.'
            : 'Na serveru nastala chyba. Zkus to prosím znovu.';
        if (!headers_sent()) {
            etd_json($api ? ['error' => 'server_error', 'message' => $message] : ['error' => $message], 500);
        }
    });
}

function etd_input(): array
{
    $raw = file_get_contents('php://input', false, null, 0, ETD_MAX_JSON_BYTES + 1);
    if ($raw === false || $raw === '') {
        return [];
    }
    if (strlen($raw) > ETD_MAX_JSON_BYTES) {
        etd_fail('Požadavek je příliš velký.', 413);
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        etd_fail('Neplatný požadavek.', 400);
    }
    return $decoded;
}

/**
 * API pro stránku volá jen stránka aplikace: vlastní hlavička (cizí web ji bez CORS poslat
 * nemůže) a u zápisů kontrola původu. Cookie relace má navíc SameSite=Strict.
 */
function etd_require_app_request(string $method): void
{
    if (($_SERVER['HTTP_X_ETD'] ?? '') !== '1') {
        etd_fail('Požadavek nepřišel z aplikace.', 403);
    }
    if (in_array($method, ['GET', 'HEAD'], true)) {
        return;
    }
    $site = strtolower((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? ''));
    if ($site !== '') {
        if ($site !== 'same-origin') {
            etd_fail('Požadavek z cizí stránky byl odmítnut.', 403);
        }
        return;
    }
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin === '') {
        return;
    }
    $host = (string)parse_url($origin, PHP_URL_HOST);
    $port = parse_url($origin, PHP_URL_PORT);
    $authority = strtolower($host . ($port !== null ? ':' . $port : ''));
    if ($host === '' || $authority !== strtolower((string)($_SERVER['HTTP_HOST'] ?? ''))) {
        etd_fail('Požadavek z cizí stránky byl odmítnut.', 403);
    }
}

/** Zapisovat smí jen aktuální stránka; stará otevřená stránka by po aktualizaci posílala stará data. */
function etd_require_client(): void
{
    if ((int)($_SERVER['HTTP_X_ETD_CLIENT'] ?? 0) < ETD_MIN_CLIENT) {
        etd_fail('Aplikace byla aktualizována. Obnov stránku (F5); poslední akce se nezapsala.', 426, ['reload' => true]);
    }
}

function etd_client_ip(): string
{
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 64);
}

/* ---------------------------------------------------------------- vstupy */

/** Text bez řídicích znaků, s jednou mezerou mezi slovy, oříznutý na délku. */
function etd_text(mixed $value, int $max): string
{
    if (!is_string($value) && !is_int($value) && !is_float($value)) {
        return '';
    }
    $text = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string)$value) ?? '';
    $text = trim(preg_replace('/\s+/u', ' ', $text) ?? '');
    return mb_substr($text, 0, $max);
}

/**
 * Barcode průvodky tak, jak ho poslala čtečka: bez řídicích znaků a okrajových mezer.
 * Vrací null, když je prázdný nebo delší než ETD_MAX_BARCODE (raději chyba než oříznutí).
 */
function etd_barcode(mixed $value): ?string
{
    if (!is_string($value) && !is_int($value)) {
        return null;
    }
    $code = trim(preg_replace('/[\x00-\x1F\x7F]+/u', '', (string)$value) ?? '');
    if ($code === '' || mb_strlen($code) > ETD_MAX_BARCODE || !mb_check_encoding($code, 'UTF-8')) {
        return null;
    }
    return $code;
}

/** Počet kusů: celé kladné číslo do ETD_MAX_QTY, jinak null. */
function etd_qty(mixed $value): ?int
{
    if (is_int($value)) {
        $n = $value;
    } elseif (is_string($value) && preg_match('/^\s*\d{1,7}\s*$/', $value)) {
        $n = (int)trim($value);
    } elseif (is_float($value) && floor($value) === $value) {
        $n = (int)$value;
    } else {
        return null;
    }
    return $n >= 1 && $n <= ETD_MAX_QTY ? $n : null;
}

function etd_login_name(mixed $value): ?string
{
    $login = strtolower(trim(is_string($value) ? $value : ''));
    return preg_match('/^[a-z0-9][a-z0-9._-]{1,39}$/', $login) ? $login : null;
}

function etd_dept_name(?string $dept): string
{
    return $dept === ETD_VISITOR ? 'Visitor' : (ETD_DEPTS[$dept] ?? (string)$dept);
}

/* ---------------------------------------------------------------- pokusy o přihlášení */

function etd_attempt(string $kind, string $subject): void
{
    etd_exec('INSERT INTO attempts (kind, subject, created_at) VALUES (?, ?, ?)', [$kind, $subject, time()]);
    if (random_int(1, 40) === 1) {
        etd_exec('DELETE FROM attempts WHERE created_at < ?', [time() - 86400]);
    }
}

function etd_attempts(string $kind, string $subject): int
{
    $row = etd_one('SELECT COUNT(*) AS n FROM attempts WHERE kind = ? AND subject = ? AND created_at >= ?', [$kind, $subject, time() - ETD_FAIL_WINDOW]);
    return (int)($row['n'] ?? 0);
}

function etd_throttle_login(string $login): void
{
    if (etd_attempts('ip', etd_client_ip()) >= ETD_FAILS_PER_IP || ($login !== '' && etd_attempts('login', $login) >= ETD_FAILS_PER_LOGIN)) {
        etd_fail('Příliš mnoho neúspěšných pokusů o přihlášení. Zkus to znovu za čtvrt hodiny.', 429);
    }
}

function etd_login_failed(string $login): void
{
    etd_attempt('ip', etd_client_ip());
    if ($login !== '') {
        etd_attempt('login', $login);
    }
}

/* ---------------------------------------------------------------- první spuštění */

function etd_setup_required(): bool
{
    return etd_one('SELECT id FROM users LIMIT 1') === null;
}

function etd_setup_token_path(): string
{
    return etd_data_dir() . DIRECTORY_SEPARATOR . 'setup-token.txt';
}

/** Jednorázový kód pro založení prvního správce. Leží jen na disku serveru. */
function etd_setup_token(): string
{
    $path = etd_setup_token_path();
    if (is_file($path)) {
        $token = trim((string)file_get_contents($path));
        if ($token !== '') {
            return $token;
        }
    }
    etd_db();
    $token = implode('-', str_split(strtoupper(bin2hex(random_bytes(6))), 4));
    $temporary = $path . '.tmp-' . bin2hex(random_bytes(4));
    file_put_contents($temporary, $token . "\n", LOCK_EX);
    @chmod($temporary, 0600);
    rename($temporary, $path);
    return $token;
}

/* ---------------------------------------------------------------- uživatelé */

/** Pracoviště, na která se uživatel smí přihlásit (Visitor smí každý). */
function etd_user_depts(array $user): array
{
    if ($user['role'] === 'visitor') {
        return [];
    }
    if ($user['role'] === 'admin') {
        return array_keys(ETD_DEPTS);
    }
    $chosen = array_values(array_intersect(array_keys(ETD_DEPTS), explode(',', (string)$user['depts'])));
    return $chosen ?: array_keys(ETD_DEPTS);
}

/** Účet bez hesla: heslo si uživatel nastaví sám při prvním přihlášení. */
function etd_user_pending(array $user): bool
{
    return (string)$user['pass_hash'] === '';
}

/** Platí ještě možnost nastavit si heslo (ETD_INVITE_DAYS od založení nebo obnovení)? */
function etd_invite_valid(array $user): bool
{
    return etd_user_pending($user) && (int)($user['pending_until'] ?? 0) >= time();
}

function etd_user_public(array $user): array
{
    return [
        'id' => (int)$user['id'],
        'login' => $user['login'],
        'name' => $user['name'],
        'role' => $user['role'],
        'roleLabel' => ETD_ROLES[$user['role']] ?? $user['role'],
        'depts' => etd_user_depts($user),
        'deptsAll' => $user['role'] !== 'operator' || trim((string)$user['depts']) === '',
        'active' => (bool)$user['active'],
        'mustChange' => (bool)$user['must_change'],
        'pending' => etd_user_pending($user),
        'pendingUntil' => etd_user_pending($user) ? etd_iso((int)($user['pending_until'] ?? 0)) : null,
        'pendingExpired' => etd_user_pending($user) && !etd_invite_valid($user),
        'createdAt' => etd_iso((int)$user['created_at']),
        'lastLoginAt' => etd_iso($user['last_login_at'] === null ? null : (int)$user['last_login_at']),
    ];
}

function etd_password_error(mixed $password): ?string
{
    if (!is_string($password) || mb_strlen($password) < ETD_MIN_PASSWORD) {
        return 'Heslo musí mít aspoň ' . ETD_MIN_PASSWORD . ' znaků.';
    }
    if (strlen($password) > 200) {
        return 'Heslo je příliš dlouhé.';
    }
    return null;
}

function etd_log(string $by, string $text): void
{
    etd_exec('INSERT INTO admin_log (at, by_name, text) VALUES (?, ?, ?)', [time(), $by, mb_substr($text, 0, 300)]);
}

/* ---------------------------------------------------------------- relace */

function etd_set_cookie(string $value, int $expires): void
{
    setcookie(ETD_SESSION_COOKIE, $value, [
        'expires' => $expires,
        'path' => etd_base_path(),
        'secure' => etd_is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function etd_start_session(int $userId): void
{
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $now = time();
    etd_exec('INSERT INTO sessions (id, user_id, dept, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', [
        hash('sha256', $token), $userId, $now, $now, $now + ETD_SESSION_HOURS * 3600, etd_client_ip(),
        substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200),
    ]);
    if (random_int(1, 20) === 1) {
        etd_exec('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?', [$now, $now - ETD_IDLE_HOURS * 3600]);
    }
    etd_exec('UPDATE users SET last_login_at = ? WHERE id = ?', [$now, $userId]);
    etd_set_cookie($token, 0);
    unset($GLOBALS['etd_session']);
    $_COOKIE[ETD_SESSION_COOKIE] = $token;
}

/** Relace spolu s uživatelem, nebo null (žádná, vypršelá, uživatel vypnutý). */
function etd_session(): ?array
{
    if (array_key_exists('etd_session', $GLOBALS)) {
        return $GLOBALS['etd_session'];
    }
    $GLOBALS['etd_session'] = null;
    $token = (string)($_COOKIE[ETD_SESSION_COOKIE] ?? '');
    if ($token === '' || strlen($token) > 100) {
        return null;
    }
    $id = hash('sha256', $token);
    $row = etd_one('SELECT s.id AS session_id, s.dept, s.last_seen_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', [$id]);
    if ($row === null) {
        return null;
    }
    $now = time();
    if (!$row['active'] || (int)$row['expires_at'] < $now || (int)$row['last_seen_at'] < $now - ETD_IDLE_HOURS * 3600) {
        etd_exec('DELETE FROM sessions WHERE id = ?', [$id]);
        return null;
    }
    if ((int)$row['last_seen_at'] < $now - 60) {
        etd_exec('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [$now, $id]);
    }
    // oddělení, které správce uživateli mezitím odebral, neplatí
    if ($row['dept'] !== null && $row['dept'] !== ETD_VISITOR && !in_array($row['dept'], etd_user_depts($row), true)) {
        $row['dept'] = null;
    }
    return $GLOBALS['etd_session'] = $row;
}

function etd_require_session(): array
{
    $session = etd_session();
    if ($session === null) {
        etd_fail('Přihlášení vypršelo. Přihlas se znovu.', 401, ['login' => true]);
    }
    return $session;
}

function etd_require_admin(): array
{
    $session = etd_require_session();
    if ($session['role'] !== 'admin') {
        etd_fail('Tohle smí jen správce.', 403);
    }
    return $session;
}

/** Zapisovat smí přihlášený na pracovišti (ne Visitor) a s uživatelem, který není jen nahlížení. */
function etd_require_writer(): array
{
    $session = etd_require_session();
    if ($session['must_change']) {
        etd_fail('Nejdřív si nastav vlastní heslo.', 403, ['mustChange' => true]);
    }
    if ($session['dept'] === null) {
        etd_fail('Nejdřív vyber oddělení, na kterém pracuješ.', 403, ['pickDept' => true]);
    }
    if ($session['dept'] === ETD_VISITOR || $session['role'] === 'visitor') {
        etd_fail('Visitor do systému jen nahlíží, zapisovat nemůže.', 403);
    }
    return $session;
}

function etd_end_session(): void
{
    $session = etd_session();
    if ($session !== null) {
        etd_exec('DELETE FROM sessions WHERE id = ?', [$session['session_id']]);
    }
    etd_set_cookie('', time() - 3600);
    $GLOBALS['etd_session'] = null;
}

/* ---------------------------------------------------------------- záznamy */

/** Záznam pro stránku i pro API (stejný tvar, viz API.md). */
function etd_record_public(array $r): array
{
    $ts = (int)$r['created_at'];
    $out = [
        'id' => (int)$r['id'],
        'barcode' => $r['barcode'],
        'action' => $r['action'],
        'action_label' => ETD_ACTIONS[$r['action']] ?? $r['action'],
        'department' => $r['dept'],
        'department_label' => etd_dept_name($r['dept']),
        'position' => $r['position'] === null || $r['position'] === '' ? null : $r['position'],
        'quantity' => $r['qty'] === null ? null : (int)$r['qty'],
        'user' => $r['user_name'],
        'user_login' => $r['user_login'],
        'recorded_at' => etd_iso($ts),
        'recorded_at_utc' => etd_iso_utc($ts),
        'recorded_at_unix' => $ts,
    ];
    if ($r['cancelled_at'] !== null) {
        $out['cancelled'] = [
            'at' => etd_iso((int)$r['cancelled_at']),
            'by' => $r['cancelled_by'],
            'reason' => $r['cancel_reason'],
        ];
    }
    return $out;
}

/** Poslední platný (nestornovaný) záznam průvodky, nebo null. Velikost písmen nehraje roli. */
function etd_last(string $barcode): ?array
{
    return etd_one('SELECT r.* FROM parts p JOIN records r ON r.id = p.last_id WHERE p.barcode = ?', [$barcode]);
}

/** Přepočítá poslední stav průvodky (po stornu). */
function etd_refresh_part(string $barcode): void
{
    $last = etd_one('SELECT * FROM records WHERE barcode = ? COLLATE NOCASE AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1', [$barcode]);
    if ($last === null) {
        etd_exec('DELETE FROM parts WHERE barcode = ?', [$barcode]);
        return;
    }
    etd_exec('INSERT INTO parts (barcode, last_id, last_action, last_dept, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(barcode) DO UPDATE SET last_id = excluded.last_id, last_action = excluded.last_action, last_dept = excluded.last_dept, updated_at = excluded.updated_at',
        [$last['barcode'], (int)$last['id'], $last['action'], $last['dept'], (int)$last['created_at']]);
}

/** Celá tabulka parts znovu z records (pro jistotu po obnově zálohy: bin/rebuild-parts.php). */
function etd_rebuild_parts(): int
{
    return etd_tx(static function (): int {
        etd_exec('DELETE FROM parts');
        etd_exec('INSERT INTO parts (barcode, last_id, last_action, last_dept, updated_at)
            SELECT r.barcode, r.id, r.action, r.dept, r.created_at FROM records r
            JOIN (SELECT MAX(id) AS id FROM records WHERE cancelled_at IS NULL GROUP BY barcode COLLATE NOCASE) m ON m.id = r.id');
        return (int)(etd_one('SELECT COUNT(*) AS n FROM parts')['n'] ?? 0);
    });
}

/**
 * Zápis příjmu nebo exportu: jedna průvodka i celá dávka (vícenásobný příjem) najednou.
 *
 * @param array $items [['barcode' => …, 'qty' => …], …]
 * @return array výsledek pro každou položku ve stejném pořadí:
 *   status 'ok' (id, record, previous), 'duplicate' (last), 'repeat' (dvakrát v dávce), 'error' (message)
 */
function etd_scan(array $session, string $action, array $items, string $position, bool $force): array
{
    $dept = (string)$session['dept'];
    $batch = count($items) > 1 ? bin2hex(random_bytes(6)) : null;
    return etd_tx(static function () use ($session, $action, $items, $position, $force, $dept, $batch): array {
        $now = time();
        $seen = [];
        $results = [];
        foreach ($items as $item) {
            $raw = is_array($item) ? ($item['barcode'] ?? null) : null;
            $code = etd_barcode($raw);
            if ($code === null) {
                $results[] = ['barcode' => is_string($raw) ? mb_substr($raw, 0, 80) : '', 'status' => 'error',
                    'message' => is_string($raw) && trim($raw) !== '' ? 'Barcode je delší než ' . ETD_MAX_BARCODE . ' znaků.' : 'Prázdný barcode.'];
                continue;
            }
            $key = mb_strtolower($code);
            if (isset($seen[$key])) {
                $results[] = ['barcode' => $code, 'status' => 'repeat', 'message' => 'V dávce je dvakrát, zapsal se jednou.'];
                continue;
            }
            $seen[$key] = true;
            $qty = null;
            if ($action === 'export') {
                $qty = etd_qty($item['qty'] ?? null);
                if ($qty === null) {
                    $results[] = ['barcode' => $code, 'status' => 'error', 'message' => 'Zadej počet kusů (celé číslo od 1 do ' . number_format(ETD_MAX_QTY, 0, ',', ' ') . ').'];
                    continue;
                }
            }
            $last = etd_last($code);
            if (!$force && $last !== null && $last['action'] === $action && $last['dept'] === $dept
                && (int)$last['created_at'] >= $now - ETD_DUPLICATE_SECONDS) {
                $results[] = ['barcode' => $code, 'status' => 'duplicate', 'last' => etd_record_public($last),
                    'message' => 'Stejný záznam už je zapsaný před chvílí.'];
                continue;
            }
            etd_exec('INSERT INTO records (barcode, action, dept, position, qty, user_id, user_name, user_login, batch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
                $code, $action, $dept, $action === 'prijem' && $position !== '' ? $position : null, $qty,
                (int)$session['id'], (string)$session['name'], (string)$session['login'], $batch, $now,
            ]);
            $id = (int)etd_db()->lastInsertId();
            etd_exec('INSERT INTO parts (barcode, last_id, last_action, last_dept, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(barcode) DO UPDATE SET last_id = excluded.last_id, last_action = excluded.last_action, last_dept = excluded.last_dept, updated_at = excluded.updated_at',
                [$code, $id, $action, $dept, $now]);
            $record = etd_one('SELECT * FROM records WHERE id = ?', [$id]);
            $results[] = ['barcode' => $code, 'status' => 'ok', 'id' => $id, 'record' => etd_record_public($record),
                'previous' => $last === null ? null : etd_record_public($last)];
        }
        return $results;
    });
}

/** Smí uživatel záznam stornovat? Správce vždy, autor do 30 minut a jen z pracoviště záznamu. */
function etd_can_cancel(array $session, array $record): bool
{
    if ($record['cancelled_at'] !== null) {
        return false;
    }
    if ($session['role'] === 'admin') {
        return true;
    }
    return $session['role'] === 'operator' && (int)$record['user_id'] === (int)$session['id']
        && $session['dept'] === $record['dept'] && (int)$record['created_at'] >= time() - ETD_CANCEL_OWN_SECONDS;
}

/** Seznam záznamů pro stránku: k záznamu přidá, jestli ho přihlášený smí stornovat. */
function etd_records_for(array $session, array $rows): array
{
    return array_map(static fn(array $r): array => etd_record_public($r) + ['canCancel' => etd_can_cancel($session, $r)], $rows);
}

/** LIKE vzor pro „obsahuje“ (s escapováním % a _). */
function etd_like(string $text): string
{
    return '%' . strtr($text, ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']) . '%';
}

/* ---------------------------------------------------------------- API klíče */

function etd_api_key_new(string $name, string $by): array
{
    $key = 'etd_' . bin2hex(random_bytes(20));
    etd_exec('INSERT INTO api_keys (name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [
        $name, substr($key, 0, 12), hash('sha256', $key), $by, time(),
    ]);
    return ['id' => (int)etd_db()->lastInsertId(), 'key' => $key];
}

/** Klíč z hlavičky Authorization: Bearer … nebo X-Api-Key. */
function etd_api_key_from_request(): string
{
    $header = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if ($header === '' && function_exists('getallheaders')) {
        foreach ((array)getallheaders() as $name => $value) {
            if (strcasecmp((string)$name, 'Authorization') === 0) {
                $header = (string)$value;
            }
        }
    }
    if (preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $header, $m)) {
        return $m[1];
    }
    return trim((string)($_SERVER['HTTP_X_API_KEY'] ?? ''));
}

function etd_api_key_check(string $key): ?array
{
    if (!preg_match('/^etd_[0-9a-f]{40}$/', $key)) {
        return null;
    }
    $row = etd_one('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [hash('sha256', $key)]);
    if ($row !== null && ((int)$row['last_used_at'] < time() - 60 || $row['last_ip'] !== etd_client_ip())) {
        etd_exec('UPDATE api_keys SET last_used_at = ?, last_ip = ? WHERE id = ?', [time(), etd_client_ip(), (int)$row['id']]);
    }
    return $row;
}
