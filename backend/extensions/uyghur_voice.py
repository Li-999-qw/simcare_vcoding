"""Extend the existing authenticated voice endpoint with explicit language choice."""
import io,json,subprocess,threading,wave
from pathlib import Path
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
ROOT=Path(__file__).resolve().parent
SLOT=threading.BoundedSemaphore(1)
PYTHON=Path(__import__('sys').executable)

def decode(data,language):
    if not SLOT.acquire(blocking=False):raise HTTPException(429,'语音转写繁忙，请稍后重试。')
    try:
        try:
            result=subprocess.run([str(PYTHON),str(ROOT/'uyghur_voice_worker.py'),language],input=data,capture_output=True,timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode:raise ValueError('recognizer unavailable')
            text=json.loads(result.stdout.decode('utf-8'))['text'].strip()
        except (subprocess.SubprocessError,OSError,ValueError,KeyError):
            raise HTTPException(503,'语音转写未完成，请缩短录音后重试。') from None
        if not text:raise HTTPException(422,'未识别到清晰语音，请重新录音。')
        return {'text':text,'language':language}
    finally:SLOT.release()

def install():
    from app import voice_input
    original=voice_input.transcribe
    async def transcribe(request):
        # Called only after the training gateway verifies ownership and stage.
        # The persisted case, not a browser parameter or display name, selects ASR.
        from app.db import SessionLocal
        from app.portal_models import PortalAttempt
        from app.portal_api import document
        parts=request.url.path.strip('/').split('/')
        if parts and parts[0]=='en':parts=parts[1:]
        language='zh'
        if len(parts)>=3 and parts[0]=='training':
            with SessionLocal() as db:
                attempt=db.get(PortalAttempt,parts[1])
                if attempt:
                    case=next((c for c in document(db).data['cases'] if c['id']==attempt.case_id),{})
                    if case.get('sourceCaseId')=='SIM-AMI-20260901-UG':language='ug'
        if language=='zh':return await original(request)
        if request.headers.get('content-type','').split(';')[0]!='audio/wav':raise HTTPException(415,'请提交WAV录音')
        data=bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data)>960_044:raise HTTPException(413,'本语音输入每次最多30秒，请分段录音。')
        try:
            with wave.open(io.BytesIO(data),'rb') as wav:
                n=wav.getnframes()
                if wav.getnchannels()!=1 or wav.getsampwidth()!=2 or wav.getframerate()!=16000 or not 1600<=n<=480000 or len(wav.readframes(n))!=n*2:raise ValueError()
        except (wave.Error,EOFError,ValueError):raise HTTPException(422,'录音格式无效或过短，请重试。') from None
        return await run_in_threadpool(decode,bytes(data),language)
    voice_input.transcribe=transcribe
