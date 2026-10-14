"""Immediate, auditable record coverage; clinical critique is generated separately."""
def overview(session):
    notes=session.get('notes',{})
    messages=session.get('messages',[])
    asked=sum(m.get('speaker')=='student' and m.get('role')=='patient' for m in messages)
    requested=set(session.get('requested_reports',[]))-{'exam','handoff'}
    opened=set(session.get('reports',[]))-{'exam','handoff'}
    def fields(keys):
        return [{'label':label,'present':bool(notes.get(key,'').strip()),'evidence':notes.get(key,'')[:500]} for key,label in keys]
    return [
        {'title':'问诊与查体','summary':f'患者问答 {asked} 轮；'+('已查看查体资料。' if 'exam' in session.get('reports',[]) else '未记录查看查体资料。'),
         'fields':fields([('chief','主诉'),('history','现病史'),('past_history','既往史'),('allergy_history','过敏史'),('exam','查体记录')])},
        {'title':'辅助检查','summary':f'申请 {len(requested)} 项，已查看 {len(opened)} 项，尚未查看 {len(requested-opened)} 项。',
         'fields':fields([('tests','辅助检查记录')])},
        {'title':'诊断与依据','summary':'逐项核对诊断及依据是否有书面记录。',
         'fields':fields([('diagnosis','接诊诊断'),('reason','诊断依据'),('discharge_diagnosis','出院诊断')])},
        {'title':'处理与随访','summary':('已选择手术治疗并确认团队回报；操作结果为病例预设。' if session.get('intervention',{}).get('status')=='confirmed' else f'记录处置指令 {len(session.get("orders",[]))} 条；指令不等于已执行。'),
         'fields':fields(([('plan','处置与交接计划')] if session.get('intervention',{}).get('status')!='confirmed' else [])+[('daily','病程记录'),('discharge','出院记录'),('discharge_advice','用药 / 医嘱 / 随访')])},
    ]

REVIEW_PROMPT='''请依据这次演练的全部实际记录，给出完整的形成性点评。按四部分写：一、问诊与查体；二、辅助检查选择及结果解读；三、诊断与依据；四、处理、交接与出院随访。
每部分写实际证据、合理之处、问题或缺漏及具体改进；没有记录时直说“未见记录，不能确认已完成”，不能仅凭数量评价好坏。区分学生的计划和病例预设病程及治疗结果，不能把预设操作计为学生表现。结合各阶段快照，不能用出院补写的内容冒充接诊时已知。最后列出下次最值得改进的三件事。可写800～1400字；不打数字分数，不判通过。'''
