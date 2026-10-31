<?php
declare(strict_types=1);

/*
 * Živé propojení s Google tabulkou (od verze 1.3).
 *
 * Tabulka přes API (POST api/v1/watch, s API klíčem) pošle seznam barcodů, které sleduje,
 * adresu své webové aplikace (Apps Script, …/exec) a tajný kód. Když pak někdo sledovanou
 * průvodku přijme, exportuje nebo stornuje, barcode se zařadí do fronty (hook_queue) a úloha
 * bin/hook-worker.php (cron, každou minutu; uvnitř kontroluje frontu každou sekundu) pošle
 * tabulce aktuální poslední záznam. Fronta drží jen „co poslat“, obsah se bere až při odeslání,
 * takže se posílá vždy nejnovější stav a opakované změny téže průvodky se slijí do jedné.
 *
 * Zpráva je podepsaná HMAC-SHA256 tajným kódem tabulky; tabulka bez platného podpisu nic
 * nezapíše. Adresa smí vést jen na script.google.com (server nebude posílat data jinam).
 */

const ETD_MAX_WATCH = 10000;          // barcodů v jedné tabulce
const ETD_HOOK_BATCH = 200;           // průvodek v jedné zprávě
const ETD_HOOK_TIMEOUT = 20;          // sekund na odpověď Googlu
const ETD_HOOK_MAX_RESPONSE = 1048576;
const ETD_HOOK_RETRY_MAX = 900;       // nejdelší pauza mezi pokusy, když tabulka neodpovídá
const ETD_WORKER_SECONDS = 55;        // jeden běh úlohy z cronu (cron ji pouští každou minutu)

/** Adresa webové aplikace Apps Script (i firemní …/a/macros/<doména>/s/…/exec). */
function etd_hook_url_valid(string $url): bool
{
    if (preg_match('#^https://script\.google\.com/(?:a/macros/[A-Za-z0-9.-]{1,100}/|macros/)s/[A-Za-z0-9_-]{20,200}/exec$#', $url)) {
        return true;
    }
    // jen pro automatické testy (náhradní „Google“ na tomhle stroji); na serveru se nenastavuje
    return getenv('ETD_HOOK_TEST') === '1' && (bool)preg_match('#^http://127\.0\.0\.1:\d{2,5}/[A-Za-z0-9/_-]*$#', $url);
}

/** Kam smí vést přesměrování odpovědi Apps Scriptu (výsledek se čte z googleusercontent.com). */
function etd_hook_redirect_valid(string $url): bool
{
    if (preg_match('#^https://(?:script\.googleusercontent\.com|script\.google\.com)/#', $url)) {
        return true;
    }
    return getenv('ETD_HOOK_TEST') === '1' && str_starts_with($url, 'http://127.0.0.1:');
}

/** Malé úložiště stavu (např. kdy naposledy běžela úloha odesílání). */
function etd_meta_get(string $key): ?string
{
    $row = etd_one('SELECT value FROM meta WHERE key = ?', [$key]);
    return $row === null ? null : (string)$row['value'];
}

function etd_meta_set(string $key, string $value): void
{
    etd_exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [$key, $value]);
}

/** Datum a čas pro lidi: 21. 10. 2026 14:05 (pražský čas). */
function etd_human_time(int $ts): string
{
    return (new DateTimeImmutable('@' . $ts))->setTimezone(new DateTimeZone(ETD_TZ))->format('j. n. Y H:i');
}

/** Poslední záznam jako jeden řádek textu do buňky tabulky. */
function etd_record_text(array $r): string
{
    $parts = [ETD_ACTIONS[$r['action']] ?? $r['action'], etd_dept_name($r['dept'])];
    if ($r['position'] !== null && $r['position'] !== '') {
        $parts[] = 'pozice ' . $r['position'];
    }
    if ($r['qty'] !== null) {
        $parts[] = number_format((int)$r['qty'], 0, ',', ' ') . ' ks';
    }
    $parts[] = etd_human_time((int)$r['created_at']);
    $parts[] = $r['user_name'];
    return implode(' · ', $parts);
}

/** Stav jedné průvodky pro tabulku: poslední záznam, nebo found = false. */
function etd_hook_item(string $barcode): array
{
    $last = etd_last($barcode);
    return [
        'barcode' => $barcode,
        'found' => $last !== null,
        'text' => $last === null ? '' : etd_record_text($last),
        'record' => $last === null ? null : etd_record_public($last),
    ];
}

/**
 * Průvodka se změnila (příjem, export, storno): zařadí ji do fronty všech tabulek, které ji sledují.
 * Volá se uvnitř transakce zápisu; je to jeden dotaz přes index, skenování nezdrží.
 */
function etd_hook_touch(string $barcode): void
{
    etd_exec('INSERT INTO hook_queue (hook_id, barcode, ver, queued_at)
        SELECT w.hook_id, w.barcode, 1, ? FROM hook_watch w JOIN hooks h ON h.id = w.hook_id WHERE w.barcode = ? AND h.active = 1
        ON CONFLICT(hook_id, barcode) DO UPDATE SET ver = ver + 1, queued_at = excluded.queued_at', [time(), $barcode]);
}

/** Celý seznam tabulky znovu do fronty (tlačítko Poslat znovu ve Správě). */
function etd_hook_requeue_all(int $hookId): int
{
    return etd_tx(static function () use ($hookId): int {
        etd_exec('UPDATE hooks SET retry_at = NULL, fails = 0 WHERE id = ?', [$hookId]);
        return etd_exec('INSERT INTO hook_queue (hook_id, barcode, ver, queued_at) SELECT hook_id, barcode, 1, ? FROM hook_watch WHERE hook_id = ?
            ON CONFLICT(hook_id, barcode) DO UPDATE SET ver = ver + 1, queued_at = excluded.queued_at', [time(), $hookId]);
    });
}

/**
 * Seznam sledovaných barcodů z tabulky (API watch). Nahradí předchozí seznam téhle tabulky.
 *
 * @return array ['hook' => řádek hooks, 'watching' => počet, 'skipped' => neplatné, 'created' => nové propojení?]
 */
function etd_hook_register(array $key, string $url, string $secret, array $barcodes): array
{
    $codes = [];
    $skipped = 0;
    foreach ($barcodes as $raw) {
        $code = etd_barcode($raw);
        if ($code === null) {
            $skipped += is_string($raw) && trim($raw) === '' ? 0 : 1;
            continue;
        }
        $codes[mb_strtolower($code)] ??= $code;
    }
    return etd_tx(static function () use ($key, $url, $secret, $codes, $skipped): array {
        $now = time();
        $hook = etd_one('SELECT * FROM hooks WHERE api_key_id = ?', [(int)$key['id']]);
        $created = $hook === null;
        $changed = $created || $hook['url'] !== $url || !$hook['active'];
        if ($created) {
            etd_exec('INSERT INTO hooks (api_key_id, url, secret, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
                [(int)$key['id'], $url, $secret, $now, $now]);
            $hookId = (int)etd_db()->lastInsertId();
        } else {
            $hookId = (int)$hook['id'];
            // nová adresa nebo kód = tabulka se znovu zapnula: starý odpočet chyb neplatí
            etd_exec('UPDATE hooks SET url = ?, secret = ?, active = 1, updated_at = ?, retry_at = CASE WHEN ? THEN NULL ELSE retry_at END,
                fails = CASE WHEN ? THEN 0 ELSE fails END WHERE id = ?',
                [$url, $secret, $now, (int)$changed, (int)$changed, $hookId]);
        }
        etd_exec('DELETE FROM hook_watch WHERE hook_id = ?', [$hookId]);
        $insert = etd_db()->prepare('INSERT INTO hook_watch (hook_id, barcode) VALUES (?, ?)');
        foreach ($codes as $code) {
            $insert->bindValue(1, $hookId, PDO::PARAM_INT);
            $insert->bindValue(2, $code, PDO::PARAM_STR);
            $insert->execute();
        }
        // ve frontě zůstane jen to, co tabulka pořád sleduje
        etd_exec('DELETE FROM hook_queue WHERE hook_id = ? AND barcode NOT IN (SELECT barcode FROM hook_watch WHERE hook_id = ?)', [$hookId, $hookId]);
        etd_exec('UPDATE hooks SET watch_count = ? WHERE id = ?', [count($codes), $hookId]);
        if ($changed) {
            etd_log('API: ' . $key['name'], ($created ? 'Zapnuto' : 'Obnoveno') . " živé propojení s Google tabulkou (klíč „{$key['name']}“), sleduje " . count($codes) . ' průvodek.');
        }
        return ['hook' => etd_one('SELECT * FROM hooks WHERE id = ?', [$hookId]), 'watching' => count($codes), 'skipped' => $skipped,
            'codes' => array_values($codes), 'created' => $created];
    });
}

function etd_hook_unregister(array $key, string $by): bool
{
    $hook = etd_one('SELECT * FROM hooks WHERE api_key_id = ?', [(int)$key['id']]);
    if ($hook === null) {
        return false;
    }
    etd_exec('DELETE FROM hooks WHERE id = ?', [(int)$hook['id']]);
    etd_log($by, "Vypnuto živé propojení s Google tabulkou (klíč „{$key['name']}“).");
    return true;
}

/* ---------------------------------------------------------------- odeslání */

/**
 * HTTP požadavek bez závislostí (PHP streamy). Přesměrování se nenásleduje automaticky.
 *
 * @return array ['status' => int (0 = nespojilo se), 'body' => string, 'location' => ?string, 'error' => ?string]
 */
function etd_http(string $method, string $url, ?string $body = null): array
{
    $headers = ['User-Agent: EvidenceTokuDilu/' . ETD_VERSION, 'Accept: application/json'];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    $context = stream_context_create([
        'http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $body ?? '', 'timeout' => ETD_HOOK_TIMEOUT,
            'ignore_errors' => true, 'follow_location' => 0, 'max_redirects' => 0, 'protocol_version' => 1.1],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $previous = ini_set('default_socket_timeout', (string)ETD_HOOK_TIMEOUT);
    $error = null;
    set_error_handler(static function (int $no, string $message) use (&$error): bool {
        $error = $message;
        return true;
    });
    try {
        $response = @file_get_contents($url, false, $context, 0, ETD_HOOK_MAX_RESPONSE);
        $responseHeaders = $http_response_header ?? [];
    } finally {
        restore_error_handler();
        if ($previous !== false) {
            ini_set('default_socket_timeout', $previous);
        }
    }
    $status = 0;
    $location = null;
    foreach ($responseHeaders as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
            $status = (int)$m[1];
            $location = null;
        } elseif (preg_match('/^Location:\s*(\S+)/i', $line, $m)) {
            $location = $m[1];
        }
    }
    if ($location !== null && str_starts_with($location, '/')) {
        $parts = parse_url($url);
        $location = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '') . $location;
    }
    return ['status' => $status, 'body' => $response === false ? '' : $response, 'location' => $location,
        'error' => $status === 0 ? etd_net_error((string)$error) : null];
}

/** Chyba spojení z PHP do češtiny (bez adresy, ta je ve Správě vidět zvlášť). */
function etd_net_error(string $message): string
{
    $m = strtolower($message);
    return match (true) {
        str_contains($m, 'refused') => 'spojení odmítnuto',
        str_contains($m, 'timed out') || str_contains($m, 'timeout') => 'vypršel čas na odpověď (' . ETD_HOOK_TIMEOUT . ' s)',
        str_contains($m, 'getaddrinfo') || str_contains($m, 'name or service') || str_contains($m, 'network_getaddresses') => 'adresu se nepodařilo najít (DNS), server asi nemá přístup do internetu',
        str_contains($m, 'ssl') || str_contains($m, 'certificate') || str_contains($m, 'crypto') => 'chyba zabezpečeného spojení (certifikát)',
        str_contains($m, 'unreachable') => 'síť je nedostupná (firewall?)',
        $message === '' => 'bez odpovědi',
        default => mb_substr((string)preg_replace('/^.*\):\s*(failed to open stream:\s*)?/i', '', $message), 0, 120),
    };
}

/** Text z chybové HTML stránky Googlu (bez značek), nebo ''. */
function etd_html_text(string $html): string
{
    if (preg_match('#<div[^>]*>([^<]{3,})</div>#u', $html, $m) || preg_match('#<title>([^<]+)</title>#iu', $html, $m)) {
        return mb_substr(trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8')), 0, 160);
    }
    return '';
}

/**
 * Pošle tabulce podepsanou zprávu a vrátí ['ok' => bool, 'error' => ?string, 'reply' => ?array].
 * Apps Script na POST odpoví přesměrováním na výsledek (GET), proto dva kroky.
 */
function etd_hook_send(array $hook, string $type, array $items = []): array
{
    $data = json_encode(['type' => $type, 'hook' => (int)$hook['id'], 'sent_at' => time(), 'app' => 'Evidence toku dílů ' . ETD_VERSION, 'items' => $items],
        JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);   // bez UNESCAPED_UNICODE: podpis je nad čistým ASCII
    $body = json_encode(['etd' => 1, 'data' => $data, 'sig' => hash_hmac('sha256', $data, (string)$hook['secret'])], JSON_UNESCAPED_SLASHES);
    $res = etd_http('POST', (string)$hook['url'], $body);
    for ($i = 0; $i < 3 && in_array($res['status'], [301, 302, 303, 307, 308], true); $i++) {
        if ($res['location'] === null || !etd_hook_redirect_valid($res['location'])) {
            return ['ok' => false, 'error' => 'Google přesměroval na neočekávanou adresu (' . mb_substr((string)$res['location'], 0, 80) . ').', 'reply' => null];
        }
        $res = etd_http('GET', $res['location']);
    }
    if ($res['status'] === 0) {
        return ['ok' => false, 'error' => 'Server se s Googlem nespojil: ' . mb_substr((string)$res['error'], 0, 160), 'reply' => null];
    }
    $reply = json_decode($res['body'], true);
    if (is_array($reply) && ($reply['ok'] ?? false) === true) {
        return ['ok' => true, 'error' => null, 'reply' => $reply];
    }
    if (is_array($reply)) {
        $why = (string)($reply['error'] ?? '');
        $text = match ($why) {
            'signature' => 'Tabulka odmítla podpis (nesedí tajný kód). V tabulce dej znovu Evidence → Zapnout živé propojení.',
            'expired' => 'Tabulka odmítla zprávu jako starou: nesedí čas na serveru nebo v Googlu.',
            default => 'Tabulka hlásí chybu: ' . mb_substr($why !== '' ? $why : (string)($reply['message'] ?? 'neznámá'), 0, 160),
        };
        return ['ok' => false, 'error' => $text, 'reply' => $reply];
    }
    $html = $res['body'];
    if ($res['status'] === 401 || $res['status'] === 403 || str_contains($html, 'accounts.google.com') || str_contains($html, 'ServiceLogin')) {
        return ['ok' => false, 'error' => 'Google chce přihlášení. Webovou aplikaci tabulky nasaď s přístupem „Kdokoli“ (Nasadit → Spravovat nasazení).', 'reply' => null];
    }
    if ($res['status'] === 404) {
        return ['ok' => false, 'error' => 'Webová aplikace na téhle adrese neexistuje (smazané nasazení?). V tabulce dej znovu Zapnout živé propojení.', 'reply' => null];
    }
    $detail = etd_html_text($html);
    return ['ok' => false, 'error' => 'Tabulka neodpověděla správně (HTTP ' . $res['status'] . ')' . ($detail !== '' ? ': ' . $detail : '.'), 'reply' => null];
}

/** Pauza před dalším pokusem: 10 s, 20 s, 40 s … nejvýš 15 minut. */
function etd_hook_backoff(int $fails): int
{
    return min(ETD_HOOK_RETRY_MAX, 10 * (2 ** min(10, max(0, $fails - 1))));
}

/**
 * Jeden průchod frontou: každé tabulce pošle nejvýš ETD_HOOK_BATCH průvodek.
 * Vrací počet odeslaných průvodek (0 = nebylo co poslat).
 */
function etd_hooks_deliver(): int
{
    $now = time();
    $hooks = etd_all('SELECT h.* FROM hooks h JOIN api_keys k ON k.id = h.api_key_id AND k.revoked_at IS NULL
        WHERE h.active = 1 AND (h.retry_at IS NULL OR h.retry_at <= ?) AND EXISTS (SELECT 1 FROM hook_queue q WHERE q.hook_id = h.id)', [$now]);
    $sent = 0;
    foreach ($hooks as $hook) {
        $hookId = (int)$hook['id'];
        $rows = etd_all('SELECT barcode, ver FROM hook_queue WHERE hook_id = ? ORDER BY queued_at, barcode LIMIT ?', [$hookId, ETD_HOOK_BATCH]);
        if ($rows === []) {
            continue;
        }
        $items = array_map(static fn(array $r): array => etd_hook_item((string)$r['barcode']), $rows);
        $result = etd_hook_send($hook, 'update', $items);
        $done = time();
        etd_tx(static function () use ($result, $rows, $hookId, $hook, $done): void {
            if ($result['ok']) {
                foreach ($rows as $r) {
                    // změnila se mezitím znovu (vyšší ver)? pak zůstane ve frontě a pošle se příště
                    etd_exec('DELETE FROM hook_queue WHERE hook_id = ? AND barcode = ? AND ver = ?', [$hookId, (string)$r['barcode'], (int)$r['ver']]);
                }
                etd_exec('UPDATE hooks SET last_ok_at = ?, fails = 0, retry_at = NULL, sent_count = sent_count + ? WHERE id = ?', [$done, count($rows), $hookId]);
            } else {
                $fails = (int)$hook['fails'] + 1;
                etd_exec('UPDATE hooks SET last_error = ?, last_error_at = ?, fails = ?, retry_at = ? WHERE id = ?',
                    [mb_substr((string)$result['error'], 0, 300), $done, $fails, $done + etd_hook_backoff($fails), $hookId]);
            }
        });
        $sent += $result['ok'] ? count($rows) : 0;
    }
    return $sent;
}

/** Zkušební zpráva (ping) a zápis výsledku k propojení. */
function etd_hook_ping(array $hook): array
{
    $result = etd_hook_send($hook, 'ping');
    $now = time();
    if ($result['ok']) {
        etd_exec('UPDATE hooks SET last_ok_at = ?, fails = 0, retry_at = NULL WHERE id = ?', [$now, (int)$hook['id']]);
    } else {
        etd_exec('UPDATE hooks SET last_error = ?, last_error_at = ?, fails = fails + 1 WHERE id = ?', [mb_substr((string)$result['error'], 0, 300), $now, (int)$hook['id']]);
    }
    return $result;
}

/** Běží úloha odesílání? (cron ji spouští každou minutu, při startu zapíše čas) */
function etd_worker_seen(): ?int
{
    $seen = etd_meta_get('worker_seen_at');
    return $seen === null ? null : (int)$seen;
}

/** Stav propojení pro Správu a pro API (GET watch). */
function etd_hook_public(array $hook, bool $admin = false): array
{
    $queued = (int)(etd_one('SELECT COUNT(*) AS n FROM hook_queue WHERE hook_id = ?', [(int)$hook['id']])['n'] ?? 0);
    $lastOk = $hook['last_ok_at'] === null ? null : (int)$hook['last_ok_at'];
    $lastErr = $hook['last_error_at'] === null ? null : (int)$hook['last_error_at'];
    $failing = (int)$hook['fails'] > 0;   // úspěšné doručení počítadlo nuluje
    $out = [
        'active' => (bool)$hook['active'],
        'status' => !$hook['active'] ? 'off' : ($failing ? 'error' : ($lastOk === null ? 'waiting' : 'ok')),
        'watching' => (int)$hook['watch_count'],
        'queued' => $queued,
        'sent' => (int)$hook['sent_count'],
        'lastOkAt' => etd_iso($lastOk),
        'lastError' => $failing ? $hook['last_error'] : null,
        'lastErrorAt' => $failing ? etd_iso($lastErr) : null,
        'retryAt' => $hook['retry_at'] === null ? null : etd_iso((int)$hook['retry_at']),
        'createdAt' => etd_iso((int)$hook['created_at']),
        'updatedAt' => etd_iso((int)$hook['updated_at']),
    ];
    if ($admin) {
        $out['id'] = (int)$hook['id'];
        $out['url'] = preg_replace('#/s/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+([A-Za-z0-9_-]{4})/exec$#', '/s/$1…$2/exec', (string)$hook['url']);
    }
    return $out;
}
