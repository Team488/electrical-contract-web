# Download AWS's official DynamoDB Local (a Java jar) into tools/dynamodb-local.
# Needs Java 17+; the WPILib JDK works. Run once; dev.ps1 and the tests use it.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $root 'tools\dynamodb-local'
if (Test-Path (Join-Path $dest 'DynamoDBLocal.jar')) { Write-Host "Already installed: $dest"; return }
New-Item -ItemType Directory -Force $dest | Out-Null
$zip = Join-Path $env:TEMP 'dynamodb_local_latest.zip'
Invoke-WebRequest 'https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip' -OutFile $zip
Expand-Archive $zip -DestinationPath $dest -Force
Remove-Item $zip
Write-Host "Installed DynamoDB Local in $dest"
