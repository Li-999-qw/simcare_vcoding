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
    if u.role != 'admin': raise HTTPException(403,'仅管理员可管理模型')
    return u

class Choice(BaseModel):
    provider: Literal['codex','openai','bailian']
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
    persona: str | None = Field(default=None,max_length=16000)
    image_data: str | None = Field(default=None,max_length=12000000)
    role: Literal['patient','senior']
    config: Choice
    text: str = Field(min_length=1,max_length=2000)
    history: list[Turn] = Field(default_factory=list,max_length=20)

@router.get('/admin/models')
def page(u=Depends(admin)):
    return FileResponse(ROOT/'app/model-admin.html')

@router.get('/admin/api/models')
def config(u=Depends(admin)):
    return {**read_config(),'api_configured':bool(api_key())}

def secure_admin(request:Request,u=Depends(admin)):
    if request.url.scheme != 'https':
        raise HTTPException(400,'请通过 HTTPS 页面配置 API 密钥')
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
        raise HTTPException(400,'请输入有效的 OpenAI API 密钥（以 sk- 开头），不要填写账号密码')
    with LOCK:
        if action=='delete' and any(read_config()[r]['provider']=='openai' for r in ('patient','senior')):
            raise HTTPException(409,'请先将正在使用 API 的角色切回 Codex 并保存，再删除密钥')
        try: save_key(key.strip() if action=='save' else '')
        except Exception: raise HTTPException(500,'密钥保存失败，请检查服务器存储权限')
        db.add(AuditEvent(actor_id=u.id,action='api_credential_'+action,target='openai',detail={}));db.commit()
    response.headers['Cache-Control']='no-store'
    return {'api_configured':action=='save'}

@router.post('/admin/api/models/credential/check')
def check_credential(response:Response,u=Depends(secure_admin)):
    key=api_key()
    if not key: raise HTTPException(400,'请先保存 API 密钥')
    try:
        with httpx.Client(timeout=20,follow_redirects=False) as client:
            result=client.get('https://api.openai.com/v1/models',headers={'Authorization':'Bearer '+key})
        if result.status_code!=200:
            reason={401:'密钥无效或已失效',403:'密钥权限或访问区域不允许此请求',429:'接口限流或额度受限'}.get(result.status_code,'服务暂时不可用')
            raise HTTPException(400,f'连接验证失败：{reason}（HTTP {result.status_code}）')
    except httpx.HTTPError:
        raise HTTPException(502,'无法连接 OpenAI，请检查服务器网络后重试')
    response.headers['Cache-Control']='no-store'
    return {'ok':True,'message':'已连接 OpenAI，密钥可访问模型列表。具体模型权限及计费可用性请再用对答测试确认。'}

@router.post('/admin/api/models')
def save(d:Config,u=Depends(admin),db=Depends(get_db)):
    if any(c.provider=='bailian' for c in [d.patient,d.senior]):
        from bailian_runtime import key
        if not key():raise HTTPException(400,'请先在百炼配置页保存密钥')
    with LOCK:
        old=read_config()
        if d.revision != old['revision']: raise HTTPException(409,'设置已被其他管理员更新，请刷新页面')
        if any(c.provider=='openai' for c in [d.patient,d.senior]) and not api_key():
            raise HTTPException(400,'服务器尚未配置 OPENAI_API_KEY，不能启用 API 模型')
        value=d.model_dump();value['revision']+=1
        save_config(value)
        db.add(AuditEvent(actor_id=u.id,action='role_models_changed',target='role_models',detail={'before':old,'after':value}));db.commit()
    return value

@router.post('/admin/api/models/test')
async def test(d:Probe,u=Depends(admin)):
    if d.image_data:
        if d.role!='senior':raise HTTPException(400,'患者测试不接收图片')
        from bailian_runtime import image_url,VISION_MODELS
        if d.config.provider!='bailian' or d.config.model not in VISION_MODELS:raise HTTPException(400,'图片测试请选择支持视觉的百炼模型')
        if not d.image_data.startswith(("data:image/png;base64,","data:image/jpeg;base64,")):raise HTTPException(400,"请选择PNG或JPEG图片")
        try:image_url(d.image_data)
        except Exception:raise HTTPException(400,'请选择8MB以内的PNG或JPEG图片')
    if TEST_LOCK.locked(): raise HTTPException(429,'已有模型测试进行中，请稍后再试')
    if d.config.provider=='openai' and not api_key(): raise HTTPException(400,'服务器尚未配置 OPENAI_API_KEY')
    async with TEST_LOCK:
        proc=await asyncio.create_subprocess_exec(sys.executable,str(ROOT/'model_probe.py'),
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,cwd=str(ROOT),env={**os.environ,'PYTHONIOENCODING':'utf-8'})
        try:
            out,err=await asyncio.wait_for(proc.communicate(json.dumps(d.model_dump(),ensure_ascii=False).encode()),125)
        except asyncio.TimeoutError:
            proc.kill();await proc.wait();raise HTTPException(504,'模型测试超时，请更换配置后重试')
        try: value=json.loads(out.decode('utf-8'))
        except Exception: raise HTTPException(502,'测试进程未正常完成，请检查服务器日志')
        if 'error' in value: raise HTTPException(502,value['error'])
        return value
