# Установка автозапуска Lumina через планировщик задач Windows
# Run as Administrator

$ErrorActionPreference = "Stop"
$projectDir = "N:\python_ide\DMX-ART-L"
$taskName = "LuminaDMX"
$batPath = Join-Path $projectDir "run_server_hidden.bat"

$action = New-ScheduledTaskAction -Execute $batPath -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -RunOnlyIfNetworkAvailable:$false

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

Start-ScheduledTask -TaskName $taskName

Write-Host "Задача '$taskName' установлена. Lumina будет запускаться при входе в Windows и работать без окна."
Write-Host "Текущий статус:"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
