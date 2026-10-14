"""Shared role routing, used by both live case engines and the admin sandbox."""
import base64, json, os, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent
import sys
sys.path.insert(0, str(ROOT.parents[1]))
CONFIG = ROOT / 'role-models.json'
DEFAULT = {'provider': 'codex', 'model': 'gpt-6-astra', 'effort': 'low'}

def read_config():
    from backend.runtime.settings_store import read_setting
    return read_setting('role_models', CONFIG,
                        {'revision': 0, 'patient': dict(DEFAULT), 'senior': dict(DEFAULT)})


def save_config(value):
    from backend.runtime.settings_store import save_setting
    save_setting('role_models', value)

def api_key():
    from credential_store import load
    stored = load()
    if stored is not None:
        return stored
    value = os.getenv('OPENAI_API_KEY', '')
    if not value and (ROOT / '.env').is_file():
        for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
            if line.startswith('OPENAI_API_KEY='):
                value = line.split('=', 1)[1].strip().strip('\"\'')
    return value

def generate(connection, context, prompt, rules, schema, delta, session_key, image_paths=None, override=None):
    role = 'patient' if context['role'] == '患者' else 'senior'
    cfg = override or read_config()[role]
    if not context.get('preserve_original_provider'):
        import sys
        sys.path.insert(0,str(ROOT.parent / 'extensions'))
        from role_personas import apply
        rules=apply(rules,role,(override or {}).get('persona'))
    if context.get('preserve_original_provider'):
        ug=ROOT/'uyghur-model.json'
        from backend.runtime.settings_store import read_setting
        cfg=read_setting('uyghur_model',ug,None)
        if not cfg:raise RuntimeError('请先在服务器配置维吾尔语模型 API；桌面登录凭据不会迁移。')
        context={**context,'preserve_original_provider':False}
    if cfg['provider'] == 'bailian':
        if context.get('preserve_original_provider'):
            backup=CONFIG.with_name('role-models.before-bailian.json')
            from backend.runtime.settings_store import read_setting
            cfg=read_setting('role_models_before_bailian',backup,{}).get(role,dict(DEFAULT))
        else:
            import sys
            sys.path.insert(0, str(ROOT.parent / 'extensions'))
            from bailian_runtime import generate as bailian_generate
            return bailian_generate(context,prompt,rules,schema,delta,cfg['model'],image_paths)
    if cfg['provider'] == 'codex':
        return connection.generate(prompt, rules, schema, cfg['model'], cfg['effort'], delta,
                                   session_key=session_key, **({'image_paths': image_paths} if image_paths else {}))
    key = api_key()
    if not key:
        raise RuntimeError('尚未配置 OpenAI API 密钥，请在管理员模型页面配置。')
    content = [{'type': 'text', 'text': prompt}]
    for path in image_paths or []:
        p = Path(path)
        mime = 'image/jpeg' if p.suffix.lower() in ('.jpg', '.jpeg') else 'image/png'
        content.append({'type': 'image_url', 'image_url': {'url': 'data:'+mime+';base64,'+base64.b64encode(p.read_bytes()).decode()}})
    body = {'model': cfg['model'], 'messages': [{'role':'system','content':rules}, {'role':'user','content':content}],
            'response_format': {'type':'json_schema','json_schema':{'name':'role_reply','strict':True,'schema':schema}}}
    start = time.monotonic()
    req = urllib.request.Request('https://api.openai.com/v1/chat/completions', data=json.dumps(body).encode(),
                                 headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=100) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'模型 API 返回 HTTP {exc.code}，请检查模型权限、密钥或额度。') from None
    raw = result['choices'][0]['message']['content']
    if not raw:
        raise RuntimeError('模型未返回可用回答。')
    delta(raw)
    return raw, {'model':result.get('model',cfg['model']), 'provider':'openai', 'total_seconds':round(time.monotonic()-start,3)}
