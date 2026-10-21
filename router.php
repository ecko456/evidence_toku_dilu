<?php
declare(strict_types=1);

// Router pro vestavěný PHP server (testy a vývoj):
//   ETD_DATA_DIR=/tmp/etd php -S 127.0.0.1:8480 router.php
// Na serveru s Apachem se nepoužívá; stejná pravidla tam drží deploy/apache-evidence_toku_dilu.conf.
$path = rawurldecode((string)(parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/'));

if (preg_match('#(^|/)(data|lib|bin|tests|deploy)(/|$)#i', $path) || preg_match('#(^|/)\.#', $path)
    || preg_match('#\.(md|txt|zip|py|sh|ini|json|sqlite3|lock|log|bak|conf)$#i', $path) || basename($path) === 'router.php') {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Nenalezeno.';
    return true;
}
// API pro IT: api/v1/<endpoint> obslouží api/v1/index.php (na Apachi FallbackResource)
if (preg_match('#^/api/v1(/[a-z]*)?/?$#', $path)) {
    require __DIR__ . '/api/v1/index.php';
    return true;
}
return false;
