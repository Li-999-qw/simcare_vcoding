"""Case adapter: original LDH v1.1 values, with phase-limited disclosure."""
import json, copy
from pathlib import Path
DATA=json.loads((Path(__file__).parent/'lumbar-case-data.json').read_text(encoding='utf-8'))
CASE_ID=DATA['id'];VERSION='腰椎病例 v'+DATA['version']+' · '+DATA['reviewStatus']
STAGES=['骨科普通诊室接诊','术前决策与手术','术后查房','出院指导','复盘']
TIMES=['9月3日09:00','9月3日11:30','9月5日09:00','9月7日09:00','演练结束']
H=dict(DATA['history']);C=DATA['course']
FACTS={'identity':H['一般资料'],'pain':H['主诉']+' '+H['现病史']+' '+H['近期进展'].split('9月3日09:00')[0],
       'previous':H['保守治疗经过'],'negatives':H['红旗症状与相关阴性病史'],
       'past':H.get('既往史',''),'allergy':H['用药与过敏史'] if '用药与过敏史' in H else next(v for k,v in H.items() if '过敏' in k),
       'social':H['个人、婚育及家族史'],
       'ward_patient':'术后第1天，左腿痛1～2/10，足背麻木减轻，可以在保护下步行，自主排尿正常。',
       'discharge_patient':'腿痛1/10，足背仍有轻度麻木，可以保护下步行，二便正常。'}
DETAILS=json.loads((Path(__file__).parent/'patient-details.json').read_text(encoding='utf-8'))
FACTS['identity']='姓名：李志强（虚构教学患者）。'+FACTS['identity'].replace('入院科室：脊柱外科','就诊科室：骨科普通门诊，尚未办理入院')
# Explicit, stable fictional additions; never replace the source clinical course.
FACTS['prior_episodes']=DETAILS['prior_episodes']
FACTS['daily_life']=DETAILS['daily_life']
PATIENT_BASE=['identity','previous','negatives','past','allergy','social','prior_episodes','daily_life']
REGISTRATION={'name':'李志强','sex':'男','age':'46岁','marital_status':'已婚','occupation':'仓储管理人员','ethnicity':'汉族（教学登记设定）','birthplace':'四川省成都市（教学登记设定）','address':'成都市武侯区安和路26号3栋502室（教学虚构地址）','history_source':'患者本人及配偶','admission_status':'骨科普通门诊；挂号资料齐备，尚未办理入院'}
REPORTS={}
def add(key,name,stage,category,text,date,positive='',rows=None,pacs=None):
    sheet=dict(title=name+'报告',number='LDH-'+key,sample='检查记录',collected=date,received=date,reported=date,findings=text,note='原腰椎病例v1.1教学资料；非真实患者报告。')
    if rows:sheet['rows']=[dict(name=r[0],value=str(r[1]),unit=r[2],reference=r[3],flag=r[4]) for r in rows]
    REPORTS[key]=dict(name=name,stage=stage,category=category,text=text,sheet=sheet,positive=positive)
    if pacs:REPORTS[key]['pacs']=pacs
exam=H['一般查体']+'\n'+H['脊柱及神经查体']+'\n入院左侧肌力：'+ '；'.join(r[0]+' '+r[2] for r in DATA['strength'])
add('exam','一般及脊柱神经查体',0,'查体',exam,'2026-09-03 09:00',H['脊柱及神经查体']+'左踝背伸、踇趾背伸3/5。')
for r in DATA['reports']:
    add(r['id'],r['title'],0,'影像',r['findings']+'\n影像印象：'+r['impression'],r['date'],r['impression'],pacs=r['id'])
    REPORTS[r['id']]['sheet']['reported']=r['reportTime']
    REPORTS[r['id']]['sheet']['note']+=' 原来源检查：'+r['date']+'；本次申请后显示模拟执行时间。合成图不能替代诊断级影像。'
groups={'cbc':('血常规',[0,1,2]),'inflammation':('炎症指标',[3,4]),'renal_liver':('肝肾功能',[5,6,7]),'other_labs':('术前其他检验',list(range(8,len(DATA['labs']))))}
for key,(name,idx) in groups.items():
    rows=[DATA['labs'][i] for i in idx]
    if rows:add(key,name,0,'血液','；'.join(str(r[0])+' '+str(r[1])+r[2] for r in rows),'2026-09-03 09:00',rows=rows)
add('ecg','术前十二导联心电图',0,'心电','窦性心律，78次/分，无明显异常。','2026-09-03 09:00')
add('handoff','手术团队回报',1,'交接',C[3][1]+'\n'+C[4][1],'2026-09-04 13:00',C[4][1])
add('ward','术后神经功能与切口复评',2,'复评',C[5][1],'2026-09-05 09:00','左踝及踇趾背伸4/5，足背麻木减轻。')
add('discharge','出院前复评',3,'复评',C[7][1],'2026-09-07 09:00','左踝背伸、踇趾背伸4/5，足背轻度麻木。')
LEGACY_REPORTS=copy.deepcopy(REPORTS)
TEACHING={0:'重点评价根性症状的节段、侧别、神经功能进展与红旗筛查。必须依已获得查体确认运动缺损，不能以患者自述替代肌力分级。MRI用于进行性神经功能下降评估；X线与CT并非都必须申请，不能为补齐检查延误评估。不得泄露未打开影像。',1:H['手术指征与选择'],2:C[5][1]+' '+C[6][1],3:C[8][1],4:'按真实问诊、已查看影像、定位诊断、手术决策、医嘱、神经复评与出院指导复盘；不把病例预设手术算作学员已操作，不打分。'}
