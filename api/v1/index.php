<?php
declare(strict_types=1);

/*
 * API pro IT (jen čtení), verze 1. Popis pro IT je v API.md a v aplikaci (Správa → API pro IT).
 *
 *   GET  api/v1/last?barcode=…        poslední platný záznam průvodky
 *   POST api/v1/last                  {"barcodes": […]} poslední záznamy více průvodek najednou
 *   GET  api/v1/history?barcode=…     všechny platné záznamy průvodky od nejnovějšího
 *   GET  api/v1/ping                  ověření klíče
 *
 * Klíč: hlavička Authorization: Bearer etd_… (nebo X-Api-Key). Klíče zakládá správce v aplikaci.
 * Na Apachi sem cesty api/v1/<endpoint> posílá FallbackResource (deploy/apache-evidence_toku_dilu.conf),
 * ve vývoji router.php. Bez přepisu cest jde i api/v1/index.php?endpoint=last&barcode=….
 */

require dirname(__DIR__, 2) . '/lib/etd.php';

const ETD_API_FAILS = 60;

function etd_api_error(string $code, string $message, int $status, array $extra = []): never
{
    etd_json(['error' => $code, 'message' => $message] + $extra, $status);
}

etd_json_errors(true);
header_remove('X-Powered-By');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('X-Robots-Tag: noindex, nofollow');
etd_require_https(true);

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$path = (string)(parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH) ?? '');
$endpoint = preg_match('#/api/v1/([a-z]+)/?$#', $path, $m) ? $m[1] : (string)($_GET['endpoint'] ?? '');

if (etd_attempts('api', etd_client_ip()) >= ETD_API_FAILS) {
    etd_api_error('too_many_attempts', 'Příliš mnoho požadavků s neplatným klíčem. Zkus to znovu za čtvrt hodiny.', 429);
}
$key = etd_api_key_check(etd_api_key_from_request());
if ($key === null) {
    etd_attempt('api', etd_client_ip());
    header('WWW-Authenticate: Bearer realm="evidence_toku_dilu"');
    etd_api_error('unauthorized', 'Chybí platný API klíč (hlavička Authorization: Bearer etd_…). Klíč založí správce v aplikaci: Správa → API klíče.', 401);
}

/** Barcode z parametru, jinak chyba 400. */
function etd_api_barcode(mixed $value): string
{
    $code = etd_barcode($value);
    if ($code === null) {
        etd_api_error('bad_request', 'Chybí parametr barcode (1 až ' . ETD_MAX_BARCODE . ' znaků).', 400);
    }
    return $code;
}

switch ($endpoint) {
    case '':
        etd_json(['name' => 'Evidence toku dílů', 'api' => 'v1', 'version' => ETD_VERSION, 'endpoints' => [
            'GET last?barcode=…' => 'poslední platný záznam průvodky',
            'POST last {"barcodes":[…]}' => 'poslední záznamy až ' . ETD_MAX_BATCH . ' průvodek najednou',
            'GET history?barcode=…&limit=…' => 'platné záznamy průvodky od nejnovějšího',
            'GET ping' => 'ověření klíče',
        ]]);

    case 'ping':
        etd_json(['ok' => true, 'key' => $key['name'], 'version' => ETD_VERSION, 'time' => etd_iso(time())]);

    case 'last':
        if ($method === 'POST') {
            $input = etd_input();
            $codes = $input['barcodes'] ?? null;
            if (!is_array($codes) || !array_is_list($codes) || $codes === [] || count($codes) > ETD_MAX_BATCH) {
                etd_api_error('bad_request', 'Pošli JSON {"barcodes": ["…", …]} s 1 až ' . ETD_MAX_BATCH . ' průvodkami.', 400);
            }
            $results = [];
            foreach ($codes as $raw) {
                $code = etd_barcode($raw);
                $last = $code === null ? null : etd_last($code);
                $results[] = ['barcode' => $code ?? (is_string($raw) ? mb_substr($raw, 0, 80) : ''), 'found' => $last !== null,
                    'record' => $last === null ? null : etd_record_public($last)];
            }
            etd_json(['count' => count($results), 'found' => count(array_filter($results, static fn(array $r): bool => $r['found'])), 'results' => $results]);
        }
        if ($method !== 'GET' && $method !== 'HEAD') {
            etd_api_error('method_not_allowed', 'Použij GET (jedna průvodka) nebo POST (více průvodek).', 405);
        }
        $code = etd_api_barcode($_GET['barcode'] ?? null);
        $last = etd_last($code);
        if ($last === null) {
            etd_api_error('not_found', 'Průvodka s tímto barcodem v evidenci není (nebo má všechny záznamy stornované).', 404, ['barcode' => $code, 'found' => false]);
        }
        etd_json(['barcode' => $last['barcode'], 'found' => true, 'record' => etd_record_public($last)]);

    case 'history':
        if ($method !== 'GET' && $method !== 'HEAD') {
            etd_api_error('method_not_allowed', 'Použij GET.', 405);
        }
        $code = etd_api_barcode($_GET['barcode'] ?? null);
        $limit = max(1, min(1000, (int)($_GET['limit'] ?? 100)));
        $rows = etd_all('SELECT * FROM records WHERE barcode = ? COLLATE NOCASE AND cancelled_at IS NULL ORDER BY id DESC LIMIT ?', [$code, $limit]);
        if ($rows === []) {
            etd_api_error('not_found', 'Průvodka s tímto barcodem v evidenci není (nebo má všechny záznamy stornované).', 404, ['barcode' => $code, 'found' => false]);
        }
        etd_json(['barcode' => $rows[0]['barcode'], 'found' => true, 'count' => count($rows), 'records' => array_map('etd_record_public', $rows)]);

    default:
        etd_api_error('not_found', 'Neznámý endpoint. Dostupné: last, history, ping.', 404);
}
