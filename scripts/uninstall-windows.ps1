$ErrorActionPreference = "SilentlyContinue"

& (Join-Path $PSScriptRoot "stop-windows.ps1")
Unregister-ScheduledTask -TaskName "PostRE Local" -Confirm:$false

Write-Host "PostRE Local scheduled task removed."
