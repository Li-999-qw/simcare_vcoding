// Shared by every case. Audio stays in memory and is sent only after release.
(()=>{
  let active=null;
  const originalControls=renderControls;
  const inputFor=role=>document.getElementById('cr-input-'+role);
  const busy=()=>active!==null;
  function paintControls(){
    root.querySelectorAll('[data-voice]').forEach(button=>{
      const mine=active?.role===button.dataset.voice;
      const label=mine?(active.phase==='listening'?'松开转写':active.phase==='starting'?'准备录音…':'正在转写…'):'🎙 按住说话';
      if(button.textContent!==label)button.textContent=label;
      button.title='按住录音，松开转写；输入框内可按住 Alt/Option + V；Esc 取消';
      button.setAttribute('aria-keyshortcuts','Alt+V');
      button.setAttribute('aria-label',mine?'正在录音或转写，Esc取消':'按住说话，松开转写');
      button.style.touchAction='none';button.style.userSelect='none';
      button.disabled=!mine&&(busy()||pending||uploadingImage||!state||reviewing()||state.busy);
    });
    root.querySelectorAll('[data-voice-status]').forEach(el=>{
      const mine=active?.role===el.dataset.voiceStatus;
      let text=mine?(active.phase==='starting'?'正在请求麦克风，请保持按住…':active.phase==='listening'?`正在聆听 ${Math.floor((performance.now()-active.started)/1000)}秒 · 松开转写 · Esc取消`:'正在转写… · Esc取消'):
        voiceJob?.role===el.dataset.voiceStatus?(voiceJob.error|| (voiceJob.status==='done'?'文字已追加，请核对后发送。':voiceJob.status==='cancelled'?'已取消本段录音。':'')):'输入框内按住 Alt/Option + V 说话，松开转写；Esc取消。';
      if(el.textContent!==text)el.textContent=text;
    });
  }
  renderControls=function(){originalControls();paintControls();};
  toggleVoice=()=>cancel(); // Legacy click-to-toggle paths must never start recording.
  function notice(role,error){voiceJob={role,status:'error',error};renderControls();}
  function cleanup(job){
    cancelAnimationFrame(job.frame);clearTimeout(job.limit);
    job.stream?.getTracks().forEach(t=>t.stop());
    try{job.sourceNode?.disconnect();job.recorder?.disconnect();job.mute?.disconnect();}catch{}
    if(job.context?.state!=='closed')job.context?.close().catch(()=>{});
    job.canvas?.remove();
  }
  function cancel(){
    const job=active;if(!job)return;
    active=null;job.cancelled=true;job.abort?.abort();job.finish?.();cleanup(job);
    job.chunks=[];voiceJob={role:job.role,status:'cancelled'};renderControls();
  }
  function draw(job){
    if(active!==job||job.phase!=='listening')return;
    if(!job.input.isConnected){cancel();return;}
    const values=new Uint8Array(job.analyser.fftSize);job.analyser.getByteTimeDomainData(values);
    const ctx=job.canvas.getContext('2d');ctx.clearRect(0,0,320,44);ctx.fillStyle='#187f85';
    for(let i=0;i<40;i++){
      let peak=0;for(let k=i*32;k<(i+1)*32;k++)peak=Math.max(peak,Math.abs(values[k]-128)/128);
      const h=Math.max(2,Math.min(40,peak*100));ctx.fillRect(i*8+2,(44-h)/2,4,h);
    }
    paintControls();job.frame=requestAnimationFrame(()=>draw(job));
  }
  async function begin(role,source,pointerId){
    const input=inputFor(role);
    if(active||!input||input.disabled||!state||pending||state.busy||reviewing())return;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){notice(role,'录音需要受信任的HTTPS连接和浏览器麦克风权限。');return;}
    const job={role,source,pointerId,input,phase:'starting',chunks:[],cancelled:false};active=job;
    input.focus();voiceJob={role,status:'starting'};renderControls();
    try{
      job.context=new (window.AudioContext||window.webkitAudioContext)();
      await job.context.resume();
      if(active!==job)return cleanup(job);
      job.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
      if(active!==job)return cleanup(job);
      await job.context.audioWorklet.addModule(portalGateway+'/voice-worklet.js');
      if(active!==job)return cleanup(job);
      job.recorder=new AudioWorkletNode(job.context,'hold-recorder');
      job.recorder.port.onmessage=e=>{if(e.data.done){job.finish?.();return;}if(!job.cancelled)job.chunks.push(e.data.samples);};
      job.sourceNode=job.context.createMediaStreamSource(job.stream);
      job.analyser=job.context.createAnalyser();job.analyser.fftSize=2048;
      job.mute=job.context.createGain();job.mute.gain.value=0;
      job.sourceNode.connect(job.analyser);job.sourceNode.connect(job.recorder);job.recorder.connect(job.mute);job.mute.connect(job.context.destination);
      job.canvas=document.createElement('canvas');job.canvas.width=320;job.canvas.height=44;job.canvas.style.cssText='display:block;width:100%;max-width:320px;height:44px;background:#edf7f7;border-radius:10px';
      job.canvas.setAttribute('aria-label','实时麦克风音量波形');job.canvas.setAttribute('role','img');
      input.insertAdjacentElement('afterend',job.canvas);
      job.started=performance.now();job.phase='listening';voiceJob={role,status:'listening'};renderControls();draw(job);
      job.limit=setTimeout(()=>{cancel();notice(role,'单次最长120秒，本段已取消，请分段录音。');},120000);
      job.stream.getAudioTracks().forEach(track=>track.onended=()=>{if(active===job&&job.phase==='listening'){cancel();notice(role,'麦克风连接已中断，请重新录音。');}});
    }catch(error){if(active===job){cancel();notice(role,error.name==='NotAllowedError'?'请允许此网站使用麦克风，再按住录音。':'麦克风未能启动，请检查设备和浏览器权限。');}else cleanup(job);}
  }
  async function wavData(job){
    const length=job.chunks.reduce((n,c)=>n+c.length,0);
    if(length<job.context.sampleRate/10)throw Error('录音过短，请按住后说话。');
    const offline=new OfflineAudioContext(1,Math.ceil(length*16000/job.context.sampleRate),16000);
    const buffer=offline.createBuffer(1,length,job.context.sampleRate);let offset=0;
    for(const chunk of job.chunks){buffer.copyToChannel(chunk,0,offset);offset+=chunk.length;}job.chunks=[];
    const src=offline.createBufferSource();src.buffer=buffer;src.connect(offline.destination);src.start();
    const samples=(await offline.startRendering()).getChannelData(0);
    const data=new ArrayBuffer(44+samples.length*2),view=new DataView(data);
    const str=(at,s)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));};
    str(0,'RIFF');view.setUint32(4,data.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)view.setInt16(44+2*i,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
    return data;
  }
  async function release(){
    const job=active;if(!job||job.phase==='transcribing')return;
    if(job.phase==='starting'){cancel();return;}
    job.phase='transcribing';clearTimeout(job.limit);cancelAnimationFrame(job.frame);
    voiceJob={role:job.role,status:'transcribing'};renderControls();
    try{
      await new Promise(resolve=>{const timer=setTimeout(resolve,500);job.finish=()=>{clearTimeout(timer);resolve();};job.recorder.port.postMessage('stop');});
      cleanup(job);if(active!==job)return;
      const data=await wavData(job);if(active!==job)return;
      job.abort=new AbortController();
      const response=await fetch(portalGateway+'/api/voice/transcribe?role='+encodeURIComponent(job.role),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'audio/wav'},body:data,signal:job.abort.signal});
      const result=await response.json();if(!response.ok)throw Error(result.detail||'语音转写未完成，请重试。');
      if(active!==job||!job.input.isConnected)return;
      job.input.value+=result.text;job.input.dispatchEvent(new Event('input',{bubbles:true}));
      composers[job.role]=job.input.value;voiceJob={role:job.role,status:'done'};
    }catch(error){if(active===job&&error.name!=='AbortError')voiceJob={role:job.role,status:'error',error:error.message};}
    finally{cleanup(job);job.chunks=[];if(active===job){active=null;renderControls();}}
  }
  document.addEventListener('pointerdown',e=>{const button=e.target.closest('[data-voice]');if(!button||button.disabled||e.button!==0)return;e.preventDefault();e.stopImmediatePropagation();try{button.setPointerCapture(e.pointerId);}catch{}begin(button.dataset.voice,'pointer',e.pointerId);},true);
  document.addEventListener('pointerup',e=>{if(active?.source==='pointer'&&e.pointerId===active.pointerId){e.preventDefault();release();}},true);
  document.addEventListener('pointercancel',e=>{if(active?.source==='pointer'&&e.pointerId===active.pointerId)cancel();},true);
  document.addEventListener('lostpointercapture',e=>{if(active?.source==='pointer'&&active.phase!=='transcribing'&&e.pointerId===active.pointerId)cancel();},true);
  document.addEventListener('click',e=>{if(e.target.closest('[data-voice]')){e.preventDefault();e.stopImmediatePropagation();}},true);
  document.addEventListener('contextmenu',e=>{if(e.target.closest('[data-voice]'))e.preventDefault();},true);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&active){e.preventDefault();e.stopImmediatePropagation();cancel();return;}
    if(e.code==='KeyV'&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey){
      const input=document.activeElement,role=input?.dataset.composer;
      if(!role||input!==inputFor(role))return;
      e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)begin(role,'keyboard');
    }
  },true);
  document.addEventListener('keyup',e=>{if(active?.source==='keyboard'&&(e.code==='KeyV'||e.key==='Alt')){e.preventDefault();release();}},true);
  window.addEventListener('blur',cancel);window.addEventListener('pagehide',cancel);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel();});
  new MutationObserver(()=>{if(active&&!active.input.isConnected)cancel();}).observe(root,{childList:true,subtree:true});
  paintControls();
})();
