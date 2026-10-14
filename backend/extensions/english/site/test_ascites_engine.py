"""Exercise an isolated real HTTP engine; no model calls and no student records."""
import json,sys,tempfile,threading,urllib.request,urllib.error
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'ascites_engine'))
import server as s

def run():
    with tempfile.TemporaryDirectory() as tmp:
        s.SESSIONS={};s.save_sessions=lambda *_:None
        http=s.ThreadingHTTPServer(('127.0.0.1',0),s.Handler)
        thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        origin='http://127.0.0.1:'+str(http.server_port)
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path,data=None,status=200):
            req=urllib.request.Request(origin+path,data=json.dumps(data).encode() if data is not None else None,headers={'Origin':origin,'Content-Type':'application/json'})
            try:r=opener.open(req)
            except urllib.error.HTTPError as e:r=e
            result=json.loads(r.read());assert r.code==status,(path,r.code,result)
            return result
        try:
            a=request('/api/session',{'mode':'practice'});sid=a['id']
            def post(path,**kw):return request('/api/'+path,dict(id=sid,**kw))
            assert a['case_id']=='SIM-ASC-20260901'
            assert a['registration']['name']=='Wang Jianhua'
            assert not a['reports'] and 'culture-final' not in a['report_results']
            patient=s.context(s.SESSIONS[sid],'patient','检查结果是什么？')
            senior=s.context(s.SESSIONS[sid],'senior','下一步如何处理？')
            assert '640' not in json.dumps(patient,ensure_ascii=False)
            assert '150' not in json.dumps(senior,ensure_ascii=False)
            assert not senior['reports'] and 'teaching_reference' not in patient
            request('/api/report',dict(id=sid,report='blood-day9'),403)
            request('/api/checks',dict(id=sid,reports=['blood-day9']),400)
            post('checks',reports=['cbc','chemistry','ascites','culture-prelim','culture-final','etiology','blood-culture'])
            request('/api/report',dict(id=sid,report='culture-final'),409)
            assert 'culture-final' not in s.context(s.SESSIONS[sid],'senior','培养情况？')['reports']
            post('wait-results',all=True)
            a=post('report',report='ascites');assert '640' in a['report']['text']
            post('report',report='chemistry')
            post('import',report='ascites',positive_only=False)
            meds=[dict(name='Ceftriaxone',dose='2',unit='g',use='Qd · Once daily',route='Intravenous drip infusion',type='One-time orders',remark='独立测试')]
            a=post('medication-orders',request_id='test-rx',rows=meds)
            assert len(a['orders'])==1
            assert len(post('medication-orders',request_id='test-rx',rows=meds)['orders'])==1
            a=post('advance');assert a['stage']==1
            post('notes',notes={'plan':'记录鉴别、抗感染与容量管理，监测并交接。'})
            a=post('advance');assert a['stage']==2 and a['ward_day']==2
            request('/api/advance',dict(id=sid),409)
            request('/api/report',dict(id=sid,report='culture-final'),409)
            post('checks',reports=['renal-day2']);a=post('report',report='renal-day2');assert '150' in a['report']['text']
            for day in range(2,9):
                a=post('notes',notes={'daily':f'No.{day}日独立查房测试记录'})
                if day==3:
                    post('checks',reports=['blood-day3','ascites-repeat','repeat-culture'])
                    post('wait-results',all=True)
                    assert 'Sensitive' in post('report',report='culture-final')['report']['text']
                    assert '120' in post('report',report='ascites-repeat')['report']['text']
                if day==4:
                    post('checks',reports=['pre-drainage','drainage']);post('wait-results',all=True)
                    assert '6000' in post('report',report='drainage')['report']['text']
                if day<8:
                    a=post('ward-next');assert a['ward_day']==day+1 and a['notes']['daily']==''
            assert len([d for d in a['medical_documents'] if d['id'].startswith('2:daily:')])==7
            a=post('advance');assert a['stage']==3
            post('checks',reports=['blood-day9']);assert '82' in post('report',report='blood-day9')['report']['text']
            post('notes',notes={'discharge':'独立出院记录','discharge_advice':'随访与风险告知'})
            a=post('advance');assert a['stage']==4 and a['record_review']
            request('/api/notes',dict(id=sid,notes={'daily':'篡改'}),403)
            other=request('/api/session',{'mode':'practice'});assert other['orders']==[] and other['reports']==[]
            assert len(s.SESSIONS[sid]['medical_documents'])>=9
            print('PASS: admission, disclosure gates, orders/idempotency, 7 daily notes, discharge, submission lock, session isolation')
        finally:http.shutdown();http.server_close()

if __name__=='__main__':run()
