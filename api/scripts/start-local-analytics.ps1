$ErrorActionPreference = 'Stop'
$analyticsRuntime = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../.organization-demo-runtime/analytics/umami')).Path
$analyticsStandalone = Join-Path $analyticsRuntime '.next/standalone'
if (-not (Test-Path -LiteralPath (Join-Path $analyticsStandalone 'server.js'))) { throw 'Build local Umami first; see docs/LOCAL-ANALYTICS.md.' }
if (Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue) { throw 'Port8091 is already in use. Check the existing analytics service before starting another.' }
Copy-Item -LiteralPath (Join-Path $analyticsRuntime 'public') -Destination $analyticsStandalone -Recurse -Force
Copy-Item -LiteralPath (Join-Path $analyticsRuntime '.next/static') -Destination (Join-Path $analyticsStandalone '.next') -Recurse -Force
$analyticsNode = (Get-Command node -ErrorAction Stop).Source
$analyticsEnv = Join-Path $analyticsRuntime '.env'
$analyticsProcess = Start-Process -FilePath $analyticsNode -ArgumentList @("--env-file=`"$analyticsEnv`"",'.next/standalone/server.js') -WorkingDirectory $analyticsRuntime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $analyticsRuntime '../server.stdout.log') -RedirectStandardError (Join-Path $analyticsRuntime '../server.stderr.log')
Write-Output ('Local analytics started on http://127.0.0.1:8091; PID ' + $analyticsProcess.Id)
