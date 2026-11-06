param([string]$Pattern = '*.test.ts')
$ErrorActionPreference = 'Stop'
$testApi = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRunner = (Get-Command npx -ErrorAction Stop).Source
$testMutex = [System.Threading.Mutex]::new($false, 'Local\KB-Dental-Backend-Test-Runner')
if (-not $testMutex.WaitOne(0)) { throw 'Another serial backend test run is active. Wait for it to finish.' }
$testFailures = @()
try {
  Push-Location $testApi
  foreach ($testFile in (Get-ChildItem -LiteralPath (Join-Path $testApi 'test') -File | Where-Object { $_.Name -like $Pattern -and $_.Name -match '^[a-z0-9-]+\.test\.ts$' } | Sort-Object Name)) {
    Write-Output ("CHECK " + $testFile.Name)
    & $testRunner vitest run ("test/" + $testFile.Name)
    if ($LASTEXITCODE -ne 0) { $testFailures += $testFile.Name }
  }
} finally {
  Pop-Location
  $testMutex.ReleaseMutex()
  $testMutex.Dispose()
}
if ($testFailures.Count -gt 0) { Write-Output ('FAILED FILES: ' + ($testFailures -join ', ')); exit 1 }
Write-Output 'All selected backend files passed, one at a time.'
