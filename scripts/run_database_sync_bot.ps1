param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$SourceRoot = "D:\OneDrive\Procurements\TOR - DUCACR",
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $LogPath) {
  $LogPath = Join-Path $RepoRoot "logs\database-sync-bot.log"
}

$logDir = Split-Path -Parent $LogPath
if ($logDir) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

Push-Location $RepoRoot
try {
  $env:DUCAR_SOURCE_ROOT = $SourceRoot
  $started = Get-Date -Format o
  Add-Content -Path $LogPath -Value "[$started] Starting DUCAR database sync bot. SourceRoot=$SourceRoot"

  & npm run sync-bot 2>&1 | Tee-Object -FilePath $LogPath -Append
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "DUCAR database sync bot failed with exit code $exitCode"
  }

  $finished = Get-Date -Format o
  Add-Content -Path $LogPath -Value "[$finished] Completed DUCAR database sync bot."
}
finally {
  Pop-Location
}
