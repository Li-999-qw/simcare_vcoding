"""Apply outpatient encounter semantics to the isolated lumbar build."""
def apply(dst):
    p=dst/'server.py';s=p.read_text(encoding='utf-8')
    s=s.replace("    s['registration']=copy.deepcopy(REGISTRATION)","    s['registration']=copy.deepcopy(REGISTRATION)\n    if s.get('stage')==0 and '入院登记：' in s.get('notes',{}).get('general',''):\n        s['notes']['general']=s['notes']['general'].split('入院登记：')[0]+'门诊登记：骨科普通门诊；挂号资料齐备，尚未办理入院。'")
    s=s.replace("\\n入院登记：{r['admission_status']}","\\n门诊登记：{r['admission_status']}")
    s=s.replace('一般资料由入院登记预先提供，不视为学生已问诊；入院手续已齐备，无需学生办理。','一般资料由门诊挂号预填。当前接诊为骨科普通门诊，尚未入院；建议住院或手术不等于已经办理或执行。')
    s=s.replace("fields=('name','dose','unit','use','route','type','remark')","fields=('name','dose','unit','use','route','type','days','quantity','remark') if s['stage']==0 else ('name','dose','unit','use','route','type','remark')")
    s=s.replace("row['type'] not in ('临时医嘱','长期医嘱','长期有药','临时有药')","row['type'] not in (('门诊处方',) if s['stage']==0 else ('临时医嘱','长期医嘱','长期有药','临时有药'))")
    s=s.replace("                        s['orders'].append(dict(item,", "                        if s['stage']==0:text+=f\"；疗程：{item['days']}；总量：{item['quantity']}\"\n                        s['orders'].append(dict(item,")
    s=s.replace("    s['registration']=copy.deepcopy(REGISTRATION)","    s['registration']=copy.deepcopy(REGISTRATION)\n    if s.get('notes',{}).get('general'):\n        s['notes']['general']=s['notes']['general'].replace('姓名：李某某','姓名：李志强')")
    p.write_text(s,encoding='utf-8')
    p=dst/'medical_records.py';s=p.read_text(encoding='utf-8')
    s=s.replace("[('admission','入院记录',ADMISSION),('first','首次病程记录',FIRST)]", "[('outpatient','门诊初诊病历',ADMISSION+FIRST+[('plan','处理意见 / 复诊及转诊安排')])]")
    # Preserve previously authored documents and versions with an explicit legacy title.
    s=s.replace("    result=copy.deepcopy(session.get('medical_documents',[]))", "    result=copy.deepcopy(session.get('medical_documents',[]))\n    for doc in result:\n        if doc.get('stage')==0 and doc['id'].split(':')[-1] in ('admission','first'):\n            doc['title']='门诊接诊旧稿（原模板）'")
    p.write_text(s,encoding='utf-8')
    p=dst/'public/app.js';s=p.read_text(encoding='utf-8')
    a=s.index('  if (viewStage === 0) return');b=s.index('\n',a)
    fields=[('general','一般资料 / 病史陈述者','门诊挂号资料',3),('chief','主诉','主要症状及持续时间',2),('history','现病史','起病、症状演变、伴随症状及既往诊治',4),('past_history','既往史','相关疾病、手术及既往类似发作',2),('allergy_history','过敏史','已核实的过敏情况',1),('exam','体格检查','阳性体征及必要的阴性体征',2),('specialist_exam','骨科专科检查','侧别、肌力、感觉、反射及相关试验',3),('tests','辅助检查','已获得的结果，可从报告编辑后导入',2),('diagnosis','诊断','诊断及待排疾病',2),('initial_plan','治疗处理意见','药物、检查、处置及沟通意见',3),('plan','复诊 / 转诊及住院安排','复诊时间、注意事项；需要转诊或住院时写明安排',3),('author','接诊医师（学员）','填写姓名',1)]
    markup=''.join("${noteField("+repr(k)+','+repr(label)+','+repr(ph)+','+str(rows)+')} ' for k,label,ph,rows in fields)
    extras=''.join("${noteField("+repr(k)+','+repr(label)+",'按问诊及分析填写',2)}" for k,label in [('personal_history','个人史'),('marriage_history','婚育史'),('family_history','家族史'),('case_features','病例特点'),('first_diagnosis','原拟诊记录'),('reason','诊断依据'),('differential','鉴别诊断')])
    s=s[:a]+"  if (viewStage === 0) return `<p class=\"muted\">骨科普通门诊 · ${esc(state.time)} · 挂号资料齐备，尚未入院</p>"+markup+'<details><summary>补充病史与诊断分析（按需填写）</summary>'+extras+'</details>`;'+s[b:]
    s=s.replace("['接诊记录'","['门诊初诊病历'").replace("['入院记录'","['门诊初诊病历'").replace("['接诊病历书写'","['门诊初诊病历'")
    s=s.replace('＋ 药品医嘱',"＋ ${viewStage===0?'门诊处方':'药品医嘱'}").replace('＋ 操作医嘱',"＋ ${viewStage===0?'门诊处置':'操作医嘱'}")
    s=s.replace("modal('药品医嘱',", "modal(state.stage===0?'门诊处方':'药品医嘱',")
    needle=" const type=select(['临时医嘱','长期医嘱','长期有药','临时有药'],data.type,'医嘱类型');"
    s=s.replace(needle," const type=select(state.stage===0?['门诊处方']:['临时医嘱','长期医嘱','长期有药','临时有药'],data.type,'处方类型');")
    s=s.replace("cells[4].append(type);", "cells[4].append(type);if(state.stage===0){type.hidden=true;for(const [key,label] of [['days','疗程'],['quantity','总量']]){const input=document.createElement('input');input.dataset.key=key;input.setAttribute('aria-label',label);input.placeholder=label+(key==='days'?'（如3天）':'（如6片）');input.value=data[key]||'';cells[4].append(input);}}")
    s=s.replace("rows.push(r);", "if(state.stage===0&&(!r.days?.trim()||!r.quantity?.trim())){$('#status').textContent='请填写疗程和总量（含单位）。';return;}rows.push(r);")
    s=s.replace("editor.addEventListener('click'", "if(state.stage===0){editor.querySelector('h1').textContent='门诊处方';editor.querySelector('header small').textContent='确定后写入门诊诊疗小结';editor.querySelectorAll('th')[4].textContent='疗程 / 总量';}\neditor.addEventListener('click'")
    # Outpatient procedures are one-encounter orders, never longitudinal ward orders.
    s=s.replace("search.oninput=()=>{tr.operation", "if(state.stage===0){const t=tr.querySelector('select[aria-label=\"医嘱类型\"]');t.innerHTML='<option>临时医嘱</option>';t.hidden=true;t.parentElement.append('本次门诊');}\n    search.oninput=()=>{tr.operation")
    s=s.replace('选择手术治疗后，由手术团队接诊并回报结果。','此后进入住院手术教学阶段；门诊处方不视为围术期已给药。')
    p.write_text(s,encoding='utf-8')
