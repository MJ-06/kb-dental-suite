param(
  [Parameter(Mandatory=$true)][string]$Config,
  [string]$TaskName = 'KB Dental Organization Archives'
)
$ErrorActionPreference = 'Stop'
$archiveConfig = (Resolve-Path -LiteralPath $Config).Path
$archiveApi = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$archiveShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$archiveScript = Join-Path $PSScriptRoot 'run-archive-worker.ps1'
$archiveAction = New-ScheduledTaskAction -Execute $archiveShell -Argument "-NoProfile -WindowStyle Hidden -File `"$archiveScript`" -Config `"$archiveConfig`"" -WorkingDirectory $archiveApi
$archiveUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$archiveTrigger = New-ScheduledTaskTrigger -AtLogOn -User $archiveUser
$archiveSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$archivePrincipal = New-ScheduledTaskPrincipal -UserId $archiveUser -LogonType Interactive -RunLevel Limited
$archiveExisting = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($archiveExisting -and -not ($archiveExisting.Actions | Where-Object { $_.Arguments.IndexOf($archiveConfig, [StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
  throw 'This task name belongs to a different configuration. Choose a unique TaskName for this organization.'
}
Register-ScheduledTask -TaskName $TaskName -Action $archiveAction -Trigger $archiveTrigger -Settings $archiveSettings -Principal $archivePrincipal -Description 'Private organization archive worker; schedule and retention are configured in Master.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output 'Archive worker task installed for the current user. No passwords printed.'
