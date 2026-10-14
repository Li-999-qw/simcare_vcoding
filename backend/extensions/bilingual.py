"""Mount the English edition on /en; Chinese remains the default entry point.

Authentication, tasks and learner records are shared. Prepared English case
packages provide localized teaching content without rewriting learner records.
"""
import json, re
from pathlib import Path

PUBLIC_ROOTS=('portal.html','index.html','learning.html','learning.css','learning.js',
              'portal/','training/','learning/','auth/','admin/','case-materials/')
ROOT_URL=re.compile(r'''(["'`])/(?!en/)(portal\.html|index\.html|learning\.(?:html|css|js)|portal/|training/|learning/|auth/|admin/|case-materials/)''')

class EnglishPrefix:
    """Adjust generated browser URLs without changing clinical data or user input."""
    def __init__(self,app):self.app=app
    async def __call__(self,scope,receive,send):
        if scope['type']!='http':return await self.app(scope,receive,send)
        if scope.get('path','').endswith('/api/tts'):
            # Preserve chunk timing for audio; authorization still runs in the shared route.
            return await self.app(scope,receive,send)
        if scope.get('path','').endswith('/shared-ui.js'):
            from starlette.responses import Response
            return await Response((Path(__file__).parent/'shared-ui.js').read_text(encoding='utf-8'),media_type='text/javascript',headers={'Cache-Control':'no-store'})(scope,receive,send)
        scope=dict(scope)
        scope['headers']=[(k,v) for k,v in scope.get('headers',[]) if k.lower() not in (b'if-none-match',b'if-modified-since')]
        start=None;chunks=[]
        async def capture(message):
            nonlocal start
            if message['type']=='http.response.start':start=message;return
            if message['type']!='http.response.body':return await send(message)
            chunks.append(message.get('body',b''))
            if message.get('more_body'):return
            headers=dict(start['headers']);kind=headers.get(b'content-type',b'').decode()
            body=b''.join(chunks)
            from attempt_language import active_binding
            binding=active_binding.get()
            if binding and binding['language']=='zh':
                await send(start);await send({'type':'http.response.body','body':body});return
            # Authorization is performed by the shared route first. Only then
            # substitute the prepared English teaching resource at the same path.
            path=scope.get('path','')
            if start['status']==200 and '/case-materials/' in path:
                from urllib.parse import unquote
                root=(Path(__file__).parent/'english/site/materials').resolve()
                resource=(root/unquote(path.split('/case-materials/',1)[1])).resolve()
                if resource.is_relative_to(root) and resource.is_file():body=resource.read_bytes()
            if any(k in kind for k in ('text/html','javascript')):
                text=body.decode('utf-8')
                text=ROOT_URL.sub(lambda m:m[1]+'/en/'+m[2],text)
                if 'text/html' in kind:
                    text=insert_switch(text,True)
                    text=text.replace('lang="zh-CN"','lang="en"',1)
                    layout=(Path(__file__).parent/'english/layout.css').read_text(encoding='utf-8')
                    text=text.replace('</head>','<style>'+layout+'</style></head>',1)
                    text+='<script src="/en/shared-ui.js"></script>'
                body=text.encode()
            elif 'application/json' in kind:
                # Only navigation fields, never dialogue, notes, or clinical text.
                payload=json.loads(body)
                from english_case_content import response_view
                payload=response_view(payload)
                if isinstance(payload,dict):
                    for key in ('url','launch_url'):
                        value=payload.get(key)
                        if isinstance(value,str) and value.startswith('/training/'):payload[key]='/en'+value
                body=json.dumps(payload,ensure_ascii=False).encode()
            headers[b'content-length']=str(len(body)).encode()
            if 'text/html' in kind:
                headers[b'cache-control']=b'no-store'
                for key in (b'etag',b'last-modified',b'accept-ranges'):headers.pop(key,None)
            start['headers']=list(headers.items())
            await send(start);await send({'type':'http.response.body','body':body})
        await self.app(scope,receive,capture)

def insert_switch(html,english=False):
    if '<html' not in html.lower() or 'id="clinical-language-switch"' in html:return html
    active='en' if english else 'zh'
    if 'function loginEntry()' in html:
        links=f'''<nav class="hx-language" aria-label="Language / 语言"><a href="/portal.html?ui=login-v4" lang="zh-CN" {'aria-current="page"' if not english else ''}>中文</a><a href="/en/portal.html?ui=login-v4" lang="en" {'aria-current="page"' if english else ''}>English</a></nav>'''
        marker='</small></div></div><div class="hx-columns">'
        html=html.replace(marker,'</small></div>'+links+'</div><div class="hx-columns">',1)
    script=f'''<style>
#clinical-language-bar{{position:static;display:flex;justify-content:flex-end;box-sizing:border-box;width:100%;max-width:1500px;margin:0 auto;padding:12px;clear:both;color-scheme:light}}
#clinical-language-bar #clinical-language-switch{{position:static!important;inset:auto!important;float:none!important;transform:none!important;display:flex;flex-wrap:wrap;gap:4px;padding:5px;border:1px solid #b7cbcd;border-radius:10px;background:#fff;box-shadow:0 2px 12px #1232;font:14px system-ui;direction:ltr}}
#clinical-language-switch a{{display:block;padding:8px 14px;color:#174d52;text-decoration:none;border-radius:6px;white-space:nowrap}}
#clinical-language-switch a[aria-current="page"]{{background:#e5f3f1;font-weight:600}}
#clinical-language-switch a:focus-visible{{outline:2px solid #116c60;outline-offset:2px}}
body:has(.hx-language) #clinical-language-bar{{display:none!important}}
#clinical-language-bar{{display:none!important}}
#clinical-roles .hx-mast{{flex-wrap:wrap}}
#clinical-roles .hx-brand{{min-width:0;overflow-wrap:anywhere}}
#clinical-roles .hx-language{{display:flex;position:static!important;gap:4px;margin-left:auto;padding:5px;border:1px solid #b7cbcd;border-radius:10px;background:#fff;flex-shrink:0;align-self:center}}
#clinical-roles .hx-language a{{display:block;padding:8px 14px;color:#174d52;text-decoration:none;border-radius:6px;font:14px system-ui;white-space:nowrap}}
#clinical-roles .hx-language a[aria-current="page"]{{background:#e5f3f1;font-weight:600}}
#clinical-roles .hx-columns{{grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);box-sizing:border-box;max-width:1500px;width:100%;margin-left:auto;margin-right:auto}}
#clinical-roles .hx-photo{{min-height:0!important;aspect-ratio:942 / 710;align-self:start}}
#clinical-roles .hx-photo img{{position:absolute!important;width:168.153%!important;height:auto!important;max-width:none!important;left:-3.7155%!important;top:-20.5634%!important}}
#clinical-roles .hx-card{{min-width:0;box-sizing:border-box}}
@media(max-width:700px){{#clinical-roles .hx-columns{{grid-template-columns:minmax(0,1fr)}}#clinical-roles .hx-language{{margin-left:auto}}}}
</style><div id="clinical-language-bar"><nav id="clinical-language-switch" aria-label="Language / 语言">
<a href="/portal.html?ui=language-v3" lang="zh-CN" {'aria-current="page"' if not english else ''}>中文 · 中文版</a>
<a href="/en/portal.html?ui=language-v3" lang="en" {'aria-current="page"' if english else ''}>English · 英文版</a></nav></div>
<script>(()=>{{const current={json.dumps(active)};document.querySelectorAll('#clinical-language-switch a').forEach(a=>a.addEventListener('click',e=>{{if(a.lang===(current==='en'?'en':'zh-CN')){{e.preventDefault();return}}if(location.pathname.includes('/training/')&&!confirm(current==='en'?'Switch language and return to the learning platform? Your saved practice is retained. Unsent text will not be transferred.':'切换语言并返回学习平台？已保存的练习会保留，尚未发送的文字不会转移。'))e.preventDefault()}}));}})();</script>'''
    # Same normal-flow header on both editions, outside the app render root.
    if re.search(r'<body\b[^>]*>',html,re.I):
        return re.sub(r'(<body\b[^>]*>)',lambda m:m[0]+script,html,count=1,flags=re.I)
    return re.sub(r'(<html\b[^>]*>)',lambda m:m[0]+script,html,count=1,flags=re.I)


class ChineseSwitch:
    def __init__(self,app):self.app=app
    async def __call__(self,scope,receive,send):
        if scope['type']!='http' or scope.get('path','').startswith('/en/'):
            return await self.app(scope,receive,send)
        if scope.get('path','').endswith('.html') or scope.get('path','')=='/':
            scope=dict(scope)
            scope['headers']=[(k,v) for k,v in scope.get('headers',[]) if k.lower() not in (b'if-none-match',b'if-modified-since')]
        start=None;chunks=[];html=False
        async def capture(message):
            nonlocal start,html
            if message['type']=='http.response.start':
                html=b'text/html' in dict(message['headers']).get(b'content-type',b'')
                if not html:return await send(message)
                start=message;return
            if not html:return await send(message)
            chunks.append(message.get('body',b''))
            if message.get('more_body'):return
            body=insert_switch(b''.join(chunks).decode()).encode()
            headers=dict(start['headers']);headers[b'content-length']=str(len(body)).encode()
            headers[b'cache-control']=b'no-store'
            for key in (b'etag',b'last-modified',b'accept-ranges'):headers.pop(key,None)
            start['headers']=list(headers.items())
            await send(start);await send({'type':'http.response.body','body':body})
        await self.app(scope,receive,capture)

def install(app):
    from shared_language import shared_router
    english_app=shared_router(app)
    # Insert ahead of the catch-all static mount.
    from starlette.routing import Mount
    app.router.routes.insert(0,Mount('/en',app=EnglishPrefix(english_app)))
    app.add_middleware(ChineseSwitch)
    from attempt_language import install as install_binding,BoundLanguage
    install_binding()
    app.add_middleware(BoundLanguage)
