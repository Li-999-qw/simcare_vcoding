param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
if($root -match '[^\x00-\x7F]'){throw 'Use an English installation path, e.g. C:\SimCare'}
. (Join-Path $root 'CondaEnv.ps1')
$envPath=Get-SimCareCondaEnvPath $root
$python=Join-Path $envPath 'python.exe'
if(-not(Test-Path $python)){throw 'Run Install.ps1 first to create the Conda environment'}
Enter-SimCareCondaEnv $envPath
foreach($file in @('certs/server.pem','certs/server-key.pem')){if(-not(Test-Path "$root/$file")){throw "Missing domain certificate file: $file"}}
& $python "$root/configure_nginx.py"
if($LASTEXITCODE -ne 0){throw 'Certificate/configuration validation failed'}
& "$root/nginx/nginx.exe" -p "$root/nginx/" -t
if($LASTEXITCODE -ne 0){throw 'Nginx certificate/configuration check failed'}
$env:PYTHONUTF8='1'
New-Item -ItemType Directory -Force "$root/logs" | Out-Null
function Launch([string]$Name,[int]$Port,[string[]]$Arguments){
 $listener=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
 if($listener){
  $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
  if($owner.ExecutablePath -ne $python -or $owner.CommandLine -notlike ('*'+$root+'*')){
   throw "Port $Port is occupied by another application or an older Python environment. Run Stop.ps1 before starting."
  }
  Write-Host "$Name already running";return
 }
 $previousWorkerId=$env:SIMCARE_WORKER_ID
 $env:SIMCARE_WORKER_ID=[string]($Port % 1024)
 $p=Start-Process -FilePath $python -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$root/logs/$Name.log" -RedirectStandardError "$root/logs/$Name.err"
 $env:SIMCARE_WORKER_ID=$previousWorkerId
 for($i=0;$i -lt 60;$i++){
  if($p.HasExited){throw "$Name failed; see logs/$Name.err"}
  if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){Write-Host "$Name ready";return}
  Start-Sleep -Milliseconds 500
 }
 throw "$Name startup timed out; see logs"
}
foreach($entry in @(@('chest',28765),@('lumbar',28770),@('ascites',28771),@('uyghur',28894))){
 $name=$entry[0];$args=@(('"'+$root+'/backend/engines/'+$name+'/server.py"'),'--host','127.0.0.1','--port',[string]$entry[1])
 if($name -in @('ascites','lumbar')){$args=@(('"'+$root+'/backend/engines/'+$name+'/server.py"'),'--port',[string]$entry[1])}
 if($name -in @('chest','lumbar')){$args=@(('"'+$root+'/backend/main/engine_runner.py"'))+$args}
 Launch $name $entry[1] $args
}
foreach($entry in @(@('chest',28891),@('lumbar',28892),@('ascites',28893))){Launch ('en-'+$entry[0]) $entry[1] @(('"'+$root+'/backend/extensions/english/site/'+$entry[0]+'_engine/server.py"'),'--port',[string]$entry[1])}
Launch 'api' 28876 @(('"'+$root+'/server.py"'))
$health=Invoke-RestMethod 'http://127.0.0.1:28876/health'
if(-not $health.ok){throw 'Backend health check failed'}
$listener=Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue
if($listener){
 $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
 if($owner.ExecutablePath -ne "$root\nginx\nginx.exe"){throw 'Port 443 is occupied by another application'}
 & "$root/nginx/nginx.exe" -p "$root/nginx/" -s reload
}else{Start-Process -FilePath "$root/nginx/nginx.exe" -ArgumentList @('-p',('"'+$root+'/nginx/"')) -WorkingDirectory "$root/nginx" -WindowStyle Hidden}
Write-Host 'Ready: https://www.simcare.top/portal.html'
if(-not $NoBrowser){Start-Process 'https://www.simcare.top/portal.html'}
