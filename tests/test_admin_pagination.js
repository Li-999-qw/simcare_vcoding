const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const file of ['frontend/portal.html', 'frontend/en/portal.html',
  'backend/main/app/static/portal.html', 'backend/main/app/static/index.html',
  'backend/runtime/app/static/portal.html', 'backend/runtime/app/static/index.html',
  'backend/extensions/english/site/app/static/portal.html',
  'backend/extensions/english/site/app/static/index.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const english = file.includes('/en/') || file.includes('/english/');
  const pending = html.match(/a\.status==='([^']+)'\?`<div class="row">\$\{btn\('[^']+','approve'/)[1];
  const start = html.indexOf('// Administrator list pagination.');
  assert(start >= 0, `${file}: missing administrator pagination`);
  const end = html.indexOf('\nfunction ', html.indexOf('function admin(){', start) + 1);
  const listeners = {};
  const context = vm.createContext({
    role:'admin', page:'approvals', account:{username:'admin'},
    students: Array.from({length:25}, (_,i) => ({id:i+1, name:`Student-${i+1}`,
      status:pending, dept:'Department', major:'Medicine', studentNo:`N${i+1}`, phone:'123'})),
    applicants:[], teachingNames:[], esc:String,
    table:(headers,rows) => '<table>'+rows.join('')+'</table>',
    tr:cells => '<tr>'+cells.join('|')+'</tr>',
    btn:(label,action,id) => `<button data-action="${action}" data-arg="${id}">${label}</button>`,
    root:{addEventListener:(type,handler) => {listeners[type]=handler;}},
    location:{pathname:english?'/en/portal.html':'/portal.html'},
    render:() => {context.output=context.admin();},
  });
  vm.runInContext(html.slice(start,end),context);
  const records = output => [...output.matchAll(/Student-(\d+)(?: \/ [^|<]+)?\|/g)].map(m=>Number(m[1]));
  const show = () => context.admin();
  const turn = n => listeners.click({target:{closest:()=>({dataset:{adminPage:String(n)},disabled:false})},preventDefault(){}});
  const size = n => listeners.change({target:{matches:s=>s==='[data-admin-size]',value:String(n)}});
  assert.deepEqual(records(show()),[1,2,3,4,5,6,7,8,9,10]);
  assert.match(show(),/data-admin-page="0"[^>]*disabled/);
  turn(2);
  assert.deepEqual(records(context.output),[11,12,13,14,15,16,17,18,19,20]);
  assert.match(context.output,/data-action="approve" data-arg="11"/,'review still targets the correct user');
  assert.deepEqual(records(show()),records(context.output),'refresh retains page');
  context.page='users';
  assert.deepEqual(records(show()),[1,2,3,4,5,6,7,8,9,10],'users has its own page');
  turn(3);
  assert.deepEqual(records(context.output),[21,22,23,24,25]);
  turn(4);
  assert.deepEqual(records(show()),[21,22,23,24,25]);
  context.students=context.students.slice(0,12);
  assert.deepEqual(records(show()),[11,12],'shrinking list clamps the page');
  size(20);
  assert.equal(records(context.output).length,12);
  size(7);
  assert.equal(records(show()).length,12,'invalid page size ignored');
  context.page='approvals';
  assert.deepEqual(records(show()),[11,12],'approval page is retained independently');
  context.account={username:'other-admin'};
  assert.deepEqual(records(show()),[1,2,3,4,5,6,7,8,9,10]);
  context.students=[];
  const empty=show();
  assert.equal(records(empty).length,0);
  assert.match(empty,/data-admin-page="2"[^>]*disabled/);
  assert.match(empty,english?/>Next<\/button>/:/>下一页<\/button>/);
  context.page='home';context.role='student';
  turn(2);size(50); // Events from another role/page must be ignored.
  console.log(`${file}: administrator pagination passed`);
}
