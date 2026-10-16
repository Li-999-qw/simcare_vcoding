param(
    [switch]$NoBrowser,
    [switch]$StopOnly,
    [string]$ProjectRoot = $PSScriptRoot,
    # Internal: Deploy-Local.ps1 already holds data/deployment.lock.
    [switch]$DeploymentLockHeld
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$ports = @(28765, 28770, 28771, 28894, 28891, 28892, 28893, 28876, 8080)
$serviceScripts = @(
    'backend/main/engine_runner.py', 'backend/engines/chest/server.py',
    'backend/engines/lumbar/server.py', 'backend/engines/ascites/server.py',
    'backend/engines/uyghur/server.py',
    'backend/extensions/english/site/chest_engine/server.py',
    'backend/extensions/english/site/lumbar_engine/server.py',
    'backend/extensions/english/site/ascites_engine/server.py', 'server.py'
)

function Normalize-WindowsPath([string]$Value) {
    return $Value.Replace('/', '\').TrimEnd('\')
}

function Test-SimCarePython($Process) {
    if ($Process.Name -notin @('python.exe', 'pythonw.exe') -or
        -not $Process.ExecutablePath -or -not $Process.CommandLine) { return $false }
    $executable = Normalize-WindowsPath $Process.ExecutablePath
    if ($executable -notin $pythonPaths) { return $false }
    $tokens = @([regex]::Matches($Process.CommandLine, '"[^"]*"|\S+') |
        ForEach-Object { $_.Value.Trim('"') })
    if ($tokens.Count -lt 2) { return $false }
    # Only known script entry points; never match an arbitrary -c/-m command.
    $entry = Normalize-WindowsPath $tokens[1]
    $known = @($serviceScripts | ForEach-Object { Normalize-WindowsPath $_ })
    $full = @($known | ForEach-Object { (Normalize-WindowsPath $root) + '\' + $_ })
    $entryAbsolute = $entry -in $full
    $entryRelative = ($entry -in $known) -or (($entry -replace '^\.\\', '') -in $known)
    if (-not $entryAbsolute -and -not $entryRelative) { return $false }
    # Migration of old relative-path commands is limited to the selected
    # installation-specific Conda environment, or its local virtual environment.
    if (-not $entryAbsolute) {
        $localEnvironment = $executable -in @(
            ((Normalize-WindowsPath $root) + '\.venv\Scripts\python.exe'),
            ((Normalize-WindowsPath $root) + '\.conda-env\python.exe')
        )
        $dedicatedConda = $executable -eq (Normalize-WindowsPath $condaPython) -and
            $executable -match '\\simcare-[0-9a-f]{8,}\\python\.exe$'
        if (-not $localEnvironment -and -not $dedicatedConda) { return $false }
    }
    # Reject another installation's script even if it borrows this interpreter.
    foreach ($token in $tokens | Select-Object -Skip 1) {
        if ($token -match '\.py$') {
            $script = (Normalize-WindowsPath $token) -replace '^\.\\', ''
            if ($script -notin $known -and $script -notin $full) { return $false }
        }
    }
    return $true
}

function Test-SimCareNginx($Process) {
    if ($Process.Name -ne 'nginx.exe' -or -not $Process.ExecutablePath -or
        (Normalize-WindowsPath $Process.ExecutablePath) -ne (Normalize-WindowsPath $nginx) -or
        -not $Process.CommandLine) { return $false }
    $tokens = @([regex]::Matches($Process.CommandLine, '"[^"]*"|\S+') |
        ForEach-Object { $_.Value.Trim('"') })
    $prefixIndex = [Array]::IndexOf($tokens, '-p')
    $configIndex = [Array]::IndexOf($tokens, '-c')
    if ($prefixIndex -lt 0 -or ($prefixIndex + 1) -ge $tokens.Count -or
        $configIndex -lt 0 -or ($configIndex + 1) -ge $tokens.Count) { return $false }
    return (Normalize-WindowsPath $tokens[$prefixIndex + 1]) -eq ((Normalize-WindowsPath $root) + '\nginx') -and
        (Normalize-WindowsPath $tokens[$configIndex + 1]) -in @('conf\local-preview.conf', ((Normalize-WindowsPath $root) + '\nginx\conf\local-preview.conf'))
}

function Get-OwnedProcesses([object[]]$Snapshot) {
    $owned = @{}
    foreach ($item in $Snapshot) {
        if ((Test-SimCarePython $item) -or (Test-SimCareNginx $item)) {
            $owned[[int]$item.ProcessId] = $item
        }
    }
    # Include workers before stopping their parents. Creation times prevent a
    # stale parent PID from making an unrelated older process look like a child.
    do {
        $added = $false
        foreach ($item in $Snapshot) {
            $parent = $owned[[int]$item.ParentProcessId]
            if (-not $owned.ContainsKey([int]$item.ProcessId) -and $parent -and
                $item.CreationDate -and $parent.CreationDate -and
                $item.CreationDate -ge $parent.CreationDate) {
                $owned[[int]$item.ProcessId] = $item
                $added = $true
            }
        }
    } while ($added)
    return @($owned.Values)
}

function Get-ProjectListeners {
    # Query failures must not be interpreted as free ports.
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -in $ports })
}

function Assert-OwnedListeners([object[]]$Listeners, [object[]]$Owned, [object[]]$Snapshot) {
    $ownedIds = @($Owned | ForEach-Object { [int]$_.ProcessId })
    foreach ($listener in $Listeners) {
        if ([int]$listener.OwningProcess -notin $ownedIds) {
            $item = $Snapshot | Where-Object { $_.ProcessId -eq $listener.OwningProcess } | Select-Object -First 1
            throw "Port $($listener.LocalPort) belongs to an unrecognized process (PID $($listener.OwningProcess), executable '$($item.ExecutablePath)'). No services were stopped. Check the Runner account's process permissions or another installation."
        }
    }
}

function Stop-VerifiedProcess($Recorded) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Recorded.ProcessId)"
    if (-not $current) { return }
    if (-not $Recorded.CreationDate -or $current.CreationDate -ne $Recorded.CreationDate) {
        throw "PID $($Recorded.ProcessId) changed identity; refusing to stop it."
    }
    Write-Host "Stopping $($current.Name) PID $($current.ProcessId)..."
    try { Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop }
    catch {
        if (Get-CimInstance Win32_Process -Filter "ProcessId = $($Recorded.ProcessId)") { throw }
    }
}

function Stop-ProjectServices {
    $snapshot = @(Get-CimInstance Win32_Process)
    $owned = @(Get-OwnedProcesses $snapshot)
    Assert-OwnedListeners @(Get-ProjectListeners) $owned $snapshot
    Write-Host 'Stopping local preview...'
    $nginxProcesses = @($owned | Where-Object { $_.Name -eq 'nginx.exe' })
    if ($nginxProcesses.Count -gt 0) {
        # Attempt graceful quit first. A stale PID/config must not prevent the
        # identity-checked fallback below from stopping this installation.
        $savedPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $nginx -p $nginxPrefix -c 'conf/local-preview.conf' -s quit 2>&1 | ForEach-Object { Write-Host "$_" }
        } catch { Write-Warning "Nginx graceful quit failed: $_" }
        finally { $ErrorActionPreference = $savedPreference }
        Start-Sleep -Milliseconds 500
    }
    foreach ($item in $owned | Sort-Object CreationDate -Descending) { Stop-VerifiedProcess $item }
    # Drain children spawned just before their parent was stopped.
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $snapshot = @(Get-CimInstance Win32_Process)
        $remaining = @(Get-OwnedProcesses $snapshot)
        foreach ($item in $remaining) { Stop-VerifiedProcess $item }
        if (@(Get-ProjectListeners).Count -eq 0 -and $remaining.Count -eq 0) {
            Write-Host 'Project services stopped; all project ports are free.'
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Project ports did not become free within 20 seconds. Startup was cancelled.'
}

function Start-SimCareService([string]$Name, [int]$Port, [string[]]$Arguments) {
    $absoluteArguments = @(
        foreach ($argument in $Arguments) {
            if ($argument -match '\.py$') { '"' + (Join-Path $root $argument) + '"' }
            else { $argument }
        }
    )
    $previousWorkerId = $env:SIMCARE_WORKER_ID
    try {
        $env:SIMCARE_WORKER_ID = [string]($Port % 1024)
        $process = Start-Process -FilePath $python -ArgumentList $absoluteArguments `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logs "$Name.log") `
            -RedirectStandardError (Join-Path $logs "$Name.err")
    } finally { $env:SIMCARE_WORKER_ID = $previousWorkerId }
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $process.Refresh()
        if ($process.HasExited) { throw "$Name exited. See logs/$Name.err." }
        $listeners = @(Get-ProjectListeners | Where-Object { $_.LocalPort -eq $Port })
        if ($listeners.Count -gt 0) {
            $snapshot = @(Get-CimInstance Win32_Process)
            Assert-OwnedListeners $listeners @(Get-OwnedProcesses $snapshot) $snapshot
            Write-Host "$Name ready"
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name timed out. See logs/$Name.err."
}

$restartLock = $null
$starting = $false
try {
    if (-not $DeploymentLockHeld) {
        $null = New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force
        try { $restartLock = [IO.File]::Open((Join-Path $root 'data\deployment.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { throw 'Another deployment/restart is running, or this account cannot access data/deployment.lock.' }
    }
    . (Join-Path $root 'CondaEnv.ps1')
    $envPath = Get-SimCareCondaEnvPath $root
    $condaPython = Join-Path $envPath 'python.exe'
    $venvPython = Join-Path $root '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $condaPython) {
        Enter-SimCareCondaEnv $envPath
        $python = $condaPython
    } elseif (Test-Path -LiteralPath $venvPython) { $python = $venvPython }
    else { throw 'No project Python environment found. Run Install.ps1 first.' }
    $pythonPaths = @($python, $condaPython, (Join-Path $root '.conda-env\python.exe'), $venvPython) |
        ForEach-Object { Normalize-WindowsPath $_ } | Select-Object -Unique
    $nginx = Join-Path $root 'nginx\nginx.exe'
    $nginxPrefix = (Join-Path $root 'nginx').Replace('\', '/') + '/'
    $logs = Join-Path $root 'logs'
    foreach ($required in @($nginx, (Join-Path $root 'nginx\conf\local-preview.conf'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing prerequisite: $required" }
    }
    if (-not $StopOnly) {
        foreach ($relative in $serviceScripts) {
            if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) { throw "Missing service script: $relative" }
        }
        foreach ($relative in @('logs', 'nginx/logs', 'nginx/temp/client_body_temp', 'nginx/temp/proxy_temp', 'nginx/temp/fastcgi_temp', 'nginx/temp/uwsgi_temp', 'nginx/temp/scgi_temp')) {
            $null = New-Item -ItemType Directory -Path (Join-Path $root $relative) -Force
        }
        & $nginx -p $nginxPrefix -c 'conf/local-preview.conf' -t
        if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed before restart.' }
    }
    Stop-ProjectServices
    if ($StopOnly) { return }
    $starting = $true
    $env:PYTHONUTF8 = '1'
    Start-SimCareService 'chest' 28765 @('backend/main/engine_runner.py', 'backend/engines/chest/server.py', '--host', '127.0.0.1', '--port', '28765')
    Start-SimCareService 'lumbar' 28770 @('backend/main/engine_runner.py', 'backend/engines/lumbar/server.py', '--port', '28770')
    Start-SimCareService 'ascites' 28771 @('backend/engines/ascites/server.py', '--port', '28771')
    Start-SimCareService 'uyghur' 28894 @('backend/engines/uyghur/server.py', '--host', '127.0.0.1', '--port', '28894')
    Start-SimCareService 'en-chest' 28891 @('backend/extensions/english/site/chest_engine/server.py', '--port', '28891')
    Start-SimCareService 'en-lumbar' 28892 @('backend/extensions/english/site/lumbar_engine/server.py', '--port', '28892')
    Start-SimCareService 'en-ascites' 28893 @('backend/extensions/english/site/ascites_engine/server.py', '--port', '28893')
    Start-SimCareService 'api' 28876 @('server.py')
    $healthy = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { $healthy = [bool](Invoke-RestMethod 'http://127.0.0.1:28876/health' -TimeoutSec 3).ok } catch { $healthy = $false }
        if ($healthy) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) { throw 'Backend health check failed.' }
    $null = Start-Process -FilePath $nginx -ArgumentList @('-p', ('"' + $nginxPrefix + '"'), '-c', 'conf/local-preview.conf') `
        -WorkingDirectory (Join-Path $root 'nginx') -WindowStyle Hidden -PassThru
    $portalReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { $portalReady = (Invoke-WebRequest 'http://127.0.0.1:8080/portal.html' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
        catch { $portalReady = $false }
        if ($portalReady) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $portalReady) { throw 'Portal check failed.' }
    $snapshot = @(Get-CimInstance Win32_Process)
    $listeners = @(Get-ProjectListeners)
    Assert-OwnedListeners $listeners @(Get-OwnedProcesses $snapshot) $snapshot
    foreach ($port in $ports) {
        if ($port -notin @($listeners | ForEach-Object LocalPort)) { throw "Service on port $port exited during startup." }
    }
    $starting = $false
    Write-Host 'Ready: http://127.0.0.1:8080/portal.html'
    if (-not $NoBrowser) {
        try { Start-Process 'http://127.0.0.1:8080/portal.html' }
        catch { Write-Warning 'Services are ready, but the browser could not be opened.' }
    }
} catch {
    $failure = $_
    if ($starting) {
        Write-Warning 'Startup failed; cleaning up this installation''s partially started services.'
        try {
            $snapshot = @(Get-CimInstance Win32_Process)
            foreach ($item in (Get-OwnedProcesses $snapshot | Sort-Object CreationDate -Descending)) { Stop-VerifiedProcess $item }
        } catch { Write-Warning "Cleanup failed: $_" }
    }
    Write-Error -ErrorRecord $failure -ErrorAction Continue
    exit 1
} finally {
    if ($restartLock) { $restartLock.Dispose() }
}
