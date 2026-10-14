"""Source-backed ascites case. Full reference records never enter the student API."""
import copy
import json
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]/'materials/materials/ascites'
DATA = json.loads((SOURCE/'case-data.json').read_text('utf-8'))
DESIGN = json.loads((SOURCE/'teaching-data.json').read_text('utf-8'))
PAGES = DATA['clinical_pages']
CASE_ID = DATA['id']
VERSION = 'Ascites Case v'+DATA['version']+' · Pending clinical expert review'
STAGES = ['Admission assessment','First-Day Management and Handover','Daily ward rounds','Discharge instructions','Debrief']
TIMES = ['9 month 1 day 09:20','9 month 1 day 12:00','9 month 2 Days to 8 day','9 month 9 day 10:00','End of simulation']

def block_text(block):
    if block['type']=='table':
        return '\n'.join('；'.join(map(str,row)) for row in block['rows'])
    return (block.get('title','')+'：' if block.get('title') else '')+block.get('text','')

def page_text(index):
    return '\n'.join(block_text(b) for b in PAGES[index]['blocks'] if b['type']!='image')

FACTS = {'identity':'Wang Jianhua, male，56 years old, married, from Chengdu。',
         'pain':page_text(2), 'past':page_text(3),
         'daily_life':'Lives with his wife and has one son; work mainly involves standing and light manual handling.。',
         'ward_patient':'Abdominal distension persists; mild abdominal pain has improved。',
         'discharge_patient':'Food intake and sleep improved; abdominal pain and edema resolved。'}
PATIENT_BASE = ['identity','past','daily_life']
REGISTRATION = dict(name='Wang Jianhua',sex='male',age='56 years old',marital_status='Married',occupation='Work involving standing and light manual handling',ethnicity='Not listed separately',birthplace='Chengdu, Sichuan',address='Chengdu, Sichuan (detailed address not specified）',history_source='Patient personally',admission_status='Gastroenterology admission intake')
REPORTS = {}

def add(key, name, page, stage, collected, reported, category='Blood', rows=None, findings=None, image=None):
    blocks=PAGES[page]['blocks']
    if rows is None:
        rows=next((b['rows'] for b in blocks if b['type']=='table' and len(b.get('headers',[]))==5),[])
    entries=[dict(name=r[0],value=r[1],flag=r[2],unit=r[3],reference=r[4]) for r in rows]
    if findings is None:
        # Lab teaching interpretations and final diagnoses are not laboratory findings.
        findings='' if entries else '\n'.join(block_text(b) for b in blocks if b['type'] in ('section','table'))
    sheet=dict(title=name,number=key,sample=category,collected=collected,received=collected,reported=reported,
               findings=findings,rows=entries,note='Synthetic Teaching Case v1.1，Pending review by clinical experts. Values and times come from the original case record; not for actual clinical care.。')
    if image: sheet['image']=image
    text='\n'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}（Reference：{r['reference']}）" for r in entries)
    text=(text+'\n'+findings).strip()
    REPORTS[key]=dict(name=name,stage=stage,category=category,sheet=sheet,text=text,
                      positive='；'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}" for r in entries if r['flag']),
                      source_page=page+1,available_at=collected)

def stamp(day,clock): return f'2026-09-{day:02d} {clock}'
add('exam','Admission Physical Examination',4,0,stamp(1,'09:20'),stamp(1,'09:20'),'Physical examination',findings=block_text(PAGES[4]['blocks'][0]))
add('cbc','Complete blood count',6,0,stamp(1,'09:45'),stamp(1,'10:15'))
add('chemistry','Liver and renal function and electrolytes',7,0,stamp(1,'09:45'),stamp(1,'10:40'))
add('coagulation','Coagulation and inflammatory markers',8,0,stamp(1,'09:45'),stamp(1,'10:45'))
urine=next(b['rows'] for b in PAGES[9]['blocks'] if b['type']=='table')
add('urine','Urinalysis',9,0,stamp(1,'10:00'),stamp(1,'11:20'),'Urine',rows=urine[:7])
add('etiology','Etiologic Screening',9,0,stamp(1,'09:45'),stamp(2,'09:00'),rows=urine[7:])
add('ultrasound','Ultrasound of the liver, gallbladder, spleen, and urinary tract',10,0,stamp(1,'10:35'),stamp(1,'11:00'),'Imaging',image='ultrasound-synthetic.png')
add('ecg','Twelve-lead ECG',11,0,stamp(1,'10:10'),stamp(1,'10:20'),'Electrocardiography',image='ecg-synthetic.png')
add('ascites','Diagnostic paracentesis and ascitic fluid analysis',13,0,stamp(1,'11:05'),stamp(1,'12:00'),'Ascites')
add('culture-prelim','Preliminary ascitic fluid culture report',17,0,stamp(1,'11:05'),stamp(2,'16:00'),'Microbiology',rows=[],findings='Gram-negative bacilli; identification and antimicrobial susceptibility results are still pending。')
add('culture-final','Final ascitic fluid culture and antimicrobial susceptibility report',17,0,stamp(1,'11:05'),stamp(3,'09:30'),'Microbiology')
add('renal-day2','No.2 Renal function and electrolytes on day',15,2,stamp(2,'06:00'),stamp(2,'07:30'))
day3=next(b['rows'] for b in PAGES[18]['blocks'] if b['type']=='table')
add('blood-day3','No.3 Repeat blood tests on day',18,2,stamp(3,'06:00'),stamp(3,'07:30'),rows=day3[:8])
add('ascites-repeat','Repeat abdominal paracentesis and ascitic fluid cell count',18,2,stamp(3,'11:50'),stamp(3,'12:30'),'Ascites',rows=day3[8:])
add('pre-drainage','No.4 Pre-paracentesis safety assessment on the day',20,2,stamp(4,'06:00'),stamp(4,'07:30'))
post=next(b['rows'] for b in PAGES[23]['blocks'] if b['type']=='table')
for day in (5,7,9):
    rows=[[r[0][6:],*r[1:]] for r in post if r[0].startswith(f'09-{day:02d}')]
    add('blood-day'+str(day),f'No.{day}Repeat blood tests on day',23,3 if day==9 else 2,stamp(day,'06:00'),stamp(day,'07:30'),rows=rows)
add('blood-culture','Final blood culture report',24,0,stamp(1,'09:50'),stamp(6,'10:00'),'Microbiology',rows=[],findings='Two sets of peripheral blood cultures 5 days with no bacteria detected。')
add('repeat-culture','Final repeat ascitic fluid culture report',24,2,stamp(3,'11:50'),stamp(8,'12:30'),'Microbiology',rows=[],findings='Repeat ascitic fluid culture 5 days with no bacteria detected。')
add('ultrasound-review','Abdominal ultrasound before discharge',25,2,stamp(8,'09:30'),stamp(8,'09:30'),'Imaging')
add('drainage','Therapeutic Paracentesis Record',21,2,stamp(4,'10:00'),stamp(4,'11:40'),'Actions',findings=page_text(21))
add('handoff','Preset first-day treatment handoff',14,1,stamp(1,'18:00'),stamp(1,'18:00'),'Handover',findings=page_text(14))
add('ward','Today’s nursing care and physical examination',29,2,stamp(2,'09:00'),stamp(2,'09:00'),'Reassessment',findings='View by the current ward-round date。')
add('discharge','Predischarge status',26,3,stamp(9,'10:00'),stamp(9,'10:00'),'Reassessment',findings='Eating and sleep have improved; abdominal pain and edema have resolved. Weight 68.1 kg，Abdominal circumference 94 cm，BP112/70 mmHg，Urine output 1500 mL/24h。')
LEGACY_REPORTS=copy.deepcopy(REPORTS)
TEACHING={0:'Discuss test priorities based on the chief complaint and history and examination findings already obtained. Do not disclose pending ascitic fluid or culture results, or the subsequent clinical course.。',
          1:'Discuss first-day diagnosis, treatment, and monitoring using available ascitic fluid and other test results. Do not disclose the next day’s creatinine or antimicrobial susceptibility results.。',
          2:'Discuss ongoing adjustments using only test results returned by the current date and Student records. Do not disclose subsequent treatment responses.。',
          3:page_text(31),4:json.dumps(DESIGN['objectives'],ensure_ascii=False)+'\n'+page_text(30)+'\n'+page_text(31)}
WARD_SYMPTOMS={2:'Abdominal distension persists; mild abdominal tenderness has improved. No melena, changes in mental status, or dyspnea.。',3:'Abdominal pain has resolved; abdominal distension remains pronounced; no dyspnea。',4:'Abdominal distension and early satiety persist before drainage。',5:'Abdominal distension has improved; mild ankle edema。',6:'Abdominal pain has not recurred; bowel movements are normal。',7:'Resolution of abdominal pain and edema。',8:'Improved eating and sleep。'}
NURSING=next(b['rows'] for b in PAGES[29]['blocks'] if b['type']=='table')

def day_of(session):
    return int(session.get('clinical_clock','2026-09-01 09:20')[8:10])

def ward_report(session):
    day=min(max(day_of(session),2),8)
    row=NURSING[day-1]
    if day==4 and 'drainage' not in session.get('reports',[]):
        row=[row[0],'75.6','105',row[3],row[4],'Observation before fluid drainage']
    return 'Date '+row[0]+'；Body weight '+row[1]+' kg；Abdominal circumference '+row[2]+' cm；BP '+row[3]+' mmHg；nearly 24 Hourly urine output '+row[4]+' mL。'+WARD_SYMPTOMS[day]+'（Preset ward-round milestone; this does not mean the Student has administered the reference treatment.。）'

def teaching(session):
    day=day_of(session)
    if session['stage']==4:return TEACHING[4]
    return TEACHING[session['stage']]+' Current Date：09-'+str(day)+'。The case follows a preset clinical course; only actions actually documented by the Student are assessed.。'
