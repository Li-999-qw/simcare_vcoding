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
        {'title':'History taking and physical examination','summary':f'Patient Q&A {asked} Round；'+('Physical examination data viewed。' if 'exam' in session.get('reports',[]) else 'No review of physical examination materials recorded。'),
         'fields':fields([('chief','Chief complaint'),('history','History of present illness'),('past_history','Past medical history'),('allergy_history','Allergy history'),('exam','Physical Examination Record')])},
        {'title':'Ancillary Investigations','summary':f'Apply {len(requested)} items, viewed {len(opened)} items, not yet viewed {len(requested-opened)} Item。',
         'fields':fields([('tests','Ancillary test records')])},
        {'title':'Diagnosis and supporting evidence','summary':'Check each diagnosis and its supporting evidence for written documentation。',
         'fields':fields([('diagnosis','Visit Diagnosis'),('reason','Diagnostic Basis'),('discharge_diagnosis','Discharge diagnosis')])},
        {'title':'Management and follow-up','summary':('Surgical treatment selected and team report confirmed; the procedural outcome is preset in the case.。' if session.get('intervention',{}).get('status')=='confirmed' else f'Record Management Instructions {len(session.get("orders",[]))} entries; instructions do not mean actions have been performed。'),
         'fields':fields(([('plan','Management and handoff plan')] if session.get('intervention',{}).get('status')!='confirmed' else [])+[('daily','Progress Notes'),('discharge','Discharge summary'),('discharge_advice','Medication / Medical orders / Follow-up')])},
    ]

REVIEW_PROMPT='''Provide comprehensive formative feedback based on all actual records from this exercise. Organize it into four sections: 1. History Taking and Physical Examination; 2. Selection of Investigations and Interpretation of Results; 3. Diagnosis and Supporting Evidence; 4. Management, Handover, and Post-discharge Follow-up.。
For each section, describe the actual evidence, what was appropriate, problems or omissions, and specific improvements. If there is no record, state plainly: “No record found; completion cannot be confirmed.” Do not judge quality solely by counts. Distinguish the Student’s plans from the case’s preset surgical outcomes; do not count preset procedures as Student performance. Use snapshots from each stage; do not present information added at discharge as if it were known at the initial consultation. Finally, list the three highest-priority improvements for next time. You may write 800～1400 characters; do not assign a numerical score or a pass verdict。'''
