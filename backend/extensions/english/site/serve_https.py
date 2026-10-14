"""TLS application plus certificate bootstrap; HTTP never serves login or records."""
import asyncio,json
from pathlib import Path
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse,HTMLResponse,RedirectResponse
from app.main import app

ROOT=Path(__file__).parent
config=json.loads((ROOT/'tls/config.json').read_text(encoding='utf-8'))
base=f"https://{config['host']}:{config['https_port']}"
bootstrap=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)

@bootstrap.get('/tls-certificate.cer')
def certificate():
    return FileResponse(ROOT/'tls/clinical-training.cer',media_type='application/pkix-cert',filename='clinical-training.cer',headers={'Cache-Control':'no-store'})

@bootstrap.get('/https-setup.html',response_class=HTMLResponse)
def instructions():
    return f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mac HTTPS Settings</title>
<style>body{{font-family:system-ui;max-width:800px;margin:50px auto;padding:24px;color:#243d46;line-height:1.8;background:#f4f8f8}}a{{color:#176c71}}code{{overflow-wrap:anywhere}}li{{margin:14px 0}}</style>
<h1>Mac HTTPS and voice input settings</h1><ol>
<li><a href="/tls-certificate.cer">Download the public certificate for this test server</a>。Do not import any private key files。</li>
<li>Open Mac“Keychain Access,” import the certificate into the “login” keychain。</li>
<li>Found“Clinical Training {config['host']}”，Double-click to expand “Trust,” then set “Secure Sockets Layer（SSL）”Set to “Always Trust,” close the window, and enter the requested information Mac Login password. Keep defaults for other uses。</li>
<li>Reopen the browser and visit <a href="{base}/portal.html">{base}/portal.html</a>。Log in after the connection no longer displays certificate errors。</li>
<li>Open the case, click Voice Input, and allow the website to use the microphone. After speaking, check the text before sending. Speech recognition support depends on the browser; some browsers use their online speech services.。</li></ol>
<p>This certificate is only for this test server and is valid until {config['expires'][:10]}。If the server IP changed; the certificate must be reconfigured。</p>
<p>Verify SHA-256 Fingerprint：</p><code>{config['sha256']}</code>
<p>If trust has not been established or certificate warnings persist, complete the trust configuration first. Do not bypass warnings instead of configuring trust.。</p>'''

@bootstrap.api_route('/{path:path}',methods=['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'])
def redirect(path:str):
    return RedirectResponse(base+'/portal.html',status_code=303)

async def main():
    common={'host':config['host'],'log_level':'info','proxy_headers':False}
    tls=uvicorn.Server(uvicorn.Config(app,port=config['https_port'],ssl_certfile=str(ROOT/'tls/server.pem'),ssl_keyfile=str(ROOT/'tls/server-key.pem'),**common))
    http=uvicorn.Server(uvicorn.Config(bootstrap,port=config['http_port'],lifespan='off',**common))
    await asyncio.gather(tls.serve(),http.serve())

if __name__=='__main__':asyncio.run(main())
