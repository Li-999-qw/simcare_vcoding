[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
try {
 Add-Type -AssemblyName System.Speech
 $r=[System.Speech.Recognition.SpeechRecognitionEngine]::new([System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
 $r.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
 $r.InitialSilenceTimeout=[TimeSpan]::FromSeconds(8)
 $r.EndSilenceTimeout=[TimeSpan]::FromSeconds(0.65)
 $r.EndSilenceTimeoutAmbiguous=[TimeSpan]::FromSeconds(0.9)
 if ($env:CLINICAL_TEST_WAV) { $r.SetInputToWaveFile($env:CLINICAL_TEST_WAV) } else { $r.SetInputToDefaultAudioDevice() }
 @{status='listening'} | ConvertTo-Json -Compress
 $result=$r.Recognize([TimeSpan]::FromSeconds(25))
 if ($null -eq $result) { @{status='error';error='未识别到语音，请靠近麦克风后重试。'} | ConvertTo-Json -Compress }
 else { @{status='done';text=$result.Text;confidence=$result.Confidence} | ConvertTo-Json -Compress }
 $r.Dispose()
} catch { @{status='error';error='本地中文识别未启动，请检查默认麦克风和Windows麦克风权限。'} | ConvertTo-Json -Compress }
