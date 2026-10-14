"""Case-bound role replies through the official persistent Codex connection."""
from pathlib import Path
import json, time
from codex_transport import CONNECTION
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / 'runtime'))
from role_runtime import generate as role_generate

ROOT=Path(__file__).resolve().parent
SCHEMA=json.loads((ROOT/'reply.schema.json').read_text(encoding='utf-8'))
MODEL='gpt-6-astra'
from english_role_rules import RULES, PATIENT_RULES, SENIOR_RULES

def allowed_ids(context):
    ids=set(context.get('allowed_facts',{})) | set(context.get('known_facts',{})) | set(context.get('reports',{})) | set(context.get('uploaded_images',{}))
    if context.get('role')=='Supervising Physician':
        ids.update(o['id'] for o in context.get('orders',[]) if isinstance(o.get('id'),str))
        ids.update(k for k in ('orders','notes','treatment_summary','teaching_reference','history','snapshots','medication_reference','medical_documents') if context.get(k))
        ids.update(context.get('medication_reference',{}))
        ids.update(k for k,v in context.get('notes',{}).items() if v)
    return ids

def valid_metadata(reply,context):
    ids=reply.get('fact_ids')
    return (isinstance(ids,list) and all(isinstance(x,str) for x in ids)
            and set(ids).issubset(allowed_ids(context))
            and type(reply.get('gap')) is bool and type(reply.get('hint')) is bool)

def string_prefix(raw):
    """Decode only complete JSON string characters, including split Unicode escapes."""
    if not raw.startswith('"'):return ''
    result=[];i=1
    escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'}
    while i<len(raw):
        char=raw[i]
        if char=='"':break
        if char!='\\':
            if ord(char)<32:return ''
            result.append(char);i+=1;continue
        if i+1>=len(raw):break
        escaped=raw[i+1]
        if escaped in escapes:result.append(escapes[escaped]);i+=2;continue
        if escaped!='u':return ''
        if i+6>len(raw):break
        try:code=int(raw[i+2:i+6],16)
        except ValueError:return ''
        if 0xD800<=code<=0xDBFF:
            if i+12>len(raw):break
            if raw[i+6:i+8]!='\\u':return ''
            try:low=int(raw[i+8:i+12],16)
            except ValueError:return ''
            if not 0xDC00<=low<=0xDFFF:return ''
            result.append(chr(0x10000+((code-0xD800)<<10)+(low-0xDC00)));i+=12
        elif 0xDC00<=code<=0xDFFF:return ''
        else:result.append(chr(code));i+=6
    return ''.join(result)

def preview_reply(raw,context):
    """Hold text until source metadata is complete and valid; never send raw JSON."""
    raw=raw.lstrip()
    if not raw.startswith('{'):return ''
    decoder=json.JSONDecoder();i=1;metadata={};complete_reply=''
    try:
        while i<len(raw):
            while i<len(raw) and (raw[i].isspace() or raw[i]==','):i+=1
            key,end=decoder.raw_decode(raw,i);i=end
            while i<len(raw) and raw[i].isspace():i+=1
            if raw[i]!=':':return ''
            i+=1
            while i<len(raw) and raw[i].isspace():i+=1
            if key=='reply' and valid_metadata(metadata,context):return string_prefix(raw[i:])[:10000]
            value,end=decoder.raw_decode(raw,i);i=end
            if key=='reply':complete_reply=value if isinstance(value,str) else ''
            else:metadata[key]=value
            if complete_reply and valid_metadata(metadata,context):return complete_reply[:10000]
    except (ValueError,IndexError,TypeError):pass
    return ''

def generate(context,on_preview=None,session_key=None):
    role_rules=PATIENT_RULES if context['role']=='Patient' else SENIOR_RULES
    # Keep clinically relevant history; omit transport IDs, timing and UI metadata.
    compact=dict(context)
    compact['valid_fact_ids']=sorted(allowed_ids(context))
    image_paths=compact.pop('image_paths',[])
    compact['history']=[{k:m[k] for k in ('speaker','role','text','stage') if k in m} for m in context.get('history',[])]
    if compact['history'] and compact['history'][-1].get('speaker')=='student' and compact['history'][-1].get('text')==context['student_text']:
        compact['history']=compact['history'][:-1]
    first_visible=None;last='';start=time.monotonic()
    def delta(raw):
        nonlocal first_visible,last
        preview=preview_reply(raw,context)
        if preview and preview!=last:
            if first_visible is None:first_visible=time.monotonic()-start
            last=preview
            if on_preview:on_preview(preview)
    try:
        raw,timing=role_generate(CONNECTION,{**context,"role":"患者" if context["role"]=="Patient" else "上级医师"},json.dumps(compact,ensure_ascii=False,separators=(',',':')),
                                     RULES+role_rules,SCHEMA,delta,session_key,image_paths=image_paths)
        reply=json.loads(raw)
    except TimeoutError:
        raise TimeoutError('Model response timed out. Please try again。') from None
    except Exception:
        raise RuntimeError('The model did not complete its reply. Please retry; no canned answer will be substituted。') from None
    if not isinstance(reply,dict) or not isinstance(reply.get('reply'),str) or not valid_metadata(reply,context):
        CONNECTION.discard(session_key)
        raise RuntimeError('The reply had an invalid format or source reference and was blocked. Please retry。')
    if len(reply['reply'])>10000:raise RuntimeError('The reply exceeded the permitted length. Please retry.')
    timing['first_visible_seconds']=round(first_visible,3) if first_visible is not None else timing['total_seconds']
    reply['timing']=timing
    return reply
