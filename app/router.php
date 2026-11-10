<?php

    // Serve phpMyAdmin through the existing PHP listener without a third service.

    $uri_path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');

    if (str_starts_with($uri_path, '/phpmyadmin'))
    {

        $relative = substr($uri_path, strlen('/phpmyadmin'));
        $platform_suffix = PHP_OS_FAMILY === 'Linux'
            ? '-linux-' . (in_array(php_uname('m'), ['aarch64', 'arm64'], true) ? 'arm64' : 'x64')
            : '';
        $selection_file = __DIR__ . '/../data/version-selection' . $platform_suffix . '.json';
        $selection = is_file($selection_file) ? json_decode(file_get_contents($selection_file), true) : [];
        $version = $selection['active']['phpMyAdmin'] ?? null;
        $root = is_string($version) && preg_match('/^\d+\.\d+\.\d+$/', $version)
            ? realpath(__DIR__ . '/../modules/phpmyadmin/versions/' . $version)
            : false;

        if (!$root)
        {
            http_response_code(503);
            exit('phpMyAdmin is not installed. Install it from SQL PORT Manager.');
        }

        $target = realpath($root . ($relative === '/' || $relative === '' ? '/index.php' : $relative));

        if (!$target || !str_starts_with($target, $root . DIRECTORY_SEPARATOR) || !is_file($target))
        {
            http_response_code(404);
            exit('Not found');
        }

        if (strtolower(pathinfo($target, PATHINFO_EXTENSION)) === 'php')
        {
            $_SERVER['SCRIPT_FILENAME'] = $target;
            $_SERVER['SCRIPT_NAME'] = '/phpmyadmin' . ($relative === '/' || $relative === '' ? '/index.php' : $relative);
            $_SERVER['PHP_SELF'] = $_SERVER['SCRIPT_NAME'];
            chdir(dirname($target));
            require $target;
            return true;
        }

        $mime = [
            'css' => 'text/css', 'js' => 'text/javascript', 'png' => 'image/png',
            'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'svg' => 'image/svg+xml',
            'gif' => 'image/gif', 'ico' => 'image/x-icon', 'woff' => 'font/woff',
            'woff2' => 'font/woff2', 'map' => 'application/json'
        ];

        $extension = strtolower(pathinfo($target, PATHINFO_EXTENSION));
        if (!isset($mime[$extension]))
        {
            http_response_code(403);
            exit('File type not permitted');
        }

        header('Content-Type: ' . $mime[$extension]);
        readfile($target);
        return true;
    }

    return false;
