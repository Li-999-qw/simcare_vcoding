'use strict';
const portalParams=new URLSearchParams(location.search);
const portalStudent=portalParams.get('portalStudent');
const portalTask=portalParams.get('portalTask');
const portalMode=portalTask&&portalParams.get('portalMode')==='exam'?'exam':'practice';
const rehearsalStorageKey=portalStudent?'lumbar-rehearsal-id-en:'+portalStudent+':lumbar:'+(portalTask?'task:'+portalTask+':'+portalMode:'practice'):'lumbar-rehearsal-id-en';
if(portalStudent){const bar=document.createElement('div');bar.style.cssText='padding:10px 20px;background:#20343e;color:white;display:flex;gap:20px;align-items:center';const label=document.createElement('span');label.textContent=(portalParams.get('portalName')||portalStudent)+' · Case of low back and leg pain · '+(portalTask?'Teacher Assignment'+(portalMode==='exam'?' · Exam':' · Practice'):'Independent Practice');const back=document.createElement('a');back.href='http://127.0.0.1:8876/portal.html?return='+(portalTask?'tasks':'1');back.textContent='Return to learning workspace';back.style.color='#80d9c7';bar.append(label,back);document.body.prepend(bar);}
// Layout and scene flow: approved clinical-rounds.html from the Interface design task.
const root = document.getElementById('clinical-rounds');
const $ = s => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stageNames = ['Patient intake','Surgical Treatment','Ward round','Discharge date','Feedback'];
const sceneNames = ['General Orthopedic Consultation Room','Transport and handoff to the surgical team','Inpatient ward','Discharge date'];
const noteTitles = ['Initial outpatient visit record','Management and handoff record','Daily progress notes','Discharge summary'];
let state, viewStage = -1, renderedStage = -1, pollTimer, saveTimer, savePromise;
let notes = {}, dirty = new Set(), composers = {}, pending = false, localError = '';
let modalKind = '', currentReport = '', category = 'Imaging', selected = new Set();
let importPositive = true, feedbackRequestPending = false, feedbackRequestedFor = '';
let screenshotDrafts=[], uploadingImage=false, voiceJob=null, voiceTimer, voiceApplied='';
let notice = 'Text records are automatically saved locally。';

async function api(path, data) {
  const res = await fetch(path, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Request not completed. Please try again.。');
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
  catch(e){showError('Feedback is not yet complete. Click to regenerate.。'+e.message);}
  finally {feedbackRequestPending=false;}
}
function showError(message) { localError = message; renderStatus(); }
function renderStatus() {
  const message = localError || state?.error || '';
  $('#cr-error').classList.toggle('hidden', !message);
  $('#cr-error').innerHTML = message ? `${esc(message)} <button data-action="reconnect">Reconnect</button>` : '';
  $('#cr-status').textContent = state?.busy ? (state.stage===4?'The Supervising Physician is preparing this debrief…':'The role is responding; you can continue writing the medical record or ordering investigations…') : dirty.size ? 'Text temporarily stored; saving…' : notice;
  root.querySelectorAll('.record-state').forEach(el => el.textContent = state?.stage === 4 ? 'Submitted · Read-only' : dirty.size ? 'Pending save' : 'Saved to server');
}
function composer(role, placeholder) {
  return `<div class="busy-state" data-busy="${role}" aria-live="polite"></div><div class="composer"><label class="field" for="cr-input-${role}">${role==='senior'?'Report to Supervising Physician / Seek advice':role==='team'?'Diagnosis, treatment, and handoff instructions':'Conversation Content'}</label><textarea id="cr-input-${role}" data-composer="${role}" rows="2" maxlength="2000" placeholder="${placeholder}">${esc(composers[role])}</textarea>${role==='senior'?'<div id="cr-attachments"></div><input id="cr-image-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>':''}<div class="voice-status" data-voice-status="${role}" role="status"></div><div class="row"><button data-voice="${role}">🎙 Voice Input</button>${role==='senior'?'<button data-action="upload-image">＋ Upload screenshot</button>':''}<span class="muted">Text Input · Ctrl + Enter Send</span><button class="primary" data-send="${role}">${role==='team'?'Recording Instructions':'Send'}</button></div></div>`;
}
function toolbar() {
  return `<div class="tools" aria-label="Clinical actions"><button data-action="exam" data-mutate>Physical examination</button><button data-action="checks" data-mutate>＋ Request Examination</button><button data-action="orders" data-mutate>＋ ${viewStage===0?'Outpatient prescription':'Medication Orders'}</button><button data-action="operation-orders" data-mutate>＋ ${viewStage===0?'Outpatient treatment':'Procedure Orders'}</button><button data-action="reports" id="cr-report-count">Examination Report</button></div>`;
}
function recordBody() {
  if (viewStage === 0) return `<p class="muted">General orthopedic outpatient clinic · ${esc(state.time)} · Registration information is complete; not yet admitted</p>${noteField('general','General information / History provided by','Outpatient registration information',3)} ${noteField('chief','Chief complaint','Main symptoms and duration',2)} ${noteField('history','History of present illness','Onset, symptom progression, associated symptoms, and previous evaluation and treatment',4)} ${noteField('past_history','Past medical history','Relevant illnesses, surgeries, and similar prior episodes',2)} ${noteField('allergy_history','Allergy history','Verified allergy status',1)} ${noteField('exam','Physical examination','Positive findings and pertinent negative findings',2)} ${noteField('specialist_exam','Specialized orthopedic examination','Laterality, muscle strength, sensation, reflexes, and relevant tests',3)} ${noteField('tests','Ancillary Investigations','Results already obtained; reports can be edited before import',2)} ${noteField('diagnosis','Diagnosis','Diagnoses and conditions to rule out',2)} ${noteField('initial_plan','Treatment and management recommendations','Recommendations on medications, tests, management, and communication',3)} ${noteField('plan','Follow-up visit / Referral and hospitalization arrangements','Follow-up timing and precautions; specify arrangements if referral or hospitalization is needed.',3)} ${noteField('author','Attending clinician (trainee）','Enter Name',1)} <details><summary>Additional history and diagnostic analysis (complete as needed）</summary>${noteField('personal_history','Personal history','Complete based on history-taking and analysis',2)}${noteField('marriage_history','Marital and reproductive history','Complete based on history-taking and analysis',2)}${noteField('family_history','Family history','Complete based on history-taking and analysis',2)}${noteField('case_features','Case features','Complete based on history-taking and analysis',2)}${noteField('first_diagnosis','Original provisional diagnosis record','Complete based on history-taking and analysis',2)}${noteField('reason','Diagnostic Basis','Complete based on history-taking and analysis',2)}${noteField('differential','Differential diagnosis','Complete based on history-taking and analysis',2)}</details>`;
  if (viewStage === 1) return `<div class="notice">Treating Physician · Responsible for decisions, coordination, and handoffs</div><h3>Management Orders</h3><div id="cr-orders"></div>${noteField('plan','Management Plan / Handover key points','Document planned management and issues requiring handover',4)}<button class="secondary-action" data-action="handoff">${state.stage > 1 ? 'View surgical team report' : 'Receive the surgical team’s report and proceed to the ward →'}</button><p class="tool-note">Ward handoffs use preset case milestones; recorded instructions do not indicate execution.。</p>`;
  if (viewStage === 2) return `${noteField('daily','Changes in clinical condition / Assess / Today’s plan','Document Patient communication, reassessment, and follow-up plans',8)}${noteField('tests','Ancillary Investigations','View and import report')}`;
  return noteField('discharge','Condition on admission / Clinical course / Condition at discharge','Prepare the discharge summary based on this care episode',6) + noteField('discharge_diagnosis','Discharge diagnosis','Enter the complete diagnosis') + noteField('discharge_advice','Discharge medications / Medical orders / Follow-up','Enter medications, lifestyle advice, and follow-up arrangements',4);
}
function sceneImage(stage) {
  return `<span class="scene-frame scene-stage-${stage}"><img src="/assets/patient-scenes-v1.png" width="1536" height="1024" loading="eager" alt="Simulated patient ${esc(state?.registration?.name||"patient")} in ${sceneNames[stage]} scene"></span>`;
}
function scenePanel() {
  return `<button class="scene-picture" data-action="scene" aria-label="Enlarge patient scene">${sceneImage(viewStage)}<span class="scene-caption"><span>${sceneNames[viewStage]} · ${esc(state?.registration?.name||"患者")}，${esc(state?.registration?.age||"")}</span><span class="scene-credit">AI Scenario Illustration</span></span></button>`;
}
function cathScene(active=false) {
  return `<figure class="cath-scene">${sceneImage(1)}${active?'<div class="procedure-overlay" role="status" aria-label="Spinal surgery in progress">Spinal surgery in progress<span class="procedure-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></div>':''}<figcaption>Spine Operating Room · AI Scenario Illustration</figcaption></figure>`;
}
function interventionLayout() {
  if(reviewing())return `<section class="panel pad intervention"><h2>Surgical Treatment Record</h2><p>${state.intervention?.status==='confirmed'?'Surgical treatment selected and team report confirmed。':'Keep the existing handoff record this time。'}</p><button data-action="handoff">View surgical team report</button>${state.orders.map(o=>`<p>${esc(o.text)}</p>`).join('')}${viewNotes().plan?`<p>${esc(viewNotes().plan)}</p>`:''}</section>`;
  const started=state.intervention?.status==='started', report=state.intervention_report;
  return `<section class="panel pad intervention"><h2>Surgical Treatment</h2>${report?`<article class="team-report"><span class="tag">Surgical team report</span><h3>${esc(report.name)}</h3><p>${esc(report.text)}</p><button class="primary" data-action="confirm-intervention">Confirm the report and enter the ward →</button><p class="muted">Once confirmed, it will be included under test reports; you must still extract, confirm, and enter content into the medical record.。</p></article>`:started?`${cathScene(true)}<p class="muted">Scenario Illustration · Preset case course</p>`:`${scenePanel()}${noteField('plan','Preoperative decision-making and risk communication','Document the responsible spinal level and side, surgical indications, alternatives, and risks to be discussed.',4)}<p>The inpatient surgical teaching stage follows; outpatient prescriptions do not count as perioperative medications administered.。</p><button class="primary" data-action="start-intervention">Select Surgical Treatment →</button>`}</section>`;
}
async function startIntervention() {
  await operation(async()=>{accept(await api('/api/intervention/start',{id:state.id}),true);schedulePoll();});
}
async function confirmIntervention() {
  await operation(async()=>{const next=await api('/api/intervention/confirm',{id:state.id});viewStage=next.stage;closeModal();accept(next,true);notice='The surgical team’s report has been added to the investigation reports; the Patient has entered the ward。';});
}
function mainLayout() {
  if (viewStage === 4) return feedbackLayout();
  if (viewStage === 1) return interventionLayout();
  const team = viewStage === 1, role = team ? 'team' : 'patient';
  const questions = viewStage === 0 ? ['Where do you feel unwell?？','How long has the pain lasted?？','Have you had anything similar before?？'] : ['Does your left leg still hurt today?？','How are your activity and sleep?？'];
  return `<section class="panel conversation" aria-label="${team?'Team Handoff':'Patient History Taking'}">${scenePanel()}<div class="pad"><h2 class="heading">${team?'Team Conversation · Management and handover':'Patient Communication'}<span class="muted" data-sim-time>${reviewing()?'Review Records':state.time}</span></h2><div class="chat chat-log" id="cr-patient-log" role="log" aria-label="${team?'Handover notes':'Patient Conversation Record'}" aria-live="polite"></div>${editable()?`<div class="row quick-questions">${team?'<button data-draft="Contact the surgical team and prepare the handover" data-target="team">Contact the Surgical Team</button><button data-draft="Arrange monitoring and reassessment" data-target="team">Arrange monitoring and reassessment</button>':questions.map(text=>`<button data-draft="${text}" data-target="patient">${text}</button>`).join('')}</div>${composer(role,team?'Enter diagnostic and treatment orders, then verify the recorded orders on the right':'Enter what you want to ask the Patient')}`:'<p class="muted">Dialogue from completed scenes is retained here. Return to the current scene to continue.。</p>'}</div></section><section class="panel pad record-panel" aria-label="Clinical documentation"><h2 class="heading">${noteTitles[viewStage]}<span class="record-state"></span></h2>${toolbar()}${recordBody()}<section id="cr-record-archive"></section><section id="cr-treatment-summary"></section><div class="record-bottom"><span class="muted">${editable()?'Automatically saved after entry':'Completed scenarios · Review Records'}</span>${editable()?'<button data-action="save" data-mutate>Save clinical record</button>':''}</div></section>`;
}
function recordReviewHtml() {
  return `<h3>Four-Dimensional Record Cross-Check</h3><p class="muted">The following checks the content actually retained. A record does not establish that the medical judgment was correct, and no record does not necessarily mean an action was not performed.。</p><div class="review-grid">${(state.record_review||[]).map(card=>`<article class="review-card"><h3>${esc(card.title)}</h3><p>${esc(card.summary)}</p>${card.fields.map(field=>`<details><summary><span class="${field.present?'recorded':'missing'}">${field.present?'Existing Records':'No Records Found'}</span> · ${esc(field.label)}</summary><p>${esc(field.evidence||'This text was not saved for this session and cannot be verified。')}</p></details>`).join('')}</article>`).join('')}</div>`;
}
function feedbackLayout() {
  if (isExam()) return `<section class="panel feedback"><h2 class="heading">Exam Submission Receipt <span class="tag">Submitted</span></h2><div class="notice">Answers are locked. You may review your records below; medical feedback and model answers are pending release by the Teacher.。</div>${recordReviewHtml()}<p class="muted">The Teacher publishing backend is not yet connected. For immediate teaching feedback, create a Self-directed Practice exercise.。</p><button data-stage="0">Review Encounter Record</button> <button data-action="export">Export This Session’s Record</button></section>`;
  const stats = [['Patient Communication',state.messages.filter(m=>m.speaker==='student'&&m.role==='patient').length+' Round'],['Investigations and materials viewed',state.reports.length+' Item'],['Medical Record Import',state.events.filter(e=>e.action==='Import Medical Records').length+' times'],['Surgical Treatment',state.intervention?.status==='confirmed'?'Selected and confirmed the report':'Unconfirmed'],['Consult the Supervising Physician',state.hint_count+' prompts']];
  return `<section class="panel feedback"><h2 class="heading">Feedback on this training session <span class="tag">Submitted</span></h2><p class="muted">Feedback is based on actual history taking, reviewed reports, and clinical notes from each stage. Unrecorded actions are not treated as completed.。</p><h3>Supervising Physician · Four-Dimensional Feedback</h3><div class="chat chat-log" id="cr-feedback-log" role="log" aria-label="Debrief discussion" aria-live="polite"></div><button data-action="feedback">Generate / Retry Full Feedback</button><div class="feedback-composer">${composer('senior','You can ask follow-up questions about whether your history-taking, testing, diagnosis, and management were appropriate.')}</div>${recordReviewHtml()}<details><summary>Interaction statistics and action timeline</summary>${stats.map(([name,value])=>`<div class="record">${name}<span class="summary-value">${value}</span></div>`).join('')}<div class="history-list">${state.events.map(e=>`<div class="record">${stageNames[e.stage]} · ${esc(e.action)} · ${esc(e.name)}</div>`).join('')}</div></details><div class="row"><button data-stage="0">Review Encounter Record</button><button data-stage="1">Review Surgical Treatment</button><button data-action="reports">Examination Report</button><button data-action="export">Export This Session’s Record</button></div><p class="muted">Formative feedback · No medical score generated for now</p></section>`;
}
function renderTreatmentSummary() {
  const el=$('#cr-treatment-summary');if(!el)return;
  const record=viewRecord();
  const summary=record ? {operations:(record.orders||[]).filter(o=>o.kind==='operation').map(o=>({time:o.clinical_time,text:o.text})),medications:(record.orders||[]).filter(o=>o.kind==='medication').map(o=>({time:o.clinical_time,text:o.text})),checks:(record.events||[]).filter(e=>e.action==='Request Examination').map(e=>({time:e.clinical_time,text:e.name}))} : state.treatment_summary;
  const list=rows=>{
    const items=(rows||[]).slice().sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    return items.length?`<ul class="treatment-items">${items.map(r=>`<li><time>${esc(r.time||'Time not recorded')}</time> · ${esc(r.text)}</li>`).join('')}</ul>`:'<p class="muted">None yet</p>';
  };
  el.innerHTML=`<h3>Diagnosis and Treatment Summary</h3><h4>Medication Orders</h4>${list(summary?.medications)}<h4>Procedure Orders</h4>${list(summary?.operations)}<h4>Scheduled Investigations</h4>${list(summary?.checks)}`;
}
function render(force = false) {
  if (!state) return renderStatus();
  $('#cr-mode').textContent = isExam() ? 'Exam Workflow Test' : 'Independent Practice';
  $('#cr-flow-toggle').textContent=`Workflow · ${stageNames[viewStage]} ${viewStage+1}/5`;
  root.querySelector('nav').innerHTML = stageNames.map((name,i)=>`<button data-stage="${i}" ${i>state.stage?'disabled':''} class="${i===viewStage?'active':''}" aria-current="${i===viewStage?'step':'false'}">${i+1}. ${name}</button>`).join('');
  $('#cr-review').classList.toggle('hidden',!reviewing());
  $('#cr-review').innerHTML = reviewing()?`<span>Reviewing${stageNames[viewStage]}Record${viewRecord()?'':'（Legacy simulations retain only existing medical records）'}</span><button data-stage="${state.stage}">Back${stageNames[state.stage]} →</button>`:'';
  if (force || renderedStage !== viewStage) {
    root.querySelector('main').innerHTML = mainLayout();
    renderedStage = viewStage;
  }
  root.querySelectorAll('[data-note]').forEach(el=>{if (document.activeElement!==el && !dirty.has(el.dataset.note)) el.value=viewNotes()[el.dataset.note]||'';});
  renderRecordArchive();
  renderTreatmentSummary();
  const patientLog = $('#cr-patient-log');
  if (patientLog) {
    if (viewStage===1) setLog(patientLog, state.orders.length ? state.orders.map(o=>`<div class="message student"><span class="speaker">You · Management Orders</span><p>${esc(o.text)}</p><span class="muted">${esc(o.status)}</span></div>`).join('') : '<p class="muted">Record the clinical care and handoff instructions to be issued; the instructions and their status will remain on the right.。</p>');
    else {
      let messages = state.messages.filter(m=>m.stage===viewStage&&(m.role==='patient'||m.speaker==='system'));
      setLog(patientLog, messages.map(messageHtml).join('')+streamHtml('patient')||'<p class="muted">No dialogue in this scenario yet。</p>');
    }
  }
  if ($('#cr-orders')) $('#cr-orders').innerHTML = state.orders.length ? state.orders.map(o=>`<div class="order">${esc(o.text)}<br><span class="tag">${esc(o.status)}</span></div>`).join('') : '<p class="empty">No orders entered yet; enter them on the left。</p>';
  const count = viewRequests().filter(id=>id!=='exam').length;
  if ($('#cr-report-count')) {
    const unread=viewRequests().filter(id=>id!=='exam'&&!viewReports().includes(id)&&state.report_status?.[id]?.ready).length;
    $('#cr-report-count').innerHTML=`Examination Report (${count})${unread?'<span class="report-dot" aria-hidden="true"></span>':''}`;
    $('#cr-report-count').setAttribute('aria-label',`Examination reports, total:${count}Item${unread?'，'+unread+'new reports not yet viewed':''}`);
  }
  root.querySelectorAll('[data-sim-time]').forEach(el=>el.textContent=reviewing()?'Review Records':state.time);
  if ($('#cr-ward-reports')) $('#cr-ward-reports').innerHTML = reportGroupsHtml(true);
  updateSeniorLog();
  renderControls();
  renderStatus();
  renderAttachments();
}
function messageHtml(m) {
  const speaker = m.speaker==='student' ? 'You' : m.role==='patient' ? 'Patient' : m.role==='senior' ? 'Supervising Physician' : 'Scenario Records';
  return `<div class="message ${m.speaker==='student'?'student':''}"><span class="speaker">${speaker}${m.role==='senior'?' · '+stageNames[m.stage]:''}${m.hint?' · Teaching Tips':''}</span><p>${esc(m.text)}</p>${(m.attachments||[]).map(id=>`<img class="chat-attachment" src="/api/attachment?id=${encodeURIComponent(state.id)}&attachment=${encodeURIComponent(id)}" alt="Image shared with the supervising physician">`).join('')}</div>`;
}
function streamHtml(role) {
  const draft=state.streaming;
  if(!state.busy||!draft?.text||draft.role!==role||draft.stage!==viewStage)return '';
  return `<div class="message streaming"><span class="speaker">${role==='patient'?'Patient':'Supervising Physician'} · Replying</span><p>${esc(draft.text)}<span class="stream-cursor" aria-hidden="true">▍</span></p></div>`;
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
    setLog(el,messages.map(messageHtml).join('')+streamHtml('senior')||`<p class="muted">${state.stage===4?'The full assessment will be generated automatically; if the connection fails, click “Generate”. / Retry Full Feedback”。':'Please report your current assessment, supporting evidence, or the specific issue for which you need help.。'}</p>`);
  }
  if ($('#cr-senior-error')) $('#cr-senior-error').textContent=state.error?('Response incomplete：'+state.error+' Please resend the question。'):'';
  if ($('#cr-hints')) $('#cr-hints').textContent=`Recorded this session ${state.hint_count} Teaching prompts`;
}
function renderControls() {
  root.querySelectorAll('[data-mutate]').forEach(el=>el.disabled=!editable()||pending);
  root.querySelectorAll('[data-voice]').forEach(el=>{const active=voiceJob?.role===el.dataset.voice&&['starting','listening','transcribing'].includes(voiceJob?.status);el.textContent=active?'■ Cancel Recording':'🎙 Voice Input';el.disabled=!active&&(pending||uploadingImage||['starting','listening','transcribing'].includes(voiceJob?.status));});
  root.querySelectorAll('[data-voice-status]').forEach(el=>el.textContent=voiceJob&&voiceJob.role===el.dataset.voiceStatus?(voiceJob.status==='starting'?'Starting the local microphone…':voiceJob.status==='listening'?'Listening. Please speak; speech will be transcribed after a pause。':voiceJob.status==='transcribing'?'Transcribing locally…':voiceJob.status==='done'?'Transcribed. Check medical terminology before sending。':voiceJob.error||''):'');
  root.querySelectorAll('[data-send]').forEach(el=>el.disabled=blocked()||(!editable()&&!(viewStage===4&&!isExam()&&el.dataset.send==='senior')));
  root.querySelectorAll('[data-busy]').forEach(el=>el.textContent=state.busy?'Generating role response…':'');
  root.querySelectorAll('[data-action="teacher"]').forEach(el=>el.disabled=isExam()||reviewing());
  $('#cr-teacher-top').classList.toggle('hidden',isExam());
  root.querySelectorAll('[data-action="new"],[data-feedback]').forEach(el=>el.disabled=blocked());
  root.querySelectorAll('[data-action="feedback"]').forEach(el=>el.disabled=blocked()||feedbackRequestPending||state.feedback?.status==='ready');
  root.querySelectorAll('[data-action="handoff"]').forEach(el=>el.disabled=blocked());
  $('#cr-next').textContent = reviewing()?`Back${stageNames[state.stage]} →`:viewStage===4?'Submitted this session':viewStage===3?'Submit This Training Session':`Enter ${stageNames[viewStage+1]} →`;
  if(!reviewing()&&viewStage===1)$('#cr-next').textContent=state.intervention_report?'Confirm the report and enter the ward →':state.intervention?.status==='started'?'Awaiting surgical team report…':'Select Surgical Treatment →';
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
  } catch(e) {showError('Connection interrupted; your current input remains on the page。'+e.message);}
}
async function send(role, override) {
  const text=(override??composers[role]??'').trim();
  if(!text){if(role==='senior'&&screenshotDrafts.length)showError('Enter the question you would like the Supervising Physician to answer。');return;}
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
  if(state.busy){notice='Wait for the current role to reply before switching scenarios。';return;}
  await operation(async()=>{closeModal();closeFlow();viewStage=stage;render(true);});
}
async function advance() {
  if(reviewing())return navigate(state.stage);
  if(state.stage===1){if(state.intervention_report)return confirmIntervention();if(state.intervention?.status==='started')return;return startIntervention();}
  if(state.stage===3){
    await operation(async()=>{
      if(!notes.discharge?.trim())throw new Error('Complete the discharge note on the right before submitting this training session。');
      modal('Submit This Training Session',`<p>After submission, the medical record and care records will be locked but remain available for review。</p><p>${isExam()?'Exam scores and explanations await release by the Teacher。':'You may then ask the Supervising Physician to debrief this history-taking, testing, diagnosis, and management.。'}</p><div class="modal-actions"><button data-action="close">Continue Writing</button><button class="primary" data-action="submit">Confirm Submission</button></div>`,'submit');
    });
    return;
  }
  await performAdvance();
}
async function performAdvance() {
  await operation(async()=>{
    const next=await api('/api/advance',{id:state.id});viewStage=next.stage;closeModal();accept(next,true);
    if(state.stage===2)openKnownReport('handoff');
    notice=state.stage===4?'This record has been submitted。':'Entered'+stageNames[state.stage]+'。';
  });
}

function modal(title, body, kind='') {
  modalKind=kind;$('#cr-dialog-title').textContent=title;$('#cr-dialog-body').innerHTML=body;
  if(!$('#cr-dialog').open)$('#cr-dialog').showModal();
  renderControls();
}
function closeModal() {if(voiceJob?.role==='senior'&&['starting','listening','transcribing'].includes(voiceJob.status))toggleVoice('senior');$('#cr-dialog').close();modalKind='';}
function openMedicineOrders() {
  modal(state.stage===0?'Outpatient prescription':'Medication Orders', '<div class="cr-rx-host"></div>', 'orders');
  const editor = document.querySelector('.cr-rx-host').attachShadow({mode:'open'});
  editor.innerHTML = '<link rel="stylesheet" href="/style.css?v=rx-native-3">' + "<main><header><h1>Medication Orders</h1><small>Medication Orders · Confirm to add to the care summary</small></header><div class=\"table-wrap\"><table><thead><tr><th>Medicinal products</th><th>Dose</th><th>Directions for use</th><th>Route of Administration</th><th>Order type</th><th>Notes</th></tr></thead><tbody id=\"rows\"></tbody></table></div><footer><button id=\"add\">＋ Add Row</button><button id=\"save\" class=\"primary\">Confirm</button><span id=\"status\">Selecting a medication fills in a standard regimen, which can be edited; individualized doses may be left for later.</span></footer></main>";
window.MI_DRUG_CATALOG={"items": [{"id": "ldh-drug-1", "name": "Celecoxib capsules", "pinyin_initials": "slxbjn", "note": "Previously used briefly in the original case; verify indications and contraindications, and do not automatically prescribe again.", "case_medication": true, "autofill": {"dose": "200", "unit": "mg", "frequency": "Qd · Once daily", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "200", "unit": "mg", "frequency": "Qd · Once daily", "route": "Oral", "details": "Previously used briefly in the original case; verify indications and contraindications, and do not automatically prescribe again."}, "dose_review_status": "Teaching plan for the original case, pending clinical review"}, {"id": "ldh-drug-2", "name": "Acetaminophen tablets", "pinyin_initials": "dyxajfp", "note": "Original case discharge regimen: at least 6 hours between doses, maximum 2 g/day for no more than 3 days; avoid duplicate ingredients.", "case_medication": true, "autofill": {"dose": "500", "unit": "mg", "frequency": "PRN · As needed", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "500", "unit": "mg", "frequency": "PRN · As needed", "route": "Oral", "details": "Original case discharge regimen: at least 6 hours between doses, maximum 2 g/day for no more than 3 days; avoid duplicate ingredients."}, "dose_review_status": "Teaching plan for the original case, pending clinical review"}, {"id": "ldh-drug-3", "name": "Cefazolin for injection", "pinyin_initials": "zsy tbzl", "note": "In the original case, prophylaxis was given 30 minutes before incision and stopped within 24 hours after surgery; this is not routine medication for general outpatients.", "case_medication": true, "autofill": {"dose": "2", "unit": "g", "frequency": "Once", "route": "Intravenous drip infusion", "remark": ""}, "common_regimen": {"dose": "2", "unit": "g", "frequency": "Once", "route": "Intravenous drip infusion", "details": "In the original case, prophylaxis was given 30 minutes before incision and stopped within 24 hours after surgery; this is not routine medication for general outpatients."}, "dose_review_status": "Teaching plan for the original case, pending clinical review"}, {"id": "ldh-drug-4", "name": "Mecobalamin tablets", "pinyin_initials": "jg ap jga mkb", "category": "Neurotrophic agents", "note": "Reference dosing for adult peripheral neuropathy in foreign-language prescribing information: 500 μg per dose, three times daily; this does not establish efficacy for radicular pain in this case. Verify the specific locally approved product and strength.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "500", "unit": "μg", "frequency": "Tid · Three times daily", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "500", "unit": "μg", "frequency": "Tid · Three times daily", "route": "Oral", "details": "Reference dosing for adult peripheral neuropathy in foreign-language prescribing information: 500 μg per dose, three times daily; this does not establish efficacy for radicular pain in this case. Verify the specific locally approved product and strength."}, "dose_review_status": "Foreign-language prescribing information used as a reference; pending verification against domestic products and strengths", "sources": ["https://pins.japic.or.jp/pdf/newPINS/00053082.pdf"]}, {"id": "ldh-drug-5", "name": "Meloxicam tablets", "pinyin_initials": "ml xk mlxk", "category": "NSAIDs", "note": "Reference adult starting regimen for arthritis from the prescribing information, not a specific recommendation for lumbar spine disease; do not combine with other NSAIDs.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "7.5", "unit": "mg", "frequency": "Qd · Once daily", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "7.5", "unit": "mg", "frequency": "Qd · Once daily", "route": "Oral", "details": "Reference adult starting regimen for arthritis from the prescribing information, not a specific recommendation for lumbar spine disease; do not combine with other NSAIDs."}, "dose_review_status": "Foreign-language prescribing information used as a reference; pending verification against domestic products and strengths", "sources": ["https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=3b1938e5-7a9e-b214-e063-6394a90a1270"]}, {"id": "ldh-drug-6", "name": "Ibuprofen sustained-release capsules", "pinyin_initials": "blfhsjn", "category": "NSAIDs", "note": "Specific extended-release formulation, strength, and dose pending verification.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Specific extended-release formulation, strength, and dose pending verification."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-7", "name": "Diclofenac sodium sustained-release tablets", "pinyin_initials": "slfsnhsp", "category": "NSAIDs", "note": "Specific extended-release formulation, strength, and dose pending verification.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Specific extended-release formulation, strength, and dose pending verification."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-8", "name": "Loxoprofen sodium tablets", "pinyin_initials": "lslfnp", "category": "NSAIDs", "note": "Specific product, strength, and dosage pending verification.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Specific product, strength, and dosage pending verification."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-9", "name": "Etoricoxib tablets", "pinyin_initials": "ytkxp", "category": "NSAIDs", "note": "Cardiovascular risk assessment is required; specific indications, formulations, strengths, and doses remain to be verified.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Cardiovascular risk assessment is required; specific indications, formulations, strengths, and doses remain to be verified."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-10", "name": "Naproxen tablets", "pinyin_initials": "npsp", "category": "NSAIDs", "note": "Specific product, strength, and dosage pending verification.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Specific product, strength, and dosage pending verification."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-11", "name": "Diclofenac diethylamine emulsion gel", "pinyin_initials": "slfseyarjj", "category": "Topical medication", "note": "Topical dose and application area depend on the specific product and strength; topical use should not be equated with effective treatment of radicular pain.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "g", "frequency": "Please select", "route": "Topical", "remark": ""}, "common_regimen": {"dose": "", "unit": "g", "frequency": "Pending verification", "route": "Topical", "details": "Topical dose and application area depend on the specific product and strength; topical use should not be equated with effective treatment of radicular pain."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-12", "name": "Eperisone hydrochloride tablets", "pinyin_initials": "ysyplsp", "category": "Muscle relaxants", "note": "Confirm the indication and check domestic prescribing information; not automatically recommended.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Confirm the indication and check domestic prescribing information; not automatically recommended."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-13", "name": "Tizanidine hydrochloride tablets", "pinyin_initials": "ystzndp", "category": "Muscle relaxants", "note": "Verify indications, hypotension and sedation risks, and interactions.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Verify indications, hypotension and sedation risks, and interactions."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-14", "name": "Pregabalin capsules", "pinyin_initials": "prbljn", "category": "Medications for neuropathic pain", "note": "NICE NG59 does not recommend routine use for sciatica; included for discussion of the appropriateness of this option, not as a default recommendation.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "NICE NG59 does not recommend routine use for sciatica; included for discussion of the appropriateness of this option, not as a default recommendation."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": ["https://www.nice.org.uk/guidance/ng59/chapter/Recommendations"]}, {"id": "ldh-drug-15", "name": "Gabapentin capsules", "pinyin_initials": "jbpdjn", "category": "Medications for neuropathic pain", "note": "NICE NG59 does not recommend routine use for sciatica; inclusion does not imply suitability.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "NICE NG59 does not recommend routine use for sciatica; inclusion does not imply suitability."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": ["https://www.nice.org.uk/guidance/ng59/chapter/Recommendations"]}, {"id": "ldh-drug-16", "name": "Duloxetine hydrochloride enteric-coated capsules", "pinyin_initials": "ysdlxtcrjn", "category": "Other pain-related medications", "note": "Other neuropathic pain indications must not be automatically applied to this case; the specific regimen remains pending assessment.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Other neuropathic pain indications must not be automatically applied to this case; the specific regimen remains pending assessment."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": ["https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=ae381859-be09-43e1-8b56-d0d8f4b49020"]}, {"id": "ldh-drug-17", "name": "Omeprazole enteric-coated capsules", "pinyin_initials": "amlzcrjn", "category": "Acid-suppressing medications", "note": "Use only when indicated; specific formulations, strengths, and doses remain to be verified.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Use only when indicated; specific formulations, strengths, and doses remain to be verified."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-18", "name": "Pantoprazole sodium enteric-coated tablets", "pinyin_initials": "ptlzncrp", "category": "Acid-suppressing medications", "note": "Use only when indicated; do not duplicate therapy with drugs of the same class.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Use only when indicated; do not duplicate therapy with drugs of the same class."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}, {"id": "ldh-drug-19", "name": "Esomeprazole magnesium enteric-coated tablets", "pinyin_initials": "asamlzmcrp", "category": "Acid-suppressing medications", "note": "Use only when indicated; do not duplicate therapy with drugs of the same class.", "case_medication": false, "catalog_role": "search_only", "autofill": {"dose": "", "unit": "mg", "frequency": "Please select", "route": "Oral", "remark": ""}, "common_regimen": {"dose": "", "unit": "mg", "frequency": "Pending verification", "route": "Oral", "details": "Use only when indicated; do not duplicate therapy with drugs of the same class."}, "dose_review_status": "Dose not prefilled; pending verification of the specific formulation and strength", "sources": []}], "case_id": "SIM-LDH-20260903", "version": "1.0", "updated": "2026-09-14", "scope": "Teaching drug reference catalog, not a recommended combination regimen for this case. Doses and frequencies are left blank where local formulations and strengths have not been verified."};
const drugs=window.MI_DRUG_CATALOG.items.map(x=>[x.name,x.pinyin_initials,x.note]);
const defaults=Object.fromEntries(window.MI_DRUG_CATALOG.items.map(x=>[x.name,[x.autofill.dose,x.autofill.unit,x.autofill.frequency,x.autofill.route,x.autofill.remark]]));
const catalogOptions=(key,base)=>[...new Set([...base,...window.MI_DRUG_CATALOG.items.map(x=>x.autofill[key]).filter(Boolean)])];
const $=s=>editor.querySelector(s), storeKey='clinical-rx-simple-v2-en';
function option(value){const o=document.createElement('option');o.textContent=value;return o;}
function select(values,value,label){const el=document.createElement('select');el.setAttribute('aria-label',label);values.forEach(v=>el.append(option(v)));el.value=value||values[0];return el;}
function addRow(data={}){
 const tr=document.createElement('tr');const cells=Array.from({length:6},()=>{const td=document.createElement('td');tr.append(td);return td;});
 const name=document.createElement('input');name.placeholder='Enter Medication Name / Pinyin Abbreviation';name.setAttribute('aria-label','Medication Search');name.value=data.name||'';tr.dataset.drug=data.name||'';
 cells[0].className='drug-cell';const results=document.createElement('div');results.className='matches';const confirm=document.createElement('div');confirm.className='confirmed';
 function picked(){confirm.replaceChildren();if(tr.dataset.drug){const label=document.createElement('span');label.textContent='✓ Selected';confirm.append(label);}const remove=document.createElement('button');remove.textContent='Delete this row';remove.className='remove';remove.onclick=()=>{tr.remove();if(!$('#rows').children.length)addRow();};confirm.append(remove);}
 name.oninput=()=>{tr.dataset.drug='';picked();results.replaceChildren();const q=name.value.trim().toLowerCase();if(!q)return;const found=drugs.filter(d=>d[0].includes(q)||d[1].replaceAll(' ','').includes(q));for(const d of found){const b=document.createElement('button');b.type='button';b.textContent=d[0];b.onclick=()=>{name.value=d[0];tr.dataset.drug=d[0];results.replaceChildren();picked();const preset=defaults[d[0]];if(preset){[dose.value,unit.value,use.value,route.value]=preset;remark.title=remark.value;unit.title=unit.value;dose.title=unit.value.includes('/')?'This field is for the dose per kilogram or administration rate':'Single dose';$('#status').textContent=preset[0]?'Dose, administration instructions, and route have been filled in and can be edited; enter the notes yourself.。':'Administration instructions and route have been filled in; enter the dose based on the specific circumstances.。';}dose.focus();};results.append(b);}if(!found.length){const hint=document.createElement('small');hint.textContent='No matching medication found；AI Supplementary medication lookup pending integration。';hint.style.padding='10px';results.append(hint);}};
 name.onkeydown=e=>{if(e.key==='Escape')results.replaceChildren();if(e.key==='Enter'&&results.querySelector('button')){e.preventDefault();results.querySelector('button').click();}};
 cells[0].append(name,results,confirm);picked();
 const dose=document.createElement('input');dose.type='number';dose.min='0';dose.step='any';dose.placeholder='Single occurrence';dose.value=data.dose||'';dose.setAttribute('aria-label','Single dose');dose.dataset.key='dose';
 const unit=select(catalogOptions('unit',['mg','μg','g','U','mL','Piece','mg/kg/h','mg/min']),data.unit,'Dose unit');unit.dataset.key='unit';const doseWrap=document.createElement('div');doseWrap.className='dose';doseWrap.append(dose,unit);cells[1].append(doseWrap);
 const use=select(catalogOptions('frequency',['Please select','Qd · Once daily','Bid · Twice daily','Tid · Three times daily','Q12h · each 12 Hours','Qn · Once nightly','ST · Once immediately','Once','PRN · As needed']),data.use,'Directions for use');use.dataset.key='use';cells[2].append(use);
 const route=select(catalogOptions('route',['Please select','Oral','Chew and swallow','Sublingual administration','Intravenous injection','Intravenous drip infusion','Intravenous infusion via pump','Subcutaneous injection','Local infiltration']),data.route,'Route of Administration');route.dataset.key='route';cells[3].append(route);
 const type=select(state.stage===0?['Outpatient prescription']:['One-time orders','Long-term orders','Long-term medication present','One-time medication available'],data.type,'Prescription Type');type.dataset.key='type';cells[4].append(type);if(state.stage===0){type.hidden=true;for(const [key,label] of [['days','Treatment duration'],['quantity','Total amount']]){const input=document.createElement('input');input.dataset.key=key;input.setAttribute('aria-label',label);input.placeholder=label+(key==='days'?'（If 3 day）':'（If 6 Piece）');input.value=data[key]||'';cells[4].append(input);}}
 const remark=document.createElement('input');remark.placeholder='Optional Notes';remark.setAttribute('aria-label','Notes');remark.dataset.key='remark';remark.value=data.remark||'';remark.title=remark.value;remark.oninput=()=>{remark.title=remark.value;};cells[5].append(remark);
 $('#rows').append(tr);
}
if(state.stage===0){editor.querySelector('h1').textContent='Outpatient prescription';editor.querySelector('header small').textContent='Add to the outpatient care summary after confirmation';editor.querySelectorAll('th')[4].textContent='Treatment duration / Total amount';}
editor.addEventListener('click',e=>{editor.querySelectorAll('.drug-cell').forEach(c=>{if(!c.contains(e.target))c.querySelector('.matches').replaceChildren();});});
$('#add').onclick=()=>{addRow();$('#rows').lastElementChild.querySelector('input').focus();};
let submissionId=crypto.randomUUID();
$('#save').onclick=async()=>{if($('#save').disabled)return;const rows=[];for(const tr of $('#rows').children){const r={name:tr.dataset.drug};tr.querySelectorAll('[data-key]').forEach(el=>r[el.dataset.key]=el.value);const typed=tr.querySelector('input').value.trim();if(!typed&&!r.dose&&r.use==='Please select'&&r.route==='Please select'&&!r.remark)continue;if(!r.name){$('#status').textContent='Click the matching medication to confirm its name first。';tr.querySelector('input').focus();return;}if(!(Number(r.dose)>0)||r.use==='Please select'||r.route==='Please select'){$('#status').textContent='Please fill in the missing information '+r.name+' dosage, instructions for use, and route of administration。';return;}if(state.stage===0&&(!r.days?.trim()||!r.quantity?.trim())){$('#status').textContent='Please enter the treatment duration and total quantity (including units）。';return;}rows.push(r);}if(!rows.length){$('#status').textContent='Please add at least one medication order。';return;}
$('#save').disabled=true;
try{const next=await api('/api/medication-orders',{id:state.id,request_id:submissionId,rows});accept(next);$('#rows').replaceChildren();addRow();submissionId=crypto.randomUUID();$('#status').textContent='Orders confirmed, added to the clinical summary, and synced to the Supervising Physician’s assessment materials.。';}
catch(e){$('#status').textContent='Confirmation Failed：'+e.message;}
finally{$('#save').disabled=false;}};
addRow();

}
function closeFlow() {$('#cr-flow-panel').classList.add('hidden');$('#cr-flow-toggle').setAttribute('aria-expanded','false');}
function reportName(id) {return state.catalog.find(r=>r.id===id)?.name||id;}
function group(r) {return r.category==='Electrocardiography'?'ECG and other tests':r.category==='Reassessment'?'Ward Reassessment':r.category;}
function sameCheck(id) {
  const item=state.catalog.find(r=>r.id===id);
  return state.catalog.filter(r=>r.orderable&&(r.order_name||r.name)===(item?.order_name||item?.name));
}
function reportGroupsHtml(compact=false) {
  const categories=['Blood','Urine','Electrocardiography','Imaging','Reassessment','Handover'];
  const rows=viewRequests().filter(id=>id!=='exam').map(id=>state.catalog.find(r=>r.id===id)||{id,name:id});
  rows.sort((a,b)=>categories.indexOf(a.category)-categories.indexOf(b.category)||(a.result_group||a.name).localeCompare(b.result_group||b.name,'en-US')||(a.sort_time||'9999').localeCompare(b.sort_time||'9999')||a.id.localeCompare(b.id));
  const groups=new Map();
  for(const r of rows){const key=r.result_group||r.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  return [...groups].map(([name,items])=>`<section class="result-group"><h3>${esc(name)}</h3>${items.map(r=>`<div class="report-row"><div><span>${esc(r.collected||'See report for time')}</span>${compact?'':`<div class="muted">${state.report_status?.[r.id]?.ready===false?'Examination in progress · Estimated '+esc(state.report_status[r.id].reported):viewReports().includes(r.id)?'Viewed':'Results returned · Not viewed'}</div>`}</div><button data-report="${r.id}" ${state.report_status?.[r.id]?.ready===false||(state.stage===4||reviewing())&&!viewReports().includes(r.id)?'disabled':''}>${state.report_status?.[r.id]?.ready===false?'Examination in progress':'View Report'}</button></div>`).join('')}</section>`).join('');
}
function openChecks() {
  const catalog=state.catalog.filter(r=>r.orderable);
  const categories=['Blood','Imaging','ECG and other tests',...(catalog.some(r=>r.category==='Urine')?['Urine']:[]),...(catalog.some(r=>r.category==='Reassessment')?['Ward Reassessment']:[])];
  const entries=[...new Set(catalog.filter(r=>group(r)===category).map(r=>r.order_name||r.name))].map(name=>{
    const members=catalog.filter(r=>(r.order_name||r.name)===name);
    return members.find(r=>!state.requested_reports.includes(r.id))||members[0];
  });
  const placeholders=[];
  modal('Request Ancillary Tests',`<div class="row" role="tablist" aria-label="Examination Categories">${categories.map(c=>`<button role="tab" aria-selected="${c===category}" data-cat="${c}" class="${c===category?'primary':''}">${c}</button>`).join('')}</div><div class="choices">${entries.map(r=>`<label><input type="checkbox" data-check="${r.id}" ${state.requested_reports.includes(r.id)?'disabled':''} ${selected.has(r.id)?'checked':''}> ${esc(r.order_name||r.name)}${state.requested_reports.includes(r.id)?'<small>Requested; track progress in the report list</small>':''}</label>`).join('')}${placeholders.map(name=>`<label class="unavailable"><input type="checkbox" disabled> ${name}<small>Unavailable at this stage</small></label>`).join('')}</div><div class="muted">Similar tests are grouped together; each category returns one report corresponding to the current clinical stage. Sample collection is scheduled together for orders in the same batch, approximately 1 Automatically returns after minutes; you can also click Wait to view earlier。</div><div class="modal-actions"><span id="cr-selected" class="muted">Selected ${new Set([...selected].map(id=>state.catalog.find(r=>r.id===id)?.order_name||id)).size} examination categories</span><button data-action="close">Cancel</button><button class="primary" data-action="request-checks" data-mutate>Request Selected Tests</button></div>`,'checks');
}
async function requestChecks() {
  if(!selected.size){$('#cr-selected').textContent='Select an investigation first';return;}
  await operation(async()=>{accept(await api('/api/checks',{id:state.id,reports:[...selected]}));selected.clear();schedulePoll();notice='Examination requested, approximately 1 Automatically returns after minutes; new reports are flagged with a red dot。';openReports();},true);
}
function openReports() {
  const entries=viewRequests().filter(id=>id!=='exam');
  modal('Current examination report',entries.length?`<p>${esc(state.time)}</p><p class="muted">approximately 1 Automatically return after minutes and advance simulated time accordingly; tests of the same type are sorted by sampling time.。</p>${!reviewing()&&state.stage<4&&Object.values(state.report_status||{}).some(r=>!r.ready)?'<div class="row"><button data-action="wait-next">Waiting for the next result</button><button data-action="wait-all">Awaiting all pending investigation results</button></div>':''}${reportGroupsHtml()}`:'<p class="empty">No reports returned yet。</p>','reports');
}
async function getReport(id) {
  if(state.report_results[id]){openKnownReport(id);return;}
  if(reviewing()){showError('When reviewing past scenes, you can only view reports already obtained. Return to the current scene to continue testing.。');return;}
  await operation(async()=>{const result=await api('/api/report',{id:state.id,report:id});accept(result.state);openKnownReport(id);},true);
}
function marked(text) {return esc(text).replace(/(↑|↓)/g,'<mark>$1</mark>');}
function openKnownReport(id) {
  const report=state.report_results[id];if(!report)return;currentReport=id;
  const s=report.sheet||{title:report.name,collected:'See main text',reported:'See main text',findings:report.text};
  const rows=s.rows||[];
  modal(report.name,`<div class="report-workspace"><article class="report-paper"><div class="report-brand">Clinical Skills Training Center · Teaching Simulation</div><h2>${esc(s.title)}</h2><div class="report-meta"><span>Name: ${esc(state.registration?.name||"")}</span><span>Sex: ${esc(state.registration?.sex||"")}　Age: ${esc(state.registration?.age||"")}</span><span>Case number：${esc(state.case_id)}</span><span>Report ID：${esc(s.number||'—')}</span><span>Specimen / Method：${esc(s.sample||'—')}</span>${s.ordered?`<span>Apply：${esc(s.ordered)}</span>`:''}<span>Sampling / Examination：${esc(s.collected)}</span><span>Receive：${esc(s.received||'Not listed separately in the original draft')}</span><span>Report：${esc(s.reported)}</span></div>${rows.length?`<div class="report-table-wrap"><table><thead><tr><th>Laboratory test items</th><th>Results</th><th>Help</th><th>Unit</th><th>Reference interval</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.flag?'abnormal-row':''}"><td>${esc(r.name)}</td><td>${esc(r.value)}</td><td>${marked(r.flag)}</td><td>${esc(r.unit)}</td><td>${esc(r.reference)}</td></tr>`).join('')}</tbody></table></div>`:''}${s.image?`<button class="diagnostic-image-button" data-action="zoom-report" aria-label="Enlarge Investigation Image"><img class="diagnostic-image" src="/api/report-image?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(id)}" alt="${esc(report.name)}：Original case synthetic teaching image"><span>Click to enlarge</span></button>`:''}${s.findings?`<h3>Findings</h3><p class="report-findings">${marked(s.findings)}</p>`:''}${s.source_collected?`<details><summary>Source case time</summary><p>Source specimen collection / Examination：${esc(s.source_collected)}；Report：${esc(s.source_reported)}。This report displays the simulated execution time。</p></details>`:''}<p class="report-note">${esc(s.note||'')} ${rows.length?'↑ Above the upper reference limit；↓ Below the lower reference limit。':''}</p><footer>Original case data · Simulated report layout · Pending expert review<br>Teaching materials, not for actual clinical care; no institutional seals or signatures have been replicated.。</footer></article><aside class="report-extract"><h3>Medical Record Extraction</h3>${report.pacs?`<a class="pacs-launch" href="/pacs/pacs.html?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(id)}" target="_blank" rel="noopener">Open PACS Image review ↗</a>`:''}${editable()?`<button class="primary" data-action="preview-import" data-mutate>Add to clinical notes</button><button data-action="preview-full" data-mutate>Import complete${id==='exam'?'Physical examination':'Report'}</button>`:''}<p class="muted">Click Extract to Clinical Record to preview positive findings; they are written to the record only after confirmation. Source, time, values, and units are retained.。</p><button data-action="reports">Return to Report List</button></aside></div>`,'report');
}
function previewImport(positive=true) {
  const r=state.report_results[currentReport];if(!r)return;
  if(positive&&!r.positive){
    modal('Extraction Results Preview',`<p>No positive findings documented in this report/Abnormal findings; no content has been added to the medical record. Import the full report if needed.。</p><div class="modal-actions"><button data-report="${currentReport}">Back to Report</button><button data-action="preview-full" data-mutate>Preview Full Report</button></div>`,'import');
    return;
  }
  importPositive=positive;
  const excerpt=positive?`【${r.name} · ${r.sheet?.collected||'See report'} · Positive/Abnormal Findings】${r.positive}`:`【${r.name}】${r.text}`;
  modal('Imported Medical Record Preview',`<div class="muted">Write${currentReport==='exam'?'「Physical examination」':'「Ancillary Investigations」'}field; retain the report source, time, and units。</div><label class="field" for="cr-import-text">Imported content (editable and removable）</label><textarea id="cr-import-text" rows="12" maxlength="6000">${esc(excerpt)}</textarea><p id="cr-import-error" role="alert"></p><div class="modal-actions"><button data-report="${currentReport}">Back to Report</button><button class="primary" data-action="confirm-import" data-mutate>Confirm Write${currentReport==='exam'?'Physical examination':'Ancillary Investigations'}</button></div>`,'import');
}
function zoomReport() {
  const r=state.report_results[currentReport];if(!r?.sheet?.image)return;
  modal(r.name+' · Enlarge View',`<div class="image-zoom-tools"><button data-image-zoom="fit" aria-pressed="false">Fit to Window</button><button data-image-zoom="double" aria-pressed="true">Zoom in 2 times</button><button data-image-zoom="native" aria-pressed="false">Original dimensions</button><button data-report="${currentReport}">Back to Report</button></div><p class="muted">Scroll horizontally and vertically to view details. Synthetic teaching images based on the original case; on-screen zoom does not represent printed scale calibration.。</p><div class="image-zoom-view zoom-double" tabindex="0" aria-label="Enlarged area of the investigation image"><img src="/api/report-image?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(currentReport)}" alt="${esc(r.name)}Enlarged image"></div>`,'image-zoom');
}
async function importReport() {
  const editedText=$('#cr-import-text').value.trim();
  if(!editedText){$('#cr-import-error').textContent='Retain the content to be entered into the medical record, or return to the report to cancel the import.。';return;}
  await operation(async()=>{accept(await api('/api/import',{id:state.id,report:currentReport,positive_only:importPositive,edited_text:editedText}));closeModal();notice='Imported into the medical record and saved; duplicate content will not be added again。';},true);
}
function openTeacher() {
  if(isExam()||reviewing())return;
  modal('Supervising Physician · Ask a Teacher',`<div class="chat chat-log" id="cr-senior-log" role="log" aria-label="Supervising Physician conversation log" aria-live="polite"></div><p id="cr-senior-error" role="alert"></p><span id="cr-hints" class="muted"></span>${composer('senior','Enter your assessment, supporting evidence, or questions for consultation')}`,'teacher');
  updateSeniorLog();renderControls();$('#cr-input-senior').focus();
}
function openNew() {
  modal('Start a Simulation',`<p>The current record will be saved on this device. A new exercise starts at the initial consultation。</p><label class="field" for="cr-new-mode">Training Mode</label><select id="cr-new-mode"><option value="practice">Independent Practice</option><option value="exam">Exam Workflow Test</option></select><div class="modal-actions"><button data-action="close">Cancel</button><button class="primary" data-action="start">Start Simulation</button></div>`,'new');
}
async function start(mode='practice') {
  screenshotDrafts=[];voiceJob=null;clearTimeout(voiceTimer);
  const next=await api('/api/session',{mode});
  clearTimeout(pollTimer);notes={};dirty.clear();composers={};viewStage=next.stage;selected.clear();localError='';
  sessionStorage.setItem(rehearsalStorageKey,next.id);closeModal();accept(next,true);notice='Text records are automatically saved locally。';showCaseIntro();
}
async function exportSession() {
  if(!state)return;
  if(!state.busy)await saveNotes();
  const blob=new Blob([JSON.stringify({...state,unsaved_notes:Object.fromEntries([...dirty].map(k=>[k,notes[k]])),exported_at:new Date().toISOString()},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Clinical Text-Based Exercise Record.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

root.addEventListener('input',e=>{
  const key=e.target.dataset.note,role=e.target.dataset.composer;
  if(key&&editable()) {notes[key]=e.target.value;dirty.add(key);renderStatus();clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveNotes().catch(err=>showError(err.message)),700);}
  if(role)composers[role]=e.target.value;
});
root.addEventListener('change',e=>{const id=e.target.dataset.check;if(id){for(const r of sameCheck(id).filter(r=>!state.requested_reports.includes(r.id))){e.target.checked?selected.add(r.id):selected.delete(r.id);}$('#cr-selected').textContent=`Selected ${new Set([...selected].map(key=>state.catalog.find(r=>r.id===key)?.order_name||key)).size} examination categories`;}});
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
      case 'scene':modal(sceneNames[viewStage]+' · Patient Scenario',`<div class="scene-enlarged">${sceneImage(viewStage)}</div><p class="muted">AI Generated illustration of a teaching scenario. Refer to the written materials for this case for the clinical condition and test results.。</p>`,'scene');break;
      case 'close':closeModal();break;
      case 'save':await operation(async()=>{notice='Clinical record saved to server。';},true);break;
      case 'checks':selected.clear();category='Imaging';openChecks();break;
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
      catch(e){showError('Unable to restore the existing simulation。'+e.message);return;}
    }else await start(portalMode);
    if(state?.stage===0 && state.messages.length<=1 && !(state.orders||[]).length && !(state.requested_reports||[]).length && !Object.values(state.notes||{}).some(Boolean))showCaseIntro();
    localError='';renderStatus();
  }catch(e){showError('Service disconnected; your input will not be cleared。'+e.message);}
}
initialize();







function renderAttachments() {
  const el=$('#cr-attachments');if(!el)return;
  el.innerHTML=screenshotDrafts.map(x=>`<div class="attachment-preview"><img src="/api/attachment?id=${encodeURIComponent(state.id)}&attachment=${encodeURIComponent(x.id)}" alt="Screenshots pending submission"><button data-remove-image="${esc(x.id)}" aria-label="Remove Screenshot">Remove</button></div>`).join('')+`<span class="muted">${uploadingImage?'Uploading…':'Paste screenshots directly; maximum per round 3 Sheets, per Sheet 4MB。Send to the Supervising Physician for interpretation。'}</span>`;
}
async function uploadImages(files) {
  if(uploadingImage||isExam())return;
  uploadingImage=true;renderControls();renderAttachments();
  try {
    for(const file of files){
      if(screenshotDrafts.length>=3)throw new Error('Maximum per Round 3 screenshots。');
      if(file.size>4*1024*1024)throw new Error('A single screenshot cannot exceed 4MB。');
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Failed to read image'));reader.readAsDataURL(file);});
      screenshotDrafts.push(await api('/api/attachment',{id:state.id,image,name:file.name||'Paste Screenshot'}));renderAttachments();
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
  }catch(e){voiceJob={...voiceJob,status:'error',error:'Voice connection interrupted. Please try again.。'};renderControls();}
}

function openOperationOrders() {
  modal('Procedure Orders',`<div class="op-editor"><p class="muted">Search for and select a procedure, then enter its parameters. Once confirmed, it is added to the clinical summary.。</p><div class="op-scroll"><table><thead><tr><th>Procedure Name</th><th>Dedicated parameters</th><th>Frequency</th><th>Duration</th><th>Order type</th><th>Notes</th><th></th></tr></thead><tbody id="op-rows"></tbody></table></div><div class="row"><button id="op-add">＋ Add Row</button><button id="op-confirm" class="primary">Confirm</button><span id="op-status" role="status"></span></div></div>`,'operation-orders');
  const catalog=state.operation_catalog||[];let requestId=crypto.randomUUID();
  function add(){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="op-search"><input aria-label="Search Procedures" placeholder="Chinese / Pinyin Abbreviation"><div class="op-matches"></div></td><td class="op-params">Select a procedure, then complete the fields</td><td><input aria-label="Frequency" list="op-frequencies" placeholder="Select or enter"></td><td><input aria-label="Duration" placeholder="If：30 Minutes / Until the order is discontinued"></td><td><select aria-label="Order type"><option>One-time orders</option><option>Long-term orders</option></select></td><td><input aria-label="Notes" placeholder="Optional"></td><td><button aria-label="Delete action">Delete</button></td>`;
    const search=tr.querySelector('input'),matches=tr.querySelector('.op-matches');
    if(state.stage===0){const t=tr.querySelector('select[aria-label="Order type"]');t.innerHTML='<option>One-time orders</option>';t.hidden=true;t.parentElement.append('This Outpatient Visit');}
    search.oninput=()=>{tr.operation=null;tr.querySelector('.op-params').textContent='Select a procedure, then complete the fields';matches.replaceChildren();const q=search.value.trim().toLowerCase();if(!q)return;catalog.filter(o=>o.name.includes(q)||o.pinyin.replaceAll(' ','').includes(q)).forEach(o=>{const b=document.createElement('button');b.textContent=o.name;b.onclick=()=>{tr.operation=o;search.value=o.name;matches.replaceChildren();const box=tr.querySelector('.op-params');box.replaceChildren();if(!o.fields.length)box.textContent='No additional parameters required';o.fields.forEach(f=>{const label=document.createElement('label');label.textContent=f.label;let options=f.options;const linked=f.label.startsWith('Link');if(linked)options=(state.orders||[]).filter(x=>x.kind==='medication').map(x=>x.text);const input=document.createElement(options.length?'select':'input');input.dataset.param=f.label;input.setAttribute('aria-label',f.label);if(options.length){const blank=document.createElement('option');blank.value='';blank.textContent='Please select';input.append(blank);options.forEach(v=>{const opt=document.createElement('option');opt.textContent=v;input.append(opt);});}if(linked&&!options.length)input.placeholder='Prescribe medication first, or enter the medication order to link';label.append(input);box.append(label);});};matches.append(b);});if(!matches.children.length)matches.textContent='No matching procedure found';};
    tr.querySelector('[aria-label="Delete action"]').onclick=()=>{tr.remove();if(!$('#op-rows').children.length)add();};$('#op-rows').append(tr);
  }
  add();$('#op-add').onclick=add;
  const dl=document.createElement('datalist');dl.id='op-frequencies';['Once','Persistent','Qd','Bid','Qh','each 15 Minutes','As needed'].forEach(v=>{const o=document.createElement('option');o.value=v;dl.append(o);});$('#op-rows').closest('.op-editor').append(dl);
  $('#op-confirm').onclick=async()=>{
    const button=$('#op-confirm');if(button.disabled)return;
    const rows=[];for(const tr of $('#op-rows').children){if(!tr.operation){$('#op-status').textContent='Please search for and confirm the procedure name in each row。';return;}const value=n=>tr.querySelector(`[aria-label="${n}"]`).value.trim();rows.push({operation_id:tr.operation.id,params:Object.fromEntries([...tr.querySelectorAll('[data-param]')].map(x=>[x.dataset.param,x.value.trim()])),frequency:value('Frequency'),duration:value('Duration'),type:value('Order type'),remark:value('Notes')});}
    button.disabled=true;$('#op-status').textContent='Confirming…';
    try{accept(await api('/api/operation-orders',{id:state.id,request_id:requestId,rows}));requestId=crypto.randomUUID();$('#op-rows').replaceChildren();add();$('#op-status').textContent='Ordered, documented in the care summary, and shared with the Supervising Physician。';}catch(e){$('#op-status').textContent=e.message;}finally{button.disabled=false;}
  };
}

function showCaseIntro() {
  if(!state||sessionStorage.getItem('clinical-intro-'+state.id))return;
  let intro=document.getElementById('cr-case-intro');
  if(!intro){intro=document.createElement('dialog');intro.id='cr-case-intro';intro.setAttribute('aria-labelledby','cr-intro-title');root.append(intro);intro.addEventListener('cancel',e=>e.preventDefault());}
  intro.innerHTML=`<div class="intro-picture">${sceneImage(0)}</div><div class="intro-shade"></div><div class="intro-top">Clinical reasoning training room<span>Seen in the general orthopedic clinic</span></div><section class="intro-bottom"><div><p class="intro-eyebrow">Patient Demographics</p><h2 id="cr-intro-title">${esc(state.registration?.name||"")} <span>${esc(state.registration?.sex||"")} · ${esc(state.registration?.age||"")}</span></h2><p class="intro-detail">${esc(state.registration?.marital_status||"")} · ${esc(state.registration?.occupation||"")}</p><p class="intro-quote">“Doctor, my lower back and left leg have been hurting for quite a while, and lately it has been hard to lift my left foot.。”</p><small>AI Generated teaching scenario</small></div><button id="cr-begin-reception" autofocus>Start Consultation <span aria-hidden="true">→</span></button></section>`;
  document.getElementById('cr-begin-reception').onclick=()=>{sessionStorage.setItem('clinical-intro-'+state.id,'1');intro.close();document.getElementById('cr-input-patient')?.focus();};
  if(!intro.open)intro.showModal();
}



function renderRecordArchive() {
  const el=$('#cr-record-archive');if(!el)return;
  const docs=(state.medical_documents||[]).filter(d=>d.stage<viewStage);
  if(viewStage<2){el.replaceChildren();return;}
  const signature=JSON.stringify(docs);if(el.dataset.signature===signature)return;el.dataset.signature=signature;
  const renderContent=d=>d.fields.map(([key,label])=>d.content[key]?`<div class="archive-field"><strong>${esc(label)}</strong><p>${esc(d.content[key])}</p></div>`:'').join('');
  el.innerHTML=`<h3>Previous Medical Records <span class="muted">${docs.length} Copy · Click to Expand</span></h3>${docs.length?docs.map(d=>`<details class="archived-document"><summary><strong>${esc(d.title)}</strong><span>${esc(d.created_at||'Writing timestamps were not retained for older records')}</span></summary><div class="archive-content"><p class="muted">First saved：${esc(d.created_at||'Not retained')} · Last saved：${esc(d.updated_at||'Not retained')} · ${esc(stageNames[d.stage])} · Read-only history</p>${d.legacy?'<p class="muted">Retained from the original stage snapshot; original “Chief complaint / Content merged under “History of Present Illness” remains there and has not been split automatically.。</p>':''}${renderContent(d)}${d.versions?.length?`<details><summary>View Revision History（${d.versions.length}）</summary>${d.versions.map(v=>`<article><p class="muted">Saved at ${esc(v.time)}</p>${renderContent({...d,content:v.content})}</article>`).join('')}</details>`:''}</div></details>`).join(''):'<p class="muted">No previously written medical records。</p>'}`;
}

