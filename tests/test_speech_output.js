const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {speechSegments} = require('../backend/main/app/speech-segments.js');

const calls=[];
const elements=[];
function element(tag){
  const node={tag,style:{},children:[],listeners:{},setAttribute(name,value){this[name]=value;},
    addEventListener(name,fn){this.listeners[name]=fn;},append(...items){this.children.push(...items);},
    querySelector(){return null;}};
  elements.push(node);return node;
}
let mounted=false;
const toolbar={querySelector(){return {};},insertBefore(node){mounted=true;this.child=node;}};
const document={body:{append(){}},querySelector(){return toolbar;},createElement:element,addEventListener(){}};
const context={
  document,window:{addEventListener(){},AudioContext:class {state='running';resume(){return Promise.resolve();}}},speechSegments,portalGateway:'/training/test',
  AbortController,Uint8Array,DataView,
  accept(next){return next;},async send(){},
  fetch:async (url,options)=>{
    if(url.endsWith('/status'))return {ok:true,json:async()=>({configured:true,patient_voice:603006})};
    calls.push(JSON.parse(options.body));
    return {ok:true,body:{getReader(){return {read:async()=>({done:true})};}}};
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/main/app/speech-output.js'),'utf8'),context);
assert.equal(mounted,true);
const patientToggle=elements.find(node=>node.id==='simcare-speech-patient');
const seniorToggle=elements.find(node=>node.id==='simcare-speech-senior');
assert.equal(patientToggle.checked,true);
assert.equal(seniorToggle.checked,false);

async function flush(){await new Promise(resolve=>setImmediate(resolve));}
(async()=>{
  await flush();
  const first={id:'opening',speaker:'assistant',role:'patient',text:'您好',initial:true};
  const student={id:'question',speaker:'student',role:'patient',text:'哪里疼？'};
  context.accept({id:'session',stage:0,messages:[first],streaming:null,busy:false});
  context.accept({id:'session',stage:0,messages:[first,student],
                  streaming:{role:'patient',text:'我胸口疼。现在稍微好一些'},busy:true});
  await flush();
  assert.deepEqual(calls.map(x=>x.text),['我胸口疼。']);
  context.accept({id:'session',stage:0,messages:[first,student,
    {id:'reply',speaker:'assistant',role:'patient',text:'我胸口疼。现在稍微好一些'}],
    streaming:null,busy:false});
  await flush();
  assert.deepEqual(calls.map(x=>x.text),['我胸口疼。','现在稍微好一些']);
  const senior={id:'senior',speaker:'assistant',role:'senior',text:'请继续监测。'};
  context.accept({id:'session',stage:0,messages:[first,student,senior],streaming:null,busy:false});
  await flush();
  assert.equal(calls.length,2);
  seniorToggle.checked=true;seniorToggle.listeners.change();
  context.accept({id:'session',stage:0,messages:[first,student,senior,
    {id:'senior2',speaker:'assistant',role:'senior',text:'复查心电图。'}],streaming:null,busy:false});
  await flush();
  assert.deepEqual(calls.map(x=>x.role),['patient','patient','senior']);
  patientToggle.checked=false;patientToggle.listeners.change();
  context.accept({id:'session',stage:0,messages:[first,student,senior,
    {id:'senior2',speaker:'assistant',role:'senior',text:'复查心电图。'},
    {id:'patient2',speaker:'assistant',role:'patient',text:'又开始疼了。'}],streaming:null,busy:false});
  await flush();
  assert.equal(calls.length,3);
  console.log('speech output flow tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
