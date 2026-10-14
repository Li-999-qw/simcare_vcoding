'use strict';
const casePresentation=window.SIMCARE_CASE_PRESENTATION||{};
const portalParams=new URLSearchParams(location.search);
const portalStudent=portalParams.get('portalStudent');
const portalTask=portalParams.get('portalTask');
const portalMode=portalTask&&portalParams.get('portalMode')==='exam'?'exam':'practice';
const rehearsalStorageKey=portalStudent?'lumbar-rehearsal-id:'+portalStudent+':lumbar:'+(portalTask?'task:'+portalTask+':'+portalMode:'practice'):'lumbar-rehearsal-id';
if(portalStudent){const bar=document.createElement('div');bar.style.cssText='padding:10px 20px;background:#20343e;color:white;display:flex;gap:20px;align-items:center';const label=document.createElement('span');label.textContent=(portalParams.get('portalName')||portalStudent)+' · 腰腿痛病例 · '+(portalTask?'教师分配'+(portalMode==='exam'?' · 考试':' · 练习'):'自主练习');const back=document.createElement('a');back.href='http://127.0.0.1:8876/portal.html?return='+(portalTask?'tasks':'1');back.textContent='返回学习工作台';back.style.color='#80d9c7';bar.append(label,back);document.body.prepend(bar);}
// Layout and scene flow: approved clinical-rounds.html from the 界面设计 task.
const root = document.getElementById('clinical-rounds');
const $ = s => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stageNames = casePresentation.ui_stage_names||['接诊','手术治疗','病房查房','出院日','反馈'];
const sceneNames = casePresentation.scene_names||['骨科普通诊室','转运与手术团队交接','住院病房','出院日'];
const noteTitles = casePresentation.note_titles||['门诊初诊病历','处置与交接记录','日常病程记录','出院记录'];
let state, viewStage = -1, renderedStage = -1, pollTimer, saveTimer, savePromise;
let notes = {}, dirty = new Set(), composers = {}, pending = false, localError = '';
let modalKind = '', currentReport = '', category = '影像', selected = new Set();
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
  return `<div class="busy-state" data-busy="${role}" aria-live="polite"></div><div class="composer"><label class="field" for="cr-input-${role}">${role==='senior'?'向上级汇报 / 请教':role==='team'?'诊疗与交接指令':'对话内容'}</label><textarea id="cr-input-${role}" data-composer="${role}" rows="2" maxlength="2000" placeholder="${placeholder}">${esc(composers[role])}</textarea>${role==='senior'?'<div id="cr-attachments"></div><input id="cr-image-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>':''}<div class="voice-status" data-voice-status="${role}" role="status"></div><div class="row"><button data-voice="${role}">🎙 语音输入</button>${role==='senior'?'<button data-action="upload-image">＋ 上传截图</button>':''}<span class="muted">文字输入 · Ctrl + Enter 发送</span><button class="primary" data-send="${role}">${role==='team'?'记录指令':'发送'}</button></div></div>`;
}
function toolbar() {
  return `<div class="tools" aria-label="临床操作"><button data-action="exam" data-mutate>查体</button><button data-action="checks" data-mutate>＋ 申请检查</button><button data-action="orders" data-mutate>＋ ${viewStage===0?'门诊处方':'药品医嘱'}</button><button data-action="operation-orders" data-mutate>＋ ${viewStage===0?'门诊处置':'操作医嘱'}</button><button data-action="reports" id="cr-report-count">检查报告</button></div>`;
}
function recordBody() {
  if (viewStage === 0) return `<p class="muted">骨科普通门诊 · ${esc(state.time)} · 挂号资料齐备，尚未入院</p>${noteField('general','一般资料 / 病史陈述者','门诊挂号资料',3)} ${noteField('chief','主诉','主要症状及持续时间',2)} ${noteField('history','现病史','起病、症状演变、伴随症状及既往诊治',4)} ${noteField('past_history','既往史','相关疾病、手术及既往类似发作',2)} ${noteField('allergy_history','过敏史','已核实的过敏情况',1)} ${noteField('exam','体格检查','阳性体征及必要的阴性体征',2)} ${noteField('specialist_exam','骨科专科检查','侧别、肌力、感觉、反射及相关试验',3)} ${noteField('tests','辅助检查','已获得的结果，可从报告编辑后导入',2)} ${noteField('diagnosis','诊断','诊断及待排疾病',2)} ${noteField('initial_plan','治疗处理意见','药物、检查、处置及沟通意见',3)} ${noteField('plan','复诊 / 转诊及住院安排','复诊时间、注意事项；需要转诊或住院时写明安排',3)} ${noteField('author','接诊医师（学员）','填写姓名',1)} <details><summary>补充病史与诊断分析（按需填写）</summary>${noteField('personal_history','个人史','按问诊及分析填写',2)}${noteField('marriage_history','婚育史','按问诊及分析填写',2)}${noteField('family_history','家族史','按问诊及分析填写',2)}${noteField('case_features','病例特点','按问诊及分析填写',2)}${noteField('first_diagnosis','原拟诊记录','按问诊及分析填写',2)}${noteField('reason','诊断依据','按问诊及分析填写',2)}${noteField('differential','鉴别诊断','按问诊及分析填写',2)}</details>`;
  if (viewStage === 1) return `<div class="notice">接诊医生 · 负责决策、协调和交接</div><h3>处置指令</h3><div id="cr-orders"></div>${noteField('plan','处置计划 / 交接要点','记录拟进行的处理与需要交接的问题',4)}<button class="secondary-action" data-action="handoff">${state.stage > 1 ? '查看手术团队回报' : '接收手术团队回报，进入病房 →'}</button><p class="tool-note">病房交接采用病例预设节点，指令记录不代表已执行。</p>`;
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
  return `<figure class="cath-scene">${sceneImage(1)}${active?'<div class="procedure-overlay" role="status" aria-label="脊柱手术进行中">脊柱手术进行中<span class="procedure-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></div>':''}<figcaption>脊柱手术室 · AI情景示意</figcaption></figure>`;
}
function interventionLayout() {
  if(reviewing())return `<section class="panel pad intervention"><h2>手术治疗记录</h2><p>${state.intervention?.status==='confirmed'?'已选择手术治疗并确认团队回报。':'本次保留原有交接记录。'}</p><button data-action="handoff">查看手术团队回报</button>${state.orders.map(o=>`<p>${esc(o.text)}</p>`).join('')}${viewNotes().plan?`<p>${esc(viewNotes().plan)}</p>`:''}</section>`;
  const started=state.intervention?.status==='started', report=state.intervention_report;
  return `<section class="panel pad intervention"><h2>手术治疗</h2>${report?`<article class="team-report"><span class="tag">手术团队回报</span><h3>${esc(report.name)}</h3><p>${esc(report.text)}</p><button class="primary" data-action="confirm-intervention">确认回报，进入病房 →</button><p class="muted">确认后归入检查报告；病历内容仍由你提取、确认写入。</p></article>`:started?`${cathScene(true)}<p class="muted">情景示意 · 病例预设过程</p>`:`${scenePanel()}${noteField('plan','术前决策与风险沟通','记录责任节段与侧别、手术指征、替代方案及拟沟通的风险',4)}<p>此后进入住院手术教学阶段；门诊处方不视为围术期已给药。</p><button class="primary" data-action="start-intervention">选择手术治疗 →</button>`}</section>`;
}
async function startIntervention() {
  await operation(async()=>{accept(await api('/api/intervention/start',{id:state.id}),true);schedulePoll();});
}
async function confirmIntervention() {
  await operation(async()=>{const next=await api('/api/intervention/confirm',{id:state.id});viewStage=next.stage;closeModal();accept(next,true);notice='手术团队回报已归入检查报告，已进入病房。';});
}
function mainLayout() {
  if (viewStage === 4) return feedbackLayout();
  if (viewStage === 1) return interventionLayout();
  const team = viewStage === 1, role = team ? 'team' : 'patient';
  const questions = viewStage === 0 ? ['哪里不舒服？','疼痛持续多久？','以前有类似情况吗？'] : ['今天左腿还痛吗？','活动和睡眠怎么样？'];
  return `<section class="panel conversation" aria-label="${team?'团队交接':'患者问诊'}">${scenePanel()}<div class="pad"><h2 class="heading">${team?'团队对话 · 处置与交接':'患者交流'}<span class="muted" data-sim-time>${reviewing()?'回看记录':state.time}</span></h2><div class="chat chat-log" id="cr-patient-log" role="log" aria-label="${team?'交接记录':'患者对话记录'}" aria-live="polite"></div>${editable()?`<div class="row quick-questions">${team?'<button data-draft="联系手术团队并准备转运交接" data-target="team">联系手术团队</button><button data-draft="安排监测与病情复评" data-target="team">安排监测与复评</button>':questions.map(text=>`<button data-draft="${text}" data-target="patient">${text}</button>`).join('')}</div>${composer(role,team?'输入诊疗指令，记录后在右侧核对':'输入想问患者的话')}`:'<p class="muted">已完成场景的对话保留在这里。返回当前场景继续。</p>'}</div></section><section class="panel pad record-panel" aria-label="病历书写区域"><h2 class="heading">${noteTitles[viewStage]}<span class="record-state"></span></h2>${toolbar()}${recordBody()}<section id="cr-record-archive"></section><section id="cr-treatment-summary"></section><div class="record-bottom"><span class="muted">${editable()?'输入后自动保存':'已完成场景 · 回看记录'}</span>${editable()?'<button data-action="save" data-mutate>保存病历</button>':''}</div></section>`;
}
function recordReviewHtml() {
  return `<h3>四维记录核对</h3><p class="muted">以下核对实际留存内容；有记录不代表医学判断正确，未见记录也不等同没有实施。</p><div class="review-grid">${(state.record_review||[]).map(card=>`<article class="review-card"><h3>${esc(card.title)}</h3><p>${esc(card.summary)}</p>${card.fields.map(field=>`<details><summary><span class="${field.present?'recorded':'missing'}">${field.present?'已有记录':'未见记录'}</span> · ${esc(field.label)}</summary><p>${esc(field.evidence||'本次未保存该项文字，无法核对。')}</p></details>`).join('')}</article>`).join('')}</div>`;
}
function feedbackLayout() {
  if (isExam()) return `<section class="panel feedback"><h2 class="heading">考试提交回执 <span class="tag">已提交</span></h2><div class="notice">作答已锁定。下面可核对自己的记录；医学点评与标准答案等待教师发布。</div>${recordReviewHtml()}<p class="muted">当前尚未接入教师发布后台。需要即时带教点评，请新建“自主练习”演练。</p><button data-stage="0">回看接诊记录</button> <button data-action="export">导出本次记录</button></section>`;
  const stats = [['患者交流',state.messages.filter(m=>m.speaker==='student'&&m.role==='patient').length+' 轮'],['已查看检查与资料',state.reports.length+' 项'],['病历导入',state.events.filter(e=>e.action==='导入病历').length+' 次'],['手术治疗',state.intervention?.status==='confirmed'?'已选择并确认回报':'未确认'],['请教上级',state.hint_count+' 次提示']];
  return `<section class="panel feedback"><h2 class="heading">本次训练反馈 <span class="tag">已提交</span></h2><p class="muted">基于实际问诊、已查看报告及各阶段病历形成点评。未记录的行为不视为已完成。</p><h3>上级医师 · 四维点评</h3><div class="chat chat-log" id="cr-feedback-log" role="log" aria-label="复盘对话记录" aria-live="polite"></div><button data-action="feedback">生成 / 重试完整点评</button><div class="feedback-composer">${composer('senior','可以追问自己的问诊、检查、诊断与处理是否合理')}</div>${recordReviewHtml()}<details><summary>交互统计与操作时间线</summary>${stats.map(([name,value])=>`<div class="record">${name}<span class="summary-value">${value}</span></div>`).join('')}<div class="history-list">${state.events.map(e=>`<div class="record">${stageNames[e.stage]} · ${esc(e.action)} · ${esc(e.name)}</div>`).join('')}</div></details><div class="row"><button data-stage="0">回看接诊记录</button><button data-stage="1">回看手术治疗</button><button data-action="reports">检查报告</button><button data-action="export">导出本次记录</button></div><p class="muted">形成性反馈 · 暂不生成医学分数</p></section>`;
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
  return `<div class="message ${m.speaker==='student'?'student':''}"><span class="speaker">${speaker}${m.role==='senior'?' · '+stageNames[m.stage]:''}${m.hint?' · 教学提示':''}</span><p>${esc(m.text)}</p>${(m.attachments||[]).map(id=>`<img class="chat-attachment" src="/api/attachment?id=${encodeURIComponent(state.id)}&attachment=${encodeURIComponent(id)}" alt="向上级医师提供的截图">`).join('')}</div>`;
}
function streamHtml(role) {
  const draft=state.streaming;
  if(!state.busy||!draft?.text||draft.role!==role||draft.stage!==viewStage)return '';
  return `<div class="message streaming"><span class="speaker">${role==='patient'?'患者':'上级医师'} · 正在回复</span><p>${esc(draft.text)}<span class="stream-cursor" aria-hidden="true">▍</span></p></div>`;
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
  if(!reviewing()&&viewStage===1)$('#cr-next').textContent=state.intervention_report?'确认回报，进入病房 →':state.intervention?.status==='started'?'等待手术团队回报…':'选择手术治疗 →';
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
    const next=await api(role==='team'?'/api/order':'/api/message',{id:state.id,role,text,request_id:crypto.randomUUID(),attachments:role==='senior'?screenshotDrafts.map(x=>x.id):[]});
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
  modal(state.stage===0?'门诊处方':'药品医嘱', '<div class="cr-rx-host"></div>', 'orders');
  const editor = document.querySelector('.cr-rx-host').attachShadow({mode:'open'});
  editor.innerHTML = '<link rel="stylesheet" href="/style.css?v=rx-native-3">' + "<main><header><h1>药品医嘱</h1><small>药品医嘱 · 确定后写入诊疗小结</small></header><div class=\"table-wrap\"><table><thead><tr><th>药品</th><th>剂量</th><th>用法</th><th>给药途径</th><th>医嘱类型</th><th>备注</th></tr></thead><tbody id=\"rows\"></tbody></table></div><footer><button id=\"add\">＋ 增加一行</button><button id=\"save\" class=\"primary\">确定</button><span id=\"status\">选药后带入常用方案，可修改；个体化剂量可留待填写</span></footer></main>";
window.MI_DRUG_CATALOG={"items": [{"id": "ldh-drug-1", "name": "塞来昔布胶囊", "pinyin_initials": "slxbjn", "note": "原病例既往短程使用；核对适应证及禁忌，不默认重新开立。", "case_medication": true, "autofill": {"dose": "200", "unit": "mg", "frequency": "Qd · 一日一次", "route": "口服", "remark": ""}, "common_regimen": {"dose": "200", "unit": "mg", "frequency": "Qd · 一日一次", "route": "口服", "details": "原病例既往短程使用；核对适应证及禁忌，不默认重新开立。"}, "dose_review_status": "原病例教学方案，待临床审核"}, {"id": "ldh-drug-2", "name": "对乙酰氨基酚片", "pinyin_initials": "dyxajfp", "note": "原病例出院方案：间隔至少6小时，最多2g/日、不超过3天；避免重复成分。", "case_medication": true, "autofill": {"dose": "500", "unit": "mg", "frequency": "PRN · 必要时", "route": "口服", "remark": ""}, "common_regimen": {"dose": "500", "unit": "mg", "frequency": "PRN · 必要时", "route": "口服", "details": "原病例出院方案：间隔至少6小时，最多2g/日、不超过3天；避免重复成分。"}, "dose_review_status": "原病例教学方案，待临床审核"}, {"id": "ldh-drug-3", "name": "注射用头孢唑林", "pinyin_initials": "zsy tbzl", "note": "原病例切皮前30分钟预防用药，术后24小时内停止；不是普通门诊常规用药。", "case_medication": true, "autofill": {"dose": "2", "unit": "g", "frequency": "一次", "route": "静脉滴注", "remark": ""}, "common_regimen": {"dose": "2", "unit": "g", "frequency": "一次", "route": "静脉滴注", "details": "原病例切皮前30分钟预防用药，术后24小时内停止；不是普通门诊常规用药。"}, "dose_review_status": "原病例教学方案，待临床审核"}, {"id": "ldh-drug-4", "name": "甲钴胺片", "pinyin_initials": "jg ap jga mkb", "category": "神经营养类", "note": "外文说明书成人周围神经病用量参考：500μg每次，每日3次；不代表对本病例根性疼痛的疗效已确立。需核对国内具体品规。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "500", "unit": "μg", "frequency": "Tid · 一日三次", "route": "口服", "remark": ""}, "common_regimen": {"dose": "500", "unit": "μg", "frequency": "Tid · 一日三次", "route": "口服", "details": "外文说明书成人周围神经病用量参考：500μg每次，每日3次；不代表对本病例根性疼痛的疗效已确立。需核对国内具体品规。"}, "dose_review_status": "外文说明书参考，待国内品规核对", "sources": ["https://pins.japic.or.jp/pdf/newPINS/00053082.pdf"]}, {"id": "ldh-drug-5", "name": "美洛昔康片", "pinyin_initials": "ml xk mlxk", "category": "NSAIDs", "note": "说明书关节炎成人起始方案参考，不是腰椎病特定推荐；不与其他NSAIDs重复。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "7.5", "unit": "mg", "frequency": "Qd · 一日一次", "route": "口服", "remark": ""}, "common_regimen": {"dose": "7.5", "unit": "mg", "frequency": "Qd · 一日一次", "route": "口服", "details": "说明书关节炎成人起始方案参考，不是腰椎病特定推荐；不与其他NSAIDs重复。"}, "dose_review_status": "外文说明书参考，待国内品规核对", "sources": ["https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=3b1938e5-7a9e-b214-e063-6394a90a1270"]}, {"id": "ldh-drug-6", "name": "布洛芬缓释胶囊", "pinyin_initials": "blfhsjn", "category": "NSAIDs", "note": "具体缓释品规与用量待核实。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "具体缓释品规与用量待核实。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-7", "name": "双氯芬酸钠缓释片", "pinyin_initials": "slfsnhsp", "category": "NSAIDs", "note": "具体缓释品规与用量待核实。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "具体缓释品规与用量待核实。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-8", "name": "洛索洛芬钠片", "pinyin_initials": "lslfnp", "category": "NSAIDs", "note": "具体品规与用量待核实。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "具体品规与用量待核实。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-9", "name": "依托考昔片", "pinyin_initials": "ytkxp", "category": "NSAIDs", "note": "需评估心血管风险，具体适应证及品规用量待核实。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "需评估心血管风险，具体适应证及品规用量待核实。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-10", "name": "萘普生片", "pinyin_initials": "npsp", "category": "NSAIDs", "note": "具体品规与用量待核实。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "具体品规与用量待核实。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-11", "name": "双氯芬酸二乙胺乳胶剂", "pinyin_initials": "slfseyarjj", "category": "局部用药", "note": "外用量与面积依具体品规，不把外用等同于根性疼痛有效治疗。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "g", "frequency": "请选择", "route": "外用", "remark": ""}, "common_regimen": {"dose": "", "unit": "g", "frequency": "待核实", "route": "外用", "details": "外用量与面积依具体品规，不把外用等同于根性疼痛有效治疗。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-12", "name": "盐酸乙哌立松片", "pinyin_initials": "ysyplsp", "category": "肌肉松弛药", "note": "需明确适应证并核对国内说明书，不自动推荐。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "需明确适应证并核对国内说明书，不自动推荐。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-13", "name": "盐酸替扎尼定片", "pinyin_initials": "ystzndp", "category": "肌肉松弛药", "note": "需核对适应证、低血压和镇静风险及相互作用。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "需核对适应证、低血压和镇静风险及相互作用。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-14", "name": "普瑞巴林胶囊", "pinyin_initials": "prbljn", "category": "神经病理性疼痛相关药", "note": "NICE NG59不建议常规用于坐骨神经痛；收录供选择合理性讨论，非默认推荐。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "NICE NG59不建议常规用于坐骨神经痛；收录供选择合理性讨论，非默认推荐。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": ["https://www.nice.org.uk/guidance/ng59/chapter/Recommendations"]}, {"id": "ldh-drug-15", "name": "加巴喷丁胶囊", "pinyin_initials": "jbpdjn", "category": "神经病理性疼痛相关药", "note": "NICE NG59不建议常规用于坐骨神经痛；收录不代表适用。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "NICE NG59不建议常规用于坐骨神经痛；收录不代表适用。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": ["https://www.nice.org.uk/guidance/ng59/chapter/Recommendations"]}, {"id": "ldh-drug-16", "name": "盐酸度洛西汀肠溶胶囊", "pinyin_initials": "ysdlxtcrjn", "category": "其他疼痛相关药", "note": "不能将其他神经病理性疼痛适应证自动套用到本病例；具体方案待评估。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "不能将其他神经病理性疼痛适应证自动套用到本病例；具体方案待评估。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": ["https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=ae381859-be09-43e1-8b56-d0d8f4b49020"]}, {"id": "ldh-drug-17", "name": "奥美拉唑肠溶胶囊", "pinyin_initials": "amlzcrjn", "category": "胃酸抑制药", "note": "仅在有适应证时使用；具体品规用量待核实。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "仅在有适应证时使用；具体品规用量待核实。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-18", "name": "泮托拉唑钠肠溶片", "pinyin_initials": "ptlzncrp", "category": "胃酸抑制药", "note": "仅在有适应证时使用，不与同类重复。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "仅在有适应证时使用，不与同类重复。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}, {"id": "ldh-drug-19", "name": "艾司奥美拉唑镁肠溶片", "pinyin_initials": "asamlzmcrp", "category": "胃酸抑制药", "note": "仅在有适应证时使用，不与同类重复。", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "请选择", "route": "口服", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "待核实", "route": "口服", "details": "仅在有适应证时使用，不与同类重复。"}, "dose_review_status": "未预填剂量，待核对具体品规", "sources": []}], "case_id": "SIM-LDH-20260903", "version": "1.0", "updated": "2026-09-14", "scope": "教学药品检索目录，不是本病例推荐联合方案；未核实本地品规的剂量和频次留空。"};
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
 const type=select(state.stage===0?['门诊处方']:['临时医嘱','长期医嘱','长期有药','临时有药'],data.type,'处方类型');type.dataset.key='type';cells[4].append(type);if(state.stage===0){type.hidden=true;for(const [key,label] of [['days','疗程'],['quantity','总量']]){const input=document.createElement('input');input.dataset.key=key;input.setAttribute('aria-label',label);input.placeholder=label+(key==='days'?'（如3天）':'（如6片）');input.value=data[key]||'';cells[4].append(input);}}
 const remark=document.createElement('input');remark.placeholder='选填备注';remark.setAttribute('aria-label','备注');remark.dataset.key='remark';remark.value=data.remark||'';remark.title=remark.value;remark.oninput=()=>{remark.title=remark.value;};cells[5].append(remark);
 $('#rows').append(tr);
}
if(state.stage===0){editor.querySelector('h1').textContent='门诊处方';editor.querySelector('header small').textContent='确定后写入门诊诊疗小结';editor.querySelectorAll('th')[4].textContent='疗程 / 总量';}
editor.addEventListener('click',e=>{editor.querySelectorAll('.drug-cell').forEach(c=>{if(!c.contains(e.target))c.querySelector('.matches').replaceChildren();});});
$('#add').onclick=()=>{addRow();$('#rows').lastElementChild.querySelector('input').focus();};
let submissionId=crypto.randomUUID();
$('#save').onclick=async()=>{if($('#save').disabled)return;const rows=[];for(const tr of $('#rows').children){const r={name:tr.dataset.drug};tr.querySelectorAll('[data-key]').forEach(el=>r[el.dataset.key]=el.value);const typed=tr.querySelector('input').value.trim();if(!typed&&!r.dose&&r.use==='请选择'&&r.route==='请选择'&&!r.remark)continue;if(!r.name){$('#status').textContent='请先点击匹配药品，确认药名。';tr.querySelector('input').focus();return;}if(!(Number(r.dose)>0)||r.use==='请选择'||r.route==='请选择'){$('#status').textContent='请补齐 '+r.name+' 的剂量、用法与给药途径。';return;}if(state.stage===0&&(!r.days?.trim()||!r.quantity?.trim())){$('#status').textContent='请填写疗程和总量（含单位）。';return;}rows.push(r);}if(!rows.length){$('#status').textContent='请至少添加一条药品医嘱。';return;}
$('#save').disabled=true;
try{const next=await api('/api/medication-orders',{id:state.id,request_id:submissionId,rows});accept(next);$('#rows').replaceChildren();addRow();submissionId=crypto.randomUUID();$('#status').textContent='医嘱已确认，已写入诊疗小结并同步至上级医师评价资料。';}
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
  const placeholders=[];
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
  modal(report.name,`<div class="report-workspace"><article class="report-paper"><div class="report-brand">临床技能训练中心 · 教学模拟</div><h2>${esc(s.title)}</h2><div class="report-meta"><span>姓名：${esc(state.registration?.name||"")}</span><span>性别：${esc(state.registration?.sex||"")}　年龄：${esc(state.registration?.age||"")}</span><span>病例号：${esc(state.case_id)}</span><span>报告编号：${esc(s.number||'—')}</span><span>标本 / 方法：${esc(s.sample||'—')}</span>${s.ordered?`<span>申请：${esc(s.ordered)}</span>`:''}<span>采样 / 检查：${esc(s.collected)}</span><span>接收：${esc(s.received||'原稿未单列')}</span><span>报告：${esc(s.reported)}</span></div>${rows.length?`<div class="report-table-wrap"><table><thead><tr><th>检验项目</th><th>结果</th><th>提示</th><th>单位</th><th>参考区间</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.flag?'abnormal-row':''}"><td>${esc(r.name)}</td><td>${esc(r.value)}</td><td>${marked(r.flag)}</td><td>${esc(r.unit)}</td><td>${esc(r.reference)}</td></tr>`).join('')}</tbody></table></div>`:''}${s.image?`<button class="diagnostic-image-button" data-action="zoom-report" aria-label="放大检查图像"><img class="diagnostic-image" src="/api/report-image?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(id)}" alt="${esc(report.name)}：原病例教学合成图"><span>点击放大查看</span></button>`:''}${s.findings?`<h3>检查所见</h3><p class="report-findings">${marked(s.findings)}</p>`:''}${s.source_collected?`<details><summary>病例模板来源时间</summary><p>原病例采样 / 检查：${esc(s.source_collected)}；报告：${esc(s.source_reported)}。本次报告显示的是模拟执行时间。</p></details>`:''}<p class="report-note">${esc(s.note||'')} ${rows.length?'↑ 高于参考上限；↓ 低于参考下限。':''}</p><footer>原病例数据 · 模拟报告样式 · 待专家审核<br>教学资料，不用于真实诊疗；未仿制机构公章或签名。</footer></article><aside class="report-extract"><h3>病历提取</h3>${report.pacs?`<a class="pacs-launch" href="/pacs/pacs.html?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(id)}" target="_blank" rel="noopener">打开 PACS 阅片 ↗</a>`:''}${editable()?`<button class="primary" data-action="preview-import" data-mutate>提取入病历</button><button data-action="preview-full" data-mutate>导入完整${id==='exam'?'查体':'报告'}</button>`:''}<p class="muted">点击“提取入病历”后显示阳性结果预览，确认后才写入；保留来源、时间、数值及单位。</p><button data-action="reports">返回报告列表</button></aside></div>`,'report');
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
      case 'checks':selected.clear();category='影像';openChecks();break;
      case 'orders':openMedicineOrders();break;
      case 'operation-orders':openOperationOrders();break;
      case 'request-checks':await requestChecks();break;
      case 'reports':openReports();break;
      case 'wait-next':case 'wait-all':await operation(async()=>{accept(await api('/api/wait-results',{id:state.id,all:b.dataset.action==='wait-all'}));openReports();});break;
      case 'exam':await getReport(viewStage===2?'ward':viewStage===3?'discharge':'exam');break;
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
  const catalog=state.operation_catalog||[];let requestId=crypto.randomUUID();
  function add(){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="op-search"><input aria-label="操作搜索" placeholder="中文 / 拼音缩写"><div class="op-matches"></div></td><td class="op-params">选择操作后填写</td><td><input aria-label="频次" list="op-frequencies" placeholder="选择或输入"></td><td><input aria-label="时长" placeholder="如：30分钟 / 至停止医嘱"></td><td><select aria-label="医嘱类型"><option>临时医嘱</option><option>长期医嘱</option></select></td><td><input aria-label="备注" placeholder="选填"></td><td><button aria-label="删除操作">删除</button></td>`;
    const search=tr.querySelector('input'),matches=tr.querySelector('.op-matches');
    if(state.stage===0){const t=tr.querySelector('select[aria-label="医嘱类型"]');t.innerHTML='<option>临时医嘱</option>';t.hidden=true;t.parentElement.append('本次门诊');}
    search.oninput=()=>{tr.operation=null;tr.querySelector('.op-params').textContent='选择操作后填写';matches.replaceChildren();const q=search.value.trim().toLowerCase();if(!q)return;catalog.filter(o=>o.name.includes(q)||o.pinyin.replaceAll(' ','').includes(q)).forEach(o=>{const b=document.createElement('button');b.textContent=o.name;b.onclick=()=>{tr.operation=o;search.value=o.name;matches.replaceChildren();const box=tr.querySelector('.op-params');box.replaceChildren();if(!o.fields.length)box.textContent='无需额外参数';o.fields.forEach(f=>{const label=document.createElement('label');label.textContent=f.label;let options=f.options;const linked=f.label.startsWith('关联');if(linked)options=(state.orders||[]).filter(x=>x.kind==='medication').map(x=>x.text);const input=document.createElement(options.length?'select':'input');input.dataset.param=f.label;input.setAttribute('aria-label',f.label);if(options.length){const blank=document.createElement('option');blank.value='';blank.textContent='请选择';input.append(blank);options.forEach(v=>{const opt=document.createElement('option');opt.textContent=v;input.append(opt);});}if(linked&&!options.length)input.placeholder='请先开药，或填写需关联的药品医嘱';label.append(input);box.append(label);});};matches.append(b);});if(!matches.children.length)matches.textContent='未找到匹配操作';};
    tr.querySelector('[aria-label="删除操作"]').onclick=()=>{tr.remove();if(!$('#op-rows').children.length)add();};$('#op-rows').append(tr);
  }
  add();$('#op-add').onclick=add;
  const dl=document.createElement('datalist');dl.id='op-frequencies';['一次','持续','Qd','Bid','Qh','每15分钟','必要时'].forEach(v=>{const o=document.createElement('option');o.value=v;dl.append(o);});$('#op-rows').closest('.op-editor').append(dl);
  $('#op-confirm').onclick=async()=>{
    const button=$('#op-confirm');if(button.disabled)return;
    const rows=[];for(const tr of $('#op-rows').children){if(!tr.operation){$('#op-status').textContent='请搜索并确认每行操作名称。';return;}const value=n=>tr.querySelector(`[aria-label="${n}"]`).value.trim();rows.push({operation_id:tr.operation.id,params:Object.fromEntries([...tr.querySelectorAll('[data-param]')].map(x=>[x.dataset.param,x.value.trim()])),frequency:value('频次'),duration:value('时长'),type:value('医嘱类型'),remark:value('备注')});}
    button.disabled=true;$('#op-status').textContent='正在确认…';
    try{accept(await api('/api/operation-orders',{id:state.id,request_id:requestId,rows}));requestId=crypto.randomUUID();$('#op-rows').replaceChildren();add();$('#op-status').textContent='已开立，已写入诊疗小结并同步给上级医师。';}catch(e){$('#op-status').textContent=e.message;}finally{button.disabled=false;}
  };
}

function showCaseIntro() {
  if(!state||sessionStorage.getItem('clinical-intro-'+state.id))return;
  let intro=document.getElementById('cr-case-intro');
  if(!intro){intro=document.createElement('dialog');intro.id='cr-case-intro';intro.setAttribute('aria-labelledby','cr-intro-title');root.append(intro);intro.addEventListener('cancel',e=>e.preventDefault());}
  intro.innerHTML=`<div class="intro-picture">${sceneImage(0)}</div><div class="intro-shade"></div><div class="intro-top">临床思维训练室<span>骨科普通诊室接诊</span></div><section class="intro-bottom"><div><p class="intro-eyebrow">患者基本信息</p><h2 id="cr-intro-title">${esc(state.registration?.name||"")} <span>${esc(state.registration?.sex||"")} · ${esc(state.registration?.age||"")}</span></h2><p class="intro-detail">${esc(state.registration?.marital_status||"")} · ${esc(state.registration?.occupation||"")}</p><p class="intro-quote">“医生，我腰和左腿痛了好一阵，最近左脚抬起来也费劲。”</p><small>AI生成的教学情景</small></div><button id="cr-begin-reception" autofocus>开始接诊 <span aria-hidden="true">→</span></button></section>`;
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

