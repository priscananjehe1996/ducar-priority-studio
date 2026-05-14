param(
  [string]$TaskName = "DUCAR Database Sync Bot",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$SourceRoot = "D:\OneDrive\Procurements\TOR - DUCACR",
  [int]$IntervalMinutes = 120
)

$ErrorActionPreference = "Stop"

if ($IntervalMinutes -lt 15) {
  throw "IntervalMinutes must be 15 or greater."
}

$runner = Join-Path $PSScriptRoot "run_database_sync_bot.ps1"
if (-not (Test-Path $runner)) {
  throw "Missing runner script: $runner"
}

$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy Bypass",
  "-File `"$runner`"",
  "-RepoRoot `"$RepoRoot`"",
  "-SourceRoot `"$SourceRoot`""
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Rebuilds the DUCAR SQLite database, fingerprints source files, and refreshes SQL prediction tables." `
  -Force | Out-Null

Write-Output "Installed scheduled task '$TaskName'. It will run every $IntervalMinutes minutes."
