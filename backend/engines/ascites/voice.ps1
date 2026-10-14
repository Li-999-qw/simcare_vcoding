param([ValidateSet('info','recognize','synthesize')][string]$Action='info',[string]$OutputPath='')
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
try {
    if ($Action -eq 'info') {
        $recognizers=@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name })
        $synth=[System.Speech.Synthesis.SpeechSynthesizer]::new()
        $voices=@($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Culture.Name })
        $synth.Dispose()
        @{recognizers=$recognizers;voices=$voices} | ConvertTo-Json -Compress
    } elseif ($Action -eq 'recognize') {
        $recognizer=[System.Speech.Recognition.SpeechRecognitionEngine]::new([System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
        $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
        $recognizer.SetInputToDefaultAudioDevice()
        $recognizer.InitialSilenceTimeout=[TimeSpan]::FromSeconds(10)
        $recognizer.EndSilenceTimeout=[TimeSpan]::FromSeconds(1)
        $result=$recognizer.Recognize([TimeSpan]::FromSeconds(15))
        if ($null -eq $result) { @{text='';error='no_speech'} | ConvertTo-Json -Compress }
        else { @{text=$result.Text;confidence=$result.Confidence} | ConvertTo-Json -Compress }
        $recognizer.Dispose()
    } else {
        $payload=[Console]::In.ReadToEnd() | ConvertFrom-Json
        $synth=[System.Speech.Synthesis.SpeechSynthesizer]::new()
        $voice=$synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
        if ($null -ne $voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
        $synth.SetOutputToWaveFile($OutputPath)
        $synth.Speak([string]$payload.text)
        $synth.Dispose()
        @{ok=$true} | ConvertTo-Json -Compress
    }
} catch { @{error='windows_speech_unavailable'} | ConvertTo-Json -Compress; exit 1 }
