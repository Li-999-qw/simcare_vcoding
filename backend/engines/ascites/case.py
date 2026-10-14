"""Source-backed ascites case. Full reference records never enter the student API."""
import copy
import json
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]/'materials/materials/ascites'
DATA = json.loads((SOURCE/'case-data.json').read_text('utf-8'))
DESIGN = json.loads((SOURCE/'teaching-data.json').read_text('utf-8'))
PAGES = DATA['clinical_pages']
CASE_ID = DATA['id']
VERSION = '腹水病例 v'+DATA['version']+' · 待临床专家审核'
STAGES = ['入院接诊','首日处置与交接','逐日病房查房','出院指导','复盘']
TIMES = ['9月1日09:20','9月1日12:00','9月2日至8日','9月9日10:00','演练结束']

def block_text(block):
    if block['type']=='table':
        return '\n'.join('；'.join(map(str,row)) for row in block['rows'])
    return (block.get('title','')+'：' if block.get('title') else '')+block.get('text','')

def page_text(index):
    return '\n'.join(block_text(b) for b in PAGES[index]['blocks'] if b['type']!='image')

FACTS = {'identity':'王建华，男，56岁，已婚，成都人。',
         'pain':page_text(2), 'past':page_text(3),
         'daily_life':'与妻子同住，育有一子，工作以站立和轻体力搬运为主。',
         'ward_patient':'腹部仍胀，轻腹痛较前减轻。',
         'discharge_patient':'进食、睡眠改善，腹痛和水肿消失。'}
PATIENT_BASE = ['identity','past','daily_life']
REGISTRATION = dict(name='王建华',sex='男',age='56岁',marital_status='已婚',occupation='站立及轻体力搬运工作',ethnicity='未单列',birthplace='四川成都',address='四川成都（详细住址未设定）',history_source='患者本人',admission_status='消化内科入院接诊')
REPORTS = {}

def add(key, name, page, stage, collected, reported, category='血液', rows=None, findings=None, image=None):
    blocks=PAGES[page]['blocks']
    if rows is None:
        rows=next((b['rows'] for b in blocks if b['type']=='table' and len(b.get('headers',[]))==5),[])
    entries=[dict(name=r[0],value=r[1],flag=r[2],unit=r[3],reference=r[4]) for r in rows]
    if findings is None:
        # Lab teaching interpretations and final diagnoses are not laboratory findings.
        findings='' if entries else '\n'.join(block_text(b) for b in blocks if b['type'] in ('section','table'))
    sheet=dict(title=name,number=key,sample=category,collected=collected,received=collected,reported=reported,
               findings=findings,rows=entries,note='教学合成病例 v1.1，待临床专家审核。数值和时间来自原病案；不用于真实诊疗。')
    if image: sheet['image']=image
    text='\n'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}（参考：{r['reference']}）" for r in entries)
    text=(text+'\n'+findings).strip()
    REPORTS[key]=dict(name=name,stage=stage,category=category,sheet=sheet,text=text,
                      positive='；'.join(f"{r['name']} {r['value']} {r['unit']} {r['flag']}" for r in entries if r['flag']),
                      source_page=page+1,available_at=collected)

def stamp(day,clock): return f'2026-09-{day:02d} {clock}'
add('exam','入院体格检查',4,0,stamp(1,'09:20'),stamp(1,'09:20'),'查体',findings=block_text(PAGES[4]['blocks'][0]))
add('cbc','血常规',6,0,stamp(1,'09:45'),stamp(1,'10:15'))
add('chemistry','肝肾功能及电解质',7,0,stamp(1,'09:45'),stamp(1,'10:40'))
add('coagulation','凝血及炎症指标',8,0,stamp(1,'09:45'),stamp(1,'10:45'))
urine=next(b['rows'] for b in PAGES[9]['blocks'] if b['type']=='table')
add('urine','尿液检查',9,0,stamp(1,'10:00'),stamp(1,'11:20'),'尿液',rows=urine[:7])
add('etiology','病因筛查',9,0,stamp(1,'09:45'),stamp(2,'09:00'),rows=urine[7:])
add('ultrasound','肝胆脾及泌尿系超声',10,0,stamp(1,'10:35'),stamp(1,'11:00'),'影像',image='ultrasound-synthetic.png')
add('ecg','十二导联心电图',11,0,stamp(1,'10:10'),stamp(1,'10:20'),'心电',image='ecg-synthetic.png')
add('ascites','诊断性腹腔穿刺与腹水检验',13,0,stamp(1,'11:05'),stamp(1,'12:00'),'腹水')
add('culture-prelim','腹水培养初报',17,0,stamp(1,'11:05'),stamp(2,'16:00'),'微生物',rows=[],findings='革兰阴性杆菌；鉴定与药敏尚未回报。')
add('culture-final','腹水培养与药敏终报',17,0,stamp(1,'11:05'),stamp(3,'09:30'),'微生物')
add('renal-day2','第2日肾功能与电解质',15,2,stamp(2,'06:00'),stamp(2,'07:30'))
day3=next(b['rows'] for b in PAGES[18]['blocks'] if b['type']=='table')
add('blood-day3','第3日血液复查',18,2,stamp(3,'06:00'),stamp(3,'07:30'),rows=day3[:8])
add('ascites-repeat','复查腹腔穿刺与腹水细胞计数',18,2,stamp(3,'11:50'),stamp(3,'12:30'),'腹水',rows=day3[8:])
add('pre-drainage','第4日放腹水前安全评估',20,2,stamp(4,'06:00'),stamp(4,'07:30'))
post=next(b['rows'] for b in PAGES[23]['blocks'] if b['type']=='table')
for day in (5,7,9):
    rows=[[r[0][6:],*r[1:]] for r in post if r[0].startswith(f'09-{day:02d}')]
    add('blood-day'+str(day),f'第{day}日血液复查',23,3 if day==9 else 2,stamp(day,'06:00'),stamp(day,'07:30'),rows=rows)
add('blood-culture','血培养终报',24,0,stamp(1,'09:50'),stamp(6,'10:00'),'微生物',rows=[],findings='两组外周血培养5天未检出细菌。')
add('repeat-culture','复查腹水培养终报',24,2,stamp(3,'11:50'),stamp(8,'12:30'),'微生物',rows=[],findings='复查腹水培养5天未检出细菌。')
add('ultrasound-review','出院前腹部超声',25,2,stamp(8,'09:30'),stamp(8,'09:30'),'影像')
add('drainage','治疗性腹腔穿刺放液记录',21,2,stamp(4,'10:00'),stamp(4,'11:40'),'操作',findings=page_text(21))
add('handoff','预设首日治疗交接',14,1,stamp(1,'18:00'),stamp(1,'18:00'),'交接',findings=page_text(14))
add('ward','当日护理与查体',29,2,stamp(2,'09:00'),stamp(2,'09:00'),'复评',findings='按当前查房日期查看。')
add('discharge','出院前状态',26,3,stamp(9,'10:00'),stamp(9,'10:00'),'复评',findings='进食睡眠改善，腹痛及水肿消失。体重68.1 kg，腹围94 cm，BP112/70 mmHg，尿量1500 mL/24h。')
LEGACY_REPORTS=copy.deepcopy(REPORTS)
TEACHING={0:'按主诉及已获得的病史查体讨论检查优先级。不得透露未返回的腹水、培养结果或后续病程。',
          1:'结合已获得的腹水和其他检查讨论首日诊断、治疗及监测，不能透露次日肌酐或药敏。',
          2:'只依据当前日期已返回检查及学员记录讨论动态调整，不透露后续疗效。',
          3:page_text(31),4:json.dumps(DESIGN['objectives'],ensure_ascii=False)+'\n'+page_text(30)+'\n'+page_text(31)}
WARD_SYMPTOMS={2:'仍腹胀，腹部轻压痛较前减轻，无黑便、意识变化及呼吸困难。',3:'腹痛消失，腹胀仍较明显，无呼吸困难。',4:'放液前仍腹胀、早饱。',5:'腹胀减轻，踝部轻度水肿。',6:'腹痛没有再发，排便正常。',7:'腹痛和水肿消失。',8:'进食和睡眠改善。'}
NURSING=next(b['rows'] for b in PAGES[29]['blocks'] if b['type']=='table')

def day_of(session):
    return int(session.get('clinical_clock','2026-09-01 09:20')[8:10])

def ward_report(session):
    day=min(max(day_of(session),2),8)
    row=NURSING[day-1]
    if day==4 and 'drainage' not in session.get('reports',[]):
        row=[row[0],'75.6','105',row[3],row[4],'放液前观察']
    return '日期 '+row[0]+'；体重 '+row[1]+' kg；腹围 '+row[2]+' cm；BP '+row[3]+' mmHg；近24小时尿量 '+row[4]+' mL。'+WARD_SYMPTOMS[day]+'（病例预设查房节点，不表示学员已执行参考治疗。）'

def teaching(session):
    day=day_of(session)
    if session['stage']==4:return TEACHING[4]
    return TEACHING[session['stage']]+' 当前日期：09-'+str(day)+'。病例按预设病程推进；只评价学员实际记录的行为。'
