// A single in-flight heartbeat; hidden/closed pages do not advance the clock.
let ticking=false;
setInterval(async()=>{if(!state||state.stage>=4||document.hidden||ticking||document.getElementById('cr-case-intro')?.open)return;ticking=true;try{const next=await api(portalGateway+'/api/tick',{id:state.id});accept(next);}catch(e){/* retain draft and retry next heartbeat */}finally{ticking=false}},10000);
function decorateReports(){
  root.querySelectorAll('[data-report]').forEach(b=>{const id=b.dataset.report;if(!b.closest('.report-row'))return;const unread=state?.report_status?.[id]?.ready&&!state.reports?.includes(id);let dot=b.querySelector('.report-dot');if(unread&&!dot){dot=document.createElement('span');dot.className='report-dot';dot.setAttribute('aria-label','Unread');b.append(dot);}if(!unread&&dot)dot.remove();});
  root.querySelectorAll('.registration-status,.registration p').forEach(el=>{if(el.textContent.includes('Registration information complete'))el.textContent=el.textContent.replace(/Registration information complete[，,、\s]*Not yet admitted[。]?/g,'');});
}
new MutationObserver(decorateReports).observe(root,{childList:true,subtree:true});
let clockValue='',clockReceived=Date.now();
document.addEventListener('visibilitychange',()=>{clockValue='';clockReceived=Date.now()});
setInterval(()=>{
  if(!state||state.stage>=4||document.hidden||reviewing()||document.getElementById('cr-case-intro')?.open)return;
  if(clockValue!==state.time){clockValue=state.time;clockReceived=Date.now();}
  const value=new Date(clockValue.replace('Simulation Time ','').replace(' ','T'));
  if(Number.isNaN(value.getTime()))return;
  value.setSeconds(value.getSeconds()+Math.min(10,Math.floor((Date.now()-clockReceived)/1000)));
  const two=n=>String(n).padStart(2,'0');
  const label='Simulation Time '+value.getFullYear()+'-'+two(value.getMonth()+1)+'-'+two(value.getDate())+' '+two(value.getHours())+':'+two(value.getMinutes())+':'+two(value.getSeconds());
  root.querySelectorAll('[data-sim-time]').forEach(el=>{if(el.textContent!==label)el.textContent=label;});
},1000);

// Page-wide senior consultation shortcut; reuse the existing button action.
(()=>{
  const mac=/Mac|iPhone|iPad/.test(navigator.platform||'');
  const shortcut=mac?'Option + Q':'Alt + Q';
  const button=document.getElementById('cr-teacher-top');
  if(button){
    button.textContent='Consult the Supervising Physician（'+shortcut+'）';
    button.title='Open / Close Supervising Physician：'+shortcut;
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
