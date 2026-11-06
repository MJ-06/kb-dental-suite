param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$archiveConfig = (Resolve-Path -LiteralPath $Config).Path
$archiveApi = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$archiveNode = (Get-Command node -ErrorAction Stop).Source
$archiveScript = Join-Path $PSScriptRoot 'archive-worker.ts'
$archiveLogFolder = Split-Path -Parent $archiveConfig
$archiveChild = Start-Process -FilePath $archiveNode -ArgumentList @('--import','tsx',"`"$archiveScript`"","`"--config=$archiveConfig`"") -WorkingDirectory $archiveApi -WindowStyle Hidden -RedirectStandardOutput (Join-Path $archiveLogFolder 'archive-worker.stdout.log') -RedirectStandardError (Join-Path $archiveLogFolder 'archive-worker.stderr.log') -Wait -PassThru
exit $archiveChild.ExitCode
