const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the actual portal renderer and its page/size event handlers.
for (const file of ['frontend/portal.html', 'frontend/en/portal.html', 'backend/main/app/static/portal.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = html.indexOf('const previousStudent=student,');
  const end = html.indexOf('teacher=function()', start);
  const listeners = {};
  const context = vm.createContext({
    page: 'progress', role: 'student', sid: 1,
    account: {username: 'student1'},
    practiceProgress: Array.from({length: 25}, (_, i) => ({id: `record-${i + 1}`, caseId: 1, percent: 40})),
    cases: [{id: 1, name: '病例'}],
    esc: String,
    panel: (title, content) => `<section><h3>${title}</h3>${content}</section>`,
    learningLink: () => '',
    student: () => '', teacher: () => '', teacherCatalog: () => '',
    root: {addEventListener: (type, handler) => {listeners[type] = handler;}},
    location: {pathname: file.includes('/en/') ? '/en/portal.html' : '/portal.html'},
    render: () => {context.output = context.student();},
  });
  vm.runInContext(html.slice(start, end), context);
  const records = output => [...output.matchAll(/attempt=record-(\d+)/g)].map(m => Number(m[1]));
  const show = () => context.student();
  const turn = number => listeners.click({
    target: {closest: () => ({dataset: {progressPage: String(number)}, disabled: false})},
    preventDefault() {},
  });
  const size = value => listeners.change({target: {
    matches: selector => selector === '[data-progress-size]', value: String(value),
  }});

  assert.deepEqual(records(show()), [1,2,3,4,5,6,7,8,9,10], `${file}: first page must limit records`);
  assert.match(show(), /data-progress-page="0"[^>]*disabled/);
  assert.match(show(), file.includes('/en/') ? /href="\/en\/learning.html\?attempt=record-1"/ : /href="\/learning.html\?attempt=record-1"/);
  assert.match(show(), file.includes('/en/') ? />Next<\/button>/ : />下一页<\/button>/);
  turn(0);
  assert.deepEqual(records(show()), [1,2,3,4,5,6,7,8,9,10], 'out of range navigation is ignored');
  turn(2);
  assert.deepEqual(records(context.output), [11,12,13,14,15,16,17,18,19,20]);
  assert.deepEqual(records(show()), [11,12,13,14,15,16,17,18,19,20], 'rerender retains current page');
  turn(3);
  assert.deepEqual(records(context.output), [21,22,23,24,25]);
  assert.match(context.output, /data-progress-page="4"[^>]*disabled/);
  turn(4);
  assert.deepEqual(records(show()), [21,22,23,24,25]);
  context.practiceProgress = context.practiceProgress.slice(0, 12);
  assert.deepEqual(records(show()), [11,12], 'data shrink clamps to the last page');
  size(20);
  assert.deepEqual(records(context.output), [1,2,3,4,5,6,7,8,9,10,11,12]);
  context.practiceProgress = Array.from({length: 51}, (_, i) => ({id: `record-${i+1}`, caseId: 1, percent: 40}));
  size(50);
  assert.equal(records(context.output).length, 50);
  turn(2);
  assert.deepEqual(records(context.output), [51]);
  context.sid = 2;
  context.account = {username: 'student2'};
  assert.deepEqual(records(show()), [1,2,3,4,5,6,7,8,9,10], 'another student starts with defaults');
  context.practiceProgress = [];
  assert.deepEqual(records(show()), []);
  assert.match(show(), /data-progress-page="2"[^>]*disabled/);
  context.practiceProgress = [{id: 'record-1', caseId: 1, percent: 40}];
  const single = show();
  assert.deepEqual(records(single), [1]);
  assert.match(single, /width:40%/);
  context.page = 'reports';
  assert.doesNotMatch(show(), /data-progress-size/, 'pagination is scoped to learning progress');
  console.log(`${file}: progress pagination passed`);
}
