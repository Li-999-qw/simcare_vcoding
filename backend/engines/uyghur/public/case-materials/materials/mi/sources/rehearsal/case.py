"""Curated rehearsal subset of build_case_pdf.py, expert-review v1.0 (not approved)."""
CASE_ID = 'SIM-AMI-20260901'
VERSION = '专家审核版 v1.0 · 待专家审核'
STAGES = ['接诊', '处置与交接', '病房查房', '出院日', '反馈']
TIMES = ['9月1日 09:20', '9月1日 09:35', '9月3日 09:00', '9月7日 09:00', '演练结束']
FACTS = {
 'identity': '张建国，男，58岁，已婚，企业行政人员。',
 'pain': '9月1日08:00搬运物品时突发胸骨后压榨样疼痛，手掌大小范围，向左肩及左上臂内侧放射，8/10分，伴大汗、恶心及胸闷。休息20分钟未缓解，09:20到院，此前未接受院前处理。',
 'previous': '近2周上楼或快走时胸骨后闷痛3次，每次3～5分钟，休息缓解，未就诊。',
 'negatives': '无撕裂样胸背痛，无呼吸或体位相关疼痛，无发热、咳嗽、咯血、晕厥、肢体活动障碍及单侧下肢肿痛。近3个月无手术、长期卧床或长途制动。',
 'hypertension': '高血压8年，最高170/100 mmHg，间断服氨氯地平5 mg每日1次，依从性差；平时145～160/90～100 mmHg。',
 'lipid': '2年前发现血脂升高，未规律治疗。',
 'past': '否认既往心肌梗死、PCI、心力衰竭、糖尿病、脑卒中、慢性肾病。否认活动性溃疡、消化道或颅内出血、凝血障碍、近期重大创伤手术，无长期抗凝用药。否认哮喘、严重慢性肺病、肝炎、结核及输血史。',
 'allergy': '否认已知药物及造影剂过敏；近期未使用西地那非等PDE-5抑制剂。',
 'social': '吸烟30年，约20支/日；偶尔饮酒，无大量饮酒史。运动少，偏咸高脂饮食，无特殊职业接触。',
 'family': '父亲54岁发生心肌梗死，母亲有高血压，否认已知遗传性心肌病和家族性猝死史。配偶及1子体健。',
 'ward_patient': '9月3日无胸痛、心悸、气短，可坐起并短距离步行。右腕穿刺点少量瘀斑，无血肿或出血。已转普通病房。',
 'discharge_patient': '9月7日无胸痛、心悸、气促，生活可自理，穿刺点愈合良好。能复述已告知的药物及复诊计划，愿意戒烟。',
}
PATIENT_BASE = ['identity','previous','negatives','hypertension','lipid','past','allergy','social','family']
REPORTS = {
 'exam': {'name':'生命体征与心肺查体','category':'查体','stage':0,'text':'9月1日09:20：T 36.5℃，P 92次/分，R 22次/分；右臂BP 148/92，左臂146/90 mmHg，空气下SpO₂ 96%。神志清楚，急性痛苦面容，皮肤湿冷。双肺清，无干湿啰音；心律齐，无第三心音、病理性杂音及心包摩擦音。双侧脉搏对称，下肢无水肿。'},
 'ecg': {'name':'12导联心电图','category':'心电','stage':0,'text':'9月1日09:25：窦性心律，92次/分；V₁～V₆ ST段抬高，Ⅲ、aVF对应性压低。本次对话演练提供文字所见，不提供诊断结论或判读图像。'},
 'troponin': {'name':'初始心肌损伤标志物','category':'血液','stage':0,'text':'采血9月1日09:28，报告09:50。hs-cTnI 186 ng/L ↑（参考上限34 ng/L）。为简化对话测试，申请后直接展示；这不模拟真实等待时间。'},
 'handoff': {'name':'介入团队交接报告','category':'交接','stage':2,'text':'9月1日急诊冠脉造影：前降支近段完全闭塞，TIMI 0级；置入1枚药物洗脱支架后TIMI 3级。术后胸痛消失，ST明显回落。11:05转CCU，循环稳定。此为按病例推进的预设事件，不代表学生的所有指令均已执行。'},
 'ward': {'name':'病房复评资料','category':'复评','stage':2,'text':'9月3日：无胸痛、心悸、气短。BP 120/74 mmHg，HR 68次/分，双肺清。Hb 143 g/L，肌酐84 μmol/L；心肌标志物下降，48小时未见持续恶性心律失常。9月1日术后超声LVEF 45%，前壁、前间隔和心尖运动减弱，无机械并发症。'},
 'discharge': {'name':'出院前复查','category':'复评','stage':3,'text':'9月6日：Hb 145 g/L，PLT 229×10⁹/L，Cr 80 μmol/L，K 4.3 mmol/L。hs-cTnI 780 ng/L ↑，持续下降；超声LVEF 50%，未见明确左室血栓。9月7日BP 118/74 mmHg，HR 66次/分，空气下SpO₂ 97%，双肺清，无下肢水肿。'},
}
from report_catalog import extend_reports
from copy import deepcopy
LEGACY_REPORTS=deepcopy(REPORTS)
extend_reports(REPORTS)
for key,old in LEGACY_REPORTS.items():
    old['sheet']={'title':old['name'],'number':key,'sample':'原文字报告','collected':'见正文','reported':'见正文',
                  'findings':old['text'],'note':'旧演练：保留当时实际获得的文字结果，不补入新版目录的额外检测结果。'}
    old['positive']=REPORTS[key]['positive'] if key not in ('ecg','troponin') else (
        '9月1日09:25：V₁～V₆ ST段抬高，Ⅲ、aVF对应性压低。' if key=='ecg' else
        '9月1日09:28采血：hs-cTnI 186 ng/L ↑（参考上限34 ng/L）。')
# Teacher references are stage-limited and never passed to the patient role.
TEACHING = {
 0: '根据已获病史、心电和查体讨论工作诊断，不能用未打开的报告或后来的冠脉结果倒推。病例参考：定位性ST段抬高与缺血症状支持启动紧急再灌注路径，不等待肌钙蛋白峰值。仅当相关体征已获时讨论Killip分级，1型机制不能冒称术前已由造影证实。',
 1: '病例参考路径为紧急协调导管室、抗血小板负荷、介入期抗凝、强化降脂、监护及风险沟通。药物须核对适用情况和禁忌。学生为接诊医生，不操作介入。所有指令只记为计划，执行应由流程确认。不要自行给未配置的剂量。',
 2: '病例术后继续双联抗血小板和降脂，观察再缺血、心衰、心律失常、出血、肾功能及穿刺点；无其他抗凝指征，不常规继续肝素。稳定后渐进康复。需要结合已打开交接和复评资料，不能把高肌钙蛋白单独等同再梗死。',
 3: '病例出院安排包含用药核对、抗血小板依从性、戒烟、康复、7～14天复诊评估症状及肾功能钾、4～6周复查血脂、6～12周复查超声；说明胸痛复发及出血的急诊处理。不能仅因支架置入判断治愈。具体剂量按审核病历，此演练不自动生成处方。',
 4: '只根据实际对话、打开的报告和病历文字复盘。列出做得好、尚未见证据的部分与下次建议。禁止数字评分、通过结论、将未记录行为算作完成。说明这是形成性反馈，病例及评分尚待专家审核。',
}

# Teaching registration data, supplied before the learner starts interviewing.
REGISTRATION = {
 'name':'张建国','sex':'男','age':'58岁','marital_status':'已婚','occupation':'企业行政人员',
 'ethnicity':'汉族','birthplace':'安徽省合肥市','address':'四川省成都市武侯区康宁路18号春和苑2栋301室（教学虚构地址）',
 'history_source':'患者本人','admission_status':'已办理入院，登记资料齐备',
}
