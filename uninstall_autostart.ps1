# Удаление автозапуска Lumina из планировщика задач
# Run as Administrator

$ErrorActionPreference = "SilentlyContinue"
$taskName = "LuminaDMX"

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Задача '$taskName' удалена."
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object TaskName, State
