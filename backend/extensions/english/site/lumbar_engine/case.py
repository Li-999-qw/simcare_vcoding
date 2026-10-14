"""Case adapter: original LDH v1.1 values, with phase-limited disclosure."""
import json, copy
from pathlib import Path
DATA=json.loads((Path(__file__).parent/'lumbar-case-data.json').read_text(encoding='utf-8'))
CASE_ID=DATA['id'];VERSION='Lumbar spine case v'+DATA['version']+' · '+DATA['reviewStatus']
STAGES=['Seen in the general orthopedic clinic','Preoperative decision-making and surgery','Postoperative ward round','Discharge instructions','Debrief']
TIMES=['9 month 3 day 09:00','9 month 3 day 11:30','9 month 5 day 09:00','9 month 7 day 09:00','End of simulation']
H=dict(DATA['history']);C=DATA['course']
FACTS={'identity':H['General information'],'pain':H['Chief complaint']+' '+H['History of present illness']+' '+H['Recent progression'].split('9 month 3 day 09:00')[0],
       'previous':H['Course of conservative treatment'],'negatives':H['Red-flag symptoms and pertinent negative history'],
       'past':H.get('Past medical history',''),'allergy':H['Medication and allergy history'] if 'Medication and allergy history' in H else next(v for k,v in H.items() if 'Allergy' in k),
       'social':H['Personal, marital, reproductive, and family history'],
       'ward_patient':'Postoperative day 1: left leg pain 1–2/10, reduced numbness over the dorsum of the foot, able to walk with support, and normal spontaneous urination.',
       'discharge_patient':'Leg pain 1/10, mild residual numbness over the dorsum of the foot, able to walk with protection, and normal bladder and bowel function.'}
DETAILS=json.loads((Path(__file__).parent/'patient-details.json').read_text(encoding='utf-8'))
FACTS['identity']='Name: Li Zhiqiang (fictional teaching Patient）。'+FACTS['identity'].replace('Admitting department: Spine Surgery','Department: General Orthopedic Outpatient Clinic; not yet admitted')
# Explicit, stable fictional additions; never replace the source clinical course.
FACTS['prior_episodes']=DETAILS['prior_episodes']
FACTS['daily_life']=DETAILS['daily_life']
PATIENT_BASE=['identity','previous','negatives','past','allergy','social','prior_episodes','daily_life']
REGISTRATION={'name':'Li Zhiqiang','sex':'male','age':'46 years old','marital_status':'Married','occupation':'Warehouse management staff','ethnicity':'Han ethnicity (registration setting for teaching）','birthplace':'Chengdu, Sichuan Province (simulated registration for teaching)','address':'Room 502, Building 3, No. 26 Anhe Road, Wuhou District, Chengdu (fictional teaching address)','history_source':'Patient and spouse','admission_status':'General orthopedic outpatient clinic; registration information complete, not yet admitted'}
REPORTS={}
def add(key,name,stage,category,text,date,positive='',rows=None,pacs=None):
    sheet=dict(title=name+'Report',number='LDH-'+key,sample='Examination record',collected=date,received=date,reported=date,findings=text,note='Original lumbar spine case v1.1 teaching material; not an actual patient report.')
    if rows:sheet['rows']=[dict(name=r[0],value=str(r[1]),unit=r[2],reference=r[3],flag=r[4]) for r in rows]
    REPORTS[key]=dict(name=name,stage=stage,category=category,text=text,sheet=sheet,positive=positive)
    if pacs:REPORTS[key]['pacs']=pacs
exam=H['General physical examination']+'\n'+H['Spinal and neurological examination']+'\n Left-Sided Muscle Strength at Admission：'+ '；'.join(r[0]+' '+r[2] for r in DATA['strength'])
add('exam','General and spinal neurological examination',0,'Physical examination',exam,'2026-09-03 09:00',H['Spinal and neurological examination']+'Left ankle dorsiflexion and great toe dorsiflexion 3/5。')
for r in DATA['reports']:
    add(r['id'],r['title'],0,'Imaging',r['findings']+'\n Imaging impression：'+r['impression'],r['date'],r['impression'],pacs=r['id'])
    REPORTS[r['id']]['sheet']['reported']=r['reportTime']
    REPORTS[r['id']]['sheet']['note']+=' Examination from the original source：'+r['date']+'；The simulated performance time is displayed after this request. Synthetic images cannot replace diagnostic-quality imaging。'
groups={'cbc':('Complete blood count',[0,1,2]),'inflammation':('Inflammatory markers',[3,4]),'renal_liver':('Liver and kidney function',[5,6,7]),'other_labs':('Other preoperative tests',list(range(8,len(DATA['labs']))))}
for key,(name,idx) in groups.items():
    rows=[DATA['labs'][i] for i in idx]
    if rows:add(key,name,0,'Blood','；'.join(str(r[0])+' '+str(r[1])+r[2] for r in rows),'2026-09-03 09:00',rows=rows)
add('ecg','Preoperative 12-lead ECG',0,'Electrocardiography','Sinus rhythm, 78 beats/min, no significant abnormalities.','2026-09-03 09:00')
add('handoff','Surgical team report',1,'Handover',C[3][1]+'\n'+C[4][1],'2026-09-04 13:00',C[4][1])
add('ward','Postoperative reassessment of neurological function and incision',2,'Reassessment',C[5][1],'2026-09-05 09:00','Left ankle and great toe dorsiflexion strength 4/5; reduced numbness over the dorsum of the foot.')
add('discharge','Reassessment before discharge',3,'Reassessment',C[7][1],'2026-09-07 09:00','Left ankle dorsiflexion and great toe dorsiflexion 4/5, with mild numbness over the dorsum of the foot.')
LEGACY_REPORTS=copy.deepcopy(REPORTS)
TEACHING={0:'Focus on the level and side of radicular symptoms, progression of neurological dysfunction, and red-flag screening. Motor deficits must be confirmed using available examination findings; the Patient’s report cannot replace muscle strength grading. MRI is used to assess progressive neurological decline. X-rays and CT are not both mandatory and must not delay assessment merely to complete testing. Do not disclose imaging that has not been opened.',1:H['Surgical indications and options'],2:C[5][1]+' '+C[6][1],3:C[8][1],4:'Debrief based on actual history-taking, images reviewed, localization diagnosis, surgical decision-making, orders, neurological reassessment, and discharge guidance. Do not count surgery predefined in the case as having been performed by the Student; no scoring.'}

# Canonical, phase-filtered English case facts.
import json as _json
from pathlib import Path as _Path
_case_export=_json.loads((_Path(__file__).resolve().parents[1]/"materials/materials/lumbar/case.json").read_text(encoding="utf-8"))
FACTS.update(_case_export["FACTS"])
REGISTRATION.update(_case_export["REGISTRATION"])
