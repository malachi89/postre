$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runner = Join-Path $repoRoot "scripts\postre-local-runner.mjs"
$taskName = "PostRE Local"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($task) {
  Start-ScheduledTask -TaskName $taskName
  Write-Host "PostRE Local scheduled task started."
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  Start-Process -FilePath $node -ArgumentList "`"$runner`"" -WorkingDirectory $repoRoot -WindowStyle Hidden
  Write-Host "PostRE Local runner started without installing autostart."
}

Write-Host "Open http://localhost:5500 after startup finishes."
