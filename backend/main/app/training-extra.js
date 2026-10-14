// A single in-flight heartbeat; hidden/closed pages do not advance the clock.
let ticking=false;
setInterval(async()=>{if(!state||state.stage>=4||document.hidden||ticking||document.getElementById('cr-case-intro')?.open)return;ticking=true;try{const next=await api(portalGateway+'/api/tick',{id:state.id});accept(next);}catch(e){/* retain draft and retry next heartbeat */}finally{ticking=false}},10000);
function decorateReports(){
  root.querySelectorAll('[data-report]').forEach(b=>{const id=b.dataset.report;if(!b.closest('.report-row'))return;const unread=state?.report_status?.[id]?.ready&&!state.reports?.includes(id);let dot=b.querySelector('.report-dot');if(unread&&!dot){dot=document.createElement('span');dot.className='report-dot';dot.setAttribute('aria-label','未读');b.append(dot);}if(!unread&&dot)dot.remove();});
  root.querySelectorAll('.registration-status,.registration p').forEach(el=>{if(el.textContent.includes('挂号资料齐备'))el.textContent=el.textContent.replace(/挂号资料齐备[，,、\s]*尚未办理住院[。]?/g,'');});
}
new MutationObserver(decorateReports).observe(root,{childList:true,subtree:true});
let clockValue='',clockReceived=Date.now();
document.addEventListener('visibilitychange',()=>{clockValue='';clockReceived=Date.now()});
setInterval(()=>{
  if(!state||state.stage>=4||document.hidden||reviewing()||document.getElementById('cr-case-intro')?.open)return;
  if(clockValue!==state.time){clockValue=state.time;clockReceived=Date.now();}
  const value=new Date(clockValue.replace('模拟时间 ','').replace(' ','T'));
  if(Number.isNaN(value.getTime()))return;
  value.setSeconds(value.getSeconds()+Math.min(10,Math.floor((Date.now()-clockReceived)/1000)));
  const two=n=>String(n).padStart(2,'0');
  const label='模拟时间 '+value.getFullYear()+'-'+two(value.getMonth()+1)+'-'+two(value.getDate())+' '+two(value.getHours())+':'+two(value.getMinutes())+':'+two(value.getSeconds());
  root.querySelectorAll('[data-sim-time]').forEach(el=>{if(el.textContent!==label)el.textContent=label;});
},1000);

// Page-wide senior consultation shortcut; reuse the existing button action.
(()=>{
  const mac=/Mac|iPhone|iPad/.test(navigator.platform||'');
  const shortcut=mac?'Option + Q':'Alt + Q';
  const button=document.getElementById('cr-teacher-top');
  if(button){
    button.textContent='请教上级医师（'+shortcut+'）';
    button.title='打开 / 关闭上级医师：'+shortcut;
    button.setAttribute('aria-keyshortcuts','Alt+Q');
  }
  document.addEventListener('keydown',event=>{
    if(event.code!=='KeyQ'||!event.altKey||event.shiftKey||event.ctrlKey||event.metaKey||event.isComposing)return;
    const dialog=document.getElementById('cr-dialog');
    if(dialog?.open&&modalKind==='teacher'){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.repeat)return;
      const input=document.getElementById('cr-input-senior');
      if(input)composers.senior=input.value;
      closeModal();return;
    }
    if(!state||!button||button.disabled||isExam()||reviewing()||document.hidden)return;
    if(['starting','listening','transcribing'].includes(voiceJob?.status))return;
    if(document.getElementById('cr-case-intro')?.open)return;
    if(dialog?.open&&modalKind!=='teacher')return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.repeat)return;
    button.click();
  },true);
})();

// Return to the conversation at action boundaries, never on polling/heartbeats.
(()=>{
  let interaction=0,frame=0,lastPatient=null,lastStage=null;
  const focused=()=>{
    let el=document.activeElement;
    while(el?.shadowRoot?.activeElement)el=el.shadowRoot.activeElement;
    return el;
  };
  const isField=el=>el?.matches?.('input,textarea,select,[contenteditable="true"]');
  const allowed=()=>state&&!document.hidden&&document.hasFocus()&&!reviewing()&&
    !document.querySelector('dialog[open]')&&
    !['starting','listening','transcribing'].includes(voiceJob?.status);
  function returnToPatient(force=false){
    const revision=interaction;
    cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{
      if(revision!==interaction||!allowed())return;
      const input=document.getElementById('cr-input-patient');
      if(!input||input.disabled||input.readOnly||!input.getClientRects().length)return;
      const current=focused();
      if(current===input)return;
      if(!force&&isField(current))return;
      input.focus({preventScroll:true});
    });
  }
  for(const name of ['pointerdown','keydown','input']){
    document.addEventListener(name,()=>{interaction++;},true);
  }
  const previousRender=render;
  render=function(...args){
    const wasEditing=isField(focused());
    const result=previousRender.apply(this,args);
    const input=document.getElementById('cr-input-patient');
    const changedStage=lastStage!==viewStage;
    if(input&&(input!==lastPatient||changedStage)&&(!wasEditing||changedStage))returnToPatient();
    lastPatient=input;lastStage=viewStage;
    return result;
  };
  const previousClose=closeModal;
  closeModal=function(...args){
    const wasOpen=document.getElementById('cr-dialog')?.open;
    const result=previousClose.apply(this,args);
    if(wasOpen)returnToPatient(true);
    return result;
  };
  // Native Escape and dialog.close() also restore the conversation focus.
  document.getElementById('cr-dialog')?.addEventListener('close',()=>returnToPatient(true));
  const previousSend=send;
  send=async function(role,...args){
    const input=document.getElementById('cr-input-'+role);
    const revision=interaction;
    if(input&&!input.disabled)input.focus({preventScroll:true});
    try{return await previousSend.call(this,role,...args);}
    finally{
      if(revision===interaction&&input?.isConnected&&!document.hidden){
        const current=focused();
        if(!isField(current)||current===input){
          if(role==='patient')returnToPatient();
          else if(role==='senior'&&modalKind==='teacher'&&document.getElementById('cr-dialog')?.open)input.focus({preventScroll:true});
        }
      }
    }
  };
  returnToPatient();
})();

// Keep the consultation in a separate training page so the original workbench stays usable.
(() => {
  const standalone = new URLSearchParams(location.search).get('senior') === '1';
  const originalOpenTeacher = openTeacher;
  const attemptId = location.pathname.match(/\/training\/([^/]+)/)?.[1] || 'current';
  let consultationWindow = null;
  let linkedWindowUntil = 0;
  let syncing = false;

  async function syncSession() {
    if (!state || syncing || pending || document.hidden || (!standalone && Date.now() > linkedWindowUntil)) return;
    syncing = true;
    try {
      const next = await api('./api/state?id=' + encodeURIComponent(state.id));
      if (pending) return;
      const stageChanged = standalone && next.stage !== viewStage;
      if (stageChanged) { viewStage = next.stage; renderedStage = -1; }
      if (stageChanged || JSON.stringify(next) !== JSON.stringify(state)) accept(next, stageChanged);
      schedulePoll();
    } catch (error) {
      if (standalone) showError('同步训练记录失败：' + error.message);
    } finally { syncing = false; }
  }

  openTeacher = function () {
    if (standalone) return originalOpenTeacher();
    if (!state || isExam() || reviewing()) return;
    if (consultationWindow && !consultationWindow.closed) {
      linkedWindowUntil = Date.now() + 30 * 60 * 1000;
      consultationWindow.focus();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('senior', '1');
    const windowName = 'simcare-senior-' + attemptId;
    const consultation = window.open(url.href, windowName, 'width=900,height=820');
    if (consultation) {
      consultationWindow = consultation;
      linkedWindowUntil = Date.now() + 30 * 60 * 1000;
      consultation.focus();
      syncSession();
      return;
    }
    // Browser popup settings can block a new page. Keep the workbench usable then too.
    const originalModal = modal;
    modal = function (title, body, kind = '') {
      if (kind !== 'teacher') return originalModal(title, body, kind);
      modalKind = kind;
      $('#cr-dialog-title').textContent = title;
      $('#cr-dialog-body').innerHTML = body;
      const dialog = $('#cr-dialog');
      if (!dialog.open) dialog.show();
      dialog.classList.add('senior-docked');
      renderControls();
    };
    try { originalOpenTeacher(); } finally { modal = originalModal; }
  };

  if (!standalone) {
    const launch = document.getElementById('cr-teacher-top');
    if (launch) {
      launch.textContent = '请教上级医师 ↗（Alt + Q）';
      launch.title = '在独立页面打开上级医师对话';
    }
    const style = document.createElement('style');
    style.textContent = '#clinical-rounds #cr-dialog.senior-docked[open]{position:fixed;inset:auto 18px 18px auto;margin:0;width:min(460px,calc(100vw - 36px));max-height:min(84dvh,760px);z-index:40;box-shadow:0 18px 55px #10273855}#clinical-rounds #cr-dialog.senior-docked[open] .chat-log{height:clamp(180px,35dvh,340px)}';
    document.head.append(style);
    setInterval(syncSession, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSession(); });
    return;
  }

  document.title = '上级医师请教 · 临床思维训练';
  document.body.classList.add('senior-standalone');
  const style = document.createElement('style');
  style.textContent = `
    body.senior-standalone{margin:0;padding:0;background:#edf4f2}
    body.senior-standalone > :not(#clinical-rounds){display:none!important}
    body.senior-standalone #clinical-rounds{display:block;width:100%;max-width:none;height:100dvh;min-height:0;margin:0;box-shadow:none}
    body.senior-standalone #clinical-rounds > :not(#cr-dialog){display:none!important}
    body.senior-standalone #clinical-rounds #cr-dialog[open]{position:fixed;inset:0;box-sizing:border-box;display:block;width:100vw;max-width:none;height:100dvh;max-height:none;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;overflow:hidden}
    body.senior-standalone #clinical-rounds #cr-dialog .dialog{display:flex;flex-direction:column;box-sizing:border-box;width:min(100%,1100px);height:100%;max-width:none;margin:auto;padding:clamp(16px,3vw,32px);border:0;border-radius:0;box-shadow:none}
    body.senior-standalone #clinical-rounds #cr-dialog-body{display:flex;flex:1;flex-direction:column;min-height:0}
    body.senior-standalone #clinical-rounds #cr-senior-log{height:auto;max-height:none;min-height:100px;flex:1;overflow:auto}
    body.senior-standalone #clinical-rounds #cr-dialog .composer{flex-shrink:0}
    body.senior-standalone #clinical-rounds .senior-page-note{margin:0 0 12px;color:var(--cr-muted);font-size:13px}
  `;
  document.head.append(style);
  showCaseIntro = function () {};
  feedbackLayout = function () { return '<section class="panel feedback"></section>'; };
  const dialog = $('#cr-dialog');
  dialog?.addEventListener('close', () => {
    window.close();
    if (!window.closed && !document.hidden) location.replace(location.pathname);
  });
  const ready = setInterval(() => {
    if (!state) return;
    clearInterval(ready);
    document.getElementById('cr-case-intro')?.close();
    if (isExam()) {
      dialog.showModal();
      $('#cr-dialog-title').textContent = '上级医师请教';
      $('#cr-dialog-body').innerHTML = '<p>考试模式不开放上级医师请教。</p><p><a href="' + location.pathname + '">返回接诊页面</a></p>';
      return;
    }
    viewStage = state.stage;
    render(true);
    originalOpenTeacher();
    const heading = $('#cr-dialog-title');
    heading?.parentElement?.insertAdjacentHTML('afterend', '<p class="senior-page-note">可在原接诊页面继续书写病历、查看报告和进行其他操作；两页会同步训练记录。</p>');
    $('#cr-dialog [data-action="close"]')?.setAttribute('aria-label', '关闭上级医师页面');
    $('#cr-input-senior')?.focus();
    syncSession();
  }, 100);
  setInterval(syncSession, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSession(); });
})();
