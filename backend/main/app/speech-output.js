// Shared training-page speech output. Text rendering remains independent of audio.
(()=>{
  const enabled={patient:true,senior:false};
  let configured=false,unsupportedPatient=false,ctx=null,playAt=0,controller=null,currentRole=null,serial=0;
  let queue=[],working=false,active=null,initialized=false;
  const seen=new Set(),sources=new Map();
  const wrapper=document.createElement('div');
  wrapper.style.cssText='position:relative;display:inline-flex';
  const button=document.createElement('button');
  button.type='button';button.id='simcare-speech-toggle';
  button.style.cssText='padding:9px 14px;border-radius:9px;background:#17384a;color:white;border:1px solid #a9c1c8;font:14px system-ui;cursor:pointer;white-space:nowrap';
  button.setAttribute('aria-label','语音同步设置');
  button.setAttribute('aria-haspopup','true');
  button.setAttribute('aria-controls','simcare-speech-menu');
  const menu=document.createElement('div');
  menu.id='simcare-speech-menu';menu.hidden=true;
  menu.setAttribute('role','group');menu.setAttribute('aria-label','语音同步设置');
  menu.style.cssText='position:absolute;right:0;top:calc(100% + 5px);z-index:1002;min-width:190px;padding:7px;background:white;color:#17384a;border:1px solid #a9c1c8;border-radius:10px;box-shadow:0 8px 24px #1233';
  const toggles={};
  for(const [role,name] of [['patient','患者语音回复'],['senior','上级医师语音回复']]){
    const label=document.createElement('label');
    label.style.cssText='display:flex;align-items:center;gap:8px;padding:9px 8px;cursor:pointer;white-space:nowrap;font:14px system-ui';
    const input=document.createElement('input');
    input.type='checkbox';input.id='simcare-speech-'+role;input.checked=enabled[role];
    input.addEventListener('change',()=>{
      enabled[role]=input.checked;
      if(!enabled[role])stopRole(role);else audio();
      paint();
    });
    label.append(input,' '+name);menu.append(label);toggles[role]=input;
  }
  wrapper.append(button,menu);
  const toolbar=document.querySelector('#clinical-rounds .top .row');
  if(toolbar)toolbar.insertBefore(wrapper,toolbar.querySelector('[data-action="export"]'));
  else document.body.append(wrapper);

  function roleEnabled(role){return configured&&enabled[role]&&!(unsupportedPatient&&role==='patient');}
  function paint(message=''){
    button.textContent=!configured?'🔇 语音待配置 ▾':enabled.patient||enabled.senior?'🔊 语音同步 ▾':'🔇 语音同步 ▾';
    button.title=message||(!configured?'请管理员配置腾讯云语音合成凭据':unsupportedPatient?'维吾尔语患者暂不支持腾讯云合成；上级医师可单独开启':'分别设置患者和上级医师的回复语音');
    button.setAttribute('aria-expanded',String(!menu.hidden));
    for(const role of ['patient','senior'])toggles[role].checked=enabled[role];
    toggles.patient.disabled=!configured||unsupportedPatient;
    toggles.senior.disabled=!configured;
  }
  function audio(){
    if(!ctx){
      const Audio=window.AudioContext||window.webkitAudioContext;
      if(!Audio){enabled.patient=false;enabled.senior=false;paint('当前浏览器不支持 Web Audio 语音播放');return null;}
      ctx=new Audio();
    }
    if(ctx.state!=='running')ctx.resume().catch(()=>{});
    return ctx;
  }
  function stop(){
    serial++;controller?.abort();controller=null;queue=[];active=null;
    for(const source of sources.keys()){try{source.stop();}catch{}}
    sources.clear();playAt=0;
  }
  function stopRole(role){
    queue=queue.filter(item=>item.role!==role);
    if(currentRole===role){serial++;controller?.abort();controller=null;}
    for(const [source,sourceRole] of sources){
      if(sourceRole===role){try{source.stop();}catch{}sources.delete(source);}
    }
    if(!sources.size)playAt=0;
  }
  button.addEventListener('click',()=>{
    menu.hidden=!menu.hidden;
    paint();
  });
  document.addEventListener('click',event=>{
    if(!wrapper.contains(event.target)&&!menu.hidden){menu.hidden=true;paint();}
    const send=event.target.closest('[data-send]');
    if(roleEnabled(send?.dataset.send|| (event.target.closest('[data-action="feedback"]')?'senior':null)))audio();
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!menu.hidden){menu.hidden=true;paint();button.focus();}
  });
  window.addEventListener('pagehide',stop);

  function playPcm(data,carry,role){
    const bytes=new Uint8Array(carry.length+data.length);
    bytes.set(carry);bytes.set(data,carry.length);
    const even=bytes.length&~1;
    if(!even)return bytes;
    const samples=even/2,context=audio();
    if(!context)return bytes.slice(even);
    const buffer=context.createBuffer(1,samples,24000);
    const channel=buffer.getChannelData(0),view=new DataView(bytes.buffer,bytes.byteOffset,even);
    for(let i=0;i<samples;i++)channel[i]=view.getInt16(i*2,true)/32768;
    const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
    source.onended=()=>sources.delete(source);sources.set(source,role);
    playAt=Math.max(playAt,context.currentTime+0.06);source.start(playAt);
    playAt+=samples/24000;
    return bytes.slice(even);
  }
  async function drain(){
    if(working||!configured)return;
    working=true;
    try{
      while(queue.length&&configured){
        const item=queue.shift(),run=serial;
        if(!roleEnabled(item.role))continue;
        currentRole=item.role;
        controller=new AbortController();
        try{
          const response=await fetch(portalGateway+'/api/tts',{
            method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
            body:JSON.stringify(item),signal:controller.signal
          });
          if(!response.ok){
            const problem=await response.json().catch(()=>({}));
            throw Error(problem.detail||'语音合成未完成');
          }
          const reader=response.body.getReader();let carry=new Uint8Array(0);
          while(true){
            const {done,value}=await reader.read();
            if(done||run!==serial||!roleEnabled(item.role))break;
            carry=playPcm(value,carry,item.role);
          }
        }catch(error){
          if(error.name!=='AbortError'&&run===serial){paint('语音暂不可用：'+error.message);queue=[];}
        }finally{controller=null;currentRole=null;}
      }
    }finally{working=false;if(queue.length&&configured)drain();}
  }
  function enqueue(role,text){
    if(!roleEnabled(role)||!text.trim())return;
    queue.push({role,text});drain();
  }
  function consume(draft,final=false){
    if(!active||!draft.startsWith(active.sent))return false;
    const remaining=draft.slice(active.sent.length);
    const cut=speechSegments(remaining,final);
    for(const piece of cut.segments)enqueue(active.role,piece);
    active.sent+=remaining.slice(0,cut.consumed);
    return true;
  }
  function observe(next){
    const messages=next.messages||[];
    if(!initialized){
      for(const m of messages)if(m.speaker==='assistant'&&m.id)seen.add(m.id);
      initialized=true;return;
    }
    const draft=next.streaming;
    if(draft&&['patient','senior'].includes(draft.role)&&typeof draft.text==='string'){
      const key=[next.id,next.stage,draft.role,messages.length].join(':');
      if(!active||active.key!==key)active={key,role:draft.role,sent:''};
      consume(draft.text);
    }
    for(const m of messages){
      if(m.speaker!=='assistant'||!m.id||seen.has(m.id))continue;
      seen.add(m.id);
      if(!['patient','senior'].includes(m.role)||m.initial)continue;
      if(active&&active.role===m.role){
        if(!consume(m.text,true)){
          stop();active={role:m.role,sent:''};consume(m.text,true);
        }
        active=null;
      }else{
        active={role:m.role,sent:''};consume(m.text,true);active=null;
      }
    }
    if(!draft&&active&&!next.busy)active=null;
  }
  const previousAccept=accept;
  accept=function(next,...args){
    const result=previousAccept.call(this,next,...args);
    observe(next);
    return result;
  };
  const previousSend=send;
  send=async function(role,...args){
    if(configured){if(roleEnabled(role))audio();stop();}
    return previousSend.call(this,role,...args);
  };
  fetch(portalGateway+'/api/tts/status',{credentials:'same-origin'})
    .then(r=>r.ok?r.json():null).then(status=>{
      configured=!!status?.configured;
      unsupportedPatient=configured&&status.patient_voice===null;
      if(unsupportedPatient)enabled.patient=false;
      paint();
    }).catch(()=>paint('无法检查语音配置，请刷新页面'));
  paint();
})();
