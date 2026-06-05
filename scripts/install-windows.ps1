$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runner = Join-Path $repoRoot "scripts\postre-local-runner.mjs"
$taskName = "PostRE Local"
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $runner)) {
  throw "Runner not found at $runner"
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$runner`"" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Runs PostRE locally on http://localhost:5500 at logon." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "PostRE Local installed and started."
Write-Host "Open http://localhost:5500 after the initial npm/prisma setup finishes."
Write-Host "Logs: $repoRoot\postre-local-runner.log and $repoRoot\postre-local-server.log"
