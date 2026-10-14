'use strict';
const casePresentation=window.SIMCARE_CASE_PRESENTATION||{};
const portalParams=new URLSearchParams(location.search);
const portalStudent=portalParams.get('portalStudent');
const portalTask=portalParams.get('portalTask');
const portalMode=portalTask&&portalParams.get('portalMode')==='exam'?'exam':'practice';
const rehearsalStorageKey=portalStudent?'clinical-rehearsal-id:'+portalStudent+':chest-pain:'+(portalTask?'task:'+portalTask+':'+portalMode:'practice'):'clinical-rehearsal-id';
if(portalStudent){const bar=document.createElement('div');bar.style.cssText='padding:10px 20px;background:#20343e;color:white;display:flex;gap:20px;align-items:center';const label=document.createElement('span');label.textContent=(portalParams.get('portalName')||portalStudent)+' · 胸痛病例 · '+(portalTask?'教师分配'+(portalMode==='exam'?' · 考试':' · 练习'):'自主练习');const back=document.createElement('a');back.href=location.protocol+'//'+location.hostname+':8876/portal.html?return='+(portalTask?'tasks':'1');back.textContent='返回学习工作台';back.style.color='#80d9c7';bar.append(label,back);document.body.prepend(bar);}
// Layout and scene flow: approved clinical-rounds.html from the 界面设计 task.
const root = document.getElementById('clinical-rounds');
const $ = s => root.querySelector(s);
const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stageNames = casePresentation.ui_stage_names||['接诊','介入治疗','病房查房','出院日','反馈'];
const sceneNames = casePresentation.scene_names||['急诊诊室','转运与介入团队交接','住院病房','出院日'];
const noteTitles = casePresentation.note_titles||['接诊病历书写','处置与交接记录','日常病程记录','出院记录'];
let state, viewStage = -1, renderedStage = -1, pollTimer, saveTimer, savePromise;
let notes = {}, dirty = new Set(), composers = {}, pending = false, localError = '';
let modalKind = '', currentReport = '', category = '血液', selected = new Set();
let importPositive = true, feedbackRequestPending = false, feedbackRequestedFor = '';
let screenshotDrafts=[], uploadingImage=false, voiceJob=null, voiceTimer, voiceApplied='';
let notice = '文字记录自动保存到本机。';

async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '请求未完成，请重试。');
  return result;
}
const reviewing = () => viewStage !== state.stage;
const editable = () => state && state.stage < 4 && !reviewing();
const blocked = () => pending || state?.busy || uploadingImage || ['starting','listening','transcribing'].includes(voiceJob?.status);
const isExam = () => state?.mode === 'exam';
const viewRecord = () => reviewing() ? state.snapshots?.[String(viewStage)] : null;
const viewNotes = () => viewRecord()?.notes || notes;
const viewRequests = () => viewRecord()?.requested_reports || state.requested_reports;
const viewReports = () => viewRecord()?.reports || state.reports;
const noteField = (key, label, placeholder, rows = 2) => `<label class="field" for="cr-note-${key}">${label}</label><textarea id="cr-note-${key}" data-note="${key}" rows="${rows}" maxlength="6000" placeholder="${placeholder}" ${editable()?'':'readonly'}>${esc(viewNotes()[key])}</textarea>`;

function accept(next, force = false) {
  if(portalStudent&&portalTask&&next.id)fetch('/api/attempt-link',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({student:portalStudent,task:portalTask,session:next.id})}).catch(()=>{});
  const changed = state?.intervention_report !== undefined && Boolean(state?.intervention_report)!==Boolean(next.intervention_report) || state?.intervention?.status!==next.intervention?.status;
  const reportsChanged=JSON.stringify(state?.report_status)!==JSON.stringify(next.report_status);
  state = next;
  force = force || changed;
  if (viewStage < 0) viewStage = state.stage;
  for (const [key,value] of Object.entries(state.notes)) if (!dirty.has(key)) notes[key] = value;
  render(force);
  if(reportsChanged&&modalKind==='reports')openReports();
  if(state.stage===4&&!isExam()&&!state.busy&&['none','generating'].includes(state.feedback?.status)&&feedbackRequestedFor!==state.id)requestFeedback();
}
async function requestFeedback() {
  if(feedbackRequestPending||state.busy)return;
  feedbackRequestPending=true;feedbackRequestedFor=state.id;
  try {accept(await api('/api/feedback',{id:state.id}));schedulePoll();}
  catch(e){showError('点评暂未完成，可点击重新生成。'+e.message);}
  finally {feedbackRequestPending=false;}
}
function showError(message) { localError = message; renderStatus(); }
function renderStatus() {
  const message = localError || state?.error || '';
  $('#cr-error').classList.toggle('hidden', !message);
  $('#cr-error').innerHTML = message ? `${esc(message)} <button data-action="reconnect">重新连接</button>` : '';
  $('#cr-status').textContent = state?.busy ? (state.stage===4?'上级医师正在整理本次复盘…':'角色正在回复，可继续书写病历或申请检查…') : dirty.size ? '文字已暂存，正在保存…' : notice;
  root.querySelectorAll('.record-state').forEach(el => el.textContent = state?.stage === 4 ? '已提交 · 只读' : dirty.size ? '待保存' : '已保存到本机');
}
function composer(role, placeholder) {
  if(role==='patient'&&casePresentation.options?.patient_input_hint)placeholder=casePresentation.options.patient_input_hint;
  return `<div class="busy-state" data-busy="${role}" aria-live="polite"></div><div class="composer"><label class="field" for="cr-input-${role}">${role==='senior'?'向上级汇报 / 请教':role==='team'?'诊疗与交接指令':'对话内容'}</label><textarea id="cr-input-${role}" data-composer="${role}" rows="2" maxlength="2000" placeholder="${placeholder}">${esc(composers[role])}</textarea>${role==='senior'?'<div id="cr-attachments"></div><input id="cr-image-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>':''}<div class="voice-status" data-voice-status="${role}" role="status"></div><div class="row"><button data-voice="${role}">🎙 语音输入</button>${role==='senior'?'<button data-action="upload-image">＋ 上传截图</button>':''}<span class="muted">文字输入 · Ctrl + Enter 发送</span><button class="primary" data-send="${role}">${role==='team'?'记录指令':'发送'}</button></div></div>`;
}
function toolbar() {
  return `<div class="tools" aria-label="临床操作"><button data-action="exam" data-mutate>查体</button><button data-action="checks" data-mutate>＋ 申请检查</button><button data-action="orders" data-mutate>＋ 药品医嘱</button><button data-action="operation-orders" data-mutate>＋ 操作医嘱</button><button data-action="reports" id="cr-report-count">检查报告</button></div>`;
}
function recordBody() {
  if (viewStage === 0) return `<p class="muted">依据问诊及已获取资料填写；未询问、未核实的内容请勿记为阴性。</p><details class="record-document" open><summary>入院记录</summary><div class="document-fields"><p class="muted">已办理入院 · 一般资料由登记系统预填</p>${noteField('general','一般资料 / 病史陈述者','入院登记资料',5)}${noteField('chief','主诉','主要症状或体征及持续时间',2)}${noteField('history','现病史','起病、主要症状特点及演变、伴随症状、院前诊治经过、一般情况',5)}<details class="history-fields"><summary>既往及个人相关病史</summary>${noteField('past_history','既往史','既往疾病、手术、外伤、输血、预防接种等')}${noteField('allergy_history','过敏史','药物、食物及其他过敏情况')}${noteField('personal_history','个人史','出生及居住、职业与暴露、烟酒等')}${noteField('marriage_history','婚育史','婚姻、生育及配偶子女情况；按患者实际情况填写')}${noteField('family_history','家族史','亲属健康情况、相关疾病及遗传病史')}</details>${noteField('exam','体格检查','生命体征及各系统检查所见',3)}${noteField('specialist_exam','专科情况','与本专科相关的查体所见')}${noteField('tests','辅助检查','仅记录已获得的结果，可从报告编辑后导入')}${noteField('diagnosis','初步诊断','按主次列出诊断')}${noteField('author','记录医师（学员）','填写姓名；教学记录，不代替正式电子签名',1)}</div></details><details class="record-document"><summary>首次病程记录</summary><div class="document-fields">${noteField('case_features','病例特点','概括病史、查体和辅助检查的关键特点',3)}${noteField('first_diagnosis','拟诊讨论：初步诊断','列出本次入院的初步诊断')}${noteField('reason','拟诊讨论：诊断依据','根据病例特点阐明诊断及依据',3)}${noteField('differential','拟诊讨论：鉴别诊断','列出需鉴别疾病及支持、排除依据',3)}${noteField('initial_plan','诊疗计划','检查计划、治疗措施、监测及沟通安排',3)}</div></details>`;
  if (viewStage === 1) return `<div class="notice">接诊医生 · 负责决策、协调和交接</div><h3>处置指令</h3><div id="cr-orders"></div>${noteField('plan','处置计划 / 交接要点','记录拟进行的处理与需要交接的问题',4)}<button class="secondary-action" data-action="handoff">${state.stage > 1 ? '查看介入团队回报' : '接收介入团队回报，进入病房 →'}</button><p class="tool-note">病房交接采用病例预设节点，指令记录不代表已执行。</p>`;
  if (viewStage === 2) return `${noteField('daily','病情变化 / 判断 / 今日计划','记录患者交流、复评与后续计划',8)}${noteField('tests','辅助检查','查看报告并导入')}`;
  return noteField('discharge','入院情况 / 诊疗经过 / 出院情况','根据本次诊疗过程整理出院记录',6) + noteField('discharge_diagnosis','出院诊断','填写完整诊断') + noteField('discharge_advice','出院用药 / 医嘱 / 随访','填写用药、生活指导与复诊安排',4);
}
function sceneImage(stage) {
  return `<span class="scene-frame scene-stage-${stage}"><img src="${esc(casePresentation.scene_image_url||'/assets/patient-scenes-v1.png')}" width="1536" height="1024" loading="eager" alt="模拟患者${esc(state?.registration?.name||"患者")}在${sceneNames[stage]}的情景"></span>`;
}
function scenePanel() {
  return `<button class="scene-picture" data-action="scene" aria-label="放大患者情景图">${sceneImage(viewStage)}<span class="scene-caption"><span>${sceneNames[viewStage]} · ${esc(state?.registration?.name||"患者")}，${esc(state?.registration?.age||"")}</span><span class="scene-credit">AI情景示意</span></span></button>`;
}
function cathScene(active=false) {
  return `<figure class="cath-scene"><img src="${esc(casePresentation.intervention_image_url||'/assets/cath-lab-v1.png')}" width="1536" height="1024" alt="写实情景：患者在导管室接受介入治疗，团队在血管造影设备旁操作">${active?'<div class="procedure-overlay" role="status" aria-label="介入手术进行中">介入手术进行中<span class="procedure-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></div>':''}<figcaption>介入手术室 · AI情景示意</figcaption></figure>`;
}
function interventionLayout() {
  if(reviewing())return `<section class="panel pad intervention"><h2>介入治疗记录</h2><p>${state.intervention?.status==='confirmed'?'已选择介入治疗并确认团队回报。':'本次保留原有交接记录。'}</p><button data-action="handoff">查看介入团队回报</button>${state.orders.map(o=>`<p>${esc(o.text)}</p>`).join('')}${viewNotes().plan?`<p>${esc(viewNotes().plan)}</p>`:''}</section>`;
  const started=state.intervention?.status==='started', report=state.intervention_report;
  return `<section class="panel pad intervention"><h2>介入治疗</h2>${report?`<article class="team-report"><span class="tag">介入团队回报</span><h3>${esc(report.name)}</h3><p>${esc(report.text)}</p><button class="primary" data-action="confirm-intervention">确认回报，进入病房 →</button><p class="muted">确认后归入检查报告；病历内容仍由你提取、确认写入。</p></article>`:started?`${cathScene(true)}<p class="muted">情景示意 · 病例预设过程</p>`:`${scenePanel()}<p>选择介入治疗后，由介入团队接诊并回报结果。</p><button class="primary" data-action="start-intervention">选择介入治疗 →</button>`}</section>`;
}
async function startIntervention() {
  await operation(async()=>{accept(await api('/api/intervention/start',{id:state.id}),true);schedulePoll();});
}
async function confirmIntervention() {
  await operation(async()=>{const next=await api('/api/intervention/confirm',{id:state.id});viewStage=next.stage;closeModal();accept(next,true);notice='介入团队回报已归入检查报告，已进入病房。';});
}
function mainLayout() {
  if (viewStage === 4) return feedbackLayout();
  if (viewStage === 1) return interventionLayout();
  const team = viewStage === 1, role = team ? 'team' : 'patient';
  const questions = viewStage === 0 ? ['哪里不舒服？','疼痛持续多久？','以前有类似情况吗？'] : ['今天还有胸痛吗？','活动和睡眠怎么样？'];
  return `<section class="panel conversation" aria-label="${team?'团队交接':'患者问诊'}">${scenePanel()}<div class="pad"><h2 class="heading">${team?'团队对话 · 处置与交接':'患者交流'}<span class="muted" data-sim-time>${reviewing()?'回看记录':state.time}</span></h2><div class="chat chat-log" id="cr-patient-log" role="log" aria-label="${team?'交接记录':'患者对话记录'}" aria-live="polite"></div>${editable()?`<div class="row quick-questions">${team?'<button data-draft="联系介入团队并准备转运交接" data-target="team">联系介入团队</button><button data-draft="安排监测与病情复评" data-target="team">安排监测与复评</button>':questions.map(text=>`<button data-draft="${text}" data-target="patient">${text}</button>`).join('')}</div>${composer(role,team?'输入诊疗指令，记录后在右侧核对':'输入想问患者的话')}`:'<p class="muted">已完成场景的对话保留在这里。返回当前场景继续。</p>'}</div></section><section class="panel pad record-panel" aria-label="病历书写区域"><h2 class="heading">${noteTitles[viewStage]}<span class="record-state"></span></h2>${toolbar()}${recordBody()}<section id="cr-record-archive"></section><section id="cr-treatment-summary"></section><div class="record-bottom"><span class="muted">${editable()?'输入后自动保存':'已完成场景 · 回看记录'}</span>${editable()?'<button data-action="save" data-mutate>保存病历</button>':''}</div></section>`;
}
function recordReviewHtml() {
  return `<h3>四维记录核对</h3><p class="muted">以下核对实际留存内容；有记录不代表医学判断正确，未见记录也不等同没有实施。</p><div class="review-grid">${(state.record_review||[]).map(card=>`<article class="review-card"><h3>${esc(card.title)}</h3><p>${esc(card.summary)}</p>${card.fields.map(field=>`<details><summary><span class="${field.present?'recorded':'missing'}">${field.present?'已有记录':'未见记录'}</span> · ${esc(field.label)}</summary><p>${esc(field.evidence||'本次未保存该项文字，无法核对。')}</p></details>`).join('')}</article>`).join('')}</div>`;
}
function feedbackLayout() {
  if (isExam()) return `<section class="panel feedback"><h2 class="heading">考试提交回执 <span class="tag">已提交</span></h2><div class="notice">作答已锁定。下面可核对自己的记录；医学点评与标准答案等待教师发布。</div>${recordReviewHtml()}<p class="muted">当前尚未接入教师发布后台。需要即时带教点评，请新建“自主练习”演练。</p><button data-stage="0">回看接诊记录</button> <button data-action="export">导出本次记录</button></section>`;
  const stats = [['患者交流',state.messages.filter(m=>m.speaker==='student'&&m.role==='patient').length+' 轮'],['已查看检查与资料',state.reports.length+' 项'],['病历导入',state.events.filter(e=>e.action==='导入病历').length+' 次'],['介入治疗',state.intervention?.status==='confirmed'?'已选择并确认回报':'未确认'],['请教上级',state.hint_count+' 次提示']];
  return `<section class="panel feedback"><h2 class="heading">本次训练反馈 <span class="tag">已提交</span></h2><p class="muted">基于实际问诊、已查看报告及各阶段病历形成点评。未记录的行为不视为已完成。</p><h3>上级医师 · 四维点评</h3><div class="chat chat-log" id="cr-feedback-log" role="log" aria-label="复盘对话记录" aria-live="polite"></div><button data-action="feedback">生成 / 重试完整点评</button><div class="feedback-composer">${composer('senior','可以追问自己的问诊、检查、诊断与处理是否合理')}</div>${recordReviewHtml()}<details><summary>交互统计与操作时间线</summary>${stats.map(([name,value])=>`<div class="record">${name}<span class="summary-value">${value}</span></div>`).join('')}<div class="history-list">${state.events.map(e=>`<div class="record">${stageNames[e.stage]} · ${esc(e.action)} · ${esc(e.name)}</div>`).join('')}</div></details><div class="row"><button data-stage="0">回看接诊记录</button><button data-stage="1">回看介入治疗</button><button data-action="reports">检查报告</button><button data-action="export">导出本次记录</button></div><p class="muted">形成性反馈 · 暂不生成医学分数</p></section>`;
}
function renderTreatmentSummary() {
  const el=$('#cr-treatment-summary');if(!el)return;
  const record=viewRecord();
  const summary=record ? {operations:(record.orders||[]).filter(o=>o.kind==='operation').map(o=>({time:o.clinical_time,text:o.text})),medications:(record.orders||[]).filter(o=>o.kind==='medication').map(o=>({time:o.clinical_time,text:o.text})),checks:(record.events||[]).filter(e=>e.action==='申请检查').map(e=>({time:e.clinical_time,text:e.name}))} : state.treatment_summary;
  const list=rows=>{
    const items=(rows||[]).slice().sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    return items.length?`<ul class="treatment-items">${items.map(r=>`<li><time>${esc(r.time||'时间未记录')}</time> · ${esc(r.text)}</li>`).join('')}</ul>`:'<p class="muted">暂无</p>';
  };
  el.innerHTML=`<h3>诊疗小结</h3><h4>药物医嘱</h4>${list(summary?.medications)}<h4>操作医嘱</h4>${list(summary?.operations)}<h4>已安排的检查</h4>${list(summary?.checks)}`;
}
function render(force = false) {
  if (!state) return renderStatus();
  $('#cr-mode').textContent = isExam() ? '考试流程测试' : '自主练习';
  $('#cr-flow-toggle').textContent=`流程 · ${stageNames[viewStage]} ${viewStage+1}/5`;
  root.querySelector('nav').innerHTML = stageNames.map((name,i)=>`<button data-stage="${i}" ${i>state.stage?'disabled':''} class="${i===viewStage?'active':''}" aria-current="${i===viewStage?'step':'false'}">${i+1}. ${name}</button>`).join('');
  $('#cr-review').classList.toggle('hidden',!reviewing());
  $('#cr-review').innerHTML = reviewing()?`<span>正在回看${stageNames[viewStage]}记录${viewRecord()?'':'（旧演练仅保留现存病历）'}</span><button data-stage="${state.stage}">返回${stageNames[state.stage]} →</button>`:'';
  if (force || renderedStage !== viewStage) {
    root.querySelector('main').innerHTML = mainLayout();
    renderedStage = viewStage;
  }
  root.querySelectorAll('[data-note]').forEach(el=>{if (document.activeElement!==el && !dirty.has(el.dataset.note)) el.value=viewNotes()[el.dataset.note]||'';});
  renderRecordArchive();
  renderTreatmentSummary();
  const patientLog = $('#cr-patient-log');
  if (patientLog) {
    if (viewStage===1) setLog(patientLog, state.orders.length ? state.orders.map(o=>`<div class="message student"><span class="speaker">你 · 处置指令</span><p>${esc(o.text)}</p><span class="muted">${esc(o.status)}</span></div>`).join('') : '<p class="muted">请记录需要下达的诊疗与交接指令，右侧将保留指令及状态。</p>');
    else {
      let messages = state.messages.filter(m=>m.stage===viewStage&&(m.role==='patient'||m.speaker==='system'));
      setLog(patientLog, messages.map(messageHtml).join('')+streamHtml('patient')||'<p class="muted">本场景尚无对话。</p>');
    }
  }
  if ($('#cr-orders')) $('#cr-orders').innerHTML = state.orders.length ? state.orders.map(o=>`<div class="order">${esc(o.text)}<br><span class="tag">${esc(o.status)}</span></div>`).join('') : '<p class="empty">尚未下达指令，在左侧输入。</p>';
  const count = viewRequests().filter(id=>id!=='exam').length;
  if ($('#cr-report-count')) {
    const unread=viewRequests().filter(id=>id!=='exam'&&!viewReports().includes(id)&&state.report_status?.[id]?.ready).length;
    $('#cr-report-count').innerHTML=`检查报告 (${count})${unread?'<span class="report-dot" aria-hidden="true"></span>':''}`;
    $('#cr-report-count').setAttribute('aria-label',`检查报告，共${count}项${unread?'，'+unread+'份新报告未查看':''}`);
  }
  root.querySelectorAll('[data-sim-time]').forEach(el=>el.textContent=reviewing()?'回看记录':state.time);
  if ($('#cr-ward-reports')) $('#cr-ward-reports').innerHTML = reportGroupsHtml(true);
  updateSeniorLog();
  renderControls();
  renderStatus();
  renderAttachments();
}
function messageHtml(m) {
  const speaker = m.speaker==='student' ? '你' : m.role==='patient' ? '患者' : m.role==='senior' ? '上级医师' : '场景记录';
  return `<div class="message ${m.speaker==='student'?'student':''}"><span class="speaker">${speaker}${m.role==='senior'?' · '+stageNames[m.stage]:''}${m.hint?' · 教学提示':''}</span><p ${casePresentation.options?.rtl_patient&&m.role==='patient'&&m.speaker!=='student'?'lang="ug" dir="rtl"':'dir="auto"'}>${esc(m.text)}</p>${(m.attachments||[]).map(id=>`<img class="chat-attachment" src="/api/attachment?id=${encodeURIComponent(state.id)}&attachment=${encodeURIComponent(id)}" alt="向上级医师提供的截图">`).join('')}</div>`;
}
function streamHtml(role) {
  const draft=state.streaming;
  if(!state.busy||!draft?.text||draft.role!==role||draft.stage!==viewStage)return '';
  return `<div class="message streaming"><span class="speaker">${role==='patient'?'患者':'上级医师'} · 正在回复</span><p ${casePresentation.options?.rtl_patient&&role==='patient'?'lang="ug" dir="rtl"':'dir="auto"'}>${esc(draft.text)}<span class="stream-cursor" aria-hidden="true">▍</span></p></div>`;
}
// Smooth only newly arriving supervisor text; stored history stays immediately readable.
const seniorPaint = new WeakMap();
function paintSeniorLog(el, html) {
  if (!['cr-senior-log','cr-feedback-log'].includes(el.id)) return false;
  if (el.dataset.content === html) return true;
  const old = seniorPaint.get(el);
  if (old) cancelAnimationFrame(old.frame);
  const nearBottom = el.scrollHeight-el.scrollTop-el.clientHeight<70;
  const previous = old ? old.items : [];
  el.innerHTML=html; el.dataset.content=html;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = [...el.querySelectorAll('.message')].map((node,index)=>{
    const p=node.querySelector('p');
    if(!p) return {text:'',shown:0,p:null};
    const text=p.textContent.replace(/▍$/,'');
    const prior=previous[index];
    const animate=!reduced&&!node.classList.contains('student')&&
      (node.classList.contains('streaming') || (old && !prior) || (prior && prior.shown<text.length && text.startsWith(prior.text.slice(0,prior.shown))));
    const shown=animate ? (prior && text.startsWith(prior.text.slice(0,prior.shown)) ? prior.shown : 0) : text.length;
    return {text,shown,p,live:node.classList.contains('streaming')};
  });
  const record={items,frame:0,last:performance.now()};seniorPaint.set(el,record);
  function tick(now){
    if(!el.isConnected)return;
    const follow=el.scrollHeight-el.scrollTop-el.clientHeight<70;
    const dt=Math.min(100,Math.max(0,now-record.last));record.last=now;
    let pending=false;
    for(const item of items){
      if(!item.p)continue;
      const left=item.text.length-item.shown;
      if(left>0){item.shown=Math.min(item.text.length,item.shown+Math.max(1,Math.ceil(dt*Math.max(0.07,left/1800))));}
      // Never cut a UTF-16 surrogate pair (emoji and supplementary characters).
      if(item.shown<item.text.length && /[\uD800-\uDBFF]/.test(item.text[item.shown-1]))item.shown++;
      pending ||= item.shown<item.text.length;
      item.p.textContent=item.text.slice(0,item.shown);
      if(item.live || item.shown<item.text.length){const cursor=document.createElement('span');cursor.textContent='▍';cursor.setAttribute('aria-hidden','true');cursor.className='stream-cursor';item.p.append(cursor);}
    }
    if(follow)el.scrollTop=el.scrollHeight;
    if(pending)record.frame=requestAnimationFrame(tick);
  }
  // Render the retained prefix before the browser can paint the new full payload.
  for(const item of items)if(item.p)item.p.textContent=item.text.slice(0,item.shown);
  if(nearBottom)el.scrollTop=el.scrollHeight;
  record.frame=requestAnimationFrame(tick);
  return true;
}

function setLog(el, html) {
  if(paintSeniorLog(el,html))return;
  if (el.dataset.content === html) return;
  const atBottom = el.scrollHeight-el.scrollTop-el.clientHeight<70;
  el.innerHTML=html;el.dataset.content=html;
  if (atBottom) el.scrollTop=el.scrollHeight;
}
function updateSeniorLog() {
  for (const el of [$('#cr-senior-log'),$('#cr-feedback-log')].filter(Boolean)) {
    let messages=state.messages.filter(m=>m.role==='senior'&&(el.id!=='cr-feedback-log'||m.stage===4));
    if(el.id==='cr-feedback-log'){
      const latest=messages.findLastIndex(m=>m.feedback_review);
      if(latest>=0)messages=messages.slice(latest);
    }
    setLog(el,messages.map(messageHtml).join('')+streamHtml('senior')||`<p class="muted">${state.stage===4?'完整点评将自动生成；如连接失败，可点击“生成 / 重试完整点评”。':'请汇报目前的判断、依据或需要帮助的具体问题。'}</p>`);
  }
  if ($('#cr-senior-error')) $('#cr-senior-error').textContent=state.error?('回复未完成：'+state.error+' 请重新发送问题。'):'';
  if ($('#cr-hints')) $('#cr-hints').textContent=`本次已记录 ${state.hint_count} 次教学提示`;
}
function renderControls() {
  root.querySelectorAll('[data-mutate]').forEach(el=>el.disabled=!editable()||pending);
  root.querySelectorAll('[data-voice]').forEach(el=>{const active=voiceJob?.role===el.dataset.voice&&['starting','listening','transcribing'].includes(voiceJob?.status);el.textContent=active?'■ 取消录音':'🎙 语音输入';el.disabled=!active&&(pending||uploadingImage||['starting','listening','transcribing'].includes(voiceJob?.status));});
  root.querySelectorAll('[data-voice-status]').forEach(el=>el.textContent=voiceJob&&voiceJob.role===el.dataset.voiceStatus?(voiceJob.status==='starting'?'正在启动本地麦克风…':voiceJob.status==='listening'?'正在聆听，请说话；停顿后转为文字。':voiceJob.status==='transcribing'?'正在本机转写…':voiceJob.status==='done'?'已转为文字，请核对医学术语后发送。':voiceJob.error||''):'');
  root.querySelectorAll('[data-send]').forEach(el=>el.disabled=blocked()||(!editable()&&!(viewStage===4&&!isExam()&&el.dataset.send==='senior')));
  root.querySelectorAll('[data-busy]').forEach(el=>el.textContent=state.busy?'正在生成角色回复…':'');
  root.querySelectorAll('[data-action="teacher"]').forEach(el=>el.disabled=isExam()||reviewing());
  $('#cr-teacher-top').classList.toggle('hidden',isExam());
  root.querySelectorAll('[data-action="new"],[data-feedback]').forEach(el=>el.disabled=blocked());
  root.querySelectorAll('[data-action="feedback"]').forEach(el=>el.disabled=blocked()||feedbackRequestPending||state.feedback?.status==='ready');
  root.querySelectorAll('[data-action="handoff"]').forEach(el=>el.disabled=blocked());
  $('#cr-next').textContent = reviewing()?`返回${stageNames[state.stage]} →`:viewStage===4?'本次已提交':viewStage===3?'提交本次训练':`进入${stageNames[viewStage+1]} →`;
  if(!reviewing()&&viewStage===1)$('#cr-next').textContent=state.intervention_report?'确认回报，进入病房 →':state.intervention?.status==='started'?'等待介入团队回报…':'选择介入治疗 →';
  $('#cr-next').disabled = blocked() || (!reviewing()&&(viewStage===4||viewStage===1&&state.intervention?.status==='started'&&!state.intervention_report));
  root.querySelectorAll('[data-action="start-intervention"],[data-action="confirm-intervention"]').forEach(el=>el.disabled=blocked());
}

async function saveNotes() {
  clearTimeout(saveTimer);
  if (savePromise) {await savePromise; if(dirty.size) return saveNotes(); return;}
  if (!dirty.size || !state || state.stage===4) return;
  const payload=Object.fromEntries([...dirty].map(key=>[key,notes[key]]));
  savePromise=(async()=>{
    const next=await api('/api/notes',{id:state.id,notes:payload});
    for(const [key,value] of Object.entries(payload)) if(notes[key]===value) dirty.delete(key);
    accept(next);
  })();
  try {await savePromise;} finally {savePromise=null;}
}
async function operation(fn, duringReply = false) {
  if (pending || (state?.busy && !duringReply)) return;
  pending=true;localError='';renderControls();
  try {await saveNotes();await fn();} catch(e) {showError(e.message);}
  finally {pending=false;renderControls();renderStatus();}
}
function schedulePoll() {clearTimeout(pollTimer);if(state?.busy||(state?.stage===1&&state?.intervention?.status==='started'&&!state.intervention_report))pollTimer=setTimeout(refresh,300);else if(state?.stage<4&&Object.values(state.report_status||{}).some(r=>!r.ready))pollTimer=setTimeout(refresh,2000);}
async function refresh() {
  try {
    const next=await api('/api/state?id='+encodeURIComponent(state.id));
    accept(next);localError='';
    if(!state.busy)await saveNotes();
    schedulePoll();renderStatus();
  } catch(e) {showError('连接中断，当前输入仍保留在页面。'+e.message);}
}
async function send(role, override) {
  const text=(override??composers[role]??'').trim();
  if(!text){if(role==='senior'&&screenshotDrafts.length)showError('请写下希望上级医师解答的问题。');return;}
  await operation(async()=>{
    if(role==='senior')await saveNotes();
    const next=await api(role==='team'?'/api/order':'/api/message',{id:state.id,role,text,request_id:requestId(),attachments:role==='senior'?screenshotDrafts.map(x=>x.id):[]});
    if(role==='senior'){screenshotDrafts=[];renderAttachments();}
    composers[role]='';const input=$(`#cr-input-${role}`);if(input)input.value='';
    accept(next);schedulePoll();
  });
}
async function navigate(stage) {
  if(!state||stage>state.stage||stage<0)return;
  if(state.busy){notice='请等待当前角色回复后切换场景。';return;}
  await operation(async()=>{closeModal();closeFlow();viewStage=stage;render(true);});
}
async function advance() {
  if(reviewing())return navigate(state.stage);
  if(state.stage===1){if(state.intervention_report)return confirmIntervention();if(state.intervention?.status==='started')return;return startIntervention();}
  if(state.stage===3){
    await operation(async()=>{
      if(!notes.discharge?.trim())throw new Error('请先填写右侧出院记录，再提交本次训练。');
      modal('提交本次训练',`<p>提交后病历与诊疗记录将锁定，可以回看。</p><p>${isExam()?'考试成绩和解析等待教师发布。':'随后可请上级医师复盘本次问诊、检查、诊断与处理。'}</p><div class="modal-actions"><button data-action="close">继续书写</button><button class="primary" data-action="submit">确认提交</button></div>`,'submit');
    });
    return;
  }
  await performAdvance();
}
async function performAdvance() {
  await operation(async()=>{
    const next=await api('/api/advance',{id:state.id});viewStage=next.stage;closeModal();accept(next,true);
    if(state.stage===2)openKnownReport('handoff');
    notice=state.stage===4?'本次记录已提交。':'已进入'+stageNames[state.stage]+'。';
  });
}

function modal(title, body, kind='') {
  modalKind=kind;$('#cr-dialog-title').textContent=title;$('#cr-dialog-body').innerHTML=body;
  if(!$('#cr-dialog').open)$('#cr-dialog').showModal();
  renderControls();
}
function closeModal() {if(voiceJob?.role==='senior'&&['starting','listening','transcribing'].includes(voiceJob.status))toggleVoice('senior');$('#cr-dialog').close();modalKind='';}
function openMedicineOrders() {
  modal('药品医嘱', '<div class="cr-rx-host"></div>', 'orders');
  const editor = document.querySelector('.cr-rx-host').attachShadow({mode:'open'});
  editor.innerHTML = '<link rel="stylesheet" href="/style.css?v=rx-native-3">' + "<main><header><h1>药品医嘱</h1><small>药品医嘱 · 确定后写入诊疗小结</small></header><div class=\"table-wrap\"><table><thead><tr><th>药品</th><th>剂量</th><th>用法</th><th>给药途径</th><th>医嘱类型</th><th>备注</th></tr></thead><tbody id=\"rows\"></tbody></table></div><footer><button id=\"add\">＋ 增加一行</button><button id=\"save\" class=\"primary\">确定</button><span id=\"status\">选药后带入常用方案，可修改；个体化剂量可留待填写</span></footer></main>";
window.MI_DRUG_CATALOG = {
  "schema_version": 1,
  "catalog_version": "2026-09-11.2",
  "case_id": "SIM-AMI-20260901",
  "reviewed_at": "2026-09-11",
  "status": "teaching_draft_pending_pharmacy_review",
  "guideline_basis": "本次检索到的最新综合ACS指南为2025 ACC/AHA；中国STEMI资料2019版，ESC综合ACS2023版作为版本核对。2026心梗定义更新不是用药指南替代。",
  "sources": [
    {
      "id": "ACS2025",
      "title": "2025 ACC/AHA ACS Guideline — AHA官方摘要",
      "url": "https://professional.heart.org/en/science-news/2025-guideline-for-the-management-of-patients-with-acute-coronary-syndromes/top-things-to-know",
      "scope": "抗血小板与强化降脂目录依据；不等于每个剂型已获本地批准"
    },
    {
      "id": "CN2019",
      "title": "中国STEMI诊疗指南（2019）",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "国内STEMI诊疗分类参考；具体制剂目录仍需药学核验"
    },
    {
      "id": "HIS",
      "title": "模拟HIS扩展目录",
      "scope": "设计性补充；不声称这些药物均获2025 ACS指南推荐，规格、适应证及剂量待本地药学核验"
    },
    {
      "id": "CASE",
      "title": "本项目心肌梗死模拟病案",
      "path": "../../build_case_pdf.py",
      "scope": "保留既有病例剂量模板，非新指南自动推荐"
    },
    {
      "id": "DOSE001",
      "title": "阿司匹林普通片：常用成人方案资料",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "ACS负荷"
    },
    {
      "id": "DOSE002",
      "title": "阿司匹林肠溶片：常用成人方案资料",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "ACS维持"
    },
    {
      "id": "DOSE003",
      "title": "替格瑞洛片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1225fd45-9b56-1671-ee77-cd0c9f2174a5",
      "scope": "ACS首年维持"
    },
    {
      "id": "DOSE004",
      "title": "硫酸氢氯吡格雷片：常用成人方案资料",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "ACS维持"
    },
    {
      "id": "DOSE005",
      "title": "普拉格雷片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=35aa7f3e-bbd8-4eae-b61f-29d1abca2224",
      "scope": "ACS行PCI后维持"
    },
    {
      "id": "DOSE006",
      "title": "盐酸替罗非班注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13ea7fb8-4b01-4286-9464-26c0b624bc3b",
      "scope": "PCI选择性救援负荷"
    },
    {
      "id": "DOSE007",
      "title": "依替巴肽注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00ad7bbe-cadd-4647-b74b-adfc9f2b5e94",
      "scope": "PCI选择性救援负荷"
    },
    {
      "id": "DOSE008",
      "title": "普通肝素注射液：常用成人方案资料",
      "url": "https://professional.heart.org/~/media/PHD-Files-2/Science-News/2/2021/2021-Coronary-Artery-Revascularization-Guideline-Slide-Set.pdf",
      "scope": "PCI术中抗凝，未合用GPI"
    },
    {
      "id": "DOSE009",
      "title": "依诺肝素钠注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=066f27ec-352c-4051-ba29-248e292690db",
      "scope": "STEMI抗凝，<75岁且CrCl≥30"
    },
    {
      "id": "DOSE010",
      "title": "磺达肝癸钠注射液：常用成人方案资料",
      "url": "https://www.medicines.org.uk/emc/product/3335/smpc",
      "scope": "非直接PCI的STEMI后续抗凝"
    },
    {
      "id": "DOSE011",
      "title": "注射用比伐芦定：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=19a4afc5-151d-4d3c-bfef-48aa8797d695",
      "scope": "PCI比伐芦定负荷"
    },
    {
      "id": "DOSE012",
      "title": "注射用阿替普酶：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=c669f77c-fa48-478b-a14b-80b20a0139c2",
      "scope": "AMI阿替普酶90分钟加速方案首段"
    },
    {
      "id": "DOSE013",
      "title": "注射用瑞替普酶：常用成人方案资料",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "STEMI瑞替普酶首剂"
    },
    {
      "id": "DOSE014",
      "title": "注射用替奈普酶：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=e647640d-c395-4b4b-a0be-1162f9c21d84",
      "scope": "STEMI，TNKase体重分档制剂方案"
    },
    {
      "id": "DOSE015",
      "title": "注射用尿激酶：常用成人方案资料",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "STEMI尿激酶溶栓"
    },
    {
      "id": "DOSE016",
      "title": "阿托伐他汀钙片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00afce9b-48c9-487a-a738-e359c005c707",
      "scope": "ACS强化降脂"
    },
    {
      "id": "DOSE017",
      "title": "瑞舒伐他汀钙片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02797697-300a-43db-92cf-9b78f08626be",
      "scope": "亚洲成人降脂起始"
    },
    {
      "id": "DOSE018",
      "title": "依折麦布片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02b00cb2-7253-4fb4-a216-53691a929a28",
      "scope": "降LDL-C"
    },
    {
      "id": "DOSE019",
      "title": "依洛尤单抗注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cd61e902-166d-4aa6-9f3c-a18c1008d07e",
      "scope": "PCSK9抑制剂降脂"
    },
    {
      "id": "DOSE020",
      "title": "阿利西尤单抗注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=446f6b5c-0dd4-44ff-9bc2-c2b41f2806b4",
      "scope": "PCSK9抑制剂降脂起始"
    },
    {
      "id": "DOSE021",
      "title": "英克司兰钠注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=6fc0afca-4513-4c35-b594-6544aee29a44",
      "scope": "英克司兰初始注射"
    },
    {
      "id": "DOSE022",
      "title": "贝派地酸片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=88d06d89-a3da-40b4-b273-8f4f7d56c4c9",
      "scope": "贝派地酸降脂"
    },
    {
      "id": "DOSE023",
      "title": "硝酸甘油片：常用成人方案资料",
      "url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
      "scope": "缺血性胸痛发作"
    },
    {
      "id": "DOSE024",
      "title": "硝酸甘油注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=578d8159-5ec6-457f-b4a8-9add624d43a8",
      "scope": "持续缺血性胸痛的静脉硝酸酯起始"
    },
    {
      "id": "DOSE025",
      "title": "硝酸异山梨酯片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0e5842f2-74f6-1f02-01bc-07578bd3b393",
      "scope": "心绞痛预防，普通片"
    },
    {
      "id": "DOSE026",
      "title": "单硝酸异山梨酯缓释片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a1e317a-7b05-4d30-9bbc-1d4ccd56ba3c",
      "scope": "心绞痛预防，缓释片"
    },
    {
      "id": "DOSE027",
      "title": "琥珀酸美托洛尔缓释片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01908d20-0e16-4410-bd27-1b6df162ede4",
      "scope": "本病例稳定后β受体阻滞剂起始"
    },
    {
      "id": "DOSE028",
      "title": "酒石酸美托洛尔片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00de1f16-f979-4dbf-aa60-246ffac8d410",
      "scope": "稳定型心绞痛，普通片"
    },
    {
      "id": "DOSE029",
      "title": "富马酸比索洛尔片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=084308e4-3b8b-40d6-acbf-d775772a8a73",
      "scope": "成人高血压起始"
    },
    {
      "id": "DOSE030",
      "title": "卡维地洛片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=010290af-81f4-0037-e063-6394a90a4638",
      "scope": "稳定慢性心衰起始"
    },
    {
      "id": "DOSE031",
      "title": "盐酸艾司洛尔注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=017023a9-00f0-4284-861f-a3634d4fdb17",
      "scope": "室上性心动过速控率维持起始"
    },
    {
      "id": "DOSE032",
      "title": "培哚普利叔丁胺片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=87768fbf-7c63-47da-8925-0316f343d6ef",
      "scope": "本病例ACEI起始"
    },
    {
      "id": "DOSE033",
      "title": "雷米普利片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01da05d8-e72e-4208-bf92-a5cd929f15ab",
      "scope": "心梗后心衰起始"
    },
    {
      "id": "DOSE034",
      "title": "马来酸依那普利片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=074fe718-88d8-365c-e063-6394a90a299d",
      "scope": "心衰起始"
    },
    {
      "id": "DOSE035",
      "title": "卡托普利片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1395ba5b-2fc9-41ff-9c43-e0740d781dee",
      "scope": "心梗后左室功能不全首次试用"
    },
    {
      "id": "DOSE036",
      "title": "缬沙坦胶囊：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03af7d09-314a-fe85-e063-6294a90afa25",
      "scope": "成人高血压，胶囊"
    },
    {
      "id": "DOSE037",
      "title": "氯沙坦钾片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=021cd76a-b093-4704-8410-5e7d01e20a54",
      "scope": "成人高血压"
    },
    {
      "id": "DOSE038",
      "title": "沙库巴曲缬沙坦钠片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=000dc81d-ab91-450c-8eae-8eb74e72296f",
      "scope": "HFrEF、未用或低剂量ACEI/ARB起始"
    },
    {
      "id": "DOSE039",
      "title": "螺内酯片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08738ad4-1607-4d55-af71-6790477353bd",
      "scope": "HFrEF起始"
    },
    {
      "id": "DOSE040",
      "title": "依普利酮片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1a52bedc-8e2c-4116-a296-a87770676b4a",
      "scope": "心梗后HFrEF起始"
    },
    {
      "id": "DOSE041",
      "title": "呋塞米注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08a44bdd-028d-41af-9d4e-70971b0bcc4e",
      "scope": "水肿的初始利尿"
    },
    {
      "id": "DOSE042",
      "title": "托拉塞米注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cf288ad5-d4e7-4b0b-bfd0-41c5327e6984",
      "scope": "心衰水肿初始利尿"
    },
    {
      "id": "DOSE043",
      "title": "达格列净片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01f90c94-71cb-4a1f-81ff-8004b850529b",
      "scope": "心衰/CKD适应证"
    },
    {
      "id": "DOSE044",
      "title": "恩格列净片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1782b947-4a72-4feb-a488-1469d9af82bd",
      "scope": "心衰或2型糖尿病"
    },
    {
      "id": "DOSE045",
      "title": "重酒石酸去甲肾上腺素注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ea48ab6-e166-df31-b132-70ef982a2d02",
      "scope": "急性低血压升压起始，按去甲肾上腺素碱基计"
    },
    {
      "id": "DOSE046",
      "title": "盐酸多巴酚丁胺注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=3418aa46-2d9a-39f3-e063-6294a90a2961",
      "scope": "低心排短期正性肌力起始"
    },
    {
      "id": "DOSE047",
      "title": "盐酸多巴胺注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=093312af-6eef-1f4b-e063-6294a90a155d",
      "scope": "休克的多巴胺低速起始"
    },
    {
      "id": "DOSE048",
      "title": "盐酸肾上腺素注射液：常用成人方案资料",
      "url": "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support",
      "scope": "成人心脏骤停复苏"
    },
    {
      "id": "DOSE049",
      "title": "盐酸胺碘酮注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a28ae25-7cc4-4ac0-a2ba-7820fb93e25c",
      "scope": "有脉室性心律失常负荷"
    },
    {
      "id": "DOSE050",
      "title": "盐酸胺碘酮片：常用成人方案资料",
      "url": "https://www.medicines.org.uk/emc/product/101141/smpc",
      "scope": "胺碘酮口服维持"
    },
    {
      "id": "DOSE051",
      "title": "硫酸阿托品注射液：常用成人方案资料",
      "url": "https://www.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Accessible/Algorithm-ACLS-Bradycardia-LngDscrp-250725-Ed.pdf",
      "scope": "有症状心动过缓"
    },
    {
      "id": "DOSE052",
      "title": "腺苷注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1809fc7e-f5d8-18d8-e063-6394a90a7713",
      "scope": "规则室上性心动过速首剂"
    },
    {
      "id": "DOSE053",
      "title": "硫酸镁注射液：常用成人方案资料",
      "url": "https://sps.nhs.uk/articles/treating-acute-hypomagnesaemia-in-adults/",
      "scope": "低镁且无法口服时补镁"
    },
    {
      "id": "DOSE054",
      "title": "盐酸吗啡注射液：常用成人方案资料",
      "url": "https://www.nhc.gov.cn/wjw/gfxwj/200703/14377de303d6428abc1be6dde4339a71.shtml",
      "scope": "成人重度疼痛的盐酸吗啡镇痛"
    },
    {
      "id": "DOSE055",
      "title": "枸橼酸芬太尼注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0c10e465-4117-48ba-a454-23ccb7a3fcc7",
      "scope": "介入/麻醉辅助镇痛"
    },
    {
      "id": "DOSE056",
      "title": "盐酸利多卡因注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01679d29-a592-8cbb-e063-6394a90ad82a",
      "scope": "穿刺局麻示例，1%无肾上腺素制剂"
    },
    {
      "id": "DOSE057",
      "title": "泮托拉唑钠肠溶片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03dea010-4bae-43ab-893e-9bbddb58062d",
      "scope": "胃食管反流/抑酸"
    },
    {
      "id": "DOSE058",
      "title": "注射用泮托拉唑钠：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=014f9762-6948-46b7-8659-5c89f35ad8bf",
      "scope": "暂不能口服时抑酸"
    },
    {
      "id": "DOSE059",
      "title": "雷贝拉唑钠肠溶片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=04e88b86-e1dd-4c56-8359-45fbcc161f7d",
      "scope": "胃食管反流/抑酸"
    },
    {
      "id": "DOSE060",
      "title": "华法林钠片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0cbce382-9c88-4f58-ae0f-532a841e8f95",
      "scope": "需维生素K拮抗剂抗凝的起始"
    },
    {
      "id": "DOSE061",
      "title": "利伐沙班片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=10db92f9-2300-4a80-836b-673e1ae91610",
      "scope": "非瓣膜性房颤，CrCl>50"
    },
    {
      "id": "DOSE062",
      "title": "阿哌沙班片：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=095a08ac-cf0e-497e-a682-ddef38d6b29c",
      "scope": "非瓣膜性房颤"
    },
    {
      "id": "DOSE063",
      "title": "达比加群酯胶囊：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13649035-a498-4e31-a7ea-8b18cedceca7",
      "scope": "非瓣膜性房颤，CrCl>30的成人标准方案"
    },
    {
      "id": "DOSE064",
      "title": "碘海醇注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5088be1d-a708-1cac-e063-6394a90a2aff",
      "scope": "冠脉造影单次注入，350 mgI/mL"
    },
    {
      "id": "DOSE065",
      "title": "碘克沙醇注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0fe89ea2-04f7-46c5-9c35-220d8c144a95",
      "scope": "右冠造影单次注入，320 mgI/mL"
    },
    {
      "id": "DOSE066",
      "title": "氯化钠注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=123bd10a-90c7-499e-97f6-acf7e0f0fb4e",
      "scope": "0.9%氯化钠作溶媒的录入模板"
    },
    {
      "id": "DOSE067",
      "title": "葡萄糖注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=4ed365da-4e62-4329-c1b9-c197ab4fb6e1",
      "scope": "低血糖纠正，50%葡萄糖"
    },
    {
      "id": "DOSE068",
      "title": "氯化钾注射液：常用成人方案资料",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=559a0a8c-a8fe-40a5-b196-21f9308780ab",
      "scope": "非重症低钾的稀释补钾示例"
    }
  ],
  "items": [
    {
      "id": "ami-drug-001",
      "name": "阿司匹林普通片",
      "pinyin_initials": "asplptp",
      "category": "抗血小板",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "CASE",
        "DOSE001"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "300",
        "unit": "mg",
        "frequency": "一次",
        "route": "嚼服",
        "remark": "ACS负荷；普通片负荷150–300 mg；维持75–100 mg Qd另开肠溶片；核对已服剂量，避免重复负荷。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "case_template": {
        "dose": "300",
        "unit": "mg",
        "frequency": "一次",
        "route": "嚼服",
        "remark": "本病例入院负荷用药"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "ACS负荷",
        "dose": "300",
        "unit": "mg",
        "frequency": "一次",
        "route": "嚼服",
        "details": "普通片负荷150–300 mg；维持75–100 mg Qd另开肠溶片；核对已服剂量，避免重复负荷。",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-002",
      "name": "阿司匹林肠溶片",
      "pinyin_initials": "asplcrp",
      "category": "抗血小板",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "CASE",
        "DOSE002"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "100",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "ACS维持；维持75–100 mg Qd；肠溶片整片吞服，非普通片嚼服负荷方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "case_template": {
        "dose": "100",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "维持用药，整片吞服"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "ACS维持",
        "dose": "100",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "维持75–100 mg Qd；肠溶片整片吞服，非普通片嚼服负荷方案。",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-003",
      "name": "替格瑞洛片",
      "pinyin_initials": "tgrlp",
      "category": "抗血小板",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "CASE",
        "DOSE003"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "90",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "ACS首年维持；负荷180 mg一次，随后90 mg Bid；约每12小时。负荷另列一行，不与维持首剂重复。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "case_template": {
        "dose": "90",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "维持用药，约每12小时；负荷方案另核对"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "ACS首年维持",
        "dose": "90",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "负荷180 mg一次，随后90 mg Bid；约每12小时。负荷另列一行，不与维持首剂重复。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1225fd45-9b56-1671-ee77-cd0c9f2174a5",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-004",
      "name": "硫酸氢氯吡格雷片",
      "pinyin_initials": "lsqlbglp",
      "category": "抗血小板",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE004"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "75",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "ACS维持；常用负荷300–600 mg一次，随后75 mg Qd；PCI与溶栓负荷方案不同，老年溶栓患者需单独核对。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "ACS维持",
        "dose": "75",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "常用负荷300–600 mg一次，随后75 mg Qd；PCI与溶栓负荷方案不同，老年溶栓患者需单独核对。",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-005",
      "name": "普拉格雷片",
      "pinyin_initials": "plglp",
      "category": "抗血小板",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE005"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "ACS行PCI后维持；负荷60 mg一次，维持10 mg Qd；<60 kg考虑5 mg；既往卒中/TIA禁用，≥75岁一般不推荐。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "ACS行PCI后维持",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "负荷60 mg一次，维持10 mg Qd；<60 kg考虑5 mg；既往卒中/TIA禁用，≥75岁一般不推荐。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=35aa7f3e-bbd8-4eae-b61f-29d1abca2224",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-006",
      "name": "盐酸替罗非班注射液",
      "pinyin_initials": "ystlfbzsy",
      "category": "静脉抗血小板",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE006"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "25",
        "unit": "μg/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "PCI选择性救援负荷；5分钟内给负荷25 μg/kg，后续0.15 μg/kg/min另开泵入，最长18小时；CrCl≤60时泵速减至0.075 μg/kg/min，监测出血及血小板。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "PCI选择性救援负荷",
        "dose": "25",
        "unit": "μg/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "5分钟内给负荷25 μg/kg，后续0.15 μg/kg/min另开泵入，最长18小时；CrCl≤60时泵速减至0.075 μg/kg/min，监测出血及血小板。",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13ea7fb8-4b01-4286-9464-26c0b624bc3b",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-007",
      "name": "依替巴肽注射液",
      "pinyin_initials": "ytbtzsy",
      "category": "静脉抗血小板",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE007"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "180",
        "unit": "μg/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "PCI选择性救援负荷；首剂180 μg/kg；10分钟后再180 μg/kg，后续2 μg/kg/min另开泵入；CrCl<50时泵速1 μg/kg/min，透析患者禁用。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "PCI选择性救援负荷",
        "dose": "180",
        "unit": "μg/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "首剂180 μg/kg；10分钟后再180 μg/kg，后续2 μg/kg/min另开泵入；CrCl<50时泵速1 μg/kg/min，透析患者禁用。",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00ad7bbe-cadd-4647-b74b-adfc9f2b5e94",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-008",
      "name": "普通肝素注射液",
      "pinyin_initials": "ptgszsy",
      "category": "抗凝",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "CASE",
        "DOSE008"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "",
        "unit": "U/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "剂量需填写；PCI术中抗凝，未合用GPI；按实际体重及ACT调整；合用GPI时常用50–70 U/kg。原病例7000 U另存病例模板，不能视为所有患者固定剂量。"
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "case_template": {
        "dose": "7000",
        "unit": "U",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "本病例仅介入期，监测ACT；非术后常规用药"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "PCI术中抗凝，未合用GPI",
        "dose": "70–100",
        "unit": "U/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "按实际体重及ACT调整；合用GPI时常用50–70 U/kg。原病例7000 U另存病例模板，不能视为所有患者固定剂量。",
        "dose_kind": "range",
        "source_url": "https://professional.heart.org/~/media/PHD-Files-2/Science-News/2/2021/2021-Coronary-Artery-Revascularization-Guideline-Slide-Set.pdf",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-009",
      "name": "依诺肝素钠注射液",
      "pinyin_initials": "yngsnzsy",
      "category": "抗凝",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE009"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "mg/kg",
        "frequency": "Q12h · 每12小时",
        "route": "皮下注射",
        "remark": "STEMI抗凝，<75岁且CrCl≥30；该行是皮下部分；首剂同时静注30 mg另列行；前两次皮下各≤100 mg。≥75岁不予静注负荷，皮下0.75 mg/kg Q12h，前两次各≤75 mg；CrCl<30需改Qd并核对年龄方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "STEMI抗凝，<75岁且CrCl≥30",
        "dose": "1",
        "unit": "mg/kg",
        "frequency": "Q12h",
        "route": "皮下注射",
        "details": "该行是皮下部分；首剂同时静注30 mg另列行；前两次皮下各≤100 mg。≥75岁不予静注负荷，皮下0.75 mg/kg Q12h，前两次各≤75 mg；CrCl<30需改Qd并核对年龄方案。",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=066f27ec-352c-4051-ba29-248e292690db",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-010",
      "name": "磺达肝癸钠注射液",
      "pinyin_initials": "hdggnzsy",
      "category": "抗凝",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE010"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "皮下注射",
        "remark": "非直接PCI的STEMI后续抗凝；STEMI首剂2.5 mg静脉给药另列行，后续皮下Qd，最长8日或出院；不能单独用于直接PCI术中抗凝，核对肾功能及出血风险。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "非直接PCI的STEMI后续抗凝",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "皮下注射",
        "details": "STEMI首剂2.5 mg静脉给药另列行，后续皮下Qd，最长8日或出院；不能单独用于直接PCI术中抗凝，核对肾功能及出血风险。",
        "dose_kind": "single_dose",
        "source_url": "https://www.medicines.org.uk/emc/product/3335/smpc",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-011",
      "name": "注射用比伐芦定",
      "pinyin_initials": "zsybfld",
      "category": "抗凝",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE011"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "0.75",
        "unit": "mg/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "PCI比伐芦定负荷；立即接1.75 mg/kg/h持续泵入，另列行；ACT在5分钟复测。CrCl<30时泵速1 mg/kg/h，透析0.25 mg/kg/h。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "PCI比伐芦定负荷",
        "dose": "0.75",
        "unit": "mg/kg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "立即接1.75 mg/kg/h持续泵入，另列行；ACT在5分钟复测。CrCl<30时泵速1 mg/kg/h，透析0.25 mg/kg/h。",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=19a4afc5-151d-4d3c-bfef-48aa8797d695",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-012",
      "name": "注射用阿替普酶",
      "pinyin_initials": "zsyatpm",
      "category": "溶栓",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE012"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "15",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "AMI阿替普酶90分钟加速方案首段；后续0.75 mg/kg（≤50 mg）30分钟，再0.5 mg/kg（≤35 mg）60分钟，分别列行；总量≤100 mg。需筛查溶栓适应证/禁忌，非脑卒中方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "AMI阿替普酶90分钟加速方案首段",
        "dose": "15",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "后续0.75 mg/kg（≤50 mg）30分钟，再0.5 mg/kg（≤35 mg）60分钟，分别列行；总量≤100 mg。需筛查溶栓适应证/禁忌，非脑卒中方案。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=c669f77c-fa48-478b-a14b-80b20a0139c2",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-013",
      "name": "注射用瑞替普酶",
      "pinyin_initials": "zsyrtpm",
      "category": "溶栓",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE013"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "MU",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "STEMI瑞替普酶首剂；10 MU=1000万U，静注不少于2分钟；30分钟后重复10 MU，另列行；不能把MU当mg或普通U。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "STEMI瑞替普酶首剂",
        "dose": "10",
        "unit": "MU",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "10 MU=1000万U，静注不少于2分钟；30分钟后重复10 MU，另列行；不能把MU当mg或普通U。",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-014",
      "name": "注射用替奈普酶",
      "pinyin_initials": "zsytnpm",
      "category": "溶栓",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE014"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "剂量需填写；STEMI，TNKase体重分档制剂方案；<60 kg:30 mg；60–<70:35 mg；70–<80:40 mg；80–<90:45 mg；≥90:50 mg，5秒静注。先按体重确定单值；高龄需核对减量策略。此方案不直接套用国内16 mg rhTNK-tPA制剂。"
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "STEMI，TNKase体重分档制剂方案",
        "dose": "30–50",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "<60 kg:30 mg；60–<70:35 mg；70–<80:40 mg；80–<90:45 mg；≥90:50 mg，5秒静注。先按体重确定单值；高龄需核对减量策略。此方案不直接套用国内16 mg rhTNK-tPA制剂。",
        "dose_kind": "range",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=e647640d-c395-4b4b-a0be-1162f9c21d84",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-015",
      "name": "注射用尿激酶",
      "pinyin_initials": "zsynjm",
      "category": "溶栓",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE015"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "150",
        "unit": "万U",
        "frequency": "一次",
        "route": "静脉滴注",
        "remark": "STEMI尿激酶溶栓；150万U溶于100 mL生理盐水，30分钟滴完；需筛查溶栓禁忌并配套抗栓监测。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "STEMI尿激酶溶栓",
        "dose": "150",
        "unit": "万U",
        "frequency": "一次",
        "route": "静脉滴注",
        "details": "150万U溶于100 mL生理盐水，30分钟滴完；需筛查溶栓禁忌并配套抗栓监测。",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-016",
      "name": "阿托伐他汀钙片",
      "pinyin_initials": "atfttgp",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "CASE",
        "DOSE016"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qn · 每晚一次",
        "route": "口服",
        "remark": "ACS强化降脂；常用40–80 mg每日一次；本病例40 mg每晚，首剂当日避免重复；按耐受、肝功能及相互作用调整。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "case_template": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qn · 每晚一次",
        "route": "口服",
        "remark": "本病例维持方案；首剂当日不重复"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "ACS强化降脂",
        "dose": "40",
        "unit": "mg",
        "frequency": "Qn",
        "route": "口服",
        "details": "常用40–80 mg每日一次；本病例40 mg每晚，首剂当日避免重复；按耐受、肝功能及相互作用调整。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00afce9b-48c9-487a-a738-e359c005c707",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-017",
      "name": "瑞舒伐他汀钙片",
      "pinyin_initials": "rsfttgp",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE017"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "亚洲成人降脂起始；亚洲成人说明书建议5 mg起始；ACS强化降脂常用20 mg Qd，需评估后调整，不能将40 mg默认套用；重度肾损害起始5 mg且≤10 mg。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "亚洲成人降脂起始",
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "亚洲成人说明书建议5 mg起始；ACS强化降脂常用20 mg Qd，需评估后调整，不能将40 mg默认套用；重度肾损害起始5 mg且≤10 mg。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02797697-300a-43db-92cf-9b78f08626be",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-018",
      "name": "依折麦布片",
      "pinyin_initials": "yzmbp",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "CASE",
        "DOSE018"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "降LDL-C；10 mg每日一次，可与他汀合用；不能将复方制剂的总毫克数套用于单方。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "case_template": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "本病例9月2日起使用"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "降LDL-C",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "10 mg每日一次，可与他汀合用；不能将复方制剂的总毫克数套用于单方。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02b00cb2-7253-4fb4-a216-53691a929a28",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-019",
      "name": "依洛尤单抗注射液",
      "pinyin_initials": "ylydkzsy",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE019"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "140",
        "unit": "mg",
        "frequency": "每2周一次",
        "route": "皮下注射",
        "remark": "PCSK9抑制剂降脂；140 mg每2周一次，或420 mg每月一次；两种方案择一，记录实际给药日期。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "PCSK9抑制剂降脂",
        "dose": "140",
        "unit": "mg",
        "frequency": "每2周一次",
        "route": "皮下注射",
        "details": "140 mg每2周一次，或420 mg每月一次；两种方案择一，记录实际给药日期。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cd61e902-166d-4aa6-9f3c-a18c1008d07e",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-020",
      "name": "阿利西尤单抗注射液",
      "pinyin_initials": "alxydkzsy",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE020"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "75",
        "unit": "mg",
        "frequency": "每2周一次",
        "route": "皮下注射",
        "remark": "PCSK9抑制剂降脂起始；75 mg每2周或300 mg每4周；LDL-C反应不足可调150 mg每2周，不叠加两套方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "PCSK9抑制剂降脂起始",
        "dose": "75",
        "unit": "mg",
        "frequency": "每2周一次",
        "route": "皮下注射",
        "details": "75 mg每2周或300 mg每4周；LDL-C反应不足可调150 mg每2周，不叠加两套方案。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=446f6b5c-0dd4-44ff-9bc2-c2b41f2806b4",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-021",
      "name": "英克司兰钠注射液",
      "pinyin_initials": "ykslnzsy",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE021"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "284",
        "unit": "mg",
        "frequency": "一次",
        "route": "皮下注射",
        "remark": "英克司兰初始注射；按活性英克司兰284 mg计（相当于英克司兰钠300 mg）；第0月、第3月，以后每6月一次，记录给药日期。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "英克司兰初始注射",
        "dose": "284",
        "unit": "mg",
        "frequency": "一次",
        "route": "皮下注射",
        "details": "按活性英克司兰284 mg计（相当于英克司兰钠300 mg）；第0月、第3月，以后每6月一次，记录给药日期。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=6fc0afca-4513-4c35-b594-6544aee29a44",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-022",
      "name": "贝派地酸片",
      "pinyin_initials": "bpdsp",
      "category": "降脂",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE022"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "180",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "贝派地酸降脂；180 mg每日一次；关注尿酸、痛风及肌腱症状；本地供应和批准适应证需核对。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "指南相关备选，结合当前适应证选择",
      "common_regimen": {
        "population": "成人",
        "indication": "贝派地酸降脂",
        "dose": "180",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "180 mg每日一次；关注尿酸、痛风及肌腱症状；本地供应和批准适应证需核对。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=88d06d89-a3da-40b4-b273-8f4f7d56c4c9",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-023",
      "name": "硝酸甘油片",
      "pinyin_initials": "xsgyp",
      "category": "抗缺血/硝酸酯",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "CASE",
        "DOSE023"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "0.5",
        "unit": "mg",
        "frequency": "一次",
        "route": "舌下含服",
        "remark": "缺血性胸痛发作；0.3–0.6 mg一次，必要时每5分钟重复，总计最多3次；先核对血压、右室梗死及近期PDE5抑制剂使用。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "case_template": {
        "dose": "0.5",
        "unit": "mg",
        "frequency": "一次",
        "route": "舌下含服",
        "remark": "本病例入院单次用药；使用前核对血压、禁忌证"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "缺血性胸痛发作",
        "dose": "0.5",
        "unit": "mg",
        "frequency": "一次",
        "route": "舌下含服",
        "details": "0.3–0.6 mg一次，必要时每5分钟重复，总计最多3次；先核对血压、右室梗死及近期PDE5抑制剂使用。",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/急性ST段抬高型心肌梗死诊断和治疗指南（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-024",
      "name": "硝酸甘油注射液",
      "pinyin_initials": "xsgyzsy",
      "category": "抗缺血/硝酸酯",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE024"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "μg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "remark": "持续缺血性胸痛的静脉硝酸酯起始；从5 μg/min起，按血压和症状每3–5分钟滴定；稀释、使用适宜管路，不能静推；该剂量是泵速而非单次总量。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "持续缺血性胸痛的静脉硝酸酯起始",
        "dose": "5",
        "unit": "μg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "details": "从5 μg/min起，按血压和症状每3–5分钟滴定；稀释、使用适宜管路，不能静推；该剂量是泵速而非单次总量。",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=578d8159-5ec6-457f-b4a8-9add624d43a8",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-025",
      "name": "硝酸异山梨酯片",
      "pinyin_initials": "xsyslzp",
      "category": "抗缺血/硝酸酯",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE025"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "心绞痛预防，普通片；起始5–20 mg Bid/Tid；维持10–40 mg Bid/Tid。安排每日不少于14小时无药间隔，不能机械等间隔覆盖24小时。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "心绞痛预防，普通片",
        "dose": "10",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "起始5–20 mg Bid/Tid；维持10–40 mg Bid/Tid。安排每日不少于14小时无药间隔，不能机械等间隔覆盖24小时。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0e5842f2-74f6-1f02-01bc-07578bd3b393",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-026",
      "name": "单硝酸异山梨酯缓释片",
      "pinyin_initials": "dxsyslzhsp",
      "category": "抗缺血/硝酸酯",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE026"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "30",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "心绞痛预防，缓释片；30–60 mg每日晨起一次，可按疗效调整；不得嚼碎，不用于即时终止胸痛。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "心绞痛预防，缓释片",
        "dose": "30",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "30–60 mg每日晨起一次，可按疗效调整；不得嚼碎，不用于即时终止胸痛。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a1e317a-7b05-4d30-9bbc-1d4ccd56ba3c",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-027",
      "name": "琥珀酸美托洛尔缓释片",
      "pinyin_initials": "hpsmtlehsp",
      "category": "β受体阻滞剂",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "CASE",
        "DOSE027"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "23.75",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "本病例稳定后β受体阻滞剂起始；本病例23.75 mg Qd，耐受后升47.5 mg；按心率、血压及心衰情况滴定。按琥珀酸盐标示，不与美版酒石酸盐等效标示25 mg混写。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "case_template": {
        "dose": "23.75",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "本病例初始剂量；后续按心率、血压等复评调整"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "本病例稳定后β受体阻滞剂起始",
        "dose": "23.75",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "本病例23.75 mg Qd，耐受后升47.5 mg；按心率、血压及心衰情况滴定。按琥珀酸盐标示，不与美版酒石酸盐等效标示25 mg混写。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01908d20-0e16-4410-bd27-1b6df162ede4",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对",
        "case_source": "../../build_case_pdf.py"
      }
    },
    {
      "id": "ami-drug-028",
      "name": "酒石酸美托洛尔片",
      "pinyin_initials": "jssmtlep",
      "category": "β受体阻滞剂",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE028"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "稳定型心绞痛，普通片；常用起始总量100 mg/日分2次，随餐或餐后；急性MI早期需较小剂量及更密切评估，不能直接套用该稳定期方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "稳定型心绞痛，普通片",
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "常用起始总量100 mg/日分2次，随餐或餐后；急性MI早期需较小剂量及更密切评估，不能直接套用该稳定期方案。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00de1f16-f979-4dbf-aa60-246ffac8d410",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-029",
      "name": "富马酸比索洛尔片",
      "pinyin_initials": "fmsbslep",
      "category": "β受体阻滞剂",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE029"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "成人高血压起始；通常5 mg Qd；部分患者或肝/肾损害2.5 mg起始，按心率血压调整；心衰起始方案需另选。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "成人高血压起始",
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "通常5 mg Qd；部分患者或肝/肾损害2.5 mg起始，按心率血压调整；心衰起始方案需另选。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=084308e4-3b8b-40d6-acbf-d775772a8a73",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-030",
      "name": "卡维地洛片",
      "pinyin_initials": "kwdlp",
      "category": "β受体阻滞剂",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE030"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "3.125",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "稳定慢性心衰起始；随餐服；至少每2周逐步增加至6.25、12.5、25 mg Bid。心梗后左室功能不全说明书常用6.25 mg Bid起始，低耐受者可更低。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "稳定慢性心衰起始",
        "dose": "3.125",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "随餐服；至少每2周逐步增加至6.25、12.5、25 mg Bid。心梗后左室功能不全说明书常用6.25 mg Bid起始，低耐受者可更低。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=010290af-81f4-0037-e063-6394a90a4638",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-031",
      "name": "盐酸艾司洛尔注射液",
      "pinyin_initials": "ysaslezsy",
      "category": "β受体阻滞剂",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE031"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "μg/kg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "remark": "室上性心动过速控率维持起始；可先500 μg/kg于1分钟负荷另列行，再50 μg/kg/min，≥4分钟评估滴定；常用50–200 μg/kg/min，监测血压心率。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "室上性心动过速控率维持起始",
        "dose": "50",
        "unit": "μg/kg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "details": "可先500 μg/kg于1分钟负荷另列行，再50 μg/kg/min，≥4分钟评估滴定；常用50–200 μg/kg/min，监测血压心率。",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=017023a9-00f0-4284-861f-a3634d4fdb17",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-032",
      "name": "培哚普利叔丁胺片",
      "pinyin_initials": "pdplsdap",
      "category": "RAAS相关药品",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "CASE",
        "DOSE032"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "2",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "本病例ACEI起始；本病例叔丁胺盐2 mg Qd，耐受后4 mg；一般稳定冠心病说明书4 mg起始至8 mg。不同盐型不可按同mg替换，监测血压/肌酐/血钾。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "case_template": {
        "dose": "2",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "本病例初始剂量，叔丁胺盐；后续复评调整"
      },
      "common_regimen": {
        "population": "成人",
        "indication": "本病例ACEI起始",
        "dose": "2",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "本病例叔丁胺盐2 mg Qd，耐受后4 mg；一般稳定冠心病说明书4 mg起始至8 mg。不同盐型不可按同mg替换，监测血压/肌酐/血钾。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=87768fbf-7c63-47da-8925-0316f343d6ef",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对",
        "case_source": "../../build_case_pdf.py"
      }
    },
    {
      "id": "ami-drug-033",
      "name": "雷米普利片",
      "pinyin_initials": "lmplp",
      "category": "RAAS相关药品",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE033"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "心梗后心衰起始；2.5 mg Bid，低血压可降1.25 mg Bid，逐步至5 mg Bid；监测血压、肾功能、血钾。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "心梗后心衰起始",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "2.5 mg Bid，低血压可降1.25 mg Bid，逐步至5 mg Bid；监测血压、肾功能、血钾。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01da05d8-e72e-4208-bf92-a5cd929f15ab",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-034",
      "name": "马来酸依那普利片",
      "pinyin_initials": "mlsynplp",
      "category": "RAAS相关药品",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE034"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "心衰起始；2.5 mg Bid起始，耐受后逐步滴定，常用范围2.5–20 mg Bid；监测血压、肌酐和血钾。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "心衰起始",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "2.5 mg Bid起始，耐受后逐步滴定，常用范围2.5–20 mg Bid；监测血压、肌酐和血钾。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=074fe718-88d8-365c-e063-6394a90a299d",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-035",
      "name": "卡托普利片",
      "pinyin_initials": "ktplp",
      "category": "RAAS相关药品",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE035"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "6.25",
        "unit": "mg",
        "frequency": "一次",
        "route": "口服",
        "remark": "心梗后左室功能不全首次试用；首次6.25 mg，随后12.5 mg Tid，逐步至25–50 mg Tid；餐前1小时；后续方案另列行，监测血压/肾功能/血钾。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "心梗后左室功能不全首次试用",
        "dose": "6.25",
        "unit": "mg",
        "frequency": "一次",
        "route": "口服",
        "details": "首次6.25 mg，随后12.5 mg Tid，逐步至25–50 mg Tid；餐前1小时；后续方案另列行，监测血压/肾功能/血钾。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1395ba5b-2fc9-41ff-9c43-e0740d781dee",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-036",
      "name": "缬沙坦胶囊",
      "pinyin_initials": "xstjn",
      "category": "RAAS相关药品",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE036"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "80",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "成人高血压，胶囊；高血压常用80–160 mg Qd起始，按疗效调整。心梗后左室功能不全有20 mg Bid起始方案，应另选能准确给20 mg的剂型，不拆80 mg胶囊估量。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "成人高血压，胶囊",
        "dose": "80",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "高血压常用80–160 mg Qd起始，按疗效调整。心梗后左室功能不全有20 mg Bid起始方案，应另选能准确给20 mg的剂型，不拆80 mg胶囊估量。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03af7d09-314a-fe85-e063-6294a90afa25",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-037",
      "name": "氯沙坦钾片",
      "pinyin_initials": "lstjp",
      "category": "RAAS相关药品",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE037"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "成人高血压；50 mg Qd，容量不足或肝损害可25 mg起始，可调整至100 mg Qd；监测血压、肾功能、血钾。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "成人高血压",
        "dose": "50",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "50 mg Qd，容量不足或肝损害可25 mg起始，可调整至100 mg Qd；监测血压、肾功能、血钾。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=021cd76a-b093-4704-8410-5e7d01e20a54",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-038",
      "name": "沙库巴曲缬沙坦钠片",
      "pinyin_initials": "skbqxstnp",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE038"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "HFrEF、未用或低剂量ACEI/ARB起始；50 mg复方总量≈24/26 mg两组分；常规起始100 mg Bid，耐受后目标200 mg Bid。停ACEI至少36小时，不与ACEI/ARB合用，监测血压/肾功能/血钾。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "HFrEF、未用或低剂量ACEI/ARB起始",
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "50 mg复方总量≈24/26 mg两组分；常规起始100 mg Bid，耐受后目标200 mg Bid。停ACEI至少36小时，不与ACEI/ARB合用，监测血压/肾功能/血钾。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=000dc81d-ab91-450c-8eae-8eb74e72296f",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-039",
      "name": "螺内酯片",
      "pinyin_initials": "lnzp",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE039"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "HFrEF起始；25 mg Qd适用于血钾≤5.0且eGFR>50；eGFR30–50考虑隔日25 mg，按血钾肾功能调整；需匹配可用规格。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "HFrEF起始",
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "25 mg Qd适用于血钾≤5.0且eGFR>50；eGFR30–50考虑隔日25 mg，按血钾肾功能调整；需匹配可用规格。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08738ad4-1607-4d55-af71-6790477353bd",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-040",
      "name": "依普利酮片",
      "pinyin_initials": "ypltp",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE040"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "心梗后HFrEF起始；25 mg Qd，耐受后4周内可至50 mg Qd；血钾升高减量或停药，CrCl≤30禁用。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "心梗后HFrEF起始",
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "25 mg Qd，耐受后4周内可至50 mg Qd；血钾升高减量或停药，CrCl≤30禁用。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1a52bedc-8e2c-4116-a296-a87770676b4a",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-041",
      "name": "呋塞米注射液",
      "pinyin_initials": "fsmzsy",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE041"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "水肿的初始利尿；常用20–40 mg缓慢静注1–2分钟；急性肺水肿常用40 mg起始，依据既往利尿剂、尿量、血压、电解质调整。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "水肿的初始利尿",
        "dose": "20",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "常用20–40 mg缓慢静注1–2分钟；急性肺水肿常用40 mg起始，依据既往利尿剂、尿量、血压、电解质调整。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08a44bdd-028d-41af-9d4e-70971b0bcc4e",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-042",
      "name": "托拉塞米注射液",
      "pinyin_initials": "tlsmzsy",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE042"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "静脉注射",
        "remark": "心衰水肿初始利尿；常用10–20 mg每日一次，约2分钟缓慢静注；按尿量及肾功能调整，监测电解质。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "心衰水肿初始利尿",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "静脉注射",
        "details": "常用10–20 mg每日一次，约2分钟缓慢静注；按尿量及肾功能调整，监测电解质。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cf288ad5-d4e7-4b0b-bfd0-41c5327e6984",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-043",
      "name": "达格列净片",
      "pinyin_initials": "dgljp",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE043"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "心衰/CKD适应证；10 mg Qd；评估肾功能及容量状态，急性危重、酮症或禁食期间不常规启动；围手术期需停药方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "心衰/CKD适应证",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "10 mg Qd；评估肾功能及容量状态，急性危重、酮症或禁食期间不常规启动；围手术期需停药方案。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01f90c94-71cb-4a1f-81ff-8004b850529b",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-044",
      "name": "恩格列净片",
      "pinyin_initials": "egljp",
      "category": "合并心衰/容量管理",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE044"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "心衰或2型糖尿病；10 mg每日晨服；仅为进一步降糖时可考虑25 mg，不把心衰剂量自动加至25 mg；核对肾功能、禁食及酮症风险。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "心衰或2型糖尿病",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "10 mg每日晨服；仅为进一步降糖时可考虑25 mg，不把心衰剂量自动加至25 mg；核对肾功能、禁食及酮症风险。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1782b947-4a72-4feb-a488-1469d9af82bd",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-045",
      "name": "重酒石酸去甲肾上腺素注射液",
      "pinyin_initials": "zjssqjssxszsy",
      "category": "急救/血流动力学",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE045"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "8",
        "unit": "μg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "remark": "急性低血压升压起始，按去甲肾上腺素碱基计；说明书常用起始8–12 μg/min，按灌注及血压滴定；先评估容量，明确稀释浓度并防外渗；不是μg/kg/min，不能混用。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "急性低血压升压起始，按去甲肾上腺素碱基计",
        "dose": "8",
        "unit": "μg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "details": "说明书常用起始8–12 μg/min，按灌注及血压滴定；先评估容量，明确稀释浓度并防外渗；不是μg/kg/min，不能混用。",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ea48ab6-e166-df31-b132-70ef982a2d02",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-046",
      "name": "盐酸多巴酚丁胺注射液",
      "pinyin_initials": "ysdbfdazsy",
      "category": "急救/血流动力学",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE046"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "0.5",
        "unit": "μg/kg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "remark": "低心排短期正性肌力起始；0.5–1 μg/kg/min起始，常用2–20 μg/kg/min，按血流动力学滴定；需持续监测，非单次静推。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "低心排短期正性肌力起始",
        "dose": "0.5",
        "unit": "μg/kg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "details": "0.5–1 μg/kg/min起始，常用2–20 μg/kg/min，按血流动力学滴定；需持续监测，非单次静推。",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=3418aa46-2d9a-39f3-e063-6294a90a2961",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-047",
      "name": "盐酸多巴胺注射液",
      "pinyin_initials": "ysdbazsy",
      "category": "急救/血流动力学",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE047"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "μg/kg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "remark": "休克的多巴胺低速起始；说明书低速起始2–5 μg/kg/min，逐步滴定；不作为肾保护用药。心动过缓算法为5–20 μg/kg/min，应另按情境选择。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "休克的多巴胺低速起始",
        "dose": "2.5",
        "unit": "μg/kg/min",
        "frequency": "持续",
        "route": "静脉泵入",
        "details": "说明书低速起始2–5 μg/kg/min，逐步滴定；不作为肾保护用药。心动过缓算法为5–20 μg/kg/min，应另按情境选择。",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=093312af-6eef-1f4b-e063-6294a90a155d",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-048",
      "name": "盐酸肾上腺素注射液",
      "pinyin_initials": "ysssxszsy",
      "category": "急救/血流动力学",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE048"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "mg",
        "frequency": "ST · 立即一次",
        "route": "静脉注射",
        "remark": "成人心脏骤停复苏；1 mg IV，每3–5分钟可重复；核对复苏用浓度。本行不适用于有脉低血压持续泵入或过敏反应肌注。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "成人心脏骤停复苏",
        "dose": "1",
        "unit": "mg",
        "frequency": "ST",
        "route": "静脉注射",
        "details": "1 mg IV，每3–5分钟可重复；核对复苏用浓度。本行不适用于有脉低血压持续泵入或过敏反应肌注。",
        "dose_kind": "single_dose",
        "source_url": "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-049",
      "name": "盐酸胺碘酮注射液",
      "pinyin_initials": "ysadtzsy",
      "category": "心律失常相关",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE049"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "150",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉滴注",
        "remark": "有脉室性心律失常负荷；150 mg用5%葡萄糖稀释，10分钟输注；随后1 mg/min 6小时，再0.5 mg/min 18小时，分别另列行；心脏骤停方案不同。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "有脉室性心律失常负荷",
        "dose": "150",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉滴注",
        "details": "150 mg用5%葡萄糖稀释，10分钟输注；随后1 mg/min 6小时，再0.5 mg/min 18小时，分别另列行；心脏骤停方案不同。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a28ae25-7cc4-4ac0-a2ba-7820fb93e25c",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-050",
      "name": "盐酸胺碘酮片",
      "pinyin_initials": "ysadtp",
      "category": "心律失常相关",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE050"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "200",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "胺碘酮口服维持；常用维持200 mg/日或更低；口服负荷200 mg Tid一周、Bid一周需专科评估；监测QT、甲功、肝肺情况，不自动套用负荷。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "胺碘酮口服维持",
        "dose": "200",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "常用维持200 mg/日或更低；口服负荷200 mg Tid一周、Bid一周需专科评估；监测QT、甲功、肝肺情况，不自动套用负荷。",
        "dose_kind": "single_dose",
        "source_url": "https://www.medicines.org.uk/emc/product/101141/smpc",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-051",
      "name": "硫酸阿托品注射液",
      "pinyin_initials": "lsatpzsy",
      "category": "心律失常相关",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE051"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "mg",
        "frequency": "ST · 立即一次",
        "route": "静脉注射",
        "remark": "有症状心动过缓；1 mg IV，可每3–5分钟重复，总量最多3 mg；无效时按复苏流程升级治疗。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "有症状心动过缓",
        "dose": "1",
        "unit": "mg",
        "frequency": "ST",
        "route": "静脉注射",
        "details": "1 mg IV，可每3–5分钟重复，总量最多3 mg；无效时按复苏流程升级治疗。",
        "dose_kind": "single_dose",
        "source_url": "https://www.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Accessible/Algorithm-ACLS-Bradycardia-LngDscrp-250725-Ed.pdf",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-052",
      "name": "腺苷注射液",
      "pinyin_initials": "xgzsy",
      "category": "心律失常相关",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE052"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "6",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "规则室上性心动过速首剂；1–2秒快速静推并立即盐水冲管；1–2分钟未转复可12 mg，另列行；核对心律、支气管痉挛及禁忌。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "规则室上性心动过速首剂",
        "dose": "6",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "1–2秒快速静推并立即盐水冲管；1–2分钟未转复可12 mg，另列行；核对心律、支气管痉挛及禁忌。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1809fc7e-f5d8-18d8-e063-6394a90a7713",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-053",
      "name": "硫酸镁注射液",
      "pinyin_initials": "lsmzsy",
      "category": "心律失常相关",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE053"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "g",
        "frequency": "一次",
        "route": "静脉滴注",
        "remark": "低镁且无法口服时补镁；初始1–5 g按血镁选择，通常1–2 g/h稀释输注；肾损害减量、监测血镁/心电/血压；本行为低镁补充，非心梗常规给镁或尖端扭转抢救方案。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "低镁且无法口服时补镁",
        "dose": "1",
        "unit": "g",
        "frequency": "一次",
        "route": "静脉滴注",
        "details": "初始1–5 g按血镁选择，通常1–2 g/h稀释输注；肾损害减量、监测血镁/心电/血压；本行为低镁补充，非心梗常规给镁或尖端扭转抢救方案。",
        "dose_kind": "single_dose",
        "source_url": "https://sps.nhs.uk/articles/treating-acute-hypomagnesaemia-in-adults/",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-054",
      "name": "盐酸吗啡注射液",
      "pinyin_initials": "ysmfzsy",
      "category": "镇痛/局麻",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE054"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "成人重度疼痛的盐酸吗啡镇痛；成人镇痛常用5–10 mg缓慢静注，按既往阿片暴露及呼吸循环状态减量滴定；ACS仅顽固疼痛个体化使用，可能延迟口服抗血小板药吸收。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "成人重度疼痛的盐酸吗啡镇痛",
        "dose": "5",
        "unit": "mg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "成人镇痛常用5–10 mg缓慢静注，按既往阿片暴露及呼吸循环状态减量滴定；ACS仅顽固疼痛个体化使用，可能延迟口服抗血小板药吸收。",
        "dose_kind": "single_dose",
        "source_url": "https://www.nhc.gov.cn/wjw/gfxwj/200703/14377de303d6428abc1be6dde4339a71.shtml",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-055",
      "name": "枸橼酸芬太尼注射液",
      "pinyin_initials": "jysftnzsy",
      "category": "镇痛/局麻",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE055"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "μg",
        "frequency": "一次",
        "route": "静脉注射",
        "remark": "介入/麻醉辅助镇痛；成人常用初始50–100 μg（按芬太尼计），缓慢给药并监测呼吸/血压；需具备气道及复苏条件。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "介入/麻醉辅助镇痛",
        "dose": "50",
        "unit": "μg",
        "frequency": "一次",
        "route": "静脉注射",
        "details": "成人常用初始50–100 μg（按芬太尼计），缓慢给药并监测呼吸/血压；需具备气道及复苏条件。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0c10e465-4117-48ba-a454-23ccb7a3fcc7",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-056",
      "name": "盐酸利多卡因注射液",
      "pinyin_initials": "ysldkyzsy",
      "category": "镇痛/局麻",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "CASE",
        "DOSE056"
      ],
      "case_medication": true,
      "autofill": {
        "dose": "",
        "unit": "mg",
        "frequency": "一次",
        "route": "局部浸润",
        "remark": "剂量需填写；穿刺局麻示例，1%无肾上腺素制剂；50 mg=1%溶液5 mL，为局部少量浸润模板，按范围用最低有效量；无肾上腺素时总量不超过4.5 mg/kg且≤300 mg，心/肝病减量。非静脉抗心律失常方案。"
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "限特定临床情境，需核对适应证及禁忌",
      "common_regimen": {
        "population": "成人",
        "indication": "穿刺局麻示例，1%无肾上腺素制剂",
        "dose": "50",
        "unit": "mg",
        "frequency": "一次",
        "route": "局部浸润",
        "details": "50 mg=1%溶液5 mL，为局部少量浸润模板，按范围用最低有效量；无肾上腺素时总量不超过4.5 mg/kg且≤300 mg，心/肝病减量。非静脉抗心律失常方案。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01679d29-a592-8cbb-e063-6394a90ad82a",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对",
        "template_note": "具体示例量为说明书原则范围内的教学录入模板，并非指南规定的统一剂量。"
      }
    },
    {
      "id": "ami-drug-057",
      "name": "泮托拉唑钠肠溶片",
      "pinyin_initials": "ptlzncrp",
      "category": "胃肠保护",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE057"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "胃食管反流/抑酸；40 mg Qd，肠溶片整吞；ACS消化道保护按出血风险选择，不默认人人使用。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "胃食管反流/抑酸",
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "40 mg Qd，肠溶片整吞；ACS消化道保护按出血风险选择，不默认人人使用。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03dea010-4bae-43ab-893e-9bbddb58062d",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-058",
      "name": "注射用泮托拉唑钠",
      "pinyin_initials": "zsyptlzn",
      "category": "胃肠保护",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE058"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "静脉滴注",
        "remark": "暂不能口服时抑酸；40 mg稀释后约15分钟输注，能口服后转换；消化道活动性出血有不同方案，不套用此行。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "暂不能口服时抑酸",
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd",
        "route": "静脉滴注",
        "details": "40 mg稀释后约15分钟输注，能口服后转换；消化道活动性出血有不同方案，不套用此行。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=014f9762-6948-46b7-8659-5c89f35ad8bf",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-059",
      "name": "雷贝拉唑钠肠溶片",
      "pinyin_initials": "lblzncrp",
      "category": "胃肠保护",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE059"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "胃食管反流/抑酸；20 mg每日一次，肠溶片整吞；按病种及疗程调整，不与其他PPI重复。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "胃食管反流/抑酸",
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "20 mg每日一次，肠溶片整吞；按病种及疗程调整，不与其他PPI重复。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=04e88b86-e1dd-4c56-8359-45fbcc161f7d",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-060",
      "name": "华法林钠片",
      "pinyin_initials": "hflnp",
      "category": "额外抗凝指征/合并疾病",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE060"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "需维生素K拮抗剂抗凝的起始；常用起始2–5 mg Qd，按INR调整；房颤/VTE通常目标INR2–3，机械瓣另定；合并抗血小板时评估出血及疗程。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "需维生素K拮抗剂抗凝的起始",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "常用起始2–5 mg Qd，按INR调整；房颤/VTE通常目标INR2–3，机械瓣另定；合并抗血小板时评估出血及疗程。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0cbce382-9c88-4f58-ae0f-532a841e8f95",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-061",
      "name": "利伐沙班片",
      "pinyin_initials": "lfsbp",
      "category": "额外抗凝指征/合并疾病",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE061"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd · 一日一次",
        "route": "口服",
        "remark": "非瓣膜性房颤，CrCl>50；20 mg随晚餐；CrCl15–50常用15 mg Qd，<15避免。VTE及CAD/PAD剂量不同，不能直接替换，也不是心梗常规加药。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "非瓣膜性房颤，CrCl>50",
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd",
        "route": "口服",
        "details": "20 mg随晚餐；CrCl15–50常用15 mg Qd，<15避免。VTE及CAD/PAD剂量不同，不能直接替换，也不是心梗常规加药。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=10db92f9-2300-4a80-836b-673e1ae91610",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-062",
      "name": "阿哌沙班片",
      "pinyin_initials": "apsbp",
      "category": "额外抗凝指征/合并疾病",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE062"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "非瓣膜性房颤；通常5 mg Bid；年龄≥80岁、体重≤60 kg、肌酐≥1.5 mg/dL三项中≥2项改2.5 mg Bid；另核对肾功能/相互作用，VTE负荷方案不同。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "非瓣膜性房颤",
        "dose": "5",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "通常5 mg Bid；年龄≥80岁、体重≤60 kg、肌酐≥1.5 mg/dL三项中≥2项改2.5 mg Bid；另核对肾功能/相互作用，VTE负荷方案不同。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=095a08ac-cf0e-497e-a682-ddef38d6b29c",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-063",
      "name": "达比加群酯胶囊",
      "pinyin_initials": "dbjqzjn",
      "category": "额外抗凝指征/合并疾病",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE063"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "150",
        "unit": "mg",
        "frequency": "Bid · 一日两次",
        "route": "口服",
        "remark": "非瓣膜性房颤，CrCl>30的成人标准方案；150 mg Bid整粒吞服，不拆胶囊；高龄、肾损害、出血高风险及P-gp相互作用需按本地说明书选择减量，不能套用美国75 mg减量规格。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "非瓣膜性房颤，CrCl>30的成人标准方案",
        "dose": "150",
        "unit": "mg",
        "frequency": "Bid",
        "route": "口服",
        "details": "150 mg Bid整粒吞服，不拆胶囊；高龄、肾损害、出血高风险及P-gp相互作用需按本地说明书选择减量，不能套用美国75 mg减量规格。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13649035-a498-4e31-a7ea-8b18cedceca7",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-064",
      "name": "碘海醇注射液",
      "pinyin_initials": "dhczsy",
      "category": "介入造影/输液与电解质",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE064"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mL",
        "frequency": "一次",
        "route": "冠状动脉内注射",
        "remark": "冠脉造影单次注入，350 mgI/mL；常用单次5 mL（范围3–14 mL），按血管和成像调整；此为单次注入量，非整台手术总量，记录累计碘量、肾功能及过敏史。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "冠脉造影单次注入，350 mgI/mL",
        "dose": "5",
        "unit": "mL",
        "frequency": "一次",
        "route": "冠状动脉内注射",
        "details": "常用单次5 mL（范围3–14 mL），按血管和成像调整；此为单次注入量，非整台手术总量，记录累计碘量、肾功能及过敏史。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5088be1d-a708-1cac-e063-6394a90a2aff",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-065",
      "name": "碘克沙醇注射液",
      "pinyin_initials": "dksczsy",
      "category": "介入造影/输液与电解质",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE065"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "mL",
        "frequency": "一次",
        "route": "冠状动脉内注射",
        "remark": "剂量需填写；右冠造影单次注入，320 mgI/mL；右冠单次3–8 mL、左冠3–10 mL，按造影效果确定单值；非手术总量，记录累计碘量、肾功能及过敏史。"
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "右冠造影单次注入，320 mgI/mL",
        "dose": "3–8",
        "unit": "mL",
        "frequency": "一次",
        "route": "冠状动脉内注射",
        "details": "右冠单次3–8 mL、左冠3–10 mL，按造影效果确定单值；非手术总量，记录累计碘量、肾功能及过敏史。",
        "dose_kind": "range",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0fe89ea2-04f7-46c5-9c35-220d8c144a95",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-066",
      "name": "氯化钠注射液",
      "pinyin_initials": "lhnzsy",
      "category": "介入造影/输液与电解质",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE066"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "mL",
        "frequency": "一次",
        "route": "静脉滴注",
        "remark": "剂量需填写；0.9%氯化钠作溶媒的录入模板；100 mL仅作相容药物的溶媒示例，不是心梗常规补液剂量；浓度0.9%，按配伍、容量状态及主药输注要求调整体积和速度。"
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "0.9%氯化钠作溶媒的录入模板",
        "dose": "100",
        "unit": "mL",
        "frequency": "一次",
        "route": "静脉滴注",
        "details": "100 mL仅作相容药物的溶媒示例，不是心梗常规补液剂量；浓度0.9%，按配伍、容量状态及主药输注要求调整体积和速度。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=123bd10a-90c7-499e-97f6-acf7e0f0fb4e",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对",
        "template_note": "具体示例量为说明书原则范围内的教学录入模板，并非指南规定的统一剂量。"
      }
    },
    {
      "id": "ami-drug-067",
      "name": "葡萄糖注射液",
      "pinyin_initials": "pttzsy",
      "category": "介入造影/输液与电解质",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE067"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mL",
        "frequency": "一次",
        "route": "静脉滴注",
        "remark": "低血糖纠正，50%葡萄糖；50%制剂20 mL=10 g；常用10–25 g（20–50 mL）缓慢静脉给药并复测血糖。非5%葡萄糖溶媒方案，核对浓度、静脉通路并防外渗。"
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "低血糖纠正，50%葡萄糖",
        "dose": "20",
        "unit": "mL",
        "frequency": "一次",
        "route": "静脉滴注",
        "details": "50%制剂20 mL=10 g；常用10–25 g（20–50 mL）缓慢静脉给药并复测血糖。非5%葡萄糖溶媒方案，核对浓度、静脉通路并防外渗。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=4ed365da-4e62-4329-c1b9-c197ab4fb6e1",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对"
      }
    },
    {
      "id": "ami-drug-068",
      "name": "氯化钾注射液",
      "pinyin_initials": "lhjzsy",
      "category": "介入造影/输液与电解质",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE068"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "g",
        "frequency": "一次",
        "route": "静脉滴注",
        "remark": "剂量需填写；非重症低钾的稀释补钾示例；1 g≈13.4 mmol钾，稀释至500 mL示例；血钾>2.5 mmol/L时通常≤10 mmol/h、浓度≤40 mmol/L。严禁直接静推；心衰限液时另定浓度/通路，监测血钾肾功能。"
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "HIS扩展备选，不表示本病例需要使用",
      "common_regimen": {
        "population": "成人",
        "indication": "非重症低钾的稀释补钾示例",
        "dose": "1",
        "unit": "g",
        "frequency": "一次",
        "route": "静脉滴注",
        "details": "1 g≈13.4 mmol钾，稀释至500 mL示例；血钾>2.5 mmol/L时通常≤10 mmol/h、浓度≤40 mmol/L。严禁直接静推；心衰限液时另定浓度/通路，监测血钾肾功能。",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=559a0a8c-a8fe-40a5-b196-21f9308780ab",
        "checked_at": "2026-09-11",
        "evidence_scope": "公开说明书/指南的特定方案；本地制剂与个体适用性仍需核对",
        "template_note": "具体示例量为说明书原则范围内的教学录入模板，并非指南规定的统一剂量。"
      }
    }
  ],
  "dose_policy": "明确成人方案可自动填写；不强求全部填数值，个体化总量保留空白并提供参考。负荷/维持分别录入，按体重及泵速方案需换算；草稿不等于可执行处方。保留case_template作为原病案证据。"
};


const drugs=window.MI_DRUG_CATALOG.items.map(x=>[x.name,x.pinyin_initials,x.note]);
const defaults=Object.fromEntries(window.MI_DRUG_CATALOG.items.map(x=>[x.name,[x.autofill.dose,x.autofill.unit,x.autofill.frequency,x.autofill.route,x.autofill.remark]]));
const catalogOptions=(key,base)=>[...new Set([...base,...window.MI_DRUG_CATALOG.items.map(x=>x.autofill[key]).filter(Boolean)])];
const $=s=>editor.querySelector(s), storeKey='clinical-rx-simple-v2';
function option(value){const o=document.createElement('option');o.textContent=value;return o;}
function select(values,value,label){const el=document.createElement('select');el.setAttribute('aria-label',label);values.forEach(v=>el.append(option(v)));el.value=value||values[0];return el;}
function addRow(data={}){
 const tr=document.createElement('tr');const cells=Array.from({length:6},()=>{const td=document.createElement('td');tr.append(td);return td;});
 const name=document.createElement('input');name.placeholder='输入药名 / 拼音缩写';name.setAttribute('aria-label','药品搜索');name.value=data.name||'';tr.dataset.drug=data.name||'';
 cells[0].className='drug-cell';const results=document.createElement('div');results.className='matches';const confirm=document.createElement('div');confirm.className='confirmed';
 function picked(){confirm.replaceChildren();if(tr.dataset.drug){const label=document.createElement('span');label.textContent='✓ 已选择';confirm.append(label);}const remove=document.createElement('button');remove.textContent='删除本行';remove.className='remove';remove.onclick=()=>{tr.remove();if(!$('#rows').children.length)addRow();};confirm.append(remove);}
 name.oninput=()=>{tr.dataset.drug='';picked();results.replaceChildren();const q=name.value.trim().toLowerCase();if(!q)return;const found=drugs.filter(d=>d[0].includes(q)||d[1].replaceAll(' ','').includes(q));for(const d of found){const b=document.createElement('button');b.type='button';b.textContent=d[0];b.onclick=()=>{name.value=d[0];tr.dataset.drug=d[0];results.replaceChildren();picked();const preset=defaults[d[0]];if(preset){[dose.value,unit.value,use.value,route.value]=preset;remark.title=remark.value;unit.title=unit.value;dose.title=unit.value.includes('/')?'此处为每公斤剂量或给药速度':'单次剂量';$('#status').textContent=preset[0]?'已带入剂量、用法和途径，可修改；备注由你填写。':'已带入用法和途径；剂量需结合具体情况填写。';}dose.focus();};results.append(b);}if(!found.length){const hint=document.createElement('small');hint.textContent='未找到匹配药品；AI补充查药待接入。';hint.style.padding='10px';results.append(hint);}};
 name.onkeydown=e=>{if(e.key==='Escape')results.replaceChildren();if(e.key==='Enter'&&results.querySelector('button')){e.preventDefault();results.querySelector('button').click();}};
 cells[0].append(name,results,confirm);picked();
 const dose=document.createElement('input');dose.type='number';dose.min='0';dose.step='any';dose.placeholder='单次';dose.value=data.dose||'';dose.setAttribute('aria-label','单次剂量');dose.dataset.key='dose';
 const unit=select(catalogOptions('unit',['mg','μg','g','U','mL','片','mg/kg/h','mg/min']),data.unit,'剂量单位');unit.dataset.key='unit';const doseWrap=document.createElement('div');doseWrap.className='dose';doseWrap.append(dose,unit);cells[1].append(doseWrap);
 const use=select(catalogOptions('frequency',['请选择','Qd · 一日一次','Bid · 一日两次','Tid · 一日三次','Q12h · 每12小时','Qn · 每晚一次','ST · 立即一次','一次','PRN · 必要时']),data.use,'用法');use.dataset.key='use';cells[2].append(use);
 const route=select(catalogOptions('route',['请选择','口服','嚼服','舌下含服','静脉注射','静脉滴注','静脉泵入','皮下注射','局部浸润']),data.route,'给药途径');route.dataset.key='route';cells[3].append(route);
 const type=select(['临时医嘱','长期医嘱','长期有药','临时有药'],data.type,'医嘱类型');type.dataset.key='type';cells[4].append(type);
 const remark=document.createElement('input');remark.placeholder='选填备注';remark.setAttribute('aria-label','备注');remark.dataset.key='remark';remark.value=data.remark||'';remark.title=remark.value;remark.oninput=()=>{remark.title=remark.value;};cells[5].append(remark);
 $('#rows').append(tr);
}
editor.addEventListener('click',e=>{editor.querySelectorAll('.drug-cell').forEach(c=>{if(!c.contains(e.target))c.querySelector('.matches').replaceChildren();});});
$('#add').onclick=()=>{addRow();$('#rows').lastElementChild.querySelector('input').focus();};
let submissionId=requestId();
$('#save').onclick=async()=>{if($('#save').disabled)return;const rows=[];for(const tr of $('#rows').children){const r={name:tr.dataset.drug};tr.querySelectorAll('[data-key]').forEach(el=>r[el.dataset.key]=el.value);const typed=tr.querySelector('input').value.trim();if(!typed&&!r.dose&&r.use==='请选择'&&r.route==='请选择'&&!r.remark)continue;if(!r.name){$('#status').textContent='请先点击匹配药品，确认药名。';tr.querySelector('input').focus();return;}if(!(Number(r.dose)>0)||r.use==='请选择'||r.route==='请选择'){$('#status').textContent='请补齐 '+r.name+' 的剂量、用法与给药途径。';return;}rows.push(r);}if(!rows.length){$('#status').textContent='请至少添加一条药品医嘱。';return;}
$('#save').disabled=true;
try{const next=await api('/api/medication-orders',{id:state.id,request_id:submissionId,rows});accept(next);$('#rows').replaceChildren();addRow();submissionId=requestId();$('#status').textContent='医嘱已确认，已写入诊疗小结并同步至上级医师评价资料。';}
catch(e){$('#status').textContent='确认失败：'+e.message;}
finally{$('#save').disabled=false;}};
addRow();

}
function closeFlow() {$('#cr-flow-panel').classList.add('hidden');$('#cr-flow-toggle').setAttribute('aria-expanded','false');}
function reportName(id) {return state.catalog.find(r=>r.id===id)?.name||id;}
function group(r) {return r.category==='心电'?'心电及其他':r.category==='复评'?'病房复评':r.category;}
function sameCheck(id) {
  const item=state.catalog.find(r=>r.id===id);
  return state.catalog.filter(r=>r.orderable&&(r.order_name||r.name)===(item?.order_name||item?.name));
}
function reportGroupsHtml(compact=false) {
  const categories=['血液','尿液','心电','影像','复评','交接'];
  const rows=viewRequests().filter(id=>id!=='exam').map(id=>state.catalog.find(r=>r.id===id)||{id,name:id});
  rows.sort((a,b)=>categories.indexOf(a.category)-categories.indexOf(b.category)||(a.result_group||a.name).localeCompare(b.result_group||b.name,'zh-CN')||(a.sort_time||'9999').localeCompare(b.sort_time||'9999')||a.id.localeCompare(b.id));
  const groups=new Map();
  for(const r of rows){const key=r.result_group||r.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  return [...groups].map(([name,items])=>`<section class="result-group"><h3>${esc(name)}</h3>${items.map(r=>`<div class="report-row"><div><span>${esc(r.collected||'时间见报告')}</span>${compact?'':`<div class="muted">${state.report_status?.[r.id]?.ready===false?'检查中 · 预计 '+esc(state.report_status[r.id].reported):viewReports().includes(r.id)?'已查看':'结果已返回 · 未查看'}</div>`}</div><button data-report="${r.id}" ${state.report_status?.[r.id]?.ready===false||(state.stage===4||reviewing())&&!viewReports().includes(r.id)?'disabled':''}>${state.report_status?.[r.id]?.ready===false?'检查中':'查看报告'}</button></div>`).join('')}</section>`).join('');
}
function openChecks() {
  const catalog=state.catalog.filter(r=>r.orderable);
  const categories=['血液','影像','心电及其他',...(catalog.some(r=>r.category==='尿液')?['尿液']:[]),...(catalog.some(r=>r.category==='复评')?['病房复评']:[])];
  const entries=[...new Set(catalog.filter(r=>group(r)===category).map(r=>r.order_name||r.name))].map(name=>{
    const members=catalog.filter(r=>(r.order_name||r.name)===name);
    return members.find(r=>!state.requested_reports.includes(r.id))||members[0];
  });
  const placeholders=category==='影像'&&state.stage<2?['胸部X线','超声心动图']:[];
  modal('申请辅助检查',`<div class="row" role="tablist" aria-label="检查分类">${categories.map(c=>`<button role="tab" aria-selected="${c===category}" data-cat="${c}" class="${c===category?'primary':''}">${c}</button>`).join('')}</div><div class="choices">${entries.map(r=>`<label><input type="checkbox" data-check="${r.id}" ${state.requested_reports.includes(r.id)?'disabled':''} ${selected.has(r.id)?'checked':''}> ${esc(r.order_name||r.name)}${state.requested_reports.includes(r.id)?'<small>已申请，可从报告列表查看进度</small>':''}</label>`).join('')}${placeholders.map(name=>`<label class="unavailable"><input type="checkbox" disabled> ${name}<small>当前场景暂不可申请</small></label>`).join('')}</div><div class="muted">同类项目合并列出；每类返回当前病程对应的一份报告；同批申请统一安排采样，约1分钟后自动返回，也可点击等待提前查看。</div><div class="modal-actions"><span id="cr-selected" class="muted">已选择 ${new Set([...selected].map(id=>state.catalog.find(r=>r.id===id)?.order_name||id)).size} 类检查</span><button data-action="close">取消</button><button class="primary" data-action="request-checks" data-mutate>申请所选检查</button></div>`,'checks');
}
async function requestChecks() {
  if(!selected.size){$('#cr-selected').textContent='请先选择检查项目';return;}
  await operation(async()=>{accept(await api('/api/checks',{id:state.id,reports:[...selected]}));selected.clear();schedulePoll();notice='检查已申请，约1分钟后自动返回；新报告会显示红点提醒。';openReports();},true);
}
function openReports() {
  const entries=viewRequests().filter(id=>id!=='exam');
  modal('本次检查报告',entries.length?`<p>${esc(state.time)}</p><p class="muted">约1分钟后自动返回并同步推进模拟时间；同类检查按采样时间排列。</p>${!reviewing()&&state.stage<4&&Object.values(state.report_status||{}).some(r=>!r.ready)?'<div class="row"><button data-action="wait-next">等待下一份结果</button><button data-action="wait-all">等待全部待检结果</button></div>':''}${reportGroupsHtml()}`:'<p class="empty">暂无已返回报告。</p>','reports');
}
async function getReport(id) {
  if(state.report_results[id]){openKnownReport(id);return;}
  if(reviewing()){showError('回看时仅可查看已获得的报告，请回到当前场景继续检查。');return;}
  await operation(async()=>{const result=await api('/api/report',{id:state.id,report:id});accept(result.state);openKnownReport(id);},true);
}
function marked(text) {return esc(text).replace(/(↑|↓)/g,'<mark>$1</mark>');}
function openKnownReport(id) {
  const report=state.report_results[id];if(!report)return;currentReport=id;
  const s=report.sheet||{title:report.name,collected:'见正文',reported:'见正文',findings:report.text};
  const rows=s.rows||[];
  modal(report.name,`<div class="report-workspace"><article class="report-paper"><div class="report-brand">临床技能训练中心 · 教学模拟</div><h2>${esc(s.title)}</h2><div class="report-meta"><span>姓名：${esc(state.registration?.name||"")}</span><span>性别：${esc(state.registration?.sex||"")}　年龄：${esc(state.registration?.age||"")}</span><span>病例号：${esc(state.case_id)}</span><span>报告编号：${esc(s.number||'—')}</span><span>标本 / 方法：${esc(s.sample||'—')}</span>${s.ordered?`<span>申请：${esc(s.ordered)}</span>`:''}<span>采样 / 检查：${esc(s.collected)}</span><span>接收：${esc(s.received||'原稿未单列')}</span><span>报告：${esc(s.reported)}</span></div>${rows.length?`<div class="report-table-wrap"><table><thead><tr><th>检验项目</th><th>结果</th><th>提示</th><th>单位</th><th>参考区间</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.flag?'abnormal-row':''}"><td>${esc(r.name)}</td><td>${esc(r.value)}</td><td>${marked(r.flag)}</td><td>${esc(r.unit)}</td><td>${esc(r.reference)}</td></tr>`).join('')}</tbody></table></div>`:''}${s.image?`<button class="diagnostic-image-button" data-action="zoom-report" aria-label="放大检查图像"><img class="diagnostic-image" src="/api/report-image?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(id)}" alt="${esc(report.name)}：原病例教学合成图"><span>点击放大查看</span></button>`:''}${s.findings?`<h3>检查所见</h3><p class="report-findings">${marked(s.findings)}</p>`:''}${s.source_collected?`<details><summary>病例模板来源时间</summary><p>原病例采样 / 检查：${esc(s.source_collected)}；报告：${esc(s.source_reported)}。本次报告显示的是模拟执行时间。</p></details>`:''}<p class="report-note">${esc(s.note||'')} ${rows.length?'↑ 高于参考上限；↓ 低于参考下限。':''}</p><footer>原病例数据 · 模拟报告样式 · 待专家审核<br>教学资料，不用于真实诊疗；未仿制机构公章或签名。</footer></article><aside class="report-extract"><h3>病历提取</h3>${editable()?`<button class="primary" data-action="preview-import" data-mutate>提取入病历</button><button data-action="preview-full" data-mutate>导入完整${id==='exam'?'查体':'报告'}</button>`:''}<p class="muted">点击“提取入病历”后显示阳性结果预览，确认后才写入；保留来源、时间、数值及单位。</p><button data-action="reports">返回报告列表</button></aside></div>`,'report');
}
function previewImport(positive=true) {
  const r=state.report_results[currentReport];if(!r)return;
  if(positive&&!r.positive){
    modal('提取结果预览',`<p>本报告未记录阳性/异常所见，未向病历写入内容。可按需要导入完整报告。</p><div class="modal-actions"><button data-report="${currentReport}">返回报告</button><button data-action="preview-full" data-mutate>预览完整报告</button></div>`,'import');
    return;
  }
  importPositive=positive;
  const excerpt=positive?`【${r.name} · ${r.sheet?.collected||'见报告'} · 阳性/异常所见】${r.positive}`:`【${r.name}】${r.text}`;
  modal('导入病历预览',`<div class="muted">写入${currentReport==='exam'?'「体格检查」':'「辅助检查」'}栏，保留报告来源、时间与单位。</div><label class="field" for="cr-import-text">导入内容（可编辑、删减）</label><textarea id="cr-import-text" rows="12" maxlength="6000">${esc(excerpt)}</textarea><p id="cr-import-error" role="alert"></p><div class="modal-actions"><button data-report="${currentReport}">返回报告</button><button class="primary" data-action="confirm-import" data-mutate>确认写入${currentReport==='exam'?'体格检查':'辅助检查'}</button></div>`,'import');
}
function zoomReport() {
  const r=state.report_results[currentReport];if(!r?.sheet?.image)return;
  modal(r.name+' · 放大查看',`<div class="image-zoom-tools"><button data-image-zoom="fit" aria-pressed="false">适应窗口</button><button data-image-zoom="double" aria-pressed="true">放大2倍</button><button data-image-zoom="native" aria-pressed="false">原始尺寸</button><button data-report="${currentReport}">返回报告</button></div><p class="muted">可横向、纵向滚动查看细节。原病例教学合成图，屏幕缩放不代表纸面定标。</p><div class="image-zoom-view zoom-double" tabindex="0" aria-label="检查图像放大区域"><img src="/api/report-image?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(currentReport)}" alt="${esc(r.name)}放大图"></div>`,'image-zoom');
}
async function importReport() {
  const editedText=$('#cr-import-text').value.trim();
  if(!editedText){$('#cr-import-error').textContent='请保留需要写入病历的内容，或返回报告取消导入。';return;}
  await operation(async()=>{accept(await api('/api/import',{id:state.id,report:currentReport,positive_only:importPositive,edited_text:editedText}));closeModal();notice='已导入病历并保存，重复内容不会再次添加。';},true);
}
function openTeacher() {
  if(isExam()||reviewing())return;
  modal('上级医师 · 教学请教',`<div class="chat chat-log" id="cr-senior-log" role="log" aria-label="上级医师对话记录" aria-live="polite"></div><p id="cr-senior-error" role="alert"></p><span id="cr-hints" class="muted"></span>${composer('senior','输入你的判断、依据或需要请教的问题')}`,'teacher');
  updateSeniorLog();renderControls();$('#cr-input-senior').focus();
}
function openNew() {
  modal('开始一次演练',`<p>当前记录会保存到本机。新演练从接诊开始。</p><label class="field" for="cr-new-mode">训练模式</label><select id="cr-new-mode"><option value="practice">自主练习</option><option value="exam">考试流程测试</option></select><div class="modal-actions"><button data-action="close">取消</button><button class="primary" data-action="start">开始演练</button></div>`,'new');
}
async function start(mode='practice') {
  screenshotDrafts=[];voiceJob=null;clearTimeout(voiceTimer);
  const next=await api('/api/session',{mode});
  clearTimeout(pollTimer);notes={};dirty.clear();composers={};viewStage=next.stage;selected.clear();localError='';
  sessionStorage.setItem(rehearsalStorageKey,next.id);closeModal();accept(next,true);notice='文字记录自动保存到本机。';showCaseIntro();
}
async function exportSession() {
  if(!state)return;
  if(!state.busy)await saveNotes();
  const blob=new Blob([JSON.stringify({...state,unsaved_notes:Object.fromEntries([...dirty].map(k=>[k,notes[k]])),exported_at:new Date().toISOString()},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='临床文字演练记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

root.addEventListener('input',e=>{
  const key=e.target.dataset.note,role=e.target.dataset.composer;
  if(key&&editable()) {notes[key]=e.target.value;dirty.add(key);renderStatus();clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveNotes().catch(err=>showError(err.message)),700);}
  if(role)composers[role]=e.target.value;
});
root.addEventListener('change',e=>{const id=e.target.dataset.check;if(id){for(const r of sameCheck(id).filter(r=>!state.requested_reports.includes(r.id))){e.target.checked?selected.add(r.id):selected.delete(r.id);}$('#cr-selected').textContent=`已选择 ${new Set([...selected].map(key=>state.catalog.find(r=>r.id===key)?.order_name||key)).size} 类检查`;}});
root.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&e.target.dataset.composer){e.preventDefault();send(e.target.dataset.composer);}});
root.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;
  if(!state){if(b.dataset.action==='reconnect')await initialize();return;}
  try {
    if(b.dataset.stage!==undefined)return navigate(Number(b.dataset.stage));
    if(b.dataset.voice)return toggleVoice(b.dataset.voice);
    if(b.dataset.removeImage){screenshotDrafts=screenshotDrafts.filter(x=>x.id!==b.dataset.removeImage);renderAttachments();return;}
    if(b.dataset.send)return send(b.dataset.send);
    if(b.dataset.draft){const role=b.dataset.target;composers[role]=b.dataset.draft;$(`#cr-input-${role}`).value=b.dataset.draft;$(`#cr-input-${role}`).focus();return;}
    if(b.dataset.cat){category=b.dataset.cat;openChecks();return;}
    if(b.dataset.orderKind){ if (b.dataset.orderKind==='meds') openMedicineOrders(); return; }
    if(b.dataset.report)return getReport(b.dataset.report);
    if(b.dataset.imageZoom){
      const view=$('.image-zoom-view');if(view)view.className='image-zoom-view zoom-'+b.dataset.imageZoom;
      root.querySelectorAll('[data-image-zoom]').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));
      return;
    }
    if(b.dataset.feedback)return send('senior',b.dataset.feedback);
    switch(b.dataset.action){
      case 'flow':{const open=$('#cr-flow-panel').classList.toggle('hidden')===false;$('#cr-flow-toggle').setAttribute('aria-expanded',String(open));break;}
      case 'close-flow':closeFlow();break;
      case 'scene':modal(sceneNames[viewStage]+' · 患者情景',`<div class="scene-enlarged">${sceneImage(viewStage)}</div><p class="muted">AI生成的教学情景示意。病情与检查结果以本次病例文字资料为准。</p>`,'scene');break;
      case 'close':closeModal();break;
      case 'save':await operation(async()=>{notice='病历已保存到本机。';},true);break;
      case 'checks':selected.clear();category='血液';openChecks();break;
      case 'orders':openMedicineOrders();break;
      case 'operation-orders':openOperationOrders();break;
      case 'request-checks':await requestChecks();break;
      case 'reports':openReports();break;
      case 'wait-next':case 'wait-all':await operation(async()=>{accept(await api('/api/wait-results',{id:state.id,all:b.dataset.action==='wait-all'}));openReports();});break;
      case 'exam':await getReport('exam');break;
      case 'preview-import':previewImport();break;
      case 'preview-full':previewImport(false);break;
      case 'zoom-report':zoomReport();break;
      case 'feedback':await requestFeedback();break;
      case 'confirm-import':await importReport();break;
      case 'teacher':openTeacher();renderAttachments();break;
      case 'upload-image':$('#cr-image-file').click();break;
      case 'start-intervention':await startIntervention();break;
      case 'confirm-intervention':await confirmIntervention();break;
      case 'handoff':if(state.stage>1)openKnownReport('handoff');else await advance();break;
      case 'submit':await performAdvance();break;
      case 'new':openNew();break;
      case 'start':await operation(()=>start($('#cr-new-mode').value));break;
      case 'export':await exportSession();break;
      case 'reconnect':if(state)await refresh();else await initialize();break;
    }
  }catch(err){showError(err.message);}
});
$('#cr-next').addEventListener('click',advance);
$('#cr-dialog').addEventListener('close',()=>{modalKind='';});
document.addEventListener('click',e=>{if(!e.target.closest('#cr-flow-panel')&&!e.target.closest('#cr-flow-toggle'))closeFlow();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeFlow();});
window.addEventListener('beforeunload',e=>{if(dirty.size){e.preventDefault();e.returnValue='';}});
async function initialize() {
  try {
    const restoreId=new URLSearchParams(location.hash.slice(1)).get('session');
    const sid=restoreId||sessionStorage.getItem(rehearsalStorageKey);
    if(sid){
      try {
        accept(await api('/api/state?id='+encodeURIComponent(sid)));schedulePoll();
        if(restoreId){sessionStorage.setItem(rehearsalStorageKey,sid);history.replaceState(null,'',location.pathname+location.search);}
      }
      catch(e){showError('未能恢复已有演练。'+e.message);return;}
    }else await start(portalMode);
    if(state?.stage===0 && state.messages.length<=1 && !(state.orders||[]).length && !(state.requested_reports||[]).length && !Object.values(state.notes||{}).some(Boolean))showCaseIntro();
    localError='';renderStatus();
  }catch(e){showError('服务未连接，输入内容不会被清空。'+e.message);}
}
initialize();







function renderAttachments() {
  const el=$('#cr-attachments');if(!el)return;
  el.innerHTML=screenshotDrafts.map(x=>`<div class="attachment-preview"><img src="/api/attachment?id=${encodeURIComponent(state.id)}&attachment=${encodeURIComponent(x.id)}" alt="待发送截图"><button data-remove-image="${esc(x.id)}" aria-label="移除截图">移除</button></div>`).join('')+`<span class="muted">${uploadingImage?'正在上传…':'可直接粘贴截图；每轮最多3张，单张4MB。发送时交给上级医师解读。'}</span>`;
}
async function uploadImages(files) {
  if(uploadingImage||isExam())return;
  uploadingImage=true;renderControls();renderAttachments();
  try {
    for(const file of files){
      if(screenshotDrafts.length>=3)throw new Error('每轮最多3张截图。');
      if(file.size>4*1024*1024)throw new Error('单张截图不能超过4MB。');
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
      screenshotDrafts.push(await api('/api/attachment',{id:state.id,image,name:file.name||'粘贴截图'}));renderAttachments();
    }
  }catch(e){showError(e.message);}finally{uploadingImage=false;renderAttachments();renderControls();}
}
root.addEventListener('change',e=>{if(e.target.id==='cr-image-file'){uploadImages([...e.target.files]);e.target.value='';}});
root.addEventListener('paste',e=>{if(!e.target.closest('.composer')||!$('#cr-input-senior')?.closest('.composer').contains(e.target))return;const files=[...(e.clipboardData?.items||[])].filter(x=>x.type.startsWith('image/')).map(x=>x.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();uploadImages(files);}});
async function toggleVoice(role) {
  if(['starting','listening','transcribing'].includes(voiceJob?.status)){
    clearTimeout(voiceTimer);voiceJob=await api('/api/voice/stop',{id:state.id});renderControls();return;
  }
  const sid=state.id;
  voiceJob={role,status:'starting'};renderControls();
  try{voiceJob=await api('/api/voice/start',{id:sid,role});pollVoice(sid);}
  catch(e){voiceJob={role,status:'error',error:e.message};renderControls();}
}
async function pollVoice(sid){
  try{
    const job=await api('/api/voice/status?id='+encodeURIComponent(sid));
    if(state.id!==sid)return;
    voiceJob=job;
    if(job.status==='done'&&voiceApplied!==job.id){
      voiceApplied=job.id;composers[job.role]=(composers[job.role]||'')+job.text;
      const input=$(`#cr-input-${job.role}`);if(input){input.value=composers[job.role];input.focus();}
    }
    renderControls();
    if(['starting','listening','transcribing'].includes(job.status))voiceTimer=setTimeout(()=>pollVoice(sid),300);
  }catch(e){voiceJob={...voiceJob,status:'error',error:'语音连接中断，请重试。'};renderControls();}
}

function openOperationOrders() {
  modal('操作医嘱',`<div class="op-editor"><p class="muted">搜索并选择操作，再填写参数。确认后写入诊疗小结。</p><div class="op-scroll"><table><thead><tr><th>操作名称</th><th>专用参数</th><th>频次</th><th>时长</th><th>医嘱类型</th><th>备注</th><th></th></tr></thead><tbody id="op-rows"></tbody></table></div><div class="row"><button id="op-add">＋ 增加一行</button><button id="op-confirm" class="primary">确定</button><span id="op-status" role="status"></span></div></div>`,'operation-orders');
  const catalog=state.operation_catalog||[];let operationRequestId=requestId();
  function add(){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="op-search"><input aria-label="操作搜索" placeholder="中文 / 拼音缩写"><div class="op-matches"></div></td><td class="op-params">选择操作后填写</td><td><input aria-label="频次" list="op-frequencies" placeholder="选择或输入"></td><td><input aria-label="时长" placeholder="如：30分钟 / 至停止医嘱"></td><td><select aria-label="医嘱类型"><option>临时医嘱</option><option>长期医嘱</option></select></td><td><input aria-label="备注" placeholder="选填"></td><td><button aria-label="删除操作">删除</button></td>`;
    const search=tr.querySelector('input'),matches=tr.querySelector('.op-matches');
    search.oninput=()=>{tr.operation=null;tr.querySelector('.op-params').textContent='选择操作后填写';matches.replaceChildren();const q=search.value.trim().toLowerCase();if(!q)return;catalog.filter(o=>o.name.includes(q)||o.pinyin.replaceAll(' ','').includes(q)).forEach(o=>{const b=document.createElement('button');b.textContent=o.name;b.onclick=()=>{tr.operation=o;search.value=o.name;matches.replaceChildren();const box=tr.querySelector('.op-params');box.replaceChildren();if(!o.fields.length)box.textContent='无需额外参数';o.fields.forEach(f=>{const label=document.createElement('label');label.textContent=f.label;let options=f.options;const linked=f.label.startsWith('关联');if(linked)options=(state.orders||[]).filter(x=>x.kind==='medication').map(x=>x.text);const input=document.createElement(options.length?'select':'input');input.dataset.param=f.label;input.setAttribute('aria-label',f.label);if(options.length){const blank=document.createElement('option');blank.value='';blank.textContent='请选择';input.append(blank);options.forEach(v=>{const opt=document.createElement('option');opt.textContent=v;input.append(opt);});}if(linked&&!options.length)input.placeholder='请先开药，或填写需关联的药品医嘱';label.append(input);box.append(label);});};matches.append(b);});if(!matches.children.length)matches.textContent='未找到匹配操作';};
    tr.querySelector('[aria-label="删除操作"]').onclick=()=>{tr.remove();if(!$('#op-rows').children.length)add();};$('#op-rows').append(tr);
  }
  add();$('#op-add').onclick=add;
  const dl=document.createElement('datalist');dl.id='op-frequencies';['一次','持续','Qd','Bid','Qh','每15分钟','必要时'].forEach(v=>{const o=document.createElement('option');o.value=v;dl.append(o);});$('#op-rows').closest('.op-editor').append(dl);
  $('#op-confirm').onclick=async()=>{
    const button=$('#op-confirm');if(button.disabled)return;
    const rows=[];for(const tr of $('#op-rows').children){if(!tr.operation){$('#op-status').textContent='请搜索并确认每行操作名称。';return;}const value=n=>tr.querySelector(`[aria-label="${n}"]`).value.trim();rows.push({operation_id:tr.operation.id,params:Object.fromEntries([...tr.querySelectorAll('[data-param]')].map(x=>[x.dataset.param,x.value.trim()])),frequency:value('频次'),duration:value('时长'),type:value('医嘱类型'),remark:value('备注')});}
    button.disabled=true;$('#op-status').textContent='正在确认…';
    try{accept(await api('/api/operation-orders',{id:state.id,request_id:operationRequestId,rows}));operationRequestId=requestId();$('#op-rows').replaceChildren();add();$('#op-status').textContent='已开立，已写入诊疗小结并同步给上级医师。';}catch(e){$('#op-status').textContent=e.message;}finally{button.disabled=false;}
  };
}

function showCaseIntro() {
  if(!state||sessionStorage.getItem('clinical-intro-'+state.id))return;
  let intro=document.getElementById('cr-case-intro');
  if(!intro){intro=document.createElement('dialog');intro.id='cr-case-intro';intro.setAttribute('aria-labelledby','cr-intro-title');root.append(intro);intro.addEventListener('cancel',e=>e.preventDefault());}
  intro.innerHTML=`<div class="intro-picture">${sceneImage(0)}</div><div class="intro-shade"></div><div class="intro-top">临床思维训练室<span>急诊接诊</span></div><section class="intro-bottom"><div><p class="intro-eyebrow">患者基本信息</p><h2 id="cr-intro-title">${esc(state.registration?.name||"")} <span>${esc(state.registration?.sex||"")} · ${esc(state.registration?.age||"")}</span></h2><p class="intro-detail">${esc(state.registration?.marital_status||"")} · ${esc(state.registration?.occupation||"")}</p><p class="intro-quote">“医生，我胸口疼得厉害，还一直出汗。”</p><small>AI生成的教学情景</small></div><button id="cr-begin-reception" autofocus>开始接诊 <span aria-hidden="true">→</span></button></section>`;
  if(casePresentation.intro_quote){const quote=intro.querySelector('.intro-quote');quote.textContent='“'+casePresentation.intro_quote+'”';if(casePresentation.options?.rtl_patient){quote.lang='ug';quote.dir='rtl';}}
  document.getElementById('cr-begin-reception').onclick=()=>{sessionStorage.setItem('clinical-intro-'+state.id,'1');intro.close();document.getElementById('cr-input-patient')?.focus();};
  if(!intro.open)intro.showModal();
}



function renderRecordArchive() {
  const el=$('#cr-record-archive');if(!el)return;
  const docs=(state.medical_documents||[]).filter(d=>d.stage<viewStage);
  if(viewStage<2){el.replaceChildren();return;}
  const signature=JSON.stringify(docs);if(el.dataset.signature===signature)return;el.dataset.signature=signature;
  const renderContent=d=>d.fields.map(([key,label])=>d.content[key]?`<div class="archive-field"><strong>${esc(label)}</strong><p>${esc(d.content[key])}</p></div>`:'').join('');
  el.innerHTML=`<h3>既往病历 <span class="muted">${docs.length} 份 · 点击展开</span></h3>${docs.length?docs.map(d=>`<details class="archived-document"><summary><strong>${esc(d.title)}</strong><span>${esc(d.created_at||'旧记录未留存书写时间')}</span></summary><div class="archive-content"><p class="muted">首次保存：${esc(d.created_at||'未留存')} · 最近保存：${esc(d.updated_at||'未留存')} · ${esc(stageNames[d.stage])} · 历史只读</p>${d.legacy?'<p class="muted">从原阶段快照保留；原“主诉 / 现病史”合并内容保留在现病史，未自动拆分。</p>':''}${renderContent(d)}${d.versions?.length?`<details><summary>查看修订历史（${d.versions.length}）</summary>${d.versions.map(v=>`<article><p class="muted">保存时间 ${esc(v.time)}</p>${renderContent({...d,content:v.content})}</article>`).join('')}</details>`:''}</div></details>`).join(''):'<p class="muted">尚无已书写的历史病历。</p>'}`;
}

