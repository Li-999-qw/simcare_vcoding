const assert = require('node:assert/strict');
const {speechSegments} = require('../backend/main/app/speech-segments.js');

assert.deepEqual(speechSegments('我胸口疼。现在好些了', false),
  {segments:['我胸口疼。'], consumed:5});
assert.deepEqual(speechSegments('现在好些了', true),
  {segments:['现在好些了'], consumed:5});
assert.deepEqual(speechSegments('，。', false),
  {segments:[], consumed:2});
const long = '这是一段持续增长但暂时没有句号的患者回答'.repeat(3);
const cut = speechSegments(long, false);
assert.ok(cut.segments.length > 0);
assert.ok(cut.consumed <= long.length);
assert.ok(cut.segments.every(x => x.length <= 80));
console.log('speech segment tests passed');
