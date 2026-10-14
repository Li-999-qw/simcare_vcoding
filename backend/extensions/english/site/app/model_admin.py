import asyncio, json, os, re, sys, threading
from pathlib import Path
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from .portal_api import actor
from .db import get_db
from .models import AuditEvent
from role_runtime import ROOT, CONFIG, read_config, save_config, api_key
from credential_store import save as save_key
import httpx

router = APIRouter()
LOCK = threading.Lock()
TEST_LOCK = asyncio.Lock()

def admin(u=Depends(actor)):
    if u.role != 'admin': raise HTTPException(403,'Only Administrators can manage models')
    return u

class Choice(BaseModel):
    provider: Literal['codex','openai']
    model: str = Field(min_length=1,max_length=100,pattern=r'^[a-zA-Z0-9_.:-]+$')
    effort: Literal['none','minimal','low','medium','high'] = 'low'

class Config(BaseModel):
    revision: int
    patient: Choice
    senior: Choice

class Turn(BaseModel):
    speaker: Literal['student','assistant']
    text: str = Field(max_length=3000)

class Probe(BaseModel):
    role: Literal['patient','senior']
    config: Choice
    text: str = Field(min_length=1,max_length=2000)
    history: list[Turn] = Field(default_factory=list,max_length=20)

@router.get('/admin/models')
def page(u=Depends(admin)):
    return FileResponse(Path(__file__).parent/'model-admin.html')

@router.get('/admin/api/models')
def config(u=Depends(admin)):
    return {**read_config(),'api_configured':bool(api_key())}

def secure_admin(request:Request,u=Depends(admin)):
    if request.url.scheme != 'https':
        raise HTTPException(400,'Please use HTTPS Page configuration API Key')
    return u

@router.post('/admin/api/models/credential')
async def credential(request:Request,response:Response,u=Depends(secure_admin),db=Depends(get_db)):
    # Manual validation deliberately avoids framework errors echoing secret input.
    try:
        raw=await request.body()
        if len(raw)>8192: raise ValueError()
        d=json.loads(raw)
        key=d.get('api_key')
        action=d.get('action','save')
        if action not in ('save','delete'): raise ValueError()
        if action=='save' and (not isinstance(key,str) or not re.fullmatch(r'sk-[A-Za-z0-9_-]{10,1000}',key.strip())): raise ValueError()
    except Exception:
        raise HTTPException(400,'Please enter a valid OpenAI API Key (with sk- starts with); do not enter account credentials')
    with LOCK:
        if action=='delete' and any(read_config()[r]['provider']=='openai' for r in ('patient','senior')):
            raise HTTPException(409,'Please first move the one currently in use API Switch role back for Codex and save, then delete the key')
        try: save_key(key.strip() if action=='save' else '')
        except Exception: raise HTTPException(500,'Failed to save the key. Check the server’s storage permissions')
        db.add(AuditEvent(actor_id=u.id,action='api_credential_'+action,target='openai',detail={}));db.commit()
    response.headers['Cache-Control']='no-store'
    return {'api_configured':action=='save'}

@router.post('/admin/api/models/credential/check')
def check_credential(response:Response,u=Depends(secure_admin)):
    key=api_key()
    if not key: raise HTTPException(400,'Please Save First API Key')
    try:
        with httpx.Client(timeout=20,follow_redirects=False) as client:
            result=client.get('https://api.openai.com/v1/models',headers={'Authorization':'Bearer '+key})
        if result.status_code!=200:
            reason={401:'Invalid or expired key',403:'Key permissions or access region do not allow this request',429:'API rate limit or quota restriction'}.get(result.status_code,'Service temporarily unavailable')
            raise HTTPException(400,f'Connection verification failed：{reason}（HTTP {result.status_code}）')
    except httpx.HTTPError:
        raise HTTPException(502,'Unable to Connect OpenAI，Please check the server’s network connection and try again')
    response.headers['Cache-Control']='no-store'
    return {'ok':True,'message':'Connected OpenAI，The key can access the model list. Confirm permissions for specific models and billing availability with another chat test.。'}

@router.post('/admin/api/models')
def save(d:Config,u=Depends(admin),db=Depends(get_db)):
    with LOCK:
        old=read_config()
        if d.revision != old['revision']: raise HTTPException(409,'Settings have been updated by another Administrator. Refresh the page')
        if any(c.provider=='openai' for c in [d.patient,d.senior]) and not api_key():
            raise HTTPException(400,'Server not configured yet OPENAI_API_KEY，Cannot enable API Model')
        value=d.model_dump();value['revision']+=1
        save_config(value)
        db.add(AuditEvent(actor_id=u.id,action='role_models_changed',target='role_models',detail={'before':old,'after':value}));db.commit()
    return value

@router.post('/admin/api/models/test')
async def test(d:Probe,u=Depends(admin)):
    if TEST_LOCK.locked(): raise HTTPException(429,'A model test is already in progress. Please try again later.')
    if d.config.provider=='openai' and not api_key(): raise HTTPException(400,'Server not configured yet OPENAI_API_KEY')
    async with TEST_LOCK:
        proc=await asyncio.create_subprocess_exec(sys.executable,str(Path(__file__).resolve().parents[2]/'model_probe_en.py'),
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,cwd=str(ROOT),env={**os.environ,'PYTHONIOENCODING':'utf-8'})
        try:
            out,err=await asyncio.wait_for(proc.communicate(json.dumps(d.model_dump(),ensure_ascii=False).encode()),125)
        except asyncio.TimeoutError:
            proc.kill();await proc.wait();raise HTTPException(504,'Model test timed out. Please change the configuration and try again.')
        try: value=json.loads(out.decode('utf-8'))
        except Exception: raise HTTPException(502,'The test process did not complete normally. Check the server logs')
        if 'error' in value: raise HTTPException(502,value['error'])
        return value
