# Export every robot's contract from a season repo checked out next to this one
# (default ../TeamXbot2026) and import each into the web tool.
# One web robot per repo + ContractToUse name; new ones are created.
#   -Api       API base URL (default: the local demo API)
#   -Repo      season repo as owner/name (default Team488/TeamXbot2026); the checkout is ../<name>
#   -Contracts which contracts (default: all four)
# The snapshot key comes from $env:SNAPSHOT_KEY, else api/.env (local demo).
param(
    [string]$Api = 'http://127.0.0.1:8787',
    [string]$Repo = 'Team488/TeamXbot2026',
    [string[]]$Contracts = @('Competition', '2025', '2023', 'Robox')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$robotRepo = Join-Path (Split-Path $root -Parent) ($Repo.Split('/')[-1])
$outDir = Join-Path $root '.local'
New-Item -ItemType Directory -Force $outDir | Out-Null

foreach ($c in $Contracts) {
    $file = Join-Path $outDir "snapshot-$c.json"
    Push-Location $robotRepo
    try { ./gradlew electricalReport -q --args="--contract $c --json -f $file" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Export of $c failed" }
    node (Join-Path $PSScriptRoot 'import-snapshot.mjs') $file $Api --repo $Repo
    if ($LASTEXITCODE -ne 0) { throw "Import of $c failed" }
}
