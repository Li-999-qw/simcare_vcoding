'use strict';
const portalParams=new URLSearchParams(location.search);
const portalStudent=portalParams.get('portalStudent');
const portalTask=portalParams.get('portalTask');
const portalMode=portalTask&&portalParams.get('portalMode')==='exam'?'exam':'practice';
const rehearsalStorageKey=portalStudent?'clinical-rehearsal-id-en:'+portalStudent+':chest-pain:'+(portalTask?'task:'+portalTask+':'+portalMode:'practice'):'clinical-rehearsal-id-en';
if(portalStudent){const bar=document.createElement('div');bar.style.cssText='padding:10px 20px;background:#20343e;color:white;display:flex;gap:20px;align-items:center';const label=document.createElement('span');label.textContent=(portalParams.get('portalName')||portalStudent)+' · Chest pain case · '+(portalTask?'Teacher Assignment'+(portalMode==='exam'?' · Exam':' · Practice'):'Independent Practice');const back=document.createElement('a');back.href=location.protocol+'//'+location.hostname+':8876/portal.html?return='+(portalTask?'tasks':'1');back.textContent='Return to learning workspace';back.style.color='#80d9c7';bar.append(label,back);document.body.prepend(bar);}
// Layout and scene flow: approved clinical-rounds.html from the Interface design task.
const root = document.getElementById('clinical-rounds');
const $ = s => root.querySelector(s);
const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stageNames = ['Patient intake','Interventional treatment','Ward round','Discharge date','Feedback'];
const sceneNames = ['Emergency Consultation Room','Transport and handoff to the interventional team','Inpatient ward','Discharge date'];
const noteTitles = ['Clinical Encounter Documentation','Management and handoff record','Daily progress notes','Discharge summary'];
let state, viewStage = -1, renderedStage = -1, pollTimer, saveTimer, savePromise;
let notes = {}, dirty = new Set(), composers = {}, pending = false, localError = '';
let modalKind = '', currentReport = '', category = 'Blood', selected = new Set();
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
  return `<div class="tools" aria-label="Clinical actions"><button data-action="exam" data-mutate>Physical examination</button><button data-action="checks" data-mutate>＋ Request Examination</button><button data-action="orders" data-mutate>＋ Medication Orders</button><button data-action="operation-orders" data-mutate>＋ Procedure Orders</button><button data-action="reports" id="cr-report-count">Examination Report</button></div>`;
}
function recordBody() {
  if (viewStage === 0) return `<p class="muted">Complete based on the history taken and information obtained; do not record unasked or unverified items as negative.。</p><details class="record-document" open><summary>Admission note</summary><div class="document-fields"><p class="muted">Admission completed · General information is prefilled by the registration system</p>${noteField('general','General information / History provided by','Admission Registration Information',5)}${noteField('chief','Chief complaint','Main symptoms or signs and their duration',2)}${noteField('history','History of present illness','Onset, main symptom characteristics and progression, associated symptoms, prehospital evaluation and treatment, and general condition.',5)}<details class="history-fields"><summary>Relevant past medical and personal history</summary>${noteField('past_history','Past medical history','Past illnesses, surgery, trauma, transfusions, immunizations, etc.')}${noteField('allergy_history','Allergy history','Drug, food, and other allergies')}${noteField('personal_history','Personal history','Birthplace and residence, occupation and exposures, smoking and alcohol use, etc.')}${noteField('marriage_history','Marital and reproductive history','Marital and reproductive history, and information on spouse and children; complete according to the Patient’s actual circumstances.')}${noteField('family_history','Family history','Relatives’ health, relevant illnesses, and family history of hereditary diseases')}</details>${noteField('exam','Physical examination','Vital signs and examination findings by system',3)}${noteField('specialist_exam','Specialty-specific findings','Physical examination findings relevant to this specialty')}${noteField('tests','Ancillary Investigations','Record only results already obtained; reports can be edited before import')}${noteField('diagnosis','Provisional diagnosis','List diagnoses in order of priority')}${noteField('author','Documenting clinician (trainee）','Enter your name; this teaching record does not replace a formal electronic signature',1)}</div></details><details class="record-document"><summary>Initial progress note</summary><div class="document-fields">${noteField('case_features','Case features','Summarize key features of the history, physical examination, and investigations',3)}${noteField('first_diagnosis','Diagnostic discussion: Preliminary diagnosis','List the preliminary diagnoses for this admission')}${noteField('reason','Diagnostic discussion: Diagnostic basis','Explain the diagnosis and supporting evidence based on the case features',3)}${noteField('differential','Diagnostic discussion: Differential diagnosis','List differential diagnoses and supporting and exclusionary evidence',3)}${noteField('initial_plan','Diagnostic and treatment plan','Investigation plan, treatment measures, monitoring, and communication arrangements',3)}</div></details>`;
  if (viewStage === 1) return `<div class="notice">Treating Physician · Responsible for decisions, coordination, and handoffs</div><h3>Management Orders</h3><div id="cr-orders"></div>${noteField('plan','Management Plan / Handover key points','Document planned management and issues requiring handover',4)}<button class="secondary-action" data-action="handoff">${state.stage > 1 ? 'View interventional team report' : 'Receive the interventional team’s report and proceed to the ward →'}</button><p class="tool-note">Ward handoffs use preset case milestones; recorded instructions do not indicate execution.。</p>`;
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
  return `<figure class="cath-scene"><img src="/assets/cath-lab-v1.png" width="1536" height="1024" alt="Illustrative scene: the patient undergoes intervention in the catheterization laboratory">${active?'<div class="procedure-overlay" role="status" aria-label="Interventional procedure in progress">Interventional procedure in progress<span class="procedure-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></div>':''}<figcaption>Interventional Procedure Room · AI Scenario Illustration</figcaption></figure>`;
}
function interventionLayout() {
  if(reviewing())return `<section class="panel pad intervention"><h2>Interventional Treatment Record</h2><p>${state.intervention?.status==='confirmed'?'Interventional treatment selected and team report confirmed。':'Keep the existing handoff record this time。'}</p><button data-action="handoff">View interventional team report</button>${state.orders.map(o=>`<p>${esc(o.text)}</p>`).join('')}${viewNotes().plan?`<p>${esc(viewNotes().plan)}</p>`:''}</section>`;
  const started=state.intervention?.status==='started', report=state.intervention_report;
  return `<section class="panel pad intervention"><h2>Interventional treatment</h2>${report?`<article class="team-report"><span class="tag">Interventional Team Report</span><h3>${esc(report.name)}</h3><p>${esc(report.text)}</p><button class="primary" data-action="confirm-intervention">Confirm the report and enter the ward →</button><p class="muted">Once confirmed, it will be included under test reports; you must still extract, confirm, and enter content into the medical record.。</p></article>`:started?`${cathScene(true)}<p class="muted">Scenario Illustration · Preset case course</p>`:`${scenePanel()}<p>After interventional treatment is selected, the interventional team will take over care and report the results。</p><button class="primary" data-action="start-intervention">Select Interventional Treatment →</button>`}</section>`;
}
async function startIntervention() {
  await operation(async()=>{accept(await api('/api/intervention/start',{id:state.id}),true);schedulePoll();});
}
async function confirmIntervention() {
  await operation(async()=>{const next=await api('/api/intervention/confirm',{id:state.id});viewStage=next.stage;closeModal();accept(next,true);notice='The interventional team’s report has been added to the investigation reports; the Patient has entered the ward。';});
}
function mainLayout() {
  if (viewStage === 4) return feedbackLayout();
  if (viewStage === 1) return interventionLayout();
  const team = viewStage === 1, role = team ? 'team' : 'patient';
  const questions = viewStage === 0 ? ['Where do you feel unwell?？','How long has the pain lasted?？','Have you had anything similar before?？'] : ['Are you still having chest pain today?？','How are your activity and sleep?？'];
  return `<section class="panel conversation" aria-label="${team?'Team Handoff':'Patient History Taking'}">${scenePanel()}<div class="pad"><h2 class="heading">${team?'Team Conversation · Management and handover':'Patient Communication'}<span class="muted" data-sim-time>${reviewing()?'Review Records':state.time}</span></h2><div class="chat chat-log" id="cr-patient-log" role="log" aria-label="${team?'Handover notes':'Patient Conversation Record'}" aria-live="polite"></div>${editable()?`<div class="row quick-questions">${team?'<button data-draft="Contact the interventional team and prepare the handover" data-target="team">Contact the Interventional Team</button><button data-draft="Arrange monitoring and reassessment" data-target="team">Arrange monitoring and reassessment</button>':questions.map(text=>`<button data-draft="${text}" data-target="patient">${text}</button>`).join('')}</div>${composer(role,team?'Enter diagnostic and treatment orders, then verify the recorded orders on the right':'Enter what you want to ask the Patient')}`:'<p class="muted">Dialogue from completed scenes is retained here. Return to the current scene to continue.。</p>'}</div></section><section class="panel pad record-panel" aria-label="Clinical documentation"><h2 class="heading">${noteTitles[viewStage]}<span class="record-state"></span></h2>${toolbar()}${recordBody()}<section id="cr-record-archive"></section><section id="cr-treatment-summary"></section><div class="record-bottom"><span class="muted">${editable()?'Automatically saved after entry':'Completed scenarios · Review Records'}</span>${editable()?'<button data-action="save" data-mutate>Save clinical record</button>':''}</div></section>`;
}
function recordReviewHtml() {
  return `<h3>Four-Dimensional Record Cross-Check</h3><p class="muted">The following checks the content actually retained. A record does not establish that the medical judgment was correct, and no record does not necessarily mean an action was not performed.。</p><div class="review-grid">${(state.record_review||[]).map(card=>`<article class="review-card"><h3>${esc(card.title)}</h3><p>${esc(card.summary)}</p>${card.fields.map(field=>`<details><summary><span class="${field.present?'recorded':'missing'}">${field.present?'Existing Records':'No Records Found'}</span> · ${esc(field.label)}</summary><p>${esc(field.evidence||'This text was not saved for this session and cannot be verified。')}</p></details>`).join('')}</article>`).join('')}</div>`;
}
function feedbackLayout() {
  if (isExam()) return `<section class="panel feedback"><h2 class="heading">Exam Submission Receipt <span class="tag">Submitted</span></h2><div class="notice">Answers are locked. You may review your records below; medical feedback and model answers are pending release by the Teacher.。</div>${recordReviewHtml()}<p class="muted">The Teacher publishing backend is not yet connected. For immediate teaching feedback, create a Self-directed Practice exercise.。</p><button data-stage="0">Review Encounter Record</button> <button data-action="export">Export This Session’s Record</button></section>`;
  const stats = [['Patient Communication',state.messages.filter(m=>m.speaker==='student'&&m.role==='patient').length+' Round'],['Investigations and materials viewed',state.reports.length+' Item'],['Medical Record Import',state.events.filter(e=>e.action==='Import Medical Records').length+' times'],['Interventional treatment',state.intervention?.status==='confirmed'?'Selected and confirmed the report':'Unconfirmed'],['Consult the Supervising Physician',state.hint_count+' prompts']];
  return `<section class="panel feedback"><h2 class="heading">Feedback on this training session <span class="tag">Submitted</span></h2><p class="muted">Feedback is based on actual history taking, reviewed reports, and clinical notes from each stage. Unrecorded actions are not treated as completed.。</p><h3>Supervising Physician · Four-Dimensional Feedback</h3><div class="chat chat-log" id="cr-feedback-log" role="log" aria-label="Debrief discussion" aria-live="polite"></div><button data-action="feedback">Generate / Retry Full Feedback</button><div class="feedback-composer">${composer('senior','You can ask follow-up questions about whether your history-taking, testing, diagnosis, and management were appropriate.')}</div>${recordReviewHtml()}<details><summary>Interaction statistics and action timeline</summary>${stats.map(([name,value])=>`<div class="record">${name}<span class="summary-value">${value}</span></div>`).join('')}<div class="history-list">${state.events.map(e=>`<div class="record">${stageNames[e.stage]} · ${esc(e.action)} · ${esc(e.name)}</div>`).join('')}</div></details><div class="row"><button data-stage="0">Review Encounter Record</button><button data-stage="1">Review Interventional Treatment</button><button data-action="reports">Examination Report</button><button data-action="export">Export This Session’s Record</button></div><p class="muted">Formative feedback · No medical score generated for now</p></section>`;
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
  if(!reviewing()&&viewStage===1)$('#cr-next').textContent=state.intervention_report?'Confirm the report and enter the ward →':state.intervention?.status==='started'?'Awaiting interventional team report…':'Select Interventional Treatment →';
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
    const next=await api(role==='team'?'/api/order':'/api/message',{id:state.id,role,text,request_id:requestId(),attachments:role==='senior'?screenshotDrafts.map(x=>x.id):[]});
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
  modal('Medication Orders', '<div class="cr-rx-host"></div>', 'orders');
  const editor = document.querySelector('.cr-rx-host').attachShadow({mode:'open'});
  editor.innerHTML = '<link rel="stylesheet" href="/style.css?v=rx-native-3">' + "<main><header><h1>Medication Orders</h1><small>Medication Orders · Confirm to add to the care summary</small></header><div class=\"table-wrap\"><table><thead><tr><th>Medicinal products</th><th>Dose</th><th>Directions for use</th><th>Route of Administration</th><th>Order type</th><th>Notes</th></tr></thead><tbody id=\"rows\"></tbody></table></div><footer><button id=\"add\">＋ Add Row</button><button id=\"save\" class=\"primary\">Confirm</button><span id=\"status\">Selecting a medication fills in a standard regimen, which can be edited; individualized doses may be left for later.</span></footer></main>";
window.MI_DRUG_CATALOG = {
  "schema_version": 1,
  "catalog_version": "2026-09-11.2",
  "case_id": "SIM-AMI-20260901",
  "reviewed_at": "2026-09-11",
  "status": "teaching_draft_pending_pharmacy_review",
  "guideline_basis": "The latest comprehensive ACS guideline retrieved in this search was the 2025 ACC/AHA guideline; the 2019 Chinese STEMI materials and 2023 ESC comprehensive ACS guideline were used for version cross-checking. The 2026 update to the definition of myocardial infarction does not replace medication guidelines.",
  "sources": [
    {
      "id": "ACS2025",
      "title": "2025 ACC/AHA ACS Guideline — AHA Official summary",
      "url": "https://professional.heart.org/en/science-news/2025-guideline-for-the-management-of-patients-with-acute-coronary-syndromes/top-things-to-know",
      "scope": "Basis for the antiplatelet and intensive lipid-lowering catalog; this does not mean every dosage form has local approval"
    },
    {
      "id": "CN2019",
      "title": "China STEMI Clinical practice guidelines（2019）",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "Reference for domestic STEMI diagnosis and treatment classification; the specific formulation list still requires pharmacy verification."
    },
    {
      "id": "HIS",
      "title": "Simulation HIS Expand directory",
      "scope": "Supplementary content added by design; no claim is made that all these medications are recommended by the 2025 ACS guideline. Strengths, indications, and doses await local pharmacy verification."
    },
    {
      "id": "CASE",
      "title": "Simulated myocardial infarction medical record for this project",
      "path": "../../build_case_pdf.py",
      "scope": "Retains the existing case dosing template; not an automatic recommendation from new guidelines."
    },
    {
      "id": "DOSE001",
      "title": "Aspirin conventional tablets: reference information on common adult regimens",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "ACS Load"
    },
    {
      "id": "DOSE002",
      "title": "Aspirin enteric-coated tablets: reference information on common adult regimens",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "ACS Maintain"
    },
    {
      "id": "DOSE003",
      "title": "Ticagrelor tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1225fd45-9b56-1671-ee77-cd0c9f2174a5",
      "scope": "ACS First-year maintenance"
    },
    {
      "id": "DOSE004",
      "title": "Clopidogrel bisulfate tablets: reference information on common adult regimens",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "ACS Maintain"
    },
    {
      "id": "DOSE005",
      "title": "Prasugrel tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=35aa7f3e-bbd8-4eae-b61f-29d1abca2224",
      "scope": "ACS perform PCI Maintained after"
    },
    {
      "id": "DOSE006",
      "title": "Tirofiban hydrochloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13ea7fb8-4b01-4286-9464-26c0b624bc3b",
      "scope": "PCI Selective rescue loading"
    },
    {
      "id": "DOSE007",
      "title": "Eptifibatide injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00ad7bbe-cadd-4647-b74b-adfc9f2b5e94",
      "scope": "PCI Selective rescue loading"
    },
    {
      "id": "DOSE008",
      "title": "Unfractionated heparin injection: reference information on common adult regimens",
      "url": "https://professional.heart.org/~/media/PHD-Files-2/Science-News/2/2021/2021-Coronary-Artery-Revascularization-Guideline-Slide-Set.pdf",
      "scope": "PCI Intraoperative anticoagulation, not coadministered with GPI"
    },
    {
      "id": "DOSE009",
      "title": "Enoxaparin sodium injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=066f27ec-352c-4051-ba29-248e292690db",
      "scope": "STEMI Anticoagulation，<75 Years old and CrCl≥30"
    },
    {
      "id": "DOSE010",
      "title": "Fondaparinux sodium injection: reference information on common adult regimens",
      "url": "https://www.medicines.org.uk/emc/product/3335/smpc",
      "scope": "Not direct PCI of STEMI Subsequent anticoagulation"
    },
    {
      "id": "DOSE011",
      "title": "Bivalirudin for injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=19a4afc5-151d-4d3c-bfef-48aa8797d695",
      "scope": "PCI Bivalirudin loading"
    },
    {
      "id": "DOSE012",
      "title": "Alteplase for injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=c669f77c-fa48-478b-a14b-80b20a0139c2",
      "scope": "First segment of the 90-minute accelerated alteplase regimen for AMI"
    },
    {
      "id": "DOSE013",
      "title": "Reteplase for injection: reference information on common adult regimens",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "STEMI First dose of reteplase"
    },
    {
      "id": "DOSE014",
      "title": "Tenecteplase for injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=e647640d-c395-4b4b-a0be-1162f9c21d84",
      "scope": "STEMI，TNKase Weight-tiered formulation regimen"
    },
    {
      "id": "DOSE015",
      "title": "Urokinase for injection: reference information on common adult regimens",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "STEMI Thrombolysis with urokinase"
    },
    {
      "id": "DOSE016",
      "title": "Atorvastatin calcium tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00afce9b-48c9-487a-a738-e359c005c707",
      "scope": "ACS Intensive lipid lowering"
    },
    {
      "id": "DOSE017",
      "title": "Rosuvastatin calcium tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02797697-300a-43db-92cf-9b78f08626be",
      "scope": "Initial lipid-lowering therapy in Asian adults"
    },
    {
      "id": "DOSE018",
      "title": "Ezetimibe tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02b00cb2-7253-4fb4-a216-53691a929a28",
      "scope": "decrease LDL-C"
    },
    {
      "id": "DOSE019",
      "title": "Evolocumab injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cd61e902-166d-4aa6-9f3c-a18c1008d07e",
      "scope": "PCSK9 Lipid lowering with inhibitors"
    },
    {
      "id": "DOSE020",
      "title": "Alirocumab injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=446f6b5c-0dd4-44ff-9bc2-c2b41f2806b4",
      "scope": "PCSK9 Initiation of inhibitor therapy for lipid lowering"
    },
    {
      "id": "DOSE021",
      "title": "Inclisiran sodium injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=6fc0afca-4513-4c35-b594-6544aee29a44",
      "scope": "Initial inclisiran injection"
    },
    {
      "id": "DOSE022",
      "title": "Bempedoic acid tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=88d06d89-a3da-40b4-b273-8f4f7d56c4c9",
      "scope": "Bempedoic acid for lipid lowering"
    },
    {
      "id": "DOSE023",
      "title": "Nitroglycerin tablets: reference information on common adult regimens",
      "url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
      "scope": "Episode of ischemic chest pain"
    },
    {
      "id": "DOSE024",
      "title": "Nitroglycerin injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=578d8159-5ec6-457f-b4a8-9add624d43a8",
      "scope": "Initiation of intravenous nitrates for persistent ischemic chest pain"
    },
    {
      "id": "DOSE025",
      "title": "Isosorbide dinitrate tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0e5842f2-74f6-1f02-01bc-07578bd3b393",
      "scope": "Angina prophylaxis, immediate-release tablets"
    },
    {
      "id": "DOSE026",
      "title": "Isosorbide mononitrate extended-release tablets: Reference information on commonly used adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a1e317a-7b05-4d30-9bbc-1d4ccd56ba3c",
      "scope": "Angina prophylaxis, extended-release tablets"
    },
    {
      "id": "DOSE027",
      "title": "Metoprolol succinate extended-release tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01908d20-0e16-4410-bd27-1b6df162ede4",
      "scope": "Initiation of a beta-blocker after stabilization in this case"
    },
    {
      "id": "DOSE028",
      "title": "Metoprolol tartrate tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00de1f16-f979-4dbf-aa60-246ffac8d410",
      "scope": "Stable angina, immediate-release tablets"
    },
    {
      "id": "DOSE029",
      "title": "Bisoprolol fumarate tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=084308e4-3b8b-40d6-acbf-d775772a8a73",
      "scope": "Initiation for adult hypertension"
    },
    {
      "id": "DOSE030",
      "title": "Carvedilol tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=010290af-81f4-0037-e063-6394a90a4638",
      "scope": "Initiation for stable chronic heart failure"
    },
    {
      "id": "DOSE031",
      "title": "Esmolol hydrochloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=017023a9-00f0-4284-861f-a3634d4fdb17",
      "scope": "Initiation of maintenance rate control for supraventricular tachycardia"
    },
    {
      "id": "DOSE032",
      "title": "Perindopril tert-butylamine tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=87768fbf-7c63-47da-8925-0316f343d6ef",
      "scope": "This case ACEI Initial"
    },
    {
      "id": "DOSE033",
      "title": "Ramipril tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01da05d8-e72e-4208-bf92-a5cd929f15ab",
      "scope": "Initiation for post-myocardial infarction heart failure"
    },
    {
      "id": "DOSE034",
      "title": "Enalapril maleate tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=074fe718-88d8-365c-e063-6394a90a299d",
      "scope": "Heart failure onset"
    },
    {
      "id": "DOSE035",
      "title": "Captopril tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1395ba5b-2fc9-41ff-9c43-e0740d781dee",
      "scope": "Initial trial for left ventricular dysfunction after myocardial infarction"
    },
    {
      "id": "DOSE036",
      "title": "Valsartan capsules: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03af7d09-314a-fe85-e063-6294a90afa25",
      "scope": "Adult hypertension, capsules"
    },
    {
      "id": "DOSE037",
      "title": "Losartan potassium tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=021cd76a-b093-4704-8410-5e7d01e20a54",
      "scope": "Adult hypertension"
    },
    {
      "id": "DOSE038",
      "title": "Sacubitril/valsartan sodium tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=000dc81d-ab91-450c-8eae-8eb74e72296f",
      "scope": "HFrEF、Not used or low-dose ACEI/ARB Initial"
    },
    {
      "id": "DOSE039",
      "title": "Spironolactone tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08738ad4-1607-4d55-af71-6790477353bd",
      "scope": "HFrEF Initial"
    },
    {
      "id": "DOSE040",
      "title": "Eplerenone tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1a52bedc-8e2c-4116-a296-a87770676b4a",
      "scope": "After myocardial infarction HFrEF Initial"
    },
    {
      "id": "DOSE041",
      "title": "Furosemide injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08a44bdd-028d-41af-9d4e-70971b0bcc4e",
      "scope": "Initial diuresis for edema"
    },
    {
      "id": "DOSE042",
      "title": "Torasemide injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cf288ad5-d4e7-4b0b-bfd0-41c5327e6984",
      "scope": "Initial diuresis for heart failure-related edema"
    },
    {
      "id": "DOSE043",
      "title": "Dapagliflozin tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01f90c94-71cb-4a1f-81ff-8004b850529b",
      "scope": "Heart failure/CKD Indications"
    },
    {
      "id": "DOSE044",
      "title": "Empagliflozin tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1782b947-4a72-4feb-a488-1469d9af82bd",
      "scope": "Heart failure or 2 Type diabetes mellitus"
    },
    {
      "id": "DOSE045",
      "title": "Norepinephrine bitartrate injection: Reference information on commonly used adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ea48ab6-e166-df31-b132-70ef982a2d02",
      "scope": "Initial vasopressor dosing for acute hypotension, expressed as norepinephrine base."
    },
    {
      "id": "DOSE046",
      "title": "Dobutamine hydrochloride injection: Information on commonly used adult regimens.",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=3418aa46-2d9a-39f3-e063-6294a90a2961",
      "scope": "Initiation of short-term inotropic support for low cardiac output"
    },
    {
      "id": "DOSE047",
      "title": "Dopamine hydrochloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=093312af-6eef-1f4b-e063-6294a90a155d",
      "scope": "Low-rate initiation of dopamine for shock"
    },
    {
      "id": "DOSE048",
      "title": "Epinephrine hydrochloride injection: reference information on common adult regimens",
      "url": "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support",
      "scope": "Adult cardiac arrest resuscitation"
    },
    {
      "id": "DOSE049",
      "title": "Amiodarone hydrochloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a28ae25-7cc4-4ac0-a2ba-7820fb93e25c",
      "scope": "Burden of ventricular arrhythmias with a pulse"
    },
    {
      "id": "DOSE050",
      "title": "Amiodarone hydrochloride tablets: reference information on common adult regimens",
      "url": "https://www.medicines.org.uk/emc/product/101141/smpc",
      "scope": "Oral amiodarone maintenance"
    },
    {
      "id": "DOSE051",
      "title": "Atropine sulfate injection: reference information on common adult regimens",
      "url": "https://www.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Accessible/Algorithm-ACLS-Bradycardia-LngDscrp-250725-Ed.pdf",
      "scope": "Symptomatic bradycardia"
    },
    {
      "id": "DOSE052",
      "title": "Adenosine injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1809fc7e-f5d8-18d8-e063-6394a90a7713",
      "scope": "Initial dose for regular supraventricular tachycardia"
    },
    {
      "id": "DOSE053",
      "title": "Magnesium sulfate injection: reference information on common adult regimens",
      "url": "https://sps.nhs.uk/articles/treating-acute-hypomagnesaemia-in-adults/",
      "scope": "Magnesium replacement for hypomagnesemia when oral administration is not possible"
    },
    {
      "id": "DOSE054",
      "title": "Morphine hydrochloride injection: reference information on common adult regimens",
      "url": "https://www.nhc.gov.cn/wjw/gfxwj/200703/14377de303d6428abc1be6dde4339a71.shtml",
      "scope": "Morphine hydrochloride analgesia for severe pain in adults"
    },
    {
      "id": "DOSE055",
      "title": "Fentanyl citrate injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0c10e465-4117-48ba-a454-23ccb7a3fcc7",
      "scope": "Intervention/Adjunctive analgesia for anesthesia"
    },
    {
      "id": "DOSE056",
      "title": "Lidocaine hydrochloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01679d29-a592-8cbb-e063-6394a90ad82a",
      "scope": "Example of local anesthesia for puncture: 1% formulation without epinephrine"
    },
    {
      "id": "DOSE057",
      "title": "Pantoprazole sodium enteric-coated tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03dea010-4bae-43ab-893e-9bbddb58062d",
      "scope": "Gastroesophageal reflux/Acid suppression"
    },
    {
      "id": "DOSE058",
      "title": "Pantoprazole sodium for injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=014f9762-6948-46b7-8659-5c89f35ad8bf",
      "scope": "Acid suppression when temporarily unable to take oral medication"
    },
    {
      "id": "DOSE059",
      "title": "Rabeprazole sodium enteric-coated tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=04e88b86-e1dd-4c56-8359-45fbcc161f7d",
      "scope": "Gastroesophageal reflux/Acid suppression"
    },
    {
      "id": "DOSE060",
      "title": "Warfarin sodium tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0cbce382-9c88-4f58-ae0f-532a841e8f95",
      "scope": "Initiation when anticoagulation with a vitamin K antagonist is required"
    },
    {
      "id": "DOSE061",
      "title": "Rivaroxaban tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=10db92f9-2300-4a80-836b-673e1ae91610",
      "scope": "Nonvalvular atrial fibrillation，CrCl>50"
    },
    {
      "id": "DOSE062",
      "title": "Apixaban tablets: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=095a08ac-cf0e-497e-a682-ddef38d6b29c",
      "scope": "Nonvalvular atrial fibrillation"
    },
    {
      "id": "DOSE063",
      "title": "Dabigatran etexilate capsules: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13649035-a498-4e31-a7ea-8b18cedceca7",
      "scope": "Standard adult regimen for nonvalvular atrial fibrillation with CrCl >30"
    },
    {
      "id": "DOSE064",
      "title": "Iohexol injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5088be1d-a708-1cac-e063-6394a90a2aff",
      "scope": "Single injection during coronary angiography，350 mgI/mL"
    },
    {
      "id": "DOSE065",
      "title": "Iodixanol injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0fe89ea2-04f7-46c5-9c35-220d8c144a95",
      "scope": "Single injection during right coronary angiography，320 mgI/mL"
    },
    {
      "id": "DOSE066",
      "title": "Sodium chloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=123bd10a-90c7-499e-97f6-acf7e0f0fb4e",
      "scope": "Entry template using 0.9% sodium chloride as the diluent"
    },
    {
      "id": "DOSE067",
      "title": "Glucose injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=4ed365da-4e62-4329-c1b9-c197ab4fb6e1",
      "scope": "Correction of hypoglycemia，50%Glucose"
    },
    {
      "id": "DOSE068",
      "title": "Potassium chloride injection: reference information on common adult regimens",
      "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=559a0a8c-a8fe-40a5-b196-21f9308780ab",
      "scope": "Example of diluted potassium replacement for non-severe hypokalemia"
    }
  ],
  "items": [
    {
      "id": "ami-drug-001",
      "name": "Plain aspirin tablets",
      "pinyin_initials": "asplptp",
      "category": "Antiplatelet",
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
        "frequency": "Once",
        "route": "Chew and swallow",
        "remark": "Loading dose for ACS: 150–300 mg using standard tablets; prescribe enteric-coated tablets separately for maintenance at 75–100 mg once daily. Check the dose already taken to avoid duplicate loading."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "case_template": {
        "dose": "300",
        "unit": "mg",
        "frequency": "Once",
        "route": "Chew and swallow",
        "remark": "Loading medication on admission in this case"
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "ACS Load",
        "dose": "300",
        "unit": "mg",
        "frequency": "Once",
        "route": "Chew and swallow",
        "details": "Immediate-release tablet loading dose 150–300 mg; prescribe enteric-coated tablets separately for maintenance at 75–100 mg once daily. Verify doses already taken to avoid duplicate loading.",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-002",
      "name": "Enteric-coated aspirin tablets",
      "pinyin_initials": "asplcrp",
      "category": "Antiplatelet",
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
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "ACS maintenance therapy; maintenance dose 75–100 mg once daily. Swallow enteric-coated tablets whole; this is not the loading regimen using chewed immediate-release tablets."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "case_template": {
        "dose": "100",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Maintenance medication; swallow tablets whole"
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "ACS Maintain",
        "dose": "100",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Maintenance: 75–100 mg once daily; swallow enteric-coated tablets whole, not a loading regimen using chewed conventional tablets.",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-003",
      "name": "Ticagrelor tablets",
      "pinyin_initials": "tgrlp",
      "category": "Antiplatelet",
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
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Maintenance during the first year after ACS; a single 180 mg loading dose, followed by 90 mg twice daily, approximately every 12 hours. List the loading dose on a separate line; do not duplicate it with the first maintenance dose."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "case_template": {
        "dose": "90",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Maintenance dosing, approximately every 12 hours; verify the loading regimen separately."
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "ACS First-year maintenance",
        "dose": "90",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "A single loading dose of 180 mg, followed by 90 mg twice daily, approximately every 12 hours. List the loading dose separately; do not duplicate it with the first maintenance dose.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1225fd45-9b56-1671-ee77-cd0c9f2174a5",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-004",
      "name": "Clopidogrel bisulfate tablets",
      "pinyin_initials": "lsqlbglp",
      "category": "Antiplatelet",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE004"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "75",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "ACS maintenance; usual single loading dose 300–600 mg, followed by 75 mg once daily; loading regimens differ for PCI and thrombolysis, and require separate verification in older patients receiving thrombolysis."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "ACS Maintain",
        "dose": "75",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Usual loading dose: 300–600 mg once, followed by 75 mg once daily; loading regimens differ for PCI and thrombolysis, and elderly patients receiving thrombolysis require separate verification.",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-005",
      "name": "Prasugrel tablets",
      "pinyin_initials": "plglp",
      "category": "Antiplatelet",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE005"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Maintenance after PCI for ACS; a single 60 mg loading dose, then 10 mg once daily; consider 5 mg if <60 kg; contraindicated with prior stroke/TIA, generally not recommended at age ≥75 years."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "ACS perform PCI Maintained after",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Loading dose: 60 mg once; maintenance: 10 mg once daily; consider 5 mg if <60 kg; contraindicated with prior stroke/TIA and generally not recommended at age ≥75 years.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=35aa7f3e-bbd8-4eae-b61f-29d1abca2224",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-006",
      "name": "Tirofiban hydrochloride injection",
      "pinyin_initials": "ystlfbzsy",
      "category": "Intravenous antiplatelet therapy",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE006"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "25",
        "unit": "μg/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Selective bailout loading dose during PCI; administer 25 μg/kg over 5 minutes, followed by a separately ordered infusion at 0.15 μg/kg/min for up to 18 hours. If CrCl≤60, reduce the infusion rate to 0.075 μg/kg/min. Monitor for bleeding and monitor platelet count."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "PCI Selective rescue loading",
        "dose": "25",
        "unit": "μg/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Administer a loading dose of 25 μg/kg over 5 minutes, followed by a separately ordered infusion at 0.15 μg/kg/min for up to 18 hours. If CrCl≤60, reduce the infusion rate to 0.075 μg/kg/min. Monitor for bleeding and monitor platelet count.",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13ea7fb8-4b01-4286-9464-26c0b624bc3b",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-007",
      "name": "Eptifibatide injection",
      "pinyin_initials": "ytbtzsy",
      "category": "Intravenous antiplatelet therapy",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE007"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "180",
        "unit": "μg/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Selective bailout loading dose during PCI; first dose 180 μg/kg, followed by another 180 μg/kg after 10 minutes, then a separately ordered infusion at 2 μg/kg/min. If CrCl<50, use an infusion rate of 1 μg/kg/min. Contraindicated in patients on dialysis."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "PCI Selective rescue loading",
        "dose": "180",
        "unit": "μg/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Initial dose 180 μg/kg; repeat 180 μg/kg after 10 minutes, followed by a separately ordered pump infusion at 2 μg/kg/min. If CrCl <50, use an infusion rate of 1 μg/kg/min. Contraindicated in dialysis patients.",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00ad7bbe-cadd-4647-b74b-adfc9f2b5e94",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-008",
      "name": "Unfractionated heparin injection",
      "pinyin_initials": "ptgszsy",
      "category": "Anticoagulation",
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
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Dose required; anticoagulation during PCI without concomitant GPI. Adjust according to actual body weight and ACT. With concomitant GPI, the usual dose is 50–70 U/kg. The original case dose of 7000 U is stored separately in the case template and must not be treated as a fixed dose for all patients."
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "case_template": {
        "dose": "7000",
        "unit": "U",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "For this case, use only during intervention, with ACT monitoring; not routine postoperative medication."
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "PCI Intraoperative anticoagulation, not coadministered with GPI",
        "dose": "70–100",
        "unit": "U/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Adjust according to actual body weight and ACT; when used with a GPI, the usual dose is 50–70 U/kg. The original case dose of 7000 U is stored separately in the case template and must not be treated as a fixed dose for all patients.",
        "dose_kind": "range",
        "source_url": "https://professional.heart.org/~/media/PHD-Files-2/Science-News/2/2021/2021-Coronary-Artery-Revascularization-Guideline-Slide-Set.pdf",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-009",
      "name": "Enoxaparin sodium injection",
      "pinyin_initials": "yngsnzsy",
      "category": "Anticoagulation",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE009"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "mg/kg",
        "frequency": "Q12h · each 12 Hours",
        "route": "Subcutaneous injection",
        "remark": "Anticoagulation for STEMI, age <75 years and CrCl ≥30; this row covers the subcutaneous component. A concurrent 30 mg intravenous dose with the first dose is listed separately; each of the first two subcutaneous doses must be ≤100 mg. For age ≥75 years, omit the intravenous loading dose and give 0.75 mg/kg subcutaneously every 12 hours, with each of the first two doses ≤75 mg. For CrCl <30, change to once daily and verify the age-specific regimen."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "STEMI Anticoagulation，<75 Years old and CrCl≥30",
        "dose": "1",
        "unit": "mg/kg",
        "frequency": "Q12h",
        "route": "Subcutaneous injection",
        "details": "This row covers the subcutaneous component; the concurrent initial 30 mg IV dose is listed separately. Each of the first two subcutaneous doses is ≤100 mg. For age ≥75 years, omit the IV loading dose and give 0.75 mg/kg subcutaneously every 12 hours, with each of the first two doses ≤75 mg. For CrCl <30, change to once daily and verify the age-specific regimen.",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=066f27ec-352c-4051-ba29-248e292690db",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-010",
      "name": "Fondaparinux sodium injection",
      "pinyin_initials": "hdggnzsy",
      "category": "Anticoagulation",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE010"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Subcutaneous injection",
        "remark": "Ongoing anticoagulation after STEMI not treated with primary PCI; enter the initial 2.5 mg intravenous STEMI dose on a separate line, followed by subcutaneous dosing once daily for up to 8 days or until discharge. Must not be used alone for intraprocedural anticoagulation during primary PCI. Check renal function and bleeding risk."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Not direct PCI of STEMI Subsequent anticoagulation",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Subcutaneous injection",
        "details": "The initial 2.5 mg intravenous dose for STEMI is listed separately, followed by once-daily subcutaneous dosing for up to 8 days or until discharge; cannot be used alone for procedural anticoagulation during primary PCI. Check renal function and bleeding risk.",
        "dose_kind": "single_dose",
        "source_url": "https://www.medicines.org.uk/emc/product/3335/smpc",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-011",
      "name": "Bivalirudin for injection",
      "pinyin_initials": "zsybfld",
      "category": "Anticoagulation",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE011"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "0.75",
        "unit": "mg/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Bivalirudin loading dose for PCI; immediately follow with a continuous infusion at 1.75 mg/kg/h, entered on a separate line. Recheck ACT at 5 minutes. If CrCl<30, use an infusion rate of 1 mg/kg/h; for dialysis, 0.25 mg/kg/h."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "PCI Bivalirudin loading",
        "dose": "0.75",
        "unit": "mg/kg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Immediately follow with a continuous pump infusion at 1.75 mg/kg/h, listed in a separate row; recheck ACT at 5 minutes. For CrCl <30, use an infusion rate of 1 mg/kg/h; for dialysis, 0.25 mg/kg/h.",
        "dose_kind": "weight_based",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=19a4afc5-151d-4d3c-bfef-48aa8797d695",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-012",
      "name": "Alteplase for injection",
      "pinyin_initials": "zsyatpm",
      "category": "Thrombolysis",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE012"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "15",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Initial phase of the 90-minute accelerated alteplase regimen for AMI; subsequently 0.75 mg/kg (≤50 mg) over 30 minutes, then 0.5 mg/kg (≤35 mg) over 60 minutes, listed in separate rows; total dose ≤100 mg. Screen for thrombolysis indications/contraindications; this is not a stroke regimen."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "First segment of the 90-minute accelerated alteplase regimen for AMI",
        "dose": "15",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Then 0.75 mg/kg (≤50 mg) over 30 minutes, followed by 0.5 mg/kg (≤35 mg) over 60 minutes, each entered on a separate line; total dose ≤100 mg. Screen for thrombolysis indications and contraindications. Not a stroke regimen.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=c669f77c-fa48-478b-a14b-80b20a0139c2",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-013",
      "name": "Reteplase for injection",
      "pinyin_initials": "zsyrtpm",
      "category": "Thrombolysis",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE013"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "MU",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Initial reteplase dose for STEMI; 10 MU = 10 million U, given intravenously over at least 2 minutes; repeat 10 MU after 30 minutes, listed on a separate line; MU must not be treated as mg or standard U."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "STEMI First dose of reteplase",
        "dose": "10",
        "unit": "MU",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "10 MU = 10 million U; inject IV over at least 2 minutes. Repeat 10 MU after 30 minutes, listed on a separate line. Do not treat MU as mg or ordinary U.",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-014",
      "name": "Tenecteplase for injection",
      "pinyin_initials": "zsytnpm",
      "category": "Thrombolysis",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE014"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Dose entry required; STEMI, weight-tiered dosing regimen for TNKase: <60 kg: 30 mg; 60–<70: 35 mg; 70–<80: 40 mg; 80–<90: 45 mg; ≥90: 50 mg, administered intravenously over 5 seconds. First determine a single dose based on body weight; verify the dose-reduction strategy in older patients. This regimen must not be directly applied to the domestic 16 mg rhTNK-tPA formulation."
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "STEMI，TNKase Weight-tiered formulation regimen",
        "dose": "30–50",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "<60 kg: 30 mg; 60–<70: 35 mg; 70–<80: 40 mg; 80–<90: 45 mg; ≥90: 50 mg, IV injection over 5 seconds. First determine a single dose based on weight; verify the dose-reduction strategy in older patients. This regimen must not be directly applied to the domestic 16 mg rhTNK-tPA formulation.",
        "dose_kind": "range",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=e647640d-c395-4b4b-a0be-1162f9c21d84",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-015",
      "name": "Urokinase for injection",
      "pinyin_initials": "zsynjm",
      "category": "Thrombolysis",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE015"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "150",
        "unit": "ten thousand U",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "remark": "Urokinase thrombolysis for STEMI: dissolve 1.5 million U in 100 mL normal saline and infuse over 30 minutes; screen for thrombolysis contraindications and provide accompanying antithrombotic monitoring."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "STEMI Thrombolysis with urokinase",
        "dose": "150",
        "unit": "ten thousand U",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "details": "Dissolve 1.5 million units in 100 mL normal saline and infuse over 30 minutes; screen for contraindications to thrombolysis and provide accompanying antithrombotic monitoring.",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-016",
      "name": "Atorvastatin calcium tablets",
      "pinyin_initials": "atfttgp",
      "category": "Lipid lowering",
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
        "frequency": "Qn · Once nightly",
        "route": "Oral",
        "remark": "Intensive lipid lowering for ACS; usual dose 40–80 mg once daily; in this case, 40 mg nightly, avoiding a duplicate dose on the day of the initial dose; adjust according to tolerance, liver function, and interactions."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "case_template": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qn · Once nightly",
        "route": "Oral",
        "remark": "Maintenance regimen for this case; do not repeat on the day of the first dose"
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "ACS Intensive lipid lowering",
        "dose": "40",
        "unit": "mg",
        "frequency": "Qn",
        "route": "Oral",
        "details": "Typically 40–80 mg once daily; in this case, 40 mg each evening. Avoid duplicate dosing on the first day; adjust according to tolerability, liver function, and interactions.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00afce9b-48c9-487a-a738-e359c005c707",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-017",
      "name": "Rosuvastatin calcium tablets",
      "pinyin_initials": "rsfttgp",
      "category": "Lipid lowering",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE017"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initial lipid-lowering therapy in Asian adults; the prescribing information recommends starting at 5 mg in Asian adults. Intensive lipid lowering in ACS commonly uses 20 mg once daily, with adjustment after assessment; do not use 40 mg by default. In severe renal impairment, start at 5 mg and do not exceed 10 mg."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial lipid-lowering therapy in Asian adults",
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Prescribing information recommends a starting dose of 5 mg for Asian adults. Intensive lipid lowering in ACS commonly uses 20 mg once daily, adjusted after assessment; do not default to 40 mg. In severe renal impairment, start at 5 mg and do not exceed 10 mg.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02797697-300a-43db-92cf-9b78f08626be",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-018",
      "name": "Ezetimibe tablets",
      "pinyin_initials": "yzmbp",
      "category": "Lipid lowering",
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
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Lowers LDL-C; 10 mg once daily, may be combined with a statin. The total milligram strength of a combination product must not be applied to a single-ingredient product."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "case_template": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "This case 9 month 2 Use starting on"
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "decrease LDL-C",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "10 mg once daily; may be combined with a statin. Do not apply the total milligram strength of a combination product to a single-ingredient product.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02b00cb2-7253-4fb4-a216-53691a929a28",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-019",
      "name": "Evolocumab injection",
      "pinyin_initials": "ylydkzsy",
      "category": "Lipid lowering",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE019"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "140",
        "unit": "mg",
        "frequency": "each 2 Once a week",
        "route": "Subcutaneous injection",
        "remark": "Lipid lowering with a PCSK9 inhibitor: 140 mg every 2 weeks or 420 mg once monthly. Choose one regimen and record actual administration dates."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "PCSK9 Lipid lowering with inhibitors",
        "dose": "140",
        "unit": "mg",
        "frequency": "each 2 Once a week",
        "route": "Subcutaneous injection",
        "details": "140 mg once every 2 weeks or 420 mg once monthly; choose one regimen and record actual administration dates.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cd61e902-166d-4aa6-9f3c-a18c1008d07e",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-020",
      "name": "Alirocumab injection",
      "pinyin_initials": "alxydkzsy",
      "category": "Lipid lowering",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE020"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "75",
        "unit": "mg",
        "frequency": "each 2 Once a week",
        "route": "Subcutaneous injection",
        "remark": "Initiation of lipid-lowering therapy with a PCSK9 inhibitor; 75 mg every 2 weeks or 300 mg every 4 weeks; if the LDL-C response is inadequate, adjust to 150 mg every 2 weeks. Do not combine the two regimens."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "PCSK9 Initiation of inhibitor therapy for lipid lowering",
        "dose": "75",
        "unit": "mg",
        "frequency": "each 2 Once a week",
        "route": "Subcutaneous injection",
        "details": "75 mg every 2 weeks or 300 mg every 4 weeks; if the LDL-C response is inadequate, adjust to 150 mg every 2 weeks. Do not combine the two regimens.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=446f6b5c-0dd4-44ff-9bc2-c2b41f2806b4",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-021",
      "name": "Inclisiran sodium injection",
      "pinyin_initials": "ykslnzsy",
      "category": "Lipid lowering",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE021"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "284",
        "unit": "mg",
        "frequency": "Once",
        "route": "Subcutaneous injection",
        "remark": "Initial inclisiran injection; dose expressed as 284 mg of active inclisiran (equivalent to 300 mg inclisiran sodium); at month 0, month 3, and every 6 months thereafter. Record administration dates."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial inclisiran injection",
        "dose": "284",
        "unit": "mg",
        "frequency": "Once",
        "route": "Subcutaneous injection",
        "details": "Based on 284 mg of active inclisiran (equivalent to 300 mg inclisiran sodium); administer at month 0, month 3, and every 6 months thereafter; document administration dates.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=6fc0afca-4513-4c35-b594-6544aee29a44",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-022",
      "name": "Bempedoic acid tablets",
      "pinyin_initials": "bpdsp",
      "category": "Lipid lowering",
      "catalog_role": "guideline",
      "source_ids": [
        "ACS2025",
        "DOSE022"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "180",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Bempedoic acid for lipid lowering; 180 mg once daily; monitor uric acid, gout, and tendon symptoms. Verify local availability and approved indications."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Guideline-related alternatives; select according to current indications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Bempedoic acid for lipid lowering",
        "dose": "180",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "180 mg once daily; monitor uric acid, gout, and tendon symptoms. Local availability and approved indications require verification.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=88d06d89-a3da-40b4-b273-8f4f7d56c4c9",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-023",
      "name": "Nitroglycerin tablets",
      "pinyin_initials": "xsgyp",
      "category": "Anti-ischemic/Nitrates",
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
        "frequency": "Once",
        "route": "Sublingual administration",
        "remark": "For an episode of ischemic chest pain: 0.3–0.6 mg per dose, repeated every 5 minutes if needed, up to 3 doses in total; first check blood pressure, right ventricular infarction, and recent PDE5 inhibitor use."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "case_template": {
        "dose": "0.5",
        "unit": "mg",
        "frequency": "Once",
        "route": "Sublingual administration",
        "remark": "Single dose on admission in this case; check blood pressure and contraindications before use"
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "Episode of ischemic chest pain",
        "dose": "0.5",
        "unit": "mg",
        "frequency": "Once",
        "route": "Sublingual administration",
        "details": "0.3–0.6 mg per dose, repeated every 5 minutes if needed, up to 3 doses total; first check blood pressure, right ventricular infarction, and recent PDE5 inhibitor use.",
        "dose_kind": "single_dose",
        "source_url": "https://cmab.yiigle.com/uploads/guide_html/Acute ST-segment elevation myocardial infarction diagnosis and treatment guideline（2019）.html",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-024",
      "name": "Nitroglycerin injection",
      "pinyin_initials": "xsgyzsy",
      "category": "Anti-ischemic/Nitrates",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE024"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "μg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "remark": "Initial intravenous nitrate therapy for persistent ischemic chest pain; start at 5 μg/min and titrate every 3–5 minutes according to blood pressure and symptoms. Dilute and use appropriate tubing; do not administer by IV push. This dose is an infusion rate, not a single total dose."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation of intravenous nitrates for persistent ischemic chest pain",
        "dose": "5",
        "unit": "μg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "details": "Start at 5 μg/min and titrate every 3–5 minutes according to blood pressure and symptoms; dilute and use appropriate tubing; do not administer by IV push. This dose is an infusion rate, not a total single dose.",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=578d8159-5ec6-457f-b4a8-9add624d43a8",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-025",
      "name": "Isosorbide dinitrate tablets",
      "pinyin_initials": "xsyslzp",
      "category": "Anti-ischemic/Nitrates",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE025"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Angina prophylaxis, immediate-release tablets; initial dose 5–20 mg twice or three times daily; maintenance 10–40 mg twice or three times daily. Schedule a drug-free interval of at least 14 hours daily; do not use rigid equal intervals to provide 24-hour coverage."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Angina prophylaxis, immediate-release tablets",
        "dose": "10",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "Start at 5–20 mg twice or three times daily; maintenance 10–40 mg twice or three times daily. Schedule a drug-free interval of at least 14 hours daily; do not mechanically space doses evenly over 24 hours.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0e5842f2-74f6-1f02-01bc-07578bd3b393",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-026",
      "name": "Isosorbide mononitrate extended-release tablets",
      "pinyin_initials": "dxsyslzhsp",
      "category": "Anti-ischemic/Nitrates",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE026"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "30",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Angina prophylaxis, extended-release tablets; 30–60 mg once each morning, adjusted according to response; do not chew, and do not use for immediate relief of chest pain."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Angina prophylaxis, extended-release tablets",
        "dose": "30",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "30–60 mg once each morning, adjustable according to response; do not chew or crush. Not for immediate relief of chest pain.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a1e317a-7b05-4d30-9bbc-1d4ccd56ba3c",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-027",
      "name": "Metoprolol succinate extended-release tablets",
      "pinyin_initials": "hpsmtlehsp",
      "category": "βReceptor blocker",
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
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "In this case, initiate a beta-blocker after stabilization; start at 23.75 mg once daily and increase to 47.5 mg if tolerated. Titrate according to heart rate, blood pressure, and heart failure status. Express the dose as the succinate salt; do not mix this with the equivalent 25 mg tartrate-based labeling used in the US."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "case_template": {
        "dose": "23.75",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initial dose for this case; subsequently reassess and adjust according to heart rate, blood pressure, and other parameters."
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation of a beta-blocker after stabilization in this case",
        "dose": "23.75",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "In this case, 23.75 mg once daily, increasing to 47.5 mg once tolerated; titrate according to heart rate, blood pressure, and heart failure status. Doses are expressed as the succinate salt; do not mix this with the US labeling of 25 mg as the tartrate-equivalent dose.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01908d20-0e16-4410-bd27-1b6df162ede4",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification",
        "case_source": "../../build_case_pdf.py"
      }
    },
    {
      "id": "ami-drug-028",
      "name": "Metoprolol tartrate tablets",
      "pinyin_initials": "jssmtlep",
      "category": "βReceptor blocker",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE028"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Stable angina, immediate-release tablets; usual starting total dose 100 mg/day in 2 divided doses, with or after meals; early acute MI requires smaller doses and closer assessment, and this stable-phase regimen must not be applied directly."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Stable angina, immediate-release tablets",
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "Usual initial total dose: 100 mg/day in 2 divided doses, with or after meals; early acute MI requires smaller doses and closer assessment, and this stable-phase regimen must not be applied directly.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00de1f16-f979-4dbf-aa60-246ffac8d410",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-029",
      "name": "Bisoprolol fumarate tablets",
      "pinyin_initials": "fmsbslep",
      "category": "βReceptor blocker",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE029"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initial treatment for adult hypertension; usually 5 mg once daily. Some patients or those with hepatic/renal impairment start at 2.5 mg, adjusted according to heart rate and blood pressure. A separate initiation regimen is required for heart failure."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation for adult hypertension",
        "dose": "5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Usually 5 mg once daily; start at 2.5 mg in selected patients or those with hepatic/renal impairment, and adjust according to heart rate and blood pressure. A separate initiation regimen is required for heart failure.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=084308e4-3b8b-40d6-acbf-d775772a8a73",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-030",
      "name": "Carvedilol tablets",
      "pinyin_initials": "kwdlp",
      "category": "βReceptor blocker",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE030"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "3.125",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Initiation for stable chronic heart failure; take with food; increase gradually at intervals of at least 2 weeks to 6.25, 12.5, and 25 mg twice daily. For left ventricular dysfunction after myocardial infarction, the prescribing information commonly recommends starting at 6.25 mg twice daily; a lower dose may be used in patients with poor tolerance."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation for stable chronic heart failure",
        "dose": "3.125",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "Take with food; increase gradually at intervals of at least 2 weeks to 6.25, 12.5, and 25 mg twice daily. For post-myocardial infarction left ventricular dysfunction, prescribing information commonly specifies a starting dose of 6.25 mg twice daily; a lower dose may be used if poorly tolerated.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=010290af-81f4-0037-e063-6394a90a4638",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-031",
      "name": "Esmolol hydrochloride injection",
      "pinyin_initials": "ysaslezsy",
      "category": "βReceptor blocker",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE031"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "μg/kg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "remark": "Initial maintenance infusion for rate control in supraventricular tachycardia; an initial loading dose of 500 μg/kg over 1 minute may be entered on a separate line, followed by 50 μg/kg/min. Assess for titration after ≥4 minutes. Usual range: 50–200 μg/kg/min. Monitor blood pressure and heart rate."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation of maintenance rate control for supraventricular tachycardia",
        "dose": "50",
        "unit": "μg/kg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "details": "An initial loading dose of 500 μg/kg over 1 minute may be entered on a separate line, followed by 50 μg/kg/min; assess for titration after ≥4 minutes. Usual range 50–200 μg/kg/min; monitor blood pressure and heart rate.",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=017023a9-00f0-4284-861f-a3634d4fdb17",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-032",
      "name": "Perindopril tert-butylamine tablets",
      "pinyin_initials": "pdplsdap",
      "category": "RAAS Related medications",
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
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "ACEI initiation in this case: tert-butylamine salt 2 mg once daily, increasing to 4 mg if tolerated. General labeling for stable coronary artery disease specifies a starting dose of 4 mg, increasing to 8 mg. Different salt forms must not be substituted milligram for milligram. Monitor blood pressure, creatinine, and serum potassium."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "case_template": {
        "dose": "2",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initial dose for this case, tert-butylamine salt; reassess and adjust subsequently"
      },
      "common_regimen": {
        "population": "Adult",
        "indication": "This case ACEI Initial",
        "dose": "2",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "In this case, the tert-butylamine salt is given at 2 mg once daily, increased to 4 mg if tolerated; prescribing information for stable coronary artery disease generally recommends starting at 4 mg and increasing to 8 mg. Different salt forms are not interchangeable on a milligram-for-milligram basis. Monitor blood pressure, creatinine, and serum potassium.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=87768fbf-7c63-47da-8925-0316f343d6ef",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification",
        "case_source": "../../build_case_pdf.py"
      }
    },
    {
      "id": "ami-drug-033",
      "name": "Ramipril tablets",
      "pinyin_initials": "lmplp",
      "category": "RAAS Related medications",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE033"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Initiation for post-myocardial infarction heart failure: 2.5 mg twice daily; may reduce to 1.25 mg twice daily for hypotension, then gradually increase to 5 mg twice daily. Monitor blood pressure, renal function, and serum potassium."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation for post-myocardial infarction heart failure",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "2.5 mg twice daily; may reduce to 1.25 mg twice daily for hypotension, then gradually increase to 5 mg twice daily; monitor blood pressure, renal function, and serum potassium.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01da05d8-e72e-4208-bf92-a5cd929f15ab",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-034",
      "name": "Enalapril maleate tablets",
      "pinyin_initials": "mlsynplp",
      "category": "RAAS Related medications",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE034"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Initiation for heart failure; start at 2.5 mg BID and gradually titrate as tolerated; usual range 2.5–20 mg BID; monitor blood pressure, creatinine, and serum potassium."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Heart failure onset",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "Start at 2.5 mg twice daily and titrate gradually as tolerated; usual range 2.5–20 mg twice daily; monitor blood pressure, creatinine, and serum potassium.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=074fe718-88d8-365c-e063-6394a90a299d",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-035",
      "name": "Captopril tablets",
      "pinyin_initials": "ktplp",
      "category": "RAAS Related medications",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE035"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "6.25",
        "unit": "mg",
        "frequency": "Once",
        "route": "Oral",
        "remark": "Initial trial for post-MI left ventricular dysfunction; first dose 6.25 mg, then 12.5 mg three times daily, gradually increasing to 25–50 mg three times daily. Take 1 hour before meals. Enter subsequent regimens on separate lines. Monitor blood pressure, renal function, and serum potassium."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial trial for left ventricular dysfunction after myocardial infarction",
        "dose": "6.25",
        "unit": "mg",
        "frequency": "Once",
        "route": "Oral",
        "details": "Initial dose 6.25 mg, then 12.5 mg three times daily, gradually increased to 25–50 mg three times daily; take 1 hour before meals. Subsequent regimens are listed separately. Monitor blood pressure, renal function, and serum potassium.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1395ba5b-2fc9-41ff-9c43-e0740d781dee",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-036",
      "name": "Valsartan capsules",
      "pinyin_initials": "xstjn",
      "category": "RAAS Related medications",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE036"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "80",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Adult hypertension, capsules; usual starting dose for hypertension is 80–160 mg once daily, adjusted to response. A starting regimen of 20 mg twice daily is available for post-myocardial infarction left ventricular dysfunction; choose another dosage form that accurately delivers 20 mg. Do not open an 80 mg capsule to estimate the dose."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Adult hypertension, capsules",
        "dose": "80",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "For hypertension, the usual starting dose is 80–160 mg once daily, adjusted according to response. A starting regimen of 20 mg twice daily is available for left ventricular dysfunction after myocardial infarction; select a dosage form that accurately delivers 20 mg rather than opening an 80 mg capsule and estimating the amount.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03af7d09-314a-fe85-e063-6294a90afa25",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-037",
      "name": "Losartan potassium tablets",
      "pinyin_initials": "lstjp",
      "category": "RAAS Related medications",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE037"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Adult hypertension: 50 mg once daily; may start at 25 mg in volume depletion or hepatic impairment, with adjustment up to 100 mg once daily. Monitor blood pressure, renal function, and serum potassium."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Adult hypertension",
        "dose": "50",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "50 mg once daily; may start at 25 mg in volume depletion or hepatic impairment, and may titrate to 100 mg once daily. Monitor blood pressure, renal function, and serum potassium.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=021cd76a-b093-4704-8410-5e7d01e20a54",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-038",
      "name": "Sacubitril/valsartan sodium tablets",
      "pinyin_initials": "skbqxstnp",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE038"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "For HFrEF, initiation in patients taking no ACEI/ARB or only a low dose; a 50 mg total combination dose corresponds to approximately 24/26 mg of the two components. The usual starting dose is 100 mg twice daily, with a target of 200 mg twice daily if tolerated. Allow at least 36 hours after stopping an ACEI; do not combine with an ACEI/ARB. Monitor blood pressure, renal function, and serum potassium."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "HFrEF、Not used or low-dose ACEI/ARB Initial",
        "dose": "50",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "A 50 mg total combination dose ≈24/26 mg of the two components. Usual starting dose: 100 mg twice daily; target: 200 mg twice daily if tolerated. Allow at least 36 hours after stopping an ACEI. Do not combine with an ACEI/ARB. Monitor blood pressure, renal function, and serum potassium.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=000dc81d-ab91-450c-8eae-8eb74e72296f",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-039",
      "name": "Spironolactone tablets",
      "pinyin_initials": "lnzp",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE039"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initiation for HFrEF; 25 mg once daily is appropriate when serum potassium ≤5.0 and eGFR>50. For eGFR 30–50, consider 25 mg every other day, adjusting according to serum potassium and renal function. Match the regimen to an available strength."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "HFrEF Initial",
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "25 mg once daily is appropriate when serum potassium is ≤5.0 and eGFR >50; for eGFR 30–50, consider 25 mg every other day, adjusting according to serum potassium and renal function; match the available strength.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08738ad4-1607-4d55-af71-6790477353bd",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-040",
      "name": "Eplerenone tablets",
      "pinyin_initials": "ypltp",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE040"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initiation for HFrEF after MI; 25 mg once daily, increasing to 50 mg once daily within 4 weeks if tolerated; reduce the dose or discontinue if serum potassium rises; contraindicated at CrCl ≤30."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "After myocardial infarction HFrEF Initial",
        "dose": "25",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "25 mg once daily, increasing to 50 mg once daily within 4 weeks if tolerated; reduce the dose or discontinue if potassium rises. Contraindicated if CrCl ≤30.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1a52bedc-8e2c-4116-a296-a87770676b4a",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-041",
      "name": "Furosemide injection",
      "pinyin_initials": "fsmzsy",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE041"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Initial diuresis for edema; usually 20–40 mg by slow IV injection over 1–2 minutes; for acute pulmonary edema, usually start at 40 mg and adjust according to prior diuretic use, urine output, blood pressure, and electrolytes."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial diuresis for edema",
        "dose": "20",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Typically 20–40 mg by slow IV injection over 1–2 minutes; acute pulmonary edema typically starts at 40 mg, adjusted according to prior diuretic use, urine output, blood pressure, and electrolytes.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=08a44bdd-028d-41af-9d4e-70971b0bcc4e",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-042",
      "name": "Torasemide injection",
      "pinyin_initials": "tlsmzsy",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE042"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Intravenous injection",
        "remark": "Initial diuresis for edema due to heart failure; usual dose 10–20 mg once daily, administered by slow IV injection over approximately 2 minutes; adjust according to urine output and renal function, and monitor electrolytes."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial diuresis for heart failure-related edema",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Intravenous injection",
        "details": "Usual dose: 10–20 mg once daily by slow intravenous injection over approximately 2 minutes; adjust according to urine output and renal function, and monitor electrolytes.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=cf288ad5-d4e7-4b0b-bfd0-41c5327e6984",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-043",
      "name": "Dapagliflozin tablets",
      "pinyin_initials": "dgljp",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE043"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "For heart failure/CKD indications: 10 mg once daily. Assess renal function and volume status; do not routinely initiate during acute critical illness, ketosis, or fasting. A perioperative withholding plan is required."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Heart failure/CKD Indications",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "10 mg once daily; assess renal function and volume status. Do not routinely initiate during acute critical illness, ketosis, or fasting; a perioperative withholding plan is required.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01f90c94-71cb-4a1f-81ff-8004b850529b",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-044",
      "name": "Empagliflozin tablets",
      "pinyin_initials": "egljp",
      "category": "With concomitant heart failure/Volume management",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE044"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Heart failure or type 2 diabetes; 10 mg every morning; consider 25 mg only for additional glycemic control, not as an automatic increase of the heart failure dose to 25 mg; check renal function, fasting status, and ketosis risk."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Heart failure or 2 Type diabetes mellitus",
        "dose": "10",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "10 mg every morning; consider 25 mg only if further glucose lowering is needed. Do not automatically increase the heart failure dose to 25 mg. Check renal function, fasting status, and ketosis risk.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1782b947-4a72-4feb-a488-1469d9af82bd",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-045",
      "name": "Norepinephrine bitartrate injection",
      "pinyin_initials": "zjssqjssxszsy",
      "category": "Emergency care/Hemodynamics",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE045"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "8",
        "unit": "μg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "remark": "Initial vasopressor dosing for acute hypotension, expressed as norepinephrine base. The usual labeled starting dose is 8–12 μg/min, titrated to perfusion and blood pressure. Assess volume status first, specify the dilution concentration, and prevent extravasation. The unit is not μg/kg/min; these must not be interchanged."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial vasopressor dosing for acute hypotension, expressed as norepinephrine base.",
        "dose": "8",
        "unit": "μg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "details": "Usual starting dose per prescribing information: 8–12 μg/min, titrated to perfusion and blood pressure; assess volume status first, confirm dilution concentration, and prevent extravasation; the unit is not μg/kg/min, and the two must not be confused.",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ea48ab6-e166-df31-b132-70ef982a2d02",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-046",
      "name": "Dobutamine hydrochloride injection",
      "pinyin_initials": "ysdbfdazsy",
      "category": "Emergency care/Hemodynamics",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE046"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "0.5",
        "unit": "μg/kg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "remark": "Initiation of short-term inotropic support for low cardiac output; start at 0.5–1 μg/kg/min, usual range 2–20 μg/kg/min, titrated to hemodynamics; continuous monitoring required, not a single IV push."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation of short-term inotropic support for low cardiac output",
        "dose": "0.5",
        "unit": "μg/kg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "details": "Start at 0.5–1 μg/kg/min; usual range 2–20 μg/kg/min, titrated to hemodynamics; continuous monitoring required, not a single IV push.",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=3418aa46-2d9a-39f3-e063-6294a90a2961",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-047",
      "name": "Dopamine hydrochloride injection",
      "pinyin_initials": "ysdbazsy",
      "category": "Emergency care/Hemodynamics",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE047"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "μg/kg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "remark": "Low-rate dopamine initiation for shock; the labeled low starting rate is 2–5 μg/kg/min, with gradual titration. Not for renal protection. The bradycardia algorithm uses 5–20 μg/kg/min; select separately according to the clinical scenario."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Low-rate initiation of dopamine for shock",
        "dose": "2.5",
        "unit": "μg/kg/min",
        "frequency": "Persistent",
        "route": "Intravenous infusion via pump",
        "details": "The prescribing information recommends starting at a low infusion rate of 2–5 μg/kg/min and titrating gradually; not for renal protection. The bradycardia algorithm uses 5–20 μg/kg/min; select separately according to the clinical scenario.",
        "dose_kind": "rate",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=093312af-6eef-1f4b-e063-6294a90a155d",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-048",
      "name": "Epinephrine hydrochloride injection",
      "pinyin_initials": "ysssxszsy",
      "category": "Emergency care/Hemodynamics",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE048"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "mg",
        "frequency": "ST · Once immediately",
        "route": "Intravenous injection",
        "remark": "Adult cardiac arrest resuscitation; 1 mg IV, repeatable every 3–5 minutes; verify the concentration for resuscitation use. This entry does not apply to continuous infusion for hypotension with a pulse or IM injection for anaphylaxis."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Adult cardiac arrest resuscitation",
        "dose": "1",
        "unit": "mg",
        "frequency": "ST",
        "route": "Intravenous injection",
        "details": "1 mg IV, repeatable every 3–5 minutes; verify the concentration used for resuscitation. This entry does not apply to continuous infusion for hypotension with a pulse or intramuscular injection for an allergic reaction.",
        "dose_kind": "single_dose",
        "source_url": "https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-049",
      "name": "Amiodarone hydrochloride injection",
      "pinyin_initials": "ysadtzsy",
      "category": "Arrhythmia-related",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE049"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "150",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "remark": "Loading dose for ventricular arrhythmia with a pulse; dilute 150 mg in 5% glucose and infuse over 10 minutes; then 1 mg/min for 6 hours, followed by 0.5 mg/min for 18 hours, each listed in a separate row. The cardiac arrest regimen differs."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Burden of ventricular arrhythmias with a pulse",
        "dose": "150",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "details": "Dilute 150 mg in 5% glucose and infuse over 10 minutes; then 1 mg/min for 6 hours, followed by 0.5 mg/min for 18 hours, each listed in a separate row. The cardiac arrest regimen differs.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0a28ae25-7cc4-4ac0-a2ba-7820fb93e25c",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-050",
      "name": "Amiodarone hydrochloride tablets",
      "pinyin_initials": "ysadtp",
      "category": "Arrhythmia-related",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE050"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "200",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Oral amiodarone maintenance; usual maintenance dose: 200 mg/day or lower. Oral loading at 200 mg three times daily for one week, then twice daily for one week, requires specialist assessment. Monitor QT, thyroid function, and hepatic and pulmonary status. Do not automatically apply the loading regimen."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Oral amiodarone maintenance",
        "dose": "200",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Usual maintenance dose: 200 mg/day or less. Oral loading at 200 mg three times daily for one week, then twice daily for one week, requires specialist assessment. Monitor QT, thyroid function, and hepatic and pulmonary status; do not automatically apply a loading regimen.",
        "dose_kind": "single_dose",
        "source_url": "https://www.medicines.org.uk/emc/product/101141/smpc",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-051",
      "name": "Atropine sulfate injection",
      "pinyin_initials": "lsatpzsy",
      "category": "Arrhythmia-related",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE051"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "mg",
        "frequency": "ST · Once immediately",
        "route": "Intravenous injection",
        "remark": "Symptomatic bradycardia; 1 mg IV, repeat every 3–5 minutes if needed, to a maximum total dose of 3 mg; if ineffective, escalate treatment according to the resuscitation protocol."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Symptomatic bradycardia",
        "dose": "1",
        "unit": "mg",
        "frequency": "ST",
        "route": "Intravenous injection",
        "details": "1 mg IV, repeat every 3–5 minutes if needed, up to a total of 3 mg; if ineffective, escalate treatment according to the resuscitation protocol.",
        "dose_kind": "single_dose",
        "source_url": "https://www.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Accessible/Algorithm-ACLS-Bradycardia-LngDscrp-250725-Ed.pdf",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-052",
      "name": "Adenosine injection",
      "pinyin_initials": "xgzsy",
      "category": "Arrhythmia-related",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE052"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "6",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Initial dose for regular supraventricular tachycardia; rapid IV push over 1–2 seconds, immediately followed by a saline flush. If conversion does not occur within 1–2 minutes, 12 mg may be given, listed separately. Verify rhythm, bronchospasm, and contraindications."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initial dose for regular supraventricular tachycardia",
        "dose": "6",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Rapid IV push over 1–2 seconds, immediately followed by a saline flush; if conversion has not occurred within 1–2 minutes, 12 mg may be given, listed in a separate row; verify rhythm, bronchospasm, and contraindications.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1809fc7e-f5d8-18d8-e063-6394a90a7713",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-053",
      "name": "Magnesium sulfate injection",
      "pinyin_initials": "lsmzsy",
      "category": "Arrhythmia-related",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE053"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "1",
        "unit": "g",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "remark": "Magnesium replacement for hypomagnesemia when oral administration is not possible; initial dose 1–5 g according to serum magnesium, usually diluted and infused at 1–2 g/h. Reduce the dose in renal impairment and monitor serum magnesium, ECG, and blood pressure. This entry is for replacement in hypomagnesemia, not routine magnesium administration for myocardial infarction or an emergency regimen for torsades de pointes."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Magnesium replacement for hypomagnesemia when oral administration is not possible",
        "dose": "1",
        "unit": "g",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "details": "Initial dose 1–5 g selected according to serum magnesium, usually diluted and infused at 1–2 g/h. Reduce the dose in renal impairment and monitor serum magnesium, ECG, and blood pressure. This entry is for magnesium replacement in hypomagnesemia, not routine magnesium administration in myocardial infarction or emergency treatment of torsades de pointes.",
        "dose_kind": "single_dose",
        "source_url": "https://sps.nhs.uk/articles/treating-acute-hypomagnesaemia-in-adults/",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-054",
      "name": "Morphine hydrochloride injection",
      "pinyin_initials": "ysmfzsy",
      "category": "Analgesia/Local anesthesia",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE054"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Morphine hydrochloride for severe pain in adults; the usual adult analgesic dose is 5–10 mg by slow IV injection, with dose reduction and titration based on prior opioid exposure and respiratory and circulatory status. In ACS, use only for refractory pain on an individualized basis; it may delay absorption of oral antiplatelet agents."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Morphine hydrochloride analgesia for severe pain in adults",
        "dose": "5",
        "unit": "mg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Usual adult analgesic dose: 5–10 mg by slow intravenous injection, with downward dose adjustment and titration according to prior opioid exposure and respiratory and circulatory status. In ACS, use only on an individualized basis for refractory pain; it may delay absorption of oral antiplatelet agents.",
        "dose_kind": "single_dose",
        "source_url": "https://www.nhc.gov.cn/wjw/gfxwj/200703/14377de303d6428abc1be6dde4339a71.shtml",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-055",
      "name": "Fentanyl citrate injection",
      "pinyin_initials": "jysftnzsy",
      "category": "Analgesia/Local anesthesia",
      "catalog_role": "conditional",
      "source_ids": [
        "CN2019",
        "DOSE055"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "50",
        "unit": "μg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "remark": "Adjunctive analgesia for interventional procedures/anesthesia; usual initial adult dose 50–100 μg (expressed as fentanyl), administered slowly with respiratory and blood pressure monitoring; airway management and resuscitation capabilities must be available."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Intervention/Adjunctive analgesia for anesthesia",
        "dose": "50",
        "unit": "μg",
        "frequency": "Once",
        "route": "Intravenous injection",
        "details": "Usual adult initial dose: 50–100 μg (as fentanyl), administered slowly with respiratory and blood pressure monitoring; airway management and resuscitation facilities must be available.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0c10e465-4117-48ba-a454-23ccb7a3fcc7",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-056",
      "name": "Lidocaine hydrochloride injection",
      "pinyin_initials": "ysldkyzsy",
      "category": "Analgesia/Local anesthesia",
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
        "frequency": "Once",
        "route": "Local infiltration",
        "remark": "Dose must be entered; example of local anesthesia for puncture using a 1% preparation without epinephrine. 50 mg = 5 mL of 1% solution, a template for small-volume local infiltration; use the lowest effective dose for the area involved. Without epinephrine, the total dose must not exceed 4.5 mg/kg or 300 mg; reduce the dose in cardiac/hepatic disease. This is not an intravenous antiarrhythmic regimen."
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Restricted to specific clinical situations; verify indications and contraindications",
      "common_regimen": {
        "population": "Adult",
        "indication": "Example of local anesthesia for puncture: 1% formulation without epinephrine",
        "dose": "50",
        "unit": "mg",
        "frequency": "Once",
        "route": "Local infiltration",
        "details": "50 mg = 5 mL of a 1% solution; a template for small-volume local infiltration. Use the lowest effective dose for the area treated. Without epinephrine, the total must not exceed 4.5 mg/kg or 300 mg; reduce the dose in cardiac or hepatic disease. Not an intravenous antiarrhythmic regimen.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=01679d29-a592-8cbb-e063-6394a90ad82a",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification",
        "template_note": "The specific example doses are teaching entry templates within the principles of the prescribing information, not standardized doses mandated by guidelines."
      }
    },
    {
      "id": "ami-drug-057",
      "name": "Pantoprazole sodium enteric-coated tablets",
      "pinyin_initials": "ptlzncrp",
      "category": "Gastrointestinal protection",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE057"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Gastroesophageal reflux/acid suppression; 40 mg once daily; swallow enteric-coated tablets whole. Gastrointestinal protection in ACS should be selected according to bleeding risk, not prescribed routinely for everyone."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Gastroesophageal reflux/Acid suppression",
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "40 mg once daily; swallow enteric-coated tablets whole. Gastroprotection in ACS is selected according to bleeding risk, not routinely prescribed for everyone.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=03dea010-4bae-43ab-893e-9bbddb58062d",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-058",
      "name": "Pantoprazole sodium for injection",
      "pinyin_initials": "zsyptlzn",
      "category": "Gastrointestinal protection",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE058"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Intravenous drip infusion",
        "remark": "Acid suppression when oral administration is temporarily unavailable; infuse 40 mg after dilution over approximately 15 minutes, and switch to oral therapy when feasible. Active gastrointestinal bleeding requires a different regimen; do not apply this entry."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Acid suppression when temporarily unable to take oral medication",
        "dose": "40",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Intravenous drip infusion",
        "details": "Dilute 40 mg and infuse over approximately 15 minutes; switch to oral treatment when feasible. Active gastrointestinal bleeding requires a different regimen; do not apply this entry.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=014f9762-6948-46b7-8659-5c89f35ad8bf",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-059",
      "name": "Rabeprazole sodium enteric-coated tablets",
      "pinyin_initials": "lblzncrp",
      "category": "Gastrointestinal protection",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE059"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Gastroesophageal reflux/acid suppression; 20 mg once daily; swallow enteric-coated tablets whole. Adjust according to the condition and treatment duration; do not duplicate with another PPI."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Gastroesophageal reflux/Acid suppression",
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "20 mg once daily; swallow enteric-coated tablets whole. Adjust according to the condition and treatment duration; do not combine with other PPIs.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=04e88b86-e1dd-4c56-8359-45fbcc161f7d",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-060",
      "name": "Warfarin sodium tablets",
      "pinyin_initials": "hflnp",
      "category": "Additional indications for anticoagulation / Comorbidities",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE060"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Initiation of anticoagulation requiring a vitamin K antagonist; usual starting dose 2–5 mg once daily, adjusted according to INR. The usual target INR for atrial fibrillation/VTE is 2–3; targets for mechanical valves are set separately. When combined with antiplatelet therapy, assess bleeding risk and treatment duration."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Initiation when anticoagulation with a vitamin K antagonist is required",
        "dose": "2.5",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "Usual starting dose: 2–5 mg once daily, adjusted according to INR. The usual target INR for atrial fibrillation/VTE is 2–3; targets for mechanical valves are determined separately. Assess bleeding risk and treatment duration when combined with antiplatelet therapy.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0cbce382-9c88-4f58-ae0f-532a841e8f95",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-061",
      "name": "Rivaroxaban tablets",
      "pinyin_initials": "lfsbp",
      "category": "Additional indications for anticoagulation / Comorbidities",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE061"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd · Once daily",
        "route": "Oral",
        "remark": "Nonvalvular atrial fibrillation, CrCl >50; 20 mg with the evening meal; for CrCl 15–50, the usual dose is 15 mg once daily; avoid if <15. Doses for VTE and CAD/PAD differ and cannot be substituted directly; this is also not a routine add-on medication for myocardial infarction."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Nonvalvular atrial fibrillation，CrCl>50",
        "dose": "20",
        "unit": "mg",
        "frequency": "Qd",
        "route": "Oral",
        "details": "20 mg with the evening meal; for CrCl 15–50, 15 mg once daily is commonly used; avoid if <15. Doses for VTE and CAD/PAD differ and are not directly interchangeable; this is also not a routine add-on medication for myocardial infarction.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=10db92f9-2300-4a80-836b-673e1ae91610",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-062",
      "name": "Apixaban tablets",
      "pinyin_initials": "apsbp",
      "category": "Additional indications for anticoagulation / Comorbidities",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE062"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Nonvalvular atrial fibrillation; usually 5 mg twice daily. Reduce to 2.5 mg twice daily if ≥2 of the following apply: age ≥80 years, weight ≤60 kg, and creatinine ≥1.5 mg/dL. Also check renal function and interactions; VTE loading regimens differ."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Nonvalvular atrial fibrillation",
        "dose": "5",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "Usually 5 mg twice daily; reduce to 2.5 mg twice daily if at least 2 of the following 3 criteria are met: age ≥80 years, body weight ≤60 kg, and creatinine ≥1.5 mg/dL. Also check renal function and interactions; the VTE loading regimen differs.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=095a08ac-cf0e-497e-a682-ddef38d6b29c",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-063",
      "name": "Dabigatran etexilate capsules",
      "pinyin_initials": "dbjqzjn",
      "category": "Additional indications for anticoagulation / Comorbidities",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE063"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "150",
        "unit": "mg",
        "frequency": "Bid · Twice daily",
        "route": "Oral",
        "remark": "Standard adult regimen for nonvalvular atrial fibrillation with CrCl >30; swallow 150 mg twice daily whole without opening the capsule. In older adults, renal impairment, high bleeding risk, or P-gp interactions, select a reduced dose according to local prescribing information; do not apply the US 75 mg reduced-dose formulation."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Standard adult regimen for nonvalvular atrial fibrillation with CrCl >30",
        "dose": "150",
        "unit": "mg",
        "frequency": "Bid",
        "route": "Oral",
        "details": "150 mg twice daily; swallow whole without opening the capsule. For advanced age, renal impairment, high bleeding risk, or P-gp interactions, select a reduced dose according to local prescribing information; do not apply the US 75 mg reduced-dose formulation.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=13649035-a498-4e31-a7ea-8b18cedceca7",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-064",
      "name": "Iohexol injection",
      "pinyin_initials": "dhczsy",
      "category": "Interventional angiography / Infusion and electrolytes",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE064"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "5",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intracoronary injection",
        "remark": "Single injection for coronary angiography, 350 mgI/mL; usual single volume 5 mL (range 3–14 mL), adjusted for the vessel and imaging requirements. This is the volume per injection, not the total for the entire procedure. Record cumulative iodine dose, renal function, and allergy history."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Single injection during coronary angiography，350 mgI/mL",
        "dose": "5",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intracoronary injection",
        "details": "Usual single injection volume 5 mL (range 3–14 mL), adjusted to the vessel and imaging requirements; this is the volume per injection, not the total for the procedure. Record cumulative iodine dose, renal function, and allergy history.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5088be1d-a708-1cac-e063-6394a90a2aff",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-065",
      "name": "Iodixanol injection",
      "pinyin_initials": "dksczsy",
      "category": "Interventional angiography / Infusion and electrolytes",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE065"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intracoronary injection",
        "remark": "Dose required; single injection for right coronary angiography, 320 mgI/mL. Single-injection volumes: 3–8 mL for the right coronary artery and 3–10 mL for the left; select a single value according to angiographic visualization. This is not the total procedural volume. Record cumulative iodine dose, renal function, and allergy history."
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Single injection during right coronary angiography，320 mgI/mL",
        "dose": "3–8",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intracoronary injection",
        "details": "Single injection: right coronary artery 3–8 mL, left coronary artery 3–10 mL; select a specific volume according to angiographic results. This is not the total procedural volume. Record cumulative iodine dose, renal function, and allergy history.",
        "dose_kind": "range",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0fe89ea2-04f7-46c5-9c35-220d8c144a95",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-066",
      "name": "Sodium chloride injection",
      "pinyin_initials": "lhnzsy",
      "category": "Interventional angiography / Infusion and electrolytes",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE066"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "remark": "Dose must be entered; an entry template for 0.9% sodium chloride as a diluent. The 100 mL volume is only an example for diluting compatible medications, not a routine fluid dose for myocardial infarction. Concentration 0.9%; adjust volume and rate according to compatibility, volume status, and the primary drug’s infusion requirements."
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Entry template using 0.9% sodium chloride as the diluent",
        "dose": "100",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "details": "100 mL is only an example of a diluent volume for compatible medications, not a routine fluid replacement dose for myocardial infarction. Concentration: 0.9%; adjust volume and rate according to compatibility, volume status, and the infusion requirements of the primary medication.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=123bd10a-90c7-499e-97f6-acf7e0f0fb4e",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification",
        "template_note": "The specific example doses are teaching entry templates within the principles of the prescribing information, not standardized doses mandated by guidelines."
      }
    },
    {
      "id": "ami-drug-067",
      "name": "Glucose injection",
      "pinyin_initials": "pttzsy",
      "category": "Interventional angiography / Infusion and electrolytes",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE067"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "20",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "remark": "Correction of hypoglycemia with 50% glucose; 20 mL of the 50% preparation = 10 g; usual dose 10–25 g (20–50 mL) given slowly IV, followed by repeat blood glucose measurement. This is not a 5% glucose diluent regimen; verify concentration and IV access, and prevent extravasation."
      },
      "dose_review_status": "reference_checked_teaching_template",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Correction of hypoglycemia，50%Glucose",
        "dose": "20",
        "unit": "mL",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "details": "20 mL of a 50% preparation = 10 g; usually 10–25 g (20–50 mL) administered slowly intravenously, followed by repeat blood glucose testing. Not a 5% glucose diluent regimen. Verify concentration and venous access, and prevent extravasation.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=4ed365da-4e62-4329-c1b9-c197ab4fb6e1",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification"
      }
    },
    {
      "id": "ami-drug-068",
      "name": "Potassium chloride injection",
      "pinyin_initials": "lhjzsy",
      "category": "Interventional angiography / Infusion and electrolytes",
      "catalog_role": "his_extension",
      "source_ids": [
        "HIS",
        "DOSE068"
      ],
      "case_medication": false,
      "autofill": {
        "dose": "",
        "unit": "g",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "remark": "Dose must be entered; example of diluted potassium replacement for non-severe hypokalemia. 1 g ≈ 13.4 mmol of potassium; dilution to 500 mL is an example. When serum potassium is >2.5 mmol/L, the rate is usually ≤10 mmol/h and concentration ≤40 mmol/L. Direct IV push is strictly prohibited. If fluid restriction is required for heart failure, determine the concentration/access separately; monitor serum potassium and renal function."
      },
      "dose_review_status": "individual_dose_required",
      "specifications": [],
      "availability": "local_formulary_not_verified",
      "note": "Additional HIS option; does not indicate that use is required in this case.",
      "common_regimen": {
        "population": "Adult",
        "indication": "Example of diluted potassium replacement for non-severe hypokalemia",
        "dose": "1",
        "unit": "g",
        "frequency": "Once",
        "route": "Intravenous drip infusion",
        "details": "1 g ≈ 13.4 mmol of potassium; dilution to 500 mL is an example. When serum potassium is >2.5 mmol/L, the rate is usually ≤10 mmol/h and concentration ≤40 mmol/L. Direct IV push is strictly prohibited. If fluid restriction is required for heart failure, determine the concentration/access separately; monitor serum potassium and renal function.",
        "dose_kind": "single_dose",
        "source_url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=559a0a8c-a8fe-40a5-b196-21f9308780ab",
        "checked_at": "2026-09-11",
        "evidence_scope": "Specific regimens from publicly available prescribing information/guidelines; local formulations and individual suitability still require verification",
        "template_note": "The specific example doses are teaching entry templates within the principles of the prescribing information, not standardized doses mandated by guidelines."
      }
    }
  ],
  "dose_policy": "Clearly defined adult regimens may be autofilled. Not all fields require numerical values; leave individualized total doses blank and provide reference guidance. Enter loading and maintenance doses separately; weight-based and infusion-rate regimens require conversion. A draft is not an actionable prescription. Retain case_template as evidence from the original case record."
};


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
 const type=select(['One-time orders','Long-term orders','Long-term medication present','One-time medication available'],data.type,'Order type');type.dataset.key='type';cells[4].append(type);
 const remark=document.createElement('input');remark.placeholder='Optional Notes';remark.setAttribute('aria-label','Notes');remark.dataset.key='remark';remark.value=data.remark||'';remark.title=remark.value;remark.oninput=()=>{remark.title=remark.value;};cells[5].append(remark);
 $('#rows').append(tr);
}
editor.addEventListener('click',e=>{editor.querySelectorAll('.drug-cell').forEach(c=>{if(!c.contains(e.target))c.querySelector('.matches').replaceChildren();});});
$('#add').onclick=()=>{addRow();$('#rows').lastElementChild.querySelector('input').focus();};
let submissionId=requestId();
$('#save').onclick=async()=>{if($('#save').disabled)return;const rows=[];for(const tr of $('#rows').children){const r={name:tr.dataset.drug};tr.querySelectorAll('[data-key]').forEach(el=>r[el.dataset.key]=el.value);const typed=tr.querySelector('input').value.trim();if(!typed&&!r.dose&&r.use==='Please select'&&r.route==='Please select'&&!r.remark)continue;if(!r.name){$('#status').textContent='Click the matching medication to confirm its name first。';tr.querySelector('input').focus();return;}if(!(Number(r.dose)>0)||r.use==='Please select'||r.route==='Please select'){$('#status').textContent='Please fill in the missing information '+r.name+' dosage, instructions for use, and route of administration。';return;}rows.push(r);}if(!rows.length){$('#status').textContent='Please add at least one medication order。';return;}
$('#save').disabled=true;
try{const next=await api('/api/medication-orders',{id:state.id,request_id:submissionId,rows});accept(next);$('#rows').replaceChildren();addRow();submissionId=requestId();$('#status').textContent='Orders confirmed, added to the clinical summary, and synced to the Supervising Physician’s assessment materials.。';}
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
  const placeholders=category==='Imaging'&&state.stage<2?['Chest X line','Echocardiogram']:[];
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
  modal(report.name,`<div class="report-workspace"><article class="report-paper"><div class="report-brand">Clinical Skills Training Center · Teaching Simulation</div><h2>${esc(s.title)}</h2><div class="report-meta"><span>Name: ${esc(state.registration?.name||"")}</span><span>Sex: ${esc(state.registration?.sex||"")}　Age: ${esc(state.registration?.age||"")}</span><span>Case number：${esc(state.case_id)}</span><span>Report ID：${esc(s.number||'—')}</span><span>Specimen / Method：${esc(s.sample||'—')}</span>${s.ordered?`<span>Apply：${esc(s.ordered)}</span>`:''}<span>Sampling / Examination：${esc(s.collected)}</span><span>Receive：${esc(s.received||'Not listed separately in the original draft')}</span><span>Report：${esc(s.reported)}</span></div>${rows.length?`<div class="report-table-wrap"><table><thead><tr><th>Laboratory test items</th><th>Results</th><th>Help</th><th>Unit</th><th>Reference interval</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.flag?'abnormal-row':''}"><td>${esc(r.name)}</td><td>${esc(r.value)}</td><td>${marked(r.flag)}</td><td>${esc(r.unit)}</td><td>${esc(r.reference)}</td></tr>`).join('')}</tbody></table></div>`:''}${s.image?`<button class="diagnostic-image-button" data-action="zoom-report" aria-label="Enlarge Investigation Image"><img class="diagnostic-image" src="/api/report-image?id=${encodeURIComponent(state.id)}&report=${encodeURIComponent(id)}" alt="${esc(report.name)}：Original case synthetic teaching image"><span>Click to enlarge</span></button>`:''}${s.findings?`<h3>Findings</h3><p class="report-findings">${marked(s.findings)}</p>`:''}${s.source_collected?`<details><summary>Source case time</summary><p>Source specimen collection / Examination：${esc(s.source_collected)}；Report：${esc(s.source_reported)}。This report displays the simulated execution time。</p></details>`:''}<p class="report-note">${esc(s.note||'')} ${rows.length?'↑ Above the upper reference limit；↓ Below the lower reference limit。':''}</p><footer>Original case data · Simulated report layout · Pending expert review<br>Teaching materials, not for actual clinical care; no institutional seals or signatures have been replicated.。</footer></article><aside class="report-extract"><h3>Medical Record Extraction</h3>${editable()?`<button class="primary" data-action="preview-import" data-mutate>Add to clinical notes</button><button data-action="preview-full" data-mutate>Import complete${id==='exam'?'Physical examination':'Report'}</button>`:''}<p class="muted">Click Extract to Clinical Record to preview positive findings; they are written to the record only after confirmation. Source, time, values, and units are retained.。</p><button data-action="reports">Return to Report List</button></aside></div>`,'report');
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
      case 'checks':selected.clear();category='Blood';openChecks();break;
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
  const catalog=state.operation_catalog||[];let operationRequestId=requestId();
  function add(){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="op-search"><input aria-label="Search Procedures" placeholder="Chinese / Pinyin Abbreviation"><div class="op-matches"></div></td><td class="op-params">Select a procedure, then complete the fields</td><td><input aria-label="Frequency" list="op-frequencies" placeholder="Select or enter"></td><td><input aria-label="Duration" placeholder="If：30 Minutes / Until the order is discontinued"></td><td><select aria-label="Order type"><option>One-time orders</option><option>Long-term orders</option></select></td><td><input aria-label="Notes" placeholder="Optional"></td><td><button aria-label="Delete action">Delete</button></td>`;
    const search=tr.querySelector('input'),matches=tr.querySelector('.op-matches');
    search.oninput=()=>{tr.operation=null;tr.querySelector('.op-params').textContent='Select a procedure, then complete the fields';matches.replaceChildren();const q=search.value.trim().toLowerCase();if(!q)return;catalog.filter(o=>o.name.includes(q)||o.pinyin.replaceAll(' ','').includes(q)).forEach(o=>{const b=document.createElement('button');b.textContent=o.name;b.onclick=()=>{tr.operation=o;search.value=o.name;matches.replaceChildren();const box=tr.querySelector('.op-params');box.replaceChildren();if(!o.fields.length)box.textContent='No additional parameters required';o.fields.forEach(f=>{const label=document.createElement('label');label.textContent=f.label;let options=f.options;const linked=f.label.startsWith('Link');if(linked)options=(state.orders||[]).filter(x=>x.kind==='medication').map(x=>x.text);const input=document.createElement(options.length?'select':'input');input.dataset.param=f.label;input.setAttribute('aria-label',f.label);if(options.length){const blank=document.createElement('option');blank.value='';blank.textContent='Please select';input.append(blank);options.forEach(v=>{const opt=document.createElement('option');opt.textContent=v;input.append(opt);});}if(linked&&!options.length)input.placeholder='Prescribe medication first, or enter the medication order to link';label.append(input);box.append(label);});};matches.append(b);});if(!matches.children.length)matches.textContent='No matching procedure found';};
    tr.querySelector('[aria-label="Delete action"]').onclick=()=>{tr.remove();if(!$('#op-rows').children.length)add();};$('#op-rows').append(tr);
  }
  add();$('#op-add').onclick=add;
  const dl=document.createElement('datalist');dl.id='op-frequencies';['Once','Persistent','Qd','Bid','Qh','each 15 Minutes','As needed'].forEach(v=>{const o=document.createElement('option');o.value=v;dl.append(o);});$('#op-rows').closest('.op-editor').append(dl);
  $('#op-confirm').onclick=async()=>{
    const button=$('#op-confirm');if(button.disabled)return;
    const rows=[];for(const tr of $('#op-rows').children){if(!tr.operation){$('#op-status').textContent='Please search for and confirm the procedure name in each row。';return;}const value=n=>tr.querySelector(`[aria-label="${n}"]`).value.trim();rows.push({operation_id:tr.operation.id,params:Object.fromEntries([...tr.querySelectorAll('[data-param]')].map(x=>[x.dataset.param,x.value.trim()])),frequency:value('Frequency'),duration:value('Duration'),type:value('Order type'),remark:value('Notes')});}
    button.disabled=true;$('#op-status').textContent='Confirming…';
    try{accept(await api('/api/operation-orders',{id:state.id,request_id:operationRequestId,rows}));operationRequestId=requestId();$('#op-rows').replaceChildren();add();$('#op-status').textContent='Ordered, documented in the care summary, and shared with the Supervising Physician。';}catch(e){$('#op-status').textContent=e.message;}finally{button.disabled=false;}
  };
}

function showCaseIntro() {
  if(!state||sessionStorage.getItem('clinical-intro-'+state.id))return;
  let intro=document.getElementById('cr-case-intro');
  if(!intro){intro=document.createElement('dialog');intro.id='cr-case-intro';intro.setAttribute('aria-labelledby','cr-intro-title');root.append(intro);intro.addEventListener('cancel',e=>e.preventDefault());}
  intro.innerHTML=`<div class="intro-picture">${sceneImage(0)}</div><div class="intro-shade"></div><div class="intro-top">Clinical reasoning training room<span>Emergency Consultation</span></div><section class="intro-bottom"><div><p class="intro-eyebrow">Patient Demographics</p><h2 id="cr-intro-title">${esc(state.registration?.name||"")} <span>${esc(state.registration?.sex||"")} · ${esc(state.registration?.age||"")}</span></h2><p class="intro-detail">${esc(state.registration?.marital_status||"")} · ${esc(state.registration?.occupation||"")}</p><p class="intro-quote">“Doctor, my chest hurts badly, and I keep sweating。”</p><small>AI Generated teaching scenario</small></div><button id="cr-begin-reception" autofocus>Start Consultation <span aria-hidden="true">→</span></button></section>`;
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

