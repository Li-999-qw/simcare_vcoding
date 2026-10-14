(() => {
  'use strict';
  const data=window.CASE_DATA;
  const $=id=>document.getElementById(id);
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const series=data.series.map(s=>({...s,src:`assets/${s.asset||s.id+'.png'}`,count:s.grid*s.grid}));
  const cache=new Map();
  const fresh=id=>({id,frame:0,zoom:1,panX:0,panY:0,brightness:100,contrast:100,invert:false});
  let views=[fresh('mr-t2-axial')],active=0,currentTab='history',lastFocus=null;
  function getSeries(id){return series.find(s=>s.id===id);}
  function load(s){
    if(cache.has(s.id))return cache.get(s.id);
    const rec={image:new Image(),ready:false,error:false};cache.set(s.id,rec);
    rec.image.onload=()=>{rec.ready=true;renderCanvases();};
    rec.image.onerror=()=>{rec.error=true;renderCanvases();};
    rec.image.src=s.src;return rec;
  }
  function toast(msg){$('toast').textContent=msg;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),2200);}
  function renderList(){
    let group='';$('seriesCount').textContent=series.length+' 组';
    $('seriesList').innerHTML=series.map(s=>{
      const heading=group!==s.group?`<div class="series-group">${escape(s.group)}</div>`:'';group=s.group;
      return heading+`<button class="series-btn ${views[active].id===s.id?'active':''}" data-series="${s.id}" aria-pressed="${views[active].id===s.id}"><img class="thumb" src="${s.src}" alt="" onerror="this.style.visibility='hidden'"><span class="series-text"><strong>${escape(s.name)}</strong><small>${s.defect?'⚠ 解剖缺陷 · 仅界面演示':(s.count===1?'1 幅投照示例':s.count+' 幅代表层面')+' · '+s.modality}</small></span></button>`;
    }).join('');
    $('seriesList').querySelectorAll('[data-series]').forEach(btn=>btn.onclick=()=>{views[active]=fresh(btn.dataset.series);render();});
  }
  function overlays(v){let s=getSeries(v.id);return `<div class="overlay top-left"><strong>${escape(s.name)}</strong><br>李志强 · 男 / 46岁</div><div class="overlay top-right">${escape(s.plane)}<br>${s.modality==='MR'?'2026-09-03':'2026-08-28'}</div>${s.defect?`<div class="defect-warning">影像不合格：${escape(s.defect)}</div>`:''}${s.locator?`<aside class="locator" aria-label="矢状定位像"><div class="locator-title">矢状定位 · 示意</div><canvas class="locator-canvas"></canvas><div class="locator-level"></div></aside>`:""}<div class="overlay bottom-left mono">${String(v.frame+1).padStart(2,'0')} / ${String(s.count).padStart(2,'0')}<br>${Math.round(v.zoom*100)}%</div><div class="overlay bottom-right">SYNTHETIC · 非诊断影像</div><div class="load-state"></div>`;}
  function render(){
    $('viewerGrid').classList.toggle('quad',views.length===4);
    $('singleBtn').classList.toggle('selected',views.length===1);$('quadBtn').classList.toggle('selected',views.length===4);
    $('viewerGrid').innerHTML=views.map((v,i)=>`<div class="viewport ${i===active?'active':''}" data-view="${i}" tabindex="0" role="group" aria-label="视窗${i+1}，${escape(getSeries(v.id).name)}"><canvas aria-label="教学合成影像"></canvas>${overlays(v)}</div>`).join('');
    $('viewerGrid').querySelectorAll('.viewport').forEach(el=>{
      const index=Number(el.dataset.view);
      el.addEventListener('focus',()=>setActive(index));
      el.addEventListener('wheel',e=>{e.preventDefault();setActive(index);changeFrame(e.deltaY>0?1:-1);},{passive:false});
      let drag=null;
      el.onpointerdown=e=>{setActive(index);el.focus({preventScroll:true});drag={x:e.clientX,y:e.clientY,px:views[index].panX,py:views[index].panY};el.setPointerCapture(e.pointerId);};
      el.onpointermove=e=>{if(!drag)return;views[index].panX=drag.px+e.clientX-drag.x;views[index].panY=drag.py+e.clientY-drag.y;draw(el,views[index]);};
      el.onpointerup=el.onpointercancel=()=>{drag=null;};
      el.ondblclick=()=>{views[index]={...fresh(views[index].id),frame:views[index].frame};syncControls();renderCanvases();};
      load(getSeries(views[index].id));
    });renderList();syncControls();requestAnimationFrame(renderCanvases);
  }
  function setActive(i){active=i;document.querySelectorAll('.viewport').forEach((e,j)=>e.classList.toggle('active',i===j));syncControls();document.querySelectorAll('[data-series]').forEach(e=>{let yes=e.dataset.series===views[active].id;e.classList.toggle('active',yes);e.setAttribute('aria-pressed',yes);});}
  function draw(el,v){
    const canvas=el.querySelector('canvas'),rect=el.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
    const width=Math.max(1,rect.width-2),height=Math.max(1,rect.height-2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
    const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle='#030405';ctx.fillRect(0,0,width,height);
    const s=getSeries(v.id),rec=load(s),state=el.querySelector('.load-state');
    state.textContent=rec.error?'影像文件未能加载，请刷新或检查本地资源。':rec.ready?'':'正在载入影像…';
    if(rec.ready){
      const sw=rec.image.naturalWidth/s.grid,sh=rec.image.naturalHeight/s.grid;
      const sx=(v.frame%s.grid)*sw,sy=Math.floor(v.frame/s.grid)*sh;
      const scale=Math.min((width-26)/sw,(height-34)/sh)*v.zoom;const dw=sw*scale,dh=sh*scale;
      ctx.filter=`brightness(${v.brightness}%) contrast(${v.contrast}%) invert(${v.invert?1:0})`;
      const inset=s.locator?2:0;
      ctx.drawImage(rec.image,sx+inset,sy+inset,sw-2*inset,sh-2*inset,(width-dw)/2+v.panX,(height-dh)/2+v.panY,dw,dh);ctx.filter='none';
    }
    drawLocator(el,v,s);
    el.querySelector('.bottom-left').innerHTML=`${String(v.frame+1).padStart(2,'0')} / ${String(s.count).padStart(2,'0')}<br>${Math.round(v.zoom*100)}%`;
  }
  function drawLocator(el,v,s){
    if(!s.locator)return;
    const box=el.querySelector('.locator'),canvas=box.querySelector('canvas');
    const size=box.clientWidth-2,ratio=window.devicePixelRatio||1;
    canvas.width=Math.round(size*ratio);canvas.height=Math.round(size*ratio);
    const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.fillStyle='#030405';ctx.fillRect(0,0,size,size);
    const rec=load({id:'locator-pair',src:'assets/locator-pair.png'});
    const item=data.axialLevels[v.frame];
    if(rec.ready){
      const sw=rec.image.naturalWidth/2,sh=rec.image.naturalHeight;
      ctx.drawImage(rec.image,s.locator.panel*sw,0,sw,sh,0,0,size,size);
      const y=s.locator.positions[v.frame]*size;
      ctx.strokeStyle='#63f2d4';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(8,y);ctx.lineTo(size-8,y);ctx.stroke();
      ctx.fillStyle='#63f2d4';ctx.beginPath();ctx.moveTo(4,y);ctx.lineTo(11,y-4);ctx.lineTo(11,y+4);ctx.fill();
    }
    box.querySelector('.locator-level').textContent=rec.error?'定位像加载失败':`${item} · ${v.frame+1}/${s.count}`;
  }
  function renderCanvases(){document.querySelectorAll('.viewport').forEach((el,i)=>draw(el,views[i]));}
  function syncControls(){const v=views[active],s=getSeries(v.id);$('frameSlider').max=s.count;$('frameSlider').value=v.frame+1;$('frameSlider').disabled=s.count===1;$('frameLabel').textContent=`${s.locator?data.axialLevels[v.frame]:s.count===1?'投照图':'代表图'} · ${v.frame+1} / ${s.count}`;$('prevFrame').disabled=v.frame===0;$('nextFrame').disabled=v.frame>=s.count-1;$('zoomText').textContent=Math.round(v.zoom*100)+'%';$('brightness').value=v.brightness;$('contrast').value=v.contrast;$('invertBtn').setAttribute('aria-pressed',v.invert);$('invertBtn').classList.toggle('selected',v.invert);}
  function changeFrame(delta){const v=views[active],s=getSeries(v.id);v.frame=Math.max(0,Math.min(s.count-1,v.frame+delta));syncControls();renderCanvases();}
  $('singleBtn').onclick=()=>{views=[views[active]];active=0;render();};
  $('quadBtn').onclick=()=>{if(views.length===4)return;views=[views[active],fresh('mr-t2-axial'),fresh('ct-sagittal'),fresh('xr-lateral')];active=0;render();};
  $('zoomOut').onclick=()=>{views[active].zoom=Math.max(.5,views[active].zoom-.25);syncControls();renderCanvases();};
  $('zoomIn').onclick=()=>{views[active].zoom=Math.min(4,views[active].zoom+.25);syncControls();renderCanvases();};
  $('invertBtn').onclick=()=>{views[active].invert=!views[active].invert;syncControls();renderCanvases();};
  $('resetBtn').onclick=()=>{views[active]={...fresh(views[active].id),frame:views[active].frame};syncControls();renderCanvases();toast('当前视窗已复位');};
  $('prevFrame').onclick=()=>changeFrame(-1);$('nextFrame').onclick=()=>changeFrame(1);
  $('frameSlider').oninput=e=>{views[active].frame=Number(e.target.value)-1;syncControls();renderCanvases();};
  for(const id of ['brightness','contrast'])$(id).oninput=e=>{views[active][id]=Number(e.target.value);renderCanvases();};
  function paragraphs(arr){return arr.map(([h,p])=>`<h3>${escape(h)}</h3><p>${escape(p)}</p>`).join('');}
  function muscleTable(){return `<h3>下肢肌力（MRC）</h3><table><thead><tr><th>肌群</th><th>8/28左侧</th><th>入院左侧</th><th>出院左侧</th><th>右侧</th></tr></thead><tbody>${data.strength.map(r=>`<tr>${r.map(t=>`<td class="${t.includes('↓')?'abnormal':''}">${escape(t)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
  function labTable(){return `<h3>术前血液检查（9月3日）</h3><table><thead><tr><th>项目</th><th>结果</th><th>单位</th><th>参考区间</th></tr></thead><tbody>${data.labs.map(r=>`<tr><td>${escape(r[0])}</td><td>${escape(r[1])} ${escape(r[4])}</td><td>${escape(r[2])}</td><td>${escape(r[3])}</td></tr>`).join('')}</tbody></table><p>↑ / ↓表示超出本模拟实验室参考范围。本例术前所列血液检查均未超范围。心电图：窦性心律，78次/分，无明显异常；无常规胸部CT设定。</p>`;}
  function reportCards(){return data.reports.map(r=>`<section class="report-card" id="report-${r.id}"><h3>${escape(r.title)}</h3><small>检查 ${escape(r.date)} · 报告 ${escape(r.reportTime)}</small><h3>所见</h3><p>${escape(r.findings)}</p><h3>印象</h3><p>${escape(r.impression)}</p><h3>检查目的</h3><p>${escape(r.reason)}</p></section>`).join('');}
  function renderTab(tab){currentTab=tab;document.querySelectorAll('[data-tab]').forEach(btn=>btn.setAttribute('aria-selected',btn.dataset.tab===tab));
    let html='';if(tab==='history')html=paragraphs(data.history)+muscleTable();
    if(tab==='reports')html=reportCards()+labTable();
    if(tab==='course')html=paragraphs(data.course);
    if(tab==='sources')html=`<p class="callout"><b>v${data.version} · ${data.reviewStatus}</b><br>本例用于临床决策和阅片界面演示，未作为真实影像判读考试素材验证。</p><h3>合成影像与功能边界</h3><p>${escape(data.imageLimitations)}</p><h3>病例设定与图像审核</h3><p>病史及报告是病例设定依据。图像可能存在椎体计数、侧别、组织对比或神经根形态偏差，不能用设定报告证明生成图像正确。临床和影像专家需分别审核节段、侧别、根性定位、手术指征和图像适用性；待确认后再作为训练内容。</p><h3>引用依据</h3>${data.sources.map(s=>`<p><a href="${s.url}" target="_blank" rel="noopener noreferrer">${escape(s.title)} ↗</a><br>${escape(s.note)}</p>`).join('')}<h3>图像生成记录</h3><p><a href="assets/generation-prompts.json" download>下载生成提示词与来源记录</a> · <a href="assets/image-quality-notes.md" download>下载影像质量核对记录</a></p><h3>待专家确认</h3><p>手术时机与术式是否合适；L5定位和肌力演变是否合理；代表图的解剖是否可接受；练习/考试中哪些报告内容可以开放；是否需改用授权真实脱敏影像。</p>`;
    $('dialogBody').innerHTML=html;$('dialogBody').scrollTop=0;
  }
  function openDialog(tab,report){lastFocus=document.activeElement;renderTab(tab);$('caseDialog').showModal();if(report)requestAnimationFrame(()=>document.getElementById('report-'+report)?.scrollIntoView({block:'start'}));}
  $('caseBtn').onclick=()=>openDialog('history');$('reportBtn').onclick=()=>openDialog('reports',getSeries(views[active].id).report);
  $('closeDialog').onclick=()=>$('caseDialog').close();$('caseDialog').addEventListener('close',()=>lastFocus?.focus());
  document.querySelectorAll('[data-tab]').forEach(btn=>btn.onclick=()=>renderTab(btn.dataset.tab));
  document.addEventListener('keydown',e=>{if($('caseDialog').open||['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName))return;if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();changeFrame(1);}if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();changeFrame(-1);}});
  new ResizeObserver(()=>renderCanvases()).observe($('viewerGrid'));
  render();
})();
