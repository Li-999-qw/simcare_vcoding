param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'CondaEnv.ps1')
$envPath = Get-SimCareCondaEnvPath $root
$condaPython = Join-Path $envPath 'python.exe'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$nginx = Join-Path $root 'nginx\nginx.exe'
$nginxPrefix = (Join-Path $root 'nginx').Replace('\', '/') + '/'
$ports = @(28765, 28770, 28771, 28894, 28891, 28892, 28893, 28876, 8080)

if (Test-Path -LiteralPath $condaPython) {
    Enter-SimCareCondaEnv $envPath
    $python = $condaPython
} elseif (Test-Path -LiteralPath $venvPython) {
    $python = $venvPython
    Write-Host 'Using the existing .venv for local preview.'
} else {
    throw 'No project Python environment found. Run Install.ps1 first.'
}
if (-not (Test-Path -LiteralPath $nginx)) { throw 'Nginx is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'nginx\conf\local-preview.conf'))) {
    throw 'Local preview configuration is missing.'
}

function Get-Listener([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Wait-ForPort([int]$port, [bool]$listening, [int]$seconds) {
    for ($i = 0; $i -lt ($seconds * 2); $i++) {
        if ([bool](Get-Listener $port) -eq $listening) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Port $port did not reach its expected state."
}

# Refuse to stop a service from another installation or application.
$pythonPaths = @($python, (Join-Path $root '.conda-env\python.exe'), (Join-Path $root '.venv\Scripts\python.exe'))
function Test-OwnedPythonCommand([string]$commandLine) {
    if (-not $commandLine) { return $false }
    foreach ($path in $pythonPaths) {
        if ($commandLine.StartsWith('"' + $path + '"', [StringComparison]::OrdinalIgnoreCase) -or
            $commandLine.StartsWith($path + ' ', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}
$ownedPython = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('python.exe', 'pythonw.exe') -and
    (Test-OwnedPythonCommand $_.CommandLine) -and
    $_.CommandLine -like ('*' + $root + '*') -and
    $_.CommandLine -match '(?:engine_runner\.py|backend[/\\]engines[/\\]|backend[/\\]extensions[/\\]english[/\\]site[/\\]|server\.py)'
})
$ownedNginx = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'nginx.exe' -and
    $_.ExecutablePath -eq $nginx -and
    $_.CommandLine -like '*conf/local-preview.conf*'
})
foreach ($port in $ports) {
    $listener = Get-Listener $port
    if (-not $listener) { continue }
    $owned = if ($port -eq 8080) { $ownedNginx } else { $ownedPython }
    if ($listener.OwningProcess -notin @($owned | ForEach-Object ProcessId)) {
        throw "Port $port is used by another application; nothing was stopped."
    }
}

Write-Host 'Stopping local preview...'
if ($ownedNginx.Count -gt 0) {
    & $nginx -p $nginxPrefix -c 'conf/local-preview.conf' -s quit
    if ($LASTEXITCODE -ne 0) { throw 'Nginx could not stop cleanly.' }
}
foreach ($process in $ownedPython) {
    Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
}
foreach ($port in $ports) { Wait-ForPort $port $false 20 }

$env:PYTHONUTF8 = '1'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Start-Service([string]$name, [int]$port, [string[]]$arguments) {
    $previousWorkerId = $env:SIMCARE_WORKER_ID
    $env:SIMCARE_WORKER_ID = [string]($port % 1024)
    $process = Start-Process -FilePath $python -ArgumentList $arguments `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logs "$name.log") `
        -RedirectStandardError (Join-Path $logs "$name.err")
    $env:SIMCARE_WORKER_ID = $previousWorkerId
    for ($i = 0; $i -lt 60; $i++) {
        if ($process.HasExited) { throw "$name failed. See logs/$name.err." }
        if (Get-Listener $port) { Write-Host "$name ready"; return }
        Start-Sleep -Milliseconds 500
    }
    throw "$name timed out. See logs/$name.err."
}

Start-Service 'chest' 28765 @('backend/main/engine_runner.py', 'backend/engines/chest/server.py', '--host', '127.0.0.1', '--port', '28765')
Start-Service 'lumbar' 28770 @('backend/main/engine_runner.py', 'backend/engines/lumbar/server.py', '--port', '28770')
Start-Service 'ascites' 28771 @('backend/engines/ascites/server.py', '--port', '28771')
Start-Service 'uyghur' 28894 @('backend/engines/uyghur/server.py', '--host', '127.0.0.1', '--port', '28894')
Start-Service 'en-chest' 28891 @('backend/extensions/english/site/chest_engine/server.py', '--port', '28891')
Start-Service 'en-lumbar' 28892 @('backend/extensions/english/site/lumbar_engine/server.py', '--port', '28892')
Start-Service 'en-ascites' 28893 @('backend/extensions/english/site/ascites_engine/server.py', '--port', '28893')
Start-Service 'api' 28876 @('server.py')

$health = Invoke-RestMethod 'http://127.0.0.1:28876/health'
if (-not $health.ok) { throw 'Backend health check failed.' }
& $nginx -p $nginxPrefix -c 'conf/local-preview.conf' -t
if ($LASTEXITCODE -ne 0) { throw 'Local Nginx configuration check failed.' }
Start-Process -FilePath $nginx -ArgumentList @('-p', ('"' + $nginxPrefix + '"'), '-c', 'conf/local-preview.conf') `
    -WorkingDirectory (Join-Path $root 'nginx') -WindowStyle Hidden
Wait-ForPort 8080 $true 15
$response = Invoke-WebRequest 'http://127.0.0.1:8080/portal.html' -UseBasicParsing
if ($response.StatusCode -ne 200) { throw 'Portal check failed.' }
Write-Host 'Ready: http://127.0.0.1:8080/portal.html'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8080/portal.html' }
