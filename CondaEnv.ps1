function Get-SimCareCondaEnvPath([string]$ProjectRoot) {
    $fullRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fullRoot))
    } finally {
        $sha.Dispose()
    }
    $id = [BitConverter]::ToString($bytes, 0, 6).Replace('-', '').ToLowerInvariant()
    $envPath = Join-Path $env:USERPROFILE ".conda\envs\simcare-$id"
    # Keep enough room for deep paths in ONNX Runtime's Windows package.
    if ($envPath.Length -gt 90) {
        throw "Conda environment path is too long: $envPath. Use a shorter Windows account path."
    }
    return $envPath
}

function Enter-SimCareCondaEnv([string]$EnvPath) {
    if (-not (Test-Path -LiteralPath (Join-Path $EnvPath 'python.exe'))) {
        throw "Conda environment is not installed: $EnvPath"
    }
    if (-not (Get-Command conda -ErrorAction SilentlyContinue)) {
        throw 'Conda was not found. Use an Anaconda PowerShell Prompt or add conda to PATH.'
    }
    $hook = & conda shell.powershell hook | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $hook) {
        throw 'Could not initialize Conda for PowerShell.'
    }
    Invoke-Expression $hook
    conda activate $EnvPath
    if (-not $env:CONDA_PREFIX -or
        [IO.Path]::GetFullPath($env:CONDA_PREFIX).TrimEnd('\') -ne [IO.Path]::GetFullPath($EnvPath).TrimEnd('\')) {
        throw "Conda did not activate the expected environment: $EnvPath"
    }
}
