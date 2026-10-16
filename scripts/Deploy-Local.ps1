param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DeployDir
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\')
$target = (Resolve-Path -LiteralPath $DeployDir).Path.TrimEnd('\')
if ($source -eq $target -or
    $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Checkout and deployment directories must be separate and must not contain each other.'
}
if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) {
    throw 'A drive root cannot be a deployment directory.'
}

function Test-ProtectedPath([string]$RelativePath) {
    $name = $RelativePath.Replace('\', '/')
    return (
        $name -match '^(?:\.git|\.github|\.venv|\.conda-env|\.idea|\.agents|\.codex|data|logs|certs)(?:/|$)' -or
        $name -match '(?:^|/)(?:__pycache__|\.secrets)(?:/|$)' -or
        $name -match '(?:^|/)\.env(?:\..*)?$' -or
        $name -match '\.(?:pyc|pyo|db|sqlite|sqlite3|log|pid)$' -or
        $name -match '^application\.ya?ml$' -or
        $name -match '^nginx/(?:logs|temp)(?:/|$)' -or
        $name -match '(?:^|/)uploads(?:/|$)' -or
        $name -match '^backend/extensions/backups(?:/|$)' -or
        $name -match '^backend/engines/(?:tmp|[^/]+/runtime)(?:/|$)' -or
        $name -match '^backend/extensions/english/site/[^/]+_engine/runtime(?:/|$)' -or
        $name -eq 'backend/runtime/role-models.json' -or
        $name -match '^[^/]+\.zip$'
    )
}

function Get-SafePath([string]$Base, [string]$RelativePath) {
    if (-not $RelativePath -or [IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath -match '(^|[/\\])\.\.([/\\]|$)' -or $RelativePath.Contains(':')) {
        throw 'Invalid managed deployment path.'
    }
    $path = [IO.Path]::GetFullPath((Join-Path $Base $RelativePath))
    if (-not $path.StartsWith($Base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Managed deployment path escapes its directory.'
    }
    $ancestor = $path
    while ($ancestor -and $ancestor.Length -ge $Base.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Deployment cannot copy through a junction or symbolic link: $ancestor"
            }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    return $path
}

function Get-ContentHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($sha.ComputeHash($stream)) }
    finally { $sha.Dispose(); $stream.Dispose() }
}

# The fixed installation must already have its machine-local environment and credentials.
foreach ($required in @('application.yml', 'data/server.json', 'nginx/nginx.exe')) {
    $path = Get-SafePath $target $required
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Deployment prerequisite missing: $path. Initialize this installation first."
    }
}

$previousConsoleEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $revision = & git -C $source rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the checked-out commit.' }
    $tracked = @(& git -C $source -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0) { throw 'Could not list source files.' }
} finally { [Console]::OutputEncoding = $previousConsoleEncoding }
$managed = @($tracked | Where-Object { -not (Test-ProtectedPath $_) })
foreach ($required in @('Restart-Local.cmd', 'Restart-Local.ps1', 'CondaEnv.ps1', 'server.py',
    'backend/main/engine_runner.py', 'backend/engines/chest/server.py',
    'backend/engines/lumbar/server.py', 'backend/engines/ascites/server.py',
    'backend/engines/uyghur/server.py',
    'backend/extensions/english/site/chest_engine/server.py',
    'backend/extensions/english/site/lumbar_engine/server.py',
    'backend/extensions/english/site/ascites_engine/server.py', 'nginx/conf/local-preview.conf')) {
    if ($required -notin $managed) { throw "Source checkout has no tracked $required." }
}
# Fail on invalid PowerShell before stopping the running installation.
foreach ($relative in @('Restart-Local.ps1', 'CondaEnv.ps1')) {
    $parseErrors = $null; $parseTokens = $null
    $null = [Management.Automation.Language.Parser]::ParseFile((Get-SafePath $source $relative), [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "Invalid source script ${relative}: $($parseErrors | Out-String)" }
}
$manifestPath = Get-SafePath $target 'data/deployment-manifest.json'
$lockPath = Get-SafePath $target 'data/deployment.lock'
try { $deploymentLock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw 'Another deployment/restart is running, or the Runner cannot access data/deployment.lock.' }
try {
    $previousFiles = @()
    if (Test-Path -LiteralPath $manifestPath) {
        $manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($manifest.version -ne 1) { throw 'Unknown deployment manifest version.' }
        $previousFiles = @($manifest.files)
    }
    # Validate every destination, including stale entries, before changing any files.
    foreach ($relative in $managed) {
        $from = Get-SafePath $source $relative
        if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "Source file is missing: $relative" }
        $null = Get-SafePath $target $relative
    }
    foreach ($relative in $previousFiles) {
        if (-not (Test-ProtectedPath $relative)) { $null = Get-SafePath $target $relative }
    }
    # Use the NEW restart implementation to stop the OLD installation. This
    # also migrates legacy relative-path processes on the very first update.
    Write-Host 'Stopping the existing installation before copying code...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $source 'Restart-Local.ps1') `
        -ProjectRoot $target -StopOnly -NoBrowser -DeploymentLockHeld
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the existing installation. No project code was copied.' }

    foreach ($relative in $managed) {
        $from = Get-SafePath $source $relative
        $to = Get-SafePath $target $relative
        # Skip unchanged files; services are already stopped at this point.
        if (Test-Path -LiteralPath $to -PathType Leaf) {
            if ((Get-ContentHash $from) -eq (Get-ContentHash $to)) { continue }
        }
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force
        Copy-Item -LiteralPath $from -Destination $to -Force
    }
    foreach ($relative in $previousFiles) {
        if ($relative -notin $managed -and -not (Test-ProtectedPath $relative)) {
            $stale = Get-SafePath $target $relative
            if (Test-Path -LiteralPath $stale -PathType Leaf) { Remove-Item -LiteralPath $stale -Force }
        }
    }
    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($manifestPath, (@{version = 1; files = $managed} | ConvertTo-Json -Depth 4), $encoding)

    $previousTrackingId = $env:RUNNER_TRACKING_ID
    try {
        # GitHub's job cleanup must not terminate the deployed service processes.
        Remove-Item Env:RUNNER_TRACKING_ID -ErrorAction SilentlyContinue
        Push-Location $target
        try {
            & (Join-Path $target 'Restart-Local.cmd') '--non-interactive' '--deployment-lock-held'
            if ($LASTEXITCODE -ne 0) { throw "Restart-Local.cmd failed with exit code $LASTEXITCODE. Check $target\logs." }
        } finally { Pop-Location }
    } finally {
        if ($null -ne $previousTrackingId) { $env:RUNNER_TRACKING_ID = $previousTrackingId }
    }
    $result = @{commit = $revision; deployed_at = [DateTime]::UtcNow.ToString('o'); directory = $target}
    [IO.File]::WriteAllText((Get-SafePath $target 'data/deployment.json'), ($result | ConvertTo-Json), $encoding)
    Write-Host "Deployed $revision to $target"
} finally { $deploymentLock.Dispose() }
