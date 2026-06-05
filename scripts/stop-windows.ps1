$ErrorActionPreference = "SilentlyContinue"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$taskName = "PostRE Local"
$runnerPidPath = Join-Path $repoRoot "postre-local-runner.pid"
$serverPidPath = Join-Path $repoRoot "postre-local-server.pid"

function Stop-PostrePid {
  param([string]$PidValue)

  if (-not $PidValue) {
    return
  }

  taskkill /PID $PidValue /T /F *> $null

  $process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $PidValue -Force -ErrorAction SilentlyContinue
  }
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName
}

foreach ($pidPath in @($serverPidPath, $runnerPidPath)) {
  if (Test-Path $pidPath) {
    $pidValue = Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    Stop-PostrePid -PidValue $pidValue
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "PostRE Local stopped."
