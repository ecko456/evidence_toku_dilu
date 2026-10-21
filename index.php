<?php
declare(strict_types=1);

/* Stránka aplikace. Přihlášení, výběr oddělení i práci obsluhuje static/app.js přes api.php. */

require __DIR__ . '/lib/etd.php';

etd_security_headers();
etd_require_https();
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');

$v = rawurlencode(ETD_VERSION . '-' . substr(hash('sha256', (string)@filemtime(__DIR__ . '/static/app.js') . (string)@filemtime(__DIR__ . '/static/app.css')), 0, 8));
?><!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0f2a3d">
<meta name="robots" content="noindex, nofollow">
<title>Evidence toku dílů</title>
<link rel="icon" href="static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="static/app.css?v=<?= $v ?>">
</head>
<body>
<div id="app" data-version="<?= htmlspecialchars(ETD_VERSION, ENT_QUOTES) ?>">
  <div class="boot">Načítám Evidenci toku dílů…</div>
  <noscript><p class="boot">Aplikace potřebuje zapnutý JavaScript.</p></noscript>
</div>
<div id="toasts" class="toasts" aria-live="polite"></div>
<script src="static/scan.js?v=<?= $v ?>"></script>
<script src="static/app.js?v=<?= $v ?>"></script>
</body>
</html>
