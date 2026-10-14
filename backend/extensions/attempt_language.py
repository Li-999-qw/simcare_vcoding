"""Persist presentation language per attempt, independently of portal locale."""
import json,re,copy,sqlite3
from datetime import datetime
from contextvars import ContextVar
from sqlalchemy import text,event
from pathlib import Path
from backend.runtime.ids import next_id
active_binding=ContextVar('active_attempt_binding',default=None)
portal_locale=ContextVar('portal_locale',default='zh')

def lookup(attempt_id):
    from app.db import engine
    if not attempt_id:return None
    with engine.connect() as conn:
        row=conn.execute(text('SELECT * FROM attempt_language WHERE attempt_id=:id'),{'id':attempt_id}).mappings().first()
        return dict(row) if row else None

def locked_url(url):
    match=re.match(r'^/(?:en/)?training/([^/]+)(.*)$',url)
    if not match:return url
    binding=lookup(match[1])
    if not binding:return url
    return ('/en' if binding['language']=='en' else '')+'/training/'+match[1]+match[2]

def install():
    from app.db import engine
    from app.portal_models import PortalAttempt
    from english_case_content import package
    from shared_language import dialogue_language
    mysql=engine.dialect.name=='mysql'
    with engine.connect() as conn:
        exists=engine.dialect.has_table(conn, 'attempt_language')
    if not exists and not mysql:
        target=Path(__file__).parent/'backups'/('before-attempt-language-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.db')
        target.parent.mkdir(exist_ok=True)
        with sqlite3.connect(str(engine.url.database)) as source,sqlite3.connect(target) as backup:source.backup(backup)
        source.close();backup.close()
    def insert(conn,attempt,language,reason):
        state=attempt.state or {}
        doc=conn.execute(text('SELECT data FROM portal_documents ORDER BY id LIMIT 1')).scalar()
        doc=json.loads(doc) if isinstance(doc,str) else doc or {}
        case=next((c for c in doc.get('cases',[]) if c['id']==attempt.case_id),{})
        pack=package(state.get('case_id',case.get('sourceCaseId','')))
        from app.portal_api import engine_url
        if engine_url(attempt.case_id)=='http://127.0.0.1:28894':language='zh';reason='case-bound Uyghur scenario'
        name=case.get('name','')
        if language=='en':
            translations=json.loads((Path(__file__).parent/'shared-ui.js').read_text(encoding='utf-8').split('=',1)[1].split(';\n',1)[0])
            name=translations.get(name,name)
        if mysql:
            statement='INSERT IGNORE INTO attempt_language (id,attempt_id,language,case_version,case_name,english_package,provenance) VALUES (:row_id,:id,:language,:version,:name,:pack,:reason)'
        else:
            statement='INSERT OR IGNORE INTO attempt_language (attempt_id,language,case_version,case_name,english_package,provenance) VALUES (:id,:language,:version,:name,:pack,:reason)'
        conn.execute(text(statement),dict(row_id=next_id(),id=attempt.id,language=language,version=state.get('version',case.get('version','')),name=name,pack=json.dumps(pack,ensure_ascii=False) if pack else None,reason=reason))
    with engine.begin() as conn:
        if mysql:
            conn.execute(text('CREATE TABLE IF NOT EXISTS attempt_language (id BIGINT NOT NULL PRIMARY KEY, attempt_id VARCHAR(64) NOT NULL UNIQUE, language VARCHAR(8) NOT NULL, case_version VARCHAR(32), case_name VARCHAR(255), english_package JSON, provenance VARCHAR(128), create_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), update_time DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6))'))
        else:
            conn.execute(text('CREATE TABLE IF NOT EXISTS attempt_language (attempt_id TEXT PRIMARY KEY, language TEXT NOT NULL, case_version TEXT, case_name TEXT, english_package TEXT, provenance TEXT)'))
        rows=conn.execute(text('SELECT a.* FROM portal_attempts a LEFT JOIN attempt_language l ON l.attempt_id=a.id WHERE l.attempt_id IS NULL')).mappings().all()
        legacy=set(conn.execute(text('SELECT attempt_id FROM language_unification')).scalars())
        from types import SimpleNamespace
        for row in rows:
            state=json.loads(row['state']) if isinstance(row['state'],str) else row['state']
            language='en' if row['id'] in legacy else 'zh'
            reason='legacy English engine' if language=='en' else 'original opening language'
            if language=='zh':
                messages=[m for m in state.get('messages',[]) if m.get('speaker')=='assistant' and not m.get('initial') and m.get('text')]
                if messages and not re.search('[\u3400-\u9fff]',messages[0]['text']) and re.search('[A-Za-z]{3}',messages[0]['text']):language='en';reason='first generated reply'
            insert(conn,SimpleNamespace(id=row['id'],state=state,case_id=row['case_id']),language,reason)
    def on_insert(mapper,connection,target):
        insert(connection,target,dialogue_language.get(),'creation locale')
    event.listen(PortalAttempt,'after_insert',on_insert)

class BoundLanguage:
    def __init__(self,app):self.app=app
    async def __call__(self,scope,receive,send):
        if scope['type']!='http':return await self.app(scope,receive,send)
        path=scope.get('path','');match=re.match(r'^/(?:en/)?training/([^/]+)(?:/|$)',path)
        binding=lookup(match[1]) if match else None
        token=active_binding.set(binding)
        locale_token=portal_locale.set('en' if path.startswith('/en/') else 'zh')
        start=None;chunks=[]
        async def capture(message):
            nonlocal start
            if message['type']=='http.response.start':start=message;return
            if message['type']!='http.response.body':return await send(message)
            chunks.append(message.get('body',b''))
            if message.get('more_body'):return
            body=b''.join(chunks);headers=dict(start['headers']);kind=headers.get(b'content-type',b'').decode()
            # Routes perform ownership checks before any redirect is sent.
            correct=locked_url(path) if binding else path
            if start['status']==200 and correct!=path and scope['method']=='GET' and 'text/html' in kind:
                start['status']=307;headers[b'location']=correct.encode();body=b''
            elif 'application/json' in kind and start['status']==200:
                data=json.loads(body)
                if binding and binding['language']=='en' and not path.startswith('/en/'):
                    from english_case_content import response_view
                    data=response_view(data)
                if isinstance(data,dict):
                    for key in ('url','launch_url'):
                        if isinstance(data.get(key),str):data[key]=locked_url(data[key])
                    if 'practiceProgress' in data:
                        names={}
                        for item in data['practiceProgress']:
                            b=lookup(item['id'])
                            if b:
                                item.update(language=b['language'],caseName=b['case_name'],caseVersion=b['case_version'])
                                names[item['caseId']]=b['case_name']
                        for case in data.get('cases',[]):
                            if case['id'] in names:case['name']=names[case['id']]
                        data['lockedCaseNames']=list(names.values())
                body=json.dumps(data,ensure_ascii=False).encode()
            elif 'text/html' in kind and not match:
                html=body.decode()
                html=html.replace('serverRevision=d.revision;', 'window.clinicalLockedCaseNames=new Set(d.lockedCaseNames||[]);serverRevision=d.revision;')
                html=html.replace("esc(cases.find(c=>c.id===a.caseId)?.name||'病例')", "esc(a.caseName||cases.find(c=>c.id===a.caseId)?.name||'病例')")
                if path.endswith('portal.html'):
                    html+='<script>sessionStorage.setItem("clinicalPortalEntry",'+json.dumps('/en/portal.html' if path.startswith('/en/') else '/portal.html')+');</script>'
                body=html.encode()
            elif match and ('javascript' in kind or 'text/html' in kind):
                content=body.decode()
                for entry in ('/en/portal.html?return=','/portal.html?return='):
                    content=content.replace("'"+entry+"'", "(sessionStorage.getItem('clinicalPortalEntry')||'/portal.html')+'?return='")
                body=content.encode()
            headers[b'content-length']=str(len(body)).encode();start['headers']=list(headers.items())
            await send(start);await send({'type':'http.response.body','body':body})
        try:await self.app(scope,receive,capture)
        finally:active_binding.reset(token);portal_locale.reset(locale_token)
