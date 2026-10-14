"""Local SenseVoice dictation: microphone audio stays in memory on this computer."""
import sys,threading,secrets,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tmp'/'voice-runtime'))
MODEL=ROOT/'tmp'/'voice-models'/'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
LOCK=threading.RLock()
ENGINE_LOCK=threading.Lock()
JOBS={}
ACTIVE=None
ENGINE=None

def engine():
    global ENGINE
    import sherpa_onnx
    if ENGINE is None:
        ENGINE=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(MODEL/'model.int8.onnx'),tokens=str(MODEL/'tokens.txt'),num_threads=4,use_itn=True,language='zh',provider='cpu')
    return ENGINE

def transcribe(samples,rate=16000):
    with ENGINE_LOCK:
        e=engine();s=e.create_stream();s.accept_waveform(rate,samples);e.decode_stream(s);return s.result.text.strip()

def warm():
    try:
        with ENGINE_LOCK:engine()
    except Exception:pass

def start(sid,role):
    global ACTIVE
    with LOCK:
        if ACTIVE and ACTIVE['status'] in ('starting','listening','transcribing'):raise ValueError('语音正在处理，请结束当前录音后再试。')
        job={'id':secrets.token_hex(12),'owner':sid,'role':role,'status':'starting','text':'','_cancel':threading.Event()}
        JOBS[sid]=job;ACTIVE=job
    def record():
        try:
            import numpy as np
            import sounddevice as sd
            with ENGINE_LOCK:engine()
            if job['_cancel'].is_set():return
            frames=[];heard=False;silence=0;start_time=time.monotonic()
            with sd.InputStream(samplerate=16000,channels=1,dtype='float32',blocksize=1600) as mic:
                with LOCK:
                    if job['_cancel'].is_set():return
                    job['status']='listening'
                while not job['_cancel'].is_set() and time.monotonic()-start_time<30:
                    chunk,overflow=mic.read(1600)
                    if overflow:raise RuntimeError('音频采集过载，请关闭占用麦克风的软件后重试。')
                    frames.append(chunk[:,0].copy())
                    if float(np.sqrt(np.mean(chunk**2)))>0.009:heard=True;silence=0
                    elif heard:silence+=1
                    if heard and silence>=10:break
                    if not heard and time.monotonic()-start_time>8:break
            if job['_cancel'].is_set():return
            if not heard:raise RuntimeError('没有听到清晰语音，请靠近默认麦克风后重试。')
            with LOCK:job['status']='transcribing'
            started=time.monotonic();text=transcribe(np.concatenate(frames))
            with LOCK:
                if job['_cancel'].is_set():return
                if not text:raise RuntimeError('未识别到文字，请重试。')
                job.update(status='done',text=text,decode_seconds=round(time.monotonic()-started,2))
        except Exception as exc:
            with LOCK:
                if job['status']!='cancelled':job.update(status='error',error=str(exc) if isinstance(exc,RuntimeError) else '本地语音识别失败，请检查默认麦克风和Windows麦克风权限。')
    threading.Thread(target=record,daemon=True).start()
    return public(sid)

def public(sid):
    with LOCK:return {k:v for k,v in JOBS.get(sid,{'status':'idle'}).items() if not k.startswith('_') and k!='owner'}

def cancel(sid):
    with LOCK:
        job=JOBS.get(sid)
        if job and job['status'] in ('starting','listening','transcribing'):
            job['_cancel'].set();job['status']='cancelled'
        return public(sid)
