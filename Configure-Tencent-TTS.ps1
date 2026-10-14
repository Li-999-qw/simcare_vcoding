$ErrorActionPreference='Stop'
$root=$PSScriptRoot
. (Join-Path $root 'CondaEnv.ps1')
$envPath=Get-SimCareCondaEnvPath $root
$python=Join-Path $envPath 'python.exe'
if(-not(Test-Path -LiteralPath $python)){throw 'Run Install.ps1 first to create the Conda environment'}
Enter-SimCareCondaEnv $envPath
& $python (Join-Path $root 'configure_tencent_tts.py')
if($LASTEXITCODE -ne 0){throw 'Tencent TTS configuration failed'}
