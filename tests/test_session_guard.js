const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/session-guard.js', 'utf8');

async function scenario(path, replies) {
  let timer, redirect, calls = 0;
  const removed = [];
  const location = {pathname: path, origin: 'http://simcare.test', search: '',
    replace: value => { redirect = value; }};
  const window = {location, fetch: async () => {
    const reply = replies[Math.min(calls++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {status: reply.status, ok: reply.status === 200,
      clone() { return this; }, json: async () => reply.body};
  }, addEventListener() {}};
  const context = {window, location, URL, URLSearchParams,
    document: {readyState: 'complete', visibilityState: 'visible',
      addEventListener() {}, getElementById() {return null;},
      createElement() {return {style: {}, remove() {}};}, body: {prepend() {}}},
    sessionStorage: {removeItem: key => removed.push(key)},
    setInterval: fn => {timer = fn;}, clearInterval() {}, console};
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return {window, tick: async () => {await timer(); await new Promise(r => setImmediate(r));},
    redirect: () => redirect, removed};
}

(async () => {
  const expired = {status:401, body:{detail:{code:'SESSION_REPLACED'}}};
  const ok = {status:200, body:{ok:true}};
  const old = await scenario('/portal.html', [ok, expired]);
  await old.tick();
  assert.equal(old.redirect(), '/portal.html?session=replaced');
  const english = await scenario('/en/training/123/', [expired]);
  assert.equal(english.redirect(), '/en/portal.html?session=replaced');
  const login = await scenario('/portal.html', [expired]);
  assert.equal(login.redirect(), undefined, 'login screen must not loop');
  const offline = await scenario('/training/123/', [new Error('offline')]);
  assert.equal(offline.redirect(), undefined, 'network failure is not logout');
  const request = await scenario('/training/123/', [ok, expired]);
  await request.window.fetch('/training/123/api/state');
  assert.equal(request.redirect(), '/portal.html?session=replaced');
  assert(!request.removed.includes('clinical-portal-v1'), 'do not delete saved training drafts');
  console.log('PASS: heartbeat, English redirect, request failure, no redirect loop, offline handling');
})().catch(error => {console.error(error); process.exitCode = 1;});
