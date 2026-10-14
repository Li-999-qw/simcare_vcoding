import os,sys,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
from backend.runtime.mysql_config import load_database_url
os.environ['DATABASE_URL']=load_database_url(ROOT).render_as_string(hide_password=False)
os.environ['APP_SECRET']=json.loads((ROOT/'data/server.json').read_text())['app_secret']
os.environ['DIALOGUE_ENGINE_URL']='http://127.0.0.1:28765'
os.environ['DIALOGUE_ENGINE_ORIGIN']=os.environ['DIALOGUE_ENGINE_URL']
for path in ('backend/runtime','backend/main','backend/extensions'):sys.path.insert(0,str(ROOT/path))
from serve_bilingual import app
from frontend_api import router
app.include_router(router)
app.router.routes.insert(0,app.router.routes.pop())
if __name__=='__main__':
 import uvicorn
 uvicorn.run(app,host='127.0.0.1',port=28876,proxy_headers=True,forwarded_allow_ips='127.0.0.1',workers=1)
