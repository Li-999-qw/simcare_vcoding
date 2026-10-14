"""Patient PACS: show all requested examinations whose results are ready."""
import json, mimetypes, copy
from pathlib import Path
from urllib.parse import parse_qs, urlencode

def serve_pacs(handler, request, sessions, lock):
    from case import DATA
    from timeline import ready, release_due
    query=parse_qs(request.query);sid=query.get('id',[''])[0];key=query.get('report',[''])[0]
    with lock:
        session=sessions.get(sid)
        if session:release_due(session)
        if not session or key not in ('mr','ct','xr') or key not in session.get('requested_reports',[]) or not ready(session,key):
            return handler.send({'error':'First request a test during the exercise, wait for the results, and open the report.。'},403)
        reports={k:copy.deepcopy(session['report_payloads'][k]) for k in session.get('requested_reports',[]) if k in ('mr','ct','xr') and ready(session,k)}
    reports=dict(sorted(reports.items(),key=lambda item:(item[1]['sheet']['collected'],item[0]),reverse=True))
    series=[s for k in reports for s in DATA['series'] if s['report']==k]
    series=copy.deepcopy(series)
    for item in series:item['group']=item['modality']+' · '+reports[item['report']]['sheet']['collected']
    suffix='?'+urlencode({'id':sid,'report':key})
    root=Path(__file__).parent/'public'/'pacs';relative=request.path.removeprefix('/pacs/')
    if relative=='case-data.js':
        visible={k:copy.deepcopy(DATA[k]) for k in ('id','version','reviewStatus','patient','imageLimitations','axialLevels')}
        visible['patient'].pop('discharge',None)
        # No complete clinical case, future course, hidden labs or future strength values.
        visible.update(initialReport=key,series=series,history=[],strength=[],labs=[],course=[],sources=[],reports=[dict(id=k,title=r['name'],date=r['sheet']['collected'],reportTime=r['sheet']['reported'],findings=r['sheet']['findings'],impression='',reason='Available investigation results for this Patient。') for k,r in reports.items()])
        return handler.send(('window.CASE_DATA='+json.dumps(visible,ensure_ascii=False)+';').encode(),kind='text/javascript; charset=utf-8')
    allowed={'pacs.html','app.js','style.css'}|{'assets/'+s.get('asset',s['id']+'.png') for s in series}
    if any(s.get('locator') for s in series):allowed.add('assets/locator-pair.png')
    if relative not in allowed:return handler.send({'error':'This material is unavailable in this session'},403)
    path=root/relative
    if not path.is_file():return handler.send({'error':'Imaging resource not found'},404)
    body=path.read_bytes()
    if relative=='pacs.html':
        text=body.decode('utf-8')
        for resource in ('style.css','case-data.js','app.js'):
            text=text.replace('"'+resource+'"','"'+resource+suffix.replace('&','&amp;')+'"')
        body=text.encode()
    return handler.send(body,kind=(mimetypes.guess_type(path.name)[0] or 'application/octet-stream')+('; charset=utf-8' if path.suffix in ('.html','.css','.js') else ''))
