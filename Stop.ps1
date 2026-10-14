$ErrorActionPreference='Stop'
$root=$PSScriptRoot
. (Join-Path $root 'CondaEnv.ps1')
$pythonPaths=@(
 (Join-Path (Get-SimCareCondaEnvPath $root) 'python.exe'),
 (Join-Path $root '.conda-env\python.exe'),
 (Join-Path $root '.venv\Scripts\python.exe'),
 (Join-Path $root 'runtime\python\python.exe')
)
if(Test-Path "$root/nginx/logs/nginx.pid"){& "$root/nginx/nginx.exe" -p "$root/nginx/" -s quit}
$procs=Get-CimInstance Win32_Process | Where-Object {
 $_.Name -in @('python.exe','pythonw.exe') -and
 $_.ExecutablePath -in $pythonPaths -and
 $_.CommandLine -match '(?:engine_runner\.py|backend[/\\]engines[/\\]|backend[/\\]extensions[/\\]english[/\\]site[/\\]|server\.py)'
}
foreach($proc in $procs){Stop-Process -Id $proc.ProcessId}
Write-Host 'Package processes stopped. Data retained.'
