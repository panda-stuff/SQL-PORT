param(
    [Parameter(Mandatory=$true)][string]$Runtime,
    [Parameter(Mandatory=$true)][string]$SourceUrl
)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='SQL PORT - First launch / Bun runtime'
Write-Host ''
Write-Host 'SQL PORT - First-time runtime setup' -ForegroundColor Cyan
Write-Host '-----------------------------------'
Write-Host 'SQL PORT needs the Bun runtime to start its local manager.'
Write-Host 'The download is the official precompiled Bun Windows x64 ZIP.'
Write-Host 'Official Bun release URL:' -ForegroundColor Cyan
Write-Host $SourceUrl -ForegroundColor White
Write-Host ('Destination: '+$Runtime)
Write-Host 'No installer or system-wide changes will be made.'
Write-Host ''
$answer=Read-Host ('Download Bun from ' + $SourceUrl + ' ? [y/N]')
if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled. SQL PORT has not downloaded anything.'; exit 2 }
if (-not $SourceUrl.StartsWith('https://github.com/oven-sh/bun/releases/',[StringComparison]::OrdinalIgnoreCase)) {
    Write-Host 'Unexpected runtime source: download refused.'; Read-Host 'Press Enter to close'; exit 3
}
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$temp=Join-Path ([IO.Path]::GetTempPath()) ('sqlport-bun-'+[guid]::NewGuid())
New-Item -ItemType Directory -Path $temp -Force|Out-Null
try {
    Add-Type -AssemblyName System.Net.Http
    $archive=Join-Path $temp 'bun.zip'
    $client=New-Object System.Net.Http.HttpClient
    $client.Timeout=[TimeSpan]::FromMinutes(15)
    try {
        $resp=$client.GetAsync($SourceUrl,[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $resp.EnsureSuccessStatusCode()|Out-Null
        if($resp.RequestMessage.RequestUri.Scheme -ne 'https') {throw 'Insecure redirect refused'}
        $total=$resp.Content.Headers.ContentLength
        $stream=$resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out=[IO.File]::Create($archive)
        $buffer=New-Object byte[] 65536
        $received=[long]0
        $lastPercent=-1
        try {
            while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0) {
                $out.Write($buffer,0,$count)
                $received+=$count
                if($total -gt 0) {
                    $percent=[math]::Min(100,[int][math]::Floor(100*$received/$total))
                    if($percent -ne $lastPercent) {
                        Write-Progress -Activity 'Downloading Bun from official source' -Status "$percent%" -PercentComplete $percent
                        $lastPercent=$percent
                    }
                } else { Write-Progress -Activity 'Downloading Bun' -Status ('{0:N1} MB' -f ($received/1MB)) }
            }
        } finally { $out.Dispose();$stream.Dispose(); }
        Write-Progress -Activity 'Downloading Bun from official source' -Completed
        if($received -lt 1000000) { throw 'Downloaded archive appears incomplete.' }
    } finally { $client.Dispose() }
    Write-Host 'Extracting portable runtime...' -ForegroundColor Cyan
    $unpacked=Join-Path $temp 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $found=Get-ChildItem -LiteralPath $unpacked -Filter 'bun.exe' -Recurse -File|Select-Object -First 1
    if(-not $found){throw 'The official ZIP did not contain bun.exe.'}
    New-Item -ItemType Directory -Path (Split-Path $Runtime -Parent) -Force|Out-Null
    Copy-Item -LiteralPath $found.FullName -Destination $Runtime -Force
    Write-Host 'Bun is ready. Starting SQL PORT...' -ForegroundColor Green
    Start-Sleep -Milliseconds 700
    exit 0
} catch {
    Write-Host ('Setup failed: '+$_) -ForegroundColor Red
    Read-Host 'Press Enter to close this window'
    exit 1
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
