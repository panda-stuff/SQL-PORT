<?php

    // Editable main application entry point.

    $database_status = 'Not connected';
    $mariadb_version = 'Not available';

    $platform_suffix = PHP_OS_FAMILY === 'Linux'
        ? '-linux-' . (in_array(php_uname('m'), ['aarch64', 'arm64'], true) ? 'arm64' : 'x64')
        : '';
    $selection_file = __DIR__ . '/../data/version-selection' . $platform_suffix . '.json';
    $selection = is_file($selection_file) ? json_decode(file_get_contents($selection_file), true) : [];
    $phpmyadmin_version = $selection['active']['phpMyAdmin'] ?? 'Not installed';

    try
    {

        $pdo = new PDO('mysql:host=127.0.0.1;port=3306;dbname=main;charset=utf8mb4', 'root', 'root', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
        ]);

        $database_status = 'Connected to MariaDB';
        $mariadb_version = $pdo->getAttribute(PDO::ATTR_SERVER_VERSION);

    }
    catch (PDOException $error)
    {

        $database_status = 'MariaDB connection unavailable';

    }

?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SQL PORT</title>
</head>
<body>
    <h1>SQL PORT</h1>
    <p><?= htmlspecialchars($database_status, ENT_QUOTES, 'UTF-8') ?></p>
    <p>PHP version: <?= htmlspecialchars(PHP_VERSION, ENT_QUOTES, 'UTF-8') ?></p>
    <p>MariaDB version: <?= htmlspecialchars($mariadb_version, ENT_QUOTES, 'UTF-8') ?></p>
    <p>phpMyAdmin version: <?= htmlspecialchars($phpmyadmin_version, ENT_QUOTES, 'UTF-8') ?></p>
    <p>Edit <code>app/index.php</code> to build your project.</p>
    <p><a href="http://127.0.0.1:4096/phpmyadmin/" target="_blank" rel="noopener noreferrer">Open phpMyAdmin</a></p>
</body>
</html>
