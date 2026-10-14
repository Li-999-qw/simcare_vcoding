"""Read English reference packages; never rewrite historical learner content."""
import copy,json,re
from functools import lru_cache
from pathlib import Path
ROOT=Path(__file__).parent
@lru_cache(None)
def package(case_id):
    if not isinstance(case_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]+',case_id):return None
    path=ROOT/'english/case-packages'/(case_id+'.json')
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None

def model_context(context,case_id):
    if context.get('reply_language')!='en':return context
    pack=package(case_id)
    if not pack:return context
    value=copy.deepcopy(context)
    for field in ('allowed_facts','known_facts'):
        for key in value.get(field,{}):
            if key in pack['FACTS']:value[field][key]=pack['FACTS'][key]
    for key in value.get('reports',{}):
        if key in pack['REPORTS']:value['reports'][key]=pack['REPORTS'][key]['text']
    chinese_stages=pack.get('source_stages',['接诊','处置与交接','病房查房','出院日','反馈'])
    stage=value.get('stage')
    if stage in chinese_stages:
        index=chinese_stages.index(stage);value['stage']=pack['STAGES'][index]
        if value.get('teaching_reference'):value['teaching_reference']=pack['TEACHING'][str(index)]
    value['case_version']=pack['VERSION']
    return value

def report_view(report,key,pack):
    reference=pack['REPORTS'].get(key)
    if not reference:return report
    out=copy.deepcopy(report)
    for field in ('name','text','positive'):
        if field in reference:out[field]=reference[field]
    # Preserve actual numerical results and simulated timestamps. Translate only
    # the template's descriptive fields and labels, never replace result values.
    original=out.get('sheet',{});translated=reference.get('sheet',{})
    for field in ('title','sample','findings','note'):
        if field in translated:original[field]=translated[field]
    source=pack.get('source_reports',{}).get(key,{}).get('sheet',{})
    rows=original.get('rows',[]); english_rows=translated.get('rows',[]); source_rows=source.get('rows',[])
    if len(rows)!=len(english_rows):return out
    for index,(row,english) in enumerate(zip(rows,english_rows)):
        for field in ('name','unit'):
            if field in english:row[field]=english[field]
        if index<len(source_rows):
            for field in ('value','reference','range'):
                current=row.get(field)
                if isinstance(current,str) and any('\u3400'<=char<='\u9fff' for char in current) and current==source_rows[index].get(field) and field in english:
                    row[field]=english[field]
    return out

def response_view(payload):
    if not isinstance(payload,dict):return payload
    state=payload.get('state',payload)
    if not isinstance(state,dict):return payload
    pack=package(state.get('case_id',''))
    from attempt_language import active_binding
    binding=active_binding.get()
    if binding and binding.get('english_package'):pack=json.loads(binding['english_package'])
    if not pack:return payload
    value=copy.deepcopy(payload);state=value.get('state',value)
    # These are engine-authored defaults, not learner-authored history. Match
    # both provenance and the exact source text before changing their view.
    source_opening=pack.get('source_opening_content',{})
    english_opening=pack.get('opening_content',{})
    notes=state.get('notes',{})
    if source_opening.get('general') and notes.get('general')==source_opening['general']:
        notes['general']=english_opening['general']
    for message in state.get('messages',[]):
        stage=message.get('stage')
        if not isinstance(stage,int) or stage<0 or stage>=len(source_opening.get('openers',[])):continue
        if (message.get('initial') is True and message.get('speaker')=='assistant' and message.get('role')=='patient') or message.get('speaker')=='system':
            if message.get('text')==source_opening['openers'][stage]:
                message['text']=english_opening['openers'][stage]
    if 'report' in value:
        # Report IDs are established by the matching result entry, not its title.
        for key,report in state.get('report_results',{}).items():
            if report==value['report']:
                value['report']=report_view(value['report'],key,pack);break
    if 'registration' in state:state['registration']=copy.deepcopy(pack['REGISTRATION'])
    for key,report in state.get('report_results',{}).items():state['report_results'][key]=report_view(report,key,pack)
    if state.get('intervention_report'):state['intervention_report']=report_view(state['intervention_report'],'handoff',pack)
    return value
