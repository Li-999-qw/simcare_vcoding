"""Initialize server-local paths and a new signing secret; never imports local credentials."""
import os,sys,json,secrets
from pathlib import Path
ROOT=Path(__file__).resolve().parent
for p in (ROOT/'backend').rglob('*'):
 if p.is_file() and p.suffix in ('.py','.json','.js','.html','.css'):
  try:s=p.read_text(encoding='utf-8-sig')
  except UnicodeError:continue
  if '__SIMCARE_ROOT__' in s:p.write_text(s.replace('__SIMCARE_ROOT__',ROOT.as_posix()),encoding='utf-8')
for name in ('data','logs','backend/extensions/backups','backend/engines/tmp','backend/engines/lumbar/runtime','backend/runtime/.secrets','backend/extensions/.secrets'):(ROOT/name).mkdir(parents=True,exist_ok=True)
config=ROOT/'data/server.json'
if not config.exists():config.write_text(json.dumps({'app_secret':secrets.token_urlsafe(48),'domain':'www.simcare.top'}),encoding='utf-8')
# Protect server configuration with server filesystem permissions.
(ROOT/'backend/runtime/.env').touch(exist_ok=True)
print('Server initialized:',ROOT)
