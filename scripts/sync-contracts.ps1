# Export every robot's contract from ../TeamXbot2026 and import each into the web tool.
# One web robot per ContractToUse name (Competition, 2025, 2023, Robox); new ones are created.
#   -Api       API base URL (default: the local demo API)
#   -Contracts which contracts (default: all four)
# The snapshot key comes from $env:SNAPSHOT_KEY, else api/.env (local demo).
param(
    [string]$Api = 'http://127.0.0.1:8787',
    [string[]]$Contracts = @('Competition', '2025', '2023', 'Robox')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$robotRepo = Join-Path (Split-Path $root -Parent) 'TeamXbot2026'
$outDir = Join-Path $root '.local'
New-Item -ItemType Directory -Force $outDir | Out-Null

foreach ($c in $Contracts) {
    $file = Join-Path $outDir "snapshot-$c.json"
    Push-Location $robotRepo
    try { ./gradlew electricalReport -q --args="--contract $c --json -f $file" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Export of $c failed" }
    node (Join-Path $PSScriptRoot 'import-snapshot.mjs') $file $Api
    if ($LASTEXITCODE -ne 0) { throw "Import of $c failed" }
}
