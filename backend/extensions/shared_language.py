"""One portal data model with a presentation-only English mount."""
import copy,json,sqlite3,threading
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from sqlalchemy import text
from backend.runtime.ids import next_id
from starlette.routing import Router
ROOT=Path(__file__).parent
legacy_context=ContextVar('legacy_language_engine',default=None)
dialogue_language=ContextVar('dialogue_language',default='zh')

def migrate():
    from app.db import engine,SessionLocal
    from app.portal_api import document
    from app.portal_models import PortalAttempt,KnowledgeItem
    if engine.dialect.name == 'mysql':
        with engine.begin() as conn:
            conn.execute(text('CREATE TABLE IF NOT EXISTS language_unification (id BIGINT NOT NULL PRIMARY KEY, attempt_id VARCHAR(64) NOT NULL UNIQUE, engine_id VARCHAR(128), engine_url VARCHAR(255), create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6))'))
            conn.execute(text("INSERT IGNORE INTO language_unification (id,attempt_id,engine_id,engine_url) VALUES (:id,'__complete__','','')"),{'id':next_id()})
        return
    with engine.connect() as conn:
        tables=set(conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).scalars())
        if 'language_unification' in tables and conn.execute(text("SELECT count(*) FROM language_unification WHERE attempt_id='__complete__'")).scalar():return
    backup=ROOT/'backups'/('before-language-unification-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.db')
    backup.parent.mkdir(exist_ok=True)
    with sqlite3.connect(str(engine.url.database)) as source,sqlite3.connect(str(backup)) as target:source.backup(target)
    source.close();target.close()
    with SessionLocal() as db:
        doc=document(db);data=copy.deepcopy(doc.data)
        by_source={c.get('sourceCaseId'):c['id'] for c in data['cases'] if c.get('sourceCaseId')}
        old=db.execute(text('SELECT data FROM en_portal_documents WHERE id=1')).scalar() if 'en_portal_documents' in tables else None
        old=json.loads(old) if isinstance(old,str) else old or {'cases':[],'tasks':[]}
        case_map={}
        for c in old['cases']:
            if c.get('sourceCaseId') in by_source:case_map[c['id']]=by_source[c['sourceCaseId']]
            else:
                new=copy.deepcopy(c);new['id']=max(x['id'] for x in data['cases'])+1
                data['cases'].append(new);case_map[c['id']]=new['id']
        task_map={}
        for task in old.get('tasks',[]):
            new=copy.deepcopy(task);new['id']=max([t['id'] for t in data['tasks']]+[0])+1
            task_map[str(task['id'])]=str(new['id']);new['caseId']=case_map[task['caseId']]
            data['tasks'].append(new)
        db.execute(text('CREATE TABLE IF NOT EXISTS language_unification (attempt_id TEXT PRIMARY KEY, engine_id TEXT, engine_url TEXT)'))
        engines={1:'http://127.0.0.1:28891',2:'http://127.0.0.1:28892',3:'http://127.0.0.1:28893'}
        rows=db.execute(text('SELECT * FROM en_portal_attempts')).mappings().all() if 'en_portal_attempts' in tables else []
        for a in rows:
            if db.get(PortalAttempt,a['id']):raise RuntimeError('Historical attempt ID collision; migration aborted')
            state=json.loads(a['state']) if isinstance(a['state'],str) else a['state']
            case_id=case_map[a['case_id']]
            key=task_map.get(a['task_key'],'practice:'+str(case_id))
            exists=db.query(PortalAttempt).filter_by(user_id=a['user_id'],task_key=key).first()
            if exists:key='history:en:'+a['id']
            db.add(PortalAttempt(id=a['id'],user_id=a['user_id'],task_key=key,case_id=case_id,engine_id=a['engine_id'],state=state))
            db.execute(text('INSERT INTO language_unification VALUES (:id,:sid,:url)'),{'id':a['id'],'sid':a['engine_id'],'url':engines[a['case_id']]})
        if 'en_knowledge_items' in tables:
            for k in db.execute(text('SELECT * FROM en_knowledge_items')).mappings():
                if db.get(KnowledgeItem,k['id']):raise RuntimeError('Knowledge ID collision; migration aborted')
                content=json.loads(k['content']) if isinstance(k['content'],str) else k['content']
                db.add(KnowledgeItem(id=k['id'],user_id=k['user_id'],attempt_id=k['attempt_id'],content=content))
        db.execute(text("INSERT INTO language_unification VALUES ('__complete__','','')"))
        doc.data=data;doc.revision+=1;db.commit()

def install_engine_routing():
    from app import portal_api,learning_api
    from app.db import engine
    import httpx
    with engine.connect() as conn:rows=conn.execute(text('SELECT * FROM language_unification')).mappings().all()
    by_attempt={r['attempt_id']:r['engine_url'] for r in rows};by_session={r['engine_id']:r['engine_url'] for r in rows}
    original=portal_api.engine
    def dispatch(case,method,path,**kwargs):
        if method=='POST' and path in ('api/message','api/feedback','api/retry') and portal_api.engine_url(case)!='http://127.0.0.1:28894':
            kwargs['json']={**kwargs.get('json',{}),'reply_language':dialogue_language.get()}
        sid=(kwargs.get('params') or kwargs.get('json') or {}).get('id')
        url=by_session.get(sid) or legacy_context.get()
        if not url or path=='api/session':return original(case,method,path,**kwargs)
        return httpx.request(method,url+'/'+path,headers={'Origin':url},timeout=60,trust_env=False,**kwargs)
    portal_api.engine=dispatch;learning_api.engine=dispatch
    class HistoricalRouting:
        def __init__(self,app):self.app=app
        async def __call__(self,scope,receive,send):
            parts=scope.get('path','').split('/')
            aid=parts[parts.index('training')+1] if 'training' in parts and len(parts)>parts.index('training')+1 else None
            token=legacy_context.set(by_attempt.get(aid))
            from attempt_language import active_binding
            binding=active_binding.get()
            language_token=dialogue_language.set(binding['language'] if binding else ('en' if scope.get('path','').startswith('/en/') or scope.get('root_path','').startswith('/en') else 'zh'))
            try:await self.app(scope,receive,send)
            finally:
                legacy_context.reset(token)
                dialogue_language.reset(language_token)
    return HistoricalRouting

def shared_router(app):
    migrate()
    routing=install_engine_routing()
    app.add_middleware(routing)
    return routing(Router(routes=list(app.router.routes)))
