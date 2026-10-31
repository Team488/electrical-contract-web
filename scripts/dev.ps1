# Local demo: DynamoDB Local on :8001, API (same code as the Lambda) on :8787,
# static site on :8000. No AWS account needed.
#   -Snapshot      export every robot's contract from ../TeamXbot2026 and import them
#   -Reset         wipe the local database first (fresh seed from the snapshot)
#   -Lan           listen on all interfaces so phones/laptops on the same network can connect
param([switch]$Snapshot, [switch]$Reset, [switch]$Lan)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$apiDir = Join-Path $root 'api'
$local = Join-Path $root '.local'
$dataDir = Join-Path $local 'dynamodb'
$ddbDir = Join-Path $root 'tools\dynamodb-local'

& (Join-Path $PSScriptRoot 'get-dynamodb-local.ps1')
if (-not (Test-Path (Join-Path $apiDir '.env'))) {
    Copy-Item (Join-Path $apiDir '.env.example') (Join-Path $apiDir '.env')
    Write-Host 'Created api/.env from the example. Change the passcode there.'
}
if ($Reset -and (Test-Path $dataDir)) { Remove-Item -Recurse -Force $dataDir }
New-Item -ItemType Directory -Force $dataDir | Out-Null

$ip = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$origins = 'http://localhost:8000,http://127.0.0.1:8000'
if ($Lan) {
    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
    $origins += ",http://${lanIp}:8000"
}

$java = & (Join-Path $PSScriptRoot 'find-java.ps1')
$ddb = Start-Process -PassThru -NoNewWindow -WorkingDirectory $ddbDir $java -ArgumentList @(
    "-Djava.library.path=$ddbDir\DynamoDBLocal_lib", '-jar', "$ddbDir\DynamoDBLocal.jar",
    '-sharedDb', '-dbPath', $dataDir, '-port', '8001')

# The API reads api/.env; these override it for this run.
$env:HOST = $ip
$env:CORS_ORIGINS = $origins
$api = Start-Process -PassThru -NoNewWindow -WorkingDirectory $apiDir npx.cmd -ArgumentList @('tsx', 'src/local.ts')
$web = Start-Process -PassThru -NoNewWindow python -ArgumentList @((Join-Path $PSScriptRoot 'serve.py'), $ip)

try {
    # Wait for the API (which waits for DynamoDB Local) before importing.
    $up = $false
    for ($i = 0; $i -lt 90 -and -not $up; $i++) {
        try { Invoke-RestMethod http://127.0.0.1:8787/api/robots | Out-Null; $up = $true } catch { Start-Sleep 1 }
    }
    if (-not $up) { throw 'The API did not start; see the messages above.' }

    $state = Invoke-RestMethod http://127.0.0.1:8787/api/robots/1
    if ($Snapshot -or -not $state.snapshot) {
        & (Join-Path $PSScriptRoot 'sync-contracts.ps1') -Api http://127.0.0.1:8787
    }

    Write-Host ''
    Write-Host 'Open http://localhost:8000  (Ctrl+C to stop)'
    if ($Lan) { Write-Host "On the LAN: http://${lanIp}:8000  (Windows Firewall must allow ports 8000 and 8787)" }
    Wait-Process -Id $ddb.Id, $api.Id, $web.Id
} finally {
    # Kill whole process trees (npx and java leave children otherwise).
    foreach ($p in $ddb, $api, $web) { taskkill /T /F /PID $p.Id 2>&1 | Out-Null }
}
