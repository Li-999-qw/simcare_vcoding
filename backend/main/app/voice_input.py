"""Authenticated gateway calls this for browser-recorded PCM audio only."""
import asyncio,io,json,subprocess,wave
from pathlib import Path
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
import threading

LIMIT=3_840_044
SLOTS=threading.BoundedSemaphore(2)
PYTHON=Path(__import__('sys').executable)
WORKER=Path(__file__).resolve().parents[1]/'voice_worker.py'

def decode(data):
    if not SLOTS.acquire(blocking=False):raise HTTPException(429,'语音转写繁忙，请稍后重试。')
    try:
        try:
            result=subprocess.run([str(PYTHON),str(WORKER)],input=data,capture_output=True,timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode:raise ValueError('worker failed')
            value=json.loads(result.stdout.decode('utf-8'))
            if not isinstance(value.get('text'),str):raise ValueError('invalid result')
        except (subprocess.SubprocessError,ValueError,OSError):
            raise HTTPException(503,'本地语音转写未完成，请重试。') from None
        if not value['text'].strip():raise HTTPException(422,'未识别到清晰语音，请靠近麦克风重试。')
        return {'text':value['text'].strip()}
    finally:SLOTS.release()

async def transcribe(request):
    if request.headers.get('content-type','').split(';')[0]!='audio/wav':raise HTTPException(415,'请提交WAV录音。')
    data=bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data)>LIMIT:raise HTTPException(413,'单次语音最长120秒。')
    try:
        with wave.open(io.BytesIO(data),'rb') as wav:
            count=wav.getnframes()
            if wav.getnchannels()!=1 or wav.getsampwidth()!=2 or wav.getframerate()!=16000 or not 1600<=count<=1_920_000 or len(wav.readframes(count))!=count*2:raise ValueError()
    except (wave.Error,EOFError,ValueError):raise HTTPException(422,'录音过短或格式无效，请重新录音。') from None
    return await run_in_threadpool(decode,bytes(data))
