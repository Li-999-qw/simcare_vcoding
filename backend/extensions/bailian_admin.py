"""Administrator-only setup; key input is never returned or placed in logs."""
import json,re,threading
from pathlib import Path
from fastapi import APIRouter,Depends,HTTPException,Request
from fastapi.responses import FileResponse
from app.model_admin import admin,secure_admin
from role_runtime import CONFIG,read_config,save_config
from bailian_runtime import key,save_key,generate
from backend.runtime.settings_store import read_setting,save_setting
router=APIRouter();lock=threading.Lock()
@router.get('/admin/bailian')
def page(u=Depends(admin)):
 return FileResponse(Path(__file__).with_name('bailian-admin.html'),headers={'Cache-Control':'no-store'})
@router.get('/admin/api/bailian')
def status(u=Depends(admin)):
 cfg=read_config()
 return {'configured':bool(key()),'active':all(cfg[r]['provider']=='bailian' for r in ('patient','senior')),'patient_model':cfg['patient']['model'],'senior_model':cfg['senior']['model']}
@router.post('/admin/api/bailian')
async def configure(request:Request,u=Depends(secure_admin)):
 try:
  raw=await request.body()
  if len(raw)>8192:raise ValueError()
  data=json.loads(raw);secret=data.get('api_key','').strip();action=data.get('action')
  if action not in ('save','test','activate'):raise ValueError()
  if action=='save' and (not secret or len(secret)>4096 or any(ord(c)<33 or ord(c)>126 for c in secret)):raise ValueError()
 except Exception:raise HTTPException(400,'密钥尚未保存：请粘贴完整密钥，勿包含换行、空格或中文。此提示来自本系统，还未向阿里云验证。')
 if action=='save':
  try:save_key(secret)
  except Exception:raise HTTPException(500,'服务器加密保存失败，请检查服务账号和存储权限；这不代表 API 密钥无效。')
  return {'configured':True,'message':'密钥已加密保存，尚未验证阿里云权限。请点击验证两个模型。'}
 if not key():raise HTTPException(400,'请先保存北京地域的百炼密钥。')
 if action=='test':
  import asyncio
  def probe():
   results=[]
   for model in ('qwen-flash','qwen3.7-plus'):
    visual=model=='qwen3.7-plus'
    prompt='Read the four-digit code in the picture. Return JSON with key code.' if visual else 'Return {"ok":true}.'
    raw,timing=generate({},prompt,'Return JSON only.',{},lambda x:None,model,[str(Path(__file__).parent/'fixtures/vision-check.png')] if visual else None)
    if (str(json.loads(raw).get('code'))!='4826' if visual else json.loads(raw).get('ok') is not True):raise ValueError('Unexpected reply')
    results.append(model+' '+str(timing['total_seconds'])+' 秒')
   return results
  try:results=await asyncio.to_thread(probe)
  except RuntimeError as exc:
   message=str(exc)
   if message.startswith(('百炼 API HTTP ','百炼网络连接失败：')):raise HTTPException(502,message)
   raise HTTPException(502,'百炼未返回完整可用的测试回复，请重试。')
  except Exception:raise HTTPException(502,'未能完成百炼连接验证，请检查网络后重试；不能据此判定密钥无效。')
  return {'message':'连接验证通过：'+ '；'.join(results)}
 with lock:
  cfg=read_config();backup=CONFIG.with_name('role-models.before-bailian.json')
  prior=read_setting('role_models_before_bailian',backup,{})
  if not prior:save_setting('role_models_before_bailian',cfg)
  cfg.update(patient={'provider':'bailian','model':'qwen-flash','effort':'none'},senior={'provider':'bailian','model':'qwen3.7-plus','effort':'none'},revision=cfg['revision']+1)
  save_config(cfg)
 return {'message':'已启用：患者 Flash；上级医师和复盘 qwen3.7-plus（支持图片）。下一次对话生效。'}

@router.get('/admin/api/role-prompts')
def role_prompts(u=Depends(admin)):
 from role_personas import read
 return read()

@router.post('/admin/api/role-prompts')
async def save_role_prompt(request:Request,u=Depends(secure_admin)):
 from role_personas import read,save,LOCK
 try:
  raw=await request.body()
  if len(raw)>100000:raise ValueError()
  d=json.loads(raw)
  if d.get('role') not in ('patient','senior') or not isinstance(d.get('text'),str) or not 1<=len(d['text'])<=16000:raise ValueError()
 except Exception:raise HTTPException(400,'请输入1至16000字的人设提示词')
 with LOCK:
  old=read()
  if d.get('revision')!=old['revision']:raise HTTPException(409,'提示词已更新，请刷新后再保存')
  value={k:v for k,v in old.items() if k in ('revision','patient','senior')}
  value['revision']=old['revision']+1
  value[d['role']]=d['text']
  save(value)
 return value
