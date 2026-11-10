# Startup and tray logic for SQL PORT (Windows PowerShell 5.1, STA).
# SQL PORT.bat launches this readable script directly.
$ErrorActionPreference = 'Stop'
$script:mutex = $null
$script:ownsMutex = $false
$script:backend = $null
$script:icon = $null
$script:menu = $null
$script:timer = $null
$script:context = $null
$script:token = $null
$script:managerUrl = $null
$script:startedBackend = $false

function Show-Error($message) {
    [System.Windows.Forms.MessageBox]::Show([string]$message, 'SQL PORT', 'OK', 'Error') | Out-Null
}

function Open-Manager {
    Start-Process -FilePath ($script:managerUrl + '/') | Out-Null
}
function Open-App {
    Start-Process -FilePath $script:appUrl | Out-Null
}

function Test-ManagerReady {
    try {
        $response = Invoke-RestMethod -Uri ($script:managerUrl + '/health') -TimeoutSec 1 -UseBasicParsing
        return ($response.app -eq 'SQL PORT' -and $response.ok -eq $true)
    } catch { return $false }
}

function Invoke-ManagerAction([string]$action) {
    $headers = @{ 'X-SQL-Port-Token' = $script:token; 'Origin' = $script:managerUrl }
    Invoke-RestMethod -Method Post -Uri ($script:managerUrl + '/api/' + $action) `
        -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 90 | Out-Null
}

function Stop-Backend {
    if (-not $script:startedBackend -or $null -eq $script:backend) { return }
    try { if (-not $script:backend.HasExited) { Invoke-ManagerAction 'quit' } } catch {}
    try {
        if (-not $script:backend.WaitForExit(60000)) {
            $script:backend.Kill()
            $script:backend.WaitForExit()
        }
    } catch {}
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $services = Get-Content -LiteralPath (Join-Path $root 'config/services/services.json') -Raw | ConvertFrom-Json
    $port = [int]$services.application.manager_port
    $script:appUrl = 'http://127.0.0.1:' + [string]$services.application.port + '/' + [string]$services.application.startup_file
    if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid manager_port in services.json.' }
    $script:managerUrl = 'http://127.0.0.1:' + $port

    # Named mutex is acquired before downloading Bun or starting processes.
    $created = $false
    $script:mutex = [System.Threading.Mutex]::new($true, 'Local\SQL_PORT_SINGLE_INSTANCE', [ref]$created)
    if (-not $created) {
        # Existing instance: do not launch another backend/tray.
        for ($i=0; $i -lt 80; $i++) {
            if (Test-ManagerReady) { Open-Manager; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-ManagerReady)) {
            Show-Error 'SQL PORT is already starting or its manager is unavailable.'
        }
        return
    }
    $script:ownsMutex = $true

    $runtime = Join-Path $root 'runtime/bun.exe'
    $scriptFile = Join-Path $root 'manager/server.js'
    $workDir = $root
    if (-not (Test-Path -LiteralPath $scriptFile -PathType Leaf)) { throw "Missing script: $scriptFile" }
    if (-not (Test-Path -LiteralPath $workDir -PathType Container)) { throw "Missing directory: $workDir" }

    if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
        $url = 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip'
        # Separate, *visible* console is used ONLY on first run. User must press Y;
        # normal application startup stays silent and uses the Windows tray.
        $onboarding = Join-Path $PSScriptRoot 'setup-bun.ps1'
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $onboarding + '" -Runtime "' + $runtime + '" -SourceUrl "' + $url + '"'
        $setup = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments `
            -WorkingDirectory $root -WindowStyle Normal -Wait -PassThru
        if ($setup.ExitCode -ne 0) { return } # Declined or failed: no manager/tray started.
        if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw 'Runtime download finished but bun.exe is missing' }
    }

    $logDir = Join-Path $root 'logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    # Per-session secret shared with Bun; not persisted to disk or exposed in HTML.
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $script:token = [Convert]::ToBase64String($bytes)
    $env:SQL_PORT_TOKEN = $script:token

    $script:backend = Start-Process -FilePath $runtime -ArgumentList ('"' + $scriptFile + '"') `
        -WorkingDirectory $workDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'bun.stdout.log') `
        -RedirectStandardError (Join-Path $logDir 'bun.stderr.log')
    $script:startedBackend = $true

    $ready = $false
    for ($i=0; $i -lt 100; $i++) {
        if (Test-ManagerReady) { $ready = $true; break }
        if ($script:backend.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw 'Bun did not start the manager. Check logs/bun.stderr.log.' }

    $script:menu = New-Object System.Windows.Forms.ContextMenuStrip
    $open = $script:menu.Items.Add('Open Browser UI')
    $openApp = $script:menu.Items.Add('Open Application')
    $restart = $script:menu.Items.Add('Restart')
    $stop = $script:menu.Items.Add('Stop')
    [void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    $quit = $script:menu.Items.Add('Quit')

    $open.Add_Click({ try { Open-Manager } catch { Show-Error $_ } })
    $openApp.Add_Click({ try { Open-App } catch { Show-Error $_ } })
    $restart.Add_Click({ try { Invoke-ManagerAction 'restart' } catch { Show-Error $_ } })
    $stop.Add_Click({ try { Invoke-ManagerAction 'stop' } catch { Show-Error $_ } })
    $quit.Add_Click({
        try { Stop-Backend } finally {
            if ($null -ne $script:context) { $script:context.ExitThread() }
        }
    })

    $script:icon = New-Object System.Windows.Forms.NotifyIcon
    $iconFile = Join-Path $root 'assets/app.ico'
    $script:icon.Icon = if (Test-Path -LiteralPath $iconFile) { New-Object System.Drawing.Icon($iconFile) } else { [System.Drawing.SystemIcons]::Application }
    $script:icon.Text = 'SQL PORT'
    $script:icon.ContextMenuStrip = $script:menu
    $script:icon.Add_DoubleClick({ try { Open-Manager } catch {} })

    $script:context = New-Object System.Windows.Forms.ApplicationContext
    $script:timer = New-Object System.Windows.Forms.Timer
    $script:timer.Interval = 500
    $script:timer.Add_Tick({
        # Browser Quit shuts Bun down; once it exits, remove tray immediately.
        if ($script:backend.HasExited) { $script:context.ExitThread() }
    })
    $script:icon.Visible = $true
    $script:timer.Start()

    if ($services.application.open_browser -ne $false) { Open-Manager }
    [System.Windows.Forms.Application]::Run($script:context)
} catch {
    Show-Error $_
} finally {
    # Always release the notification icon; avoids a ghost tray icon on normal Quit.
    if ($null -ne $script:timer) { $script:timer.Stop(); $script:timer.Dispose() }
    if ($null -ne $script:icon) {
        $script:icon.Visible = $false
        $script:icon.Dispose()
        [System.Windows.Forms.Application]::DoEvents()
    }
    if ($null -ne $script:menu) { $script:menu.Dispose() }
    if ($null -ne $script:context) { $script:context.Dispose() }
    Stop-Backend
    if ($script:ownsMutex -and $null -ne $script:mutex) {
        try { $script:mutex.ReleaseMutex() } catch {}
    }
    if ($null -ne $script:mutex) { $script:mutex.Dispose() }
    Remove-Item Env:SQL_PORT_TOKEN -ErrorAction SilentlyContinue
}
