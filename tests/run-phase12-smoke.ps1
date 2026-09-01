$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nodeBin = "C:\Users\bendi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$nodeExe = Join-Path $nodeBin "node.exe"
$cli = Join-Path $root "node_modules\vinext\dist\cli.js"
$stdout = Join-Path $root "work-phase12-server.out.log"
$stderr = Join-Path $root "work-phase12-server.err.log"
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")

Remove-Item Env:PATH -ErrorAction SilentlyContinue
$env:Path = "$nodeBin;$machinePath;$userPath"

$server = Start-Process `
  -FilePath $nodeExe `
  -ArgumentList $cli, "dev", "--host", "127.0.0.1" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

try {
  & (Join-Path $PSScriptRoot "phase12-api-smoke.ps1")
} catch {
  if (Test-Path $stdout) { Get-Content $stdout }
  if (Test-Path $stderr) { Get-Content $stderr }
  throw
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
