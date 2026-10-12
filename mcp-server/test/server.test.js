'use strict';
// MCP 서버를 stdio로 띄워(임시 DOILSECRETARY_HOME) 도구를 호출하는 통합 테스트.
// 실제 사용자 데이터(~/.doil-secretary)는 건드리지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let home;
let client;

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'src', 'index.js')],
    env: { PATH: process.env.PATH, DOILSECRETARY_HOME: home },
  });
  client = new Client({ name: 'sec-test', version: '0.0.0' });
  await client.connect(transport);
});
test.after(async () => {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const keys = (r) => r.items.map((i) => `${i.node_id}@${i.occurrence_key}`);

test('todo kind: one-shot completion sets status and logs; undo restores; idempotent', async () => {
  const put = await call('sec_node_put', { id: 'todo::dentist', kind: 'todo', title: '치과 예약 전화', start: '2026-10-02T11:00' });
  assert.strictEqual(put.ok, true);
  assert.strictEqual(put.node.status, 'active');

  let r = await call('sec_agenda', { from: '2026-10-02', to: '2026-10-02T23:59:59', kind: 'todo' });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].occurrence, '2026-10-02T11:00:00+09:00');
  assert.strictEqual(r.items[0].occurrence_key, '2026-10-02T11:00');
  assert.strictEqual(r.items[0].done, false);

  const done = await call('sec_complete', { id: 'todo::dentist' });
  assert.deepStrictEqual([done.ok, done.changed, done.done, done.status], [true, true, true, 'done']);
  assert.strictEqual((await call('sec_node_get', { id: 'todo::dentist' })).status, 'done');
  r = await call('sec_agenda', { from: '2026-10-02', to: '2026-10-02T23:59:59' });
  assert.strictEqual(r.items.find((i) => i.node_id === 'todo::dentist').done, true);

  const again = await call('sec_complete', { id: 'todo::dentist', occurrence: '2026-10-02T11:00' });
  assert.strictEqual(again.changed, false);

  const undo = await call('sec_complete', { id: 'todo::dentist', done: false });
  assert.deepStrictEqual([undo.ok, undo.changed, undo.done, undo.status], [true, true, false, 'active']);
  r = await call('sec_agenda', { from: '2026-10-02', to: '2026-10-02T23:59:59' });
  assert.strictEqual(r.items.find((i) => i.node_id === 'todo::dentist').done, false);

  const logs = await call('sec_log_list', { node_id: 'todo::dentist' });
  const events = logs.map((l) => l.event).sort();
  assert.deepStrictEqual(events, ['complete', 'create', 'uncomplete']);
  assert.ok(logs.filter((l) => l.event !== 'create').every((l) => l.occurrence === '2026-10-02T11:00'));
});

test('recurring: per-occurrence completion leaves the node active; exdates and count apply', async () => {
  await call('sec_node_put', {
    id: 'routine::english', kind: 'routine', title: '영어 단어 30개', start: '2026-10-01T07:30',
    recurrence: { freq: 'daily', count: 5, exdates: ['2026-10-03'] },
  });
  let r = await call('sec_agenda', { from: '2026-10-01', to: '2026-10-31', kind: 'routine' });
  assert.deepStrictEqual(keys(r), ['routine::english@2026-10-01T07:30', 'routine::english@2026-10-02T07:30', 'routine::english@2026-10-04T07:30', 'routine::english@2026-10-05T07:30']);

  const c = await call('sec_complete', { id: 'routine::english', occurrence: '2026-10-02T07:30' });
  assert.deepStrictEqual([c.ok, c.changed], [true, true]);
  assert.strictEqual((await call('sec_node_get', { id: 'routine::english' })).status, 'active');
  r = await call('sec_agenda', { from: '2026-10-01', to: '2026-10-31', kind: 'routine' });
  assert.deepStrictEqual(r.items.map((i) => i.done), [false, true, false, false]);

  assert.strictEqual((await call('sec_complete', { id: 'routine::english', occurrence: '2026-10-03T07:30' })).ok, false); // excluded
  assert.strictEqual((await call('sec_complete', { id: 'routine::english' })).ok, false); // occurrence required
  assert.strictEqual((await call('sec_complete', { id: 'nope' })).ok, false);

  await call('sec_complete', { id: 'routine::english', occurrence: '2026-10-02T07:30', done: false });
  r = await call('sec_agenda', { from: '2026-10-01', to: '2026-10-31', kind: 'routine' });
  assert.ok(r.items.every((i) => i.done === false));
});

test('backward compatible nodes (no todo/count/exdates fields) still work', async () => {
  await call('sec_node_put', { id: 'anniversary::bday', kind: 'anniversary', title: '생일', start: '1992-02-01', all_day: true, timezone: 'Asia/Seoul', recurrence: { freq: 'yearly' } });
  await call('sec_node_put', { id: 'event::old', kind: 'event', title: '구미 워크숍', start: '2026-07-30T13:00:00+09:00', timezone: 'Asia/Seoul' });
  const r = await call('sec_agenda', { from: '2027-02-01', to: '2027-02-01' });
  assert.deepStrictEqual(keys(r), ['anniversary::bday@2027-02-01']);
  const old = await call('sec_agenda', { from: '2026-07-30', to: '2026-07-30T23:59:59' });
  assert.strictEqual(old.items[0].occurrence, '2026-07-30T13:00:00+09:00');
});

test('presets use local (Asia/Seoul) day boundaries and offset ISO windows', async () => {
  const t = await call('sec_agenda', { preset: 'today' });
  assert.match(t.window.from, /T00:00:00\+09:00$/);
  assert.match(t.window.to, /T23:59:59\+09:00$/);
  const status = await call('sec_status');
  assert.ok(status.by_kind.todo >= 1);
});

test('month-end monthly node through the tool', async () => {
  await call('sec_node_put', { id: 'routine::rent', kind: 'routine', title: '월말 정산', start: '2026-01-31', all_day: true, recurrence: { freq: 'monthly' } });
  const r = await call('sec_agenda', { from: '2026-02-01', to: '2026-04-30', kind: 'routine' });
  assert.deepStrictEqual(r.items.filter((i) => i.node_id === 'routine::rent').map((i) => i.occurrence), ['2026-02-28', '2026-03-31', '2026-04-30']);
});

test('memo: body_md/color/updated_at, legacy text migrates on read, optimistic update, soft discard', async () => {
  // legacy-shaped doc (text only), as written before body_md existed
  const legacy = await call('sec_memo_add', { id: 'memo::legacy-1', text: '우유 사기' });
  assert.strictEqual(legacy.ok, true);
  assert.strictEqual(legacy.memo.body_md, '우유 사기');
  assert.strictEqual(legacy.memo.text, '우유 사기');
  assert.strictEqual(legacy.memo.color, 'yellow');
  assert.ok(legacy.memo.updated_at);

  const added = await call('sec_memo_add', { body_md: '**회의** 준비\n- 자료', color: 'green' });
  assert.strictEqual(added.ok, true);
  assert.deepStrictEqual([added.memo.color, added.memo.text, added.memo.status], ['green', '**회의** 준비\n- 자료', 'active']);
  assert.strictEqual((await call('sec_memo_add', { color: 'blue' })).ok, false, 'a body is required');

  const id = added.memo.id;
  const v1 = added.memo.updated_at;
  const upd = await call('sec_memo_update', { id, body_md: '수정됨', expected_updated_at: v1 });
  assert.strictEqual(upd.ok, true);
  assert.strictEqual(upd.memo.body_md, '수정됨');
  assert.strictEqual(upd.memo.text, '수정됨');
  assert.strictEqual(upd.memo.color, 'green', 'color untouched when omitted');
  assert.ok(upd.memo.updated_at > v1, 'version strictly advances');

  // stale writer: nothing is written, the current memo comes back
  const stale = await call('sec_memo_update', { id, body_md: '내 버전', color: 'pink', expected_updated_at: v1 });
  assert.deepStrictEqual([stale.ok, stale.conflict, stale.memo.body_md, stale.memo.color], [false, true, '수정됨', 'green']);
  assert.strictEqual((await call('sec_memo_get', { id })).body_md, '수정됨');

  // color-only change, then keep-mine style resend with the fresh version
  const recolor = await call('sec_memo_update', { id, color: 'purple', expected_updated_at: upd.memo.updated_at });
  assert.deepStrictEqual([recolor.ok, recolor.memo.color, recolor.memo.body_md], [true, 'purple', '수정됨']);
  assert.strictEqual((await call('sec_memo_update', { id, body_md: '내 버전', expected_updated_at: recolor.memo.updated_at })).ok, true);
  assert.strictEqual((await call('sec_memo_update', { id: 'memo::nope', body_md: 'x', expected_updated_at: 'x' })).ok, false);
  assert.strictEqual((await call('sec_memo_update', { id, body_md: 'x'.repeat(20001), expected_updated_at: 'x' }).catch(() => ({ ok: false }))).ok, false);

  // list ordering: recent = updated_at desc
  const recent = await call('sec_memo_list', { order: 'recent' });
  assert.strictEqual(recent[0].id, id);
  assert.ok(recent.every((m) => m.body_md !== undefined && m.color && m.updated_at));

  // soft discard bumps the version and later writers get a conflict, not a revival
  const cur = await call('sec_memo_get', { id });
  const gone = await call('sec_memo_discard', { id });
  assert.deepStrictEqual([gone.ok, gone.memo.status], [true, 'discarded']);
  assert.ok(gone.memo.updated_at > cur.updated_at);
  const late = await call('sec_memo_update', { id, body_md: 'zombie', expected_updated_at: gone.memo.updated_at });
  assert.deepStrictEqual([late.ok, late.conflict, late.memo.status], [false, true, 'discarded']);
  assert.ok(!(await call('sec_memo_list', {})).some((m) => m.id === id));
  assert.ok((await call('sec_memo_list', { status: 'discarded' })).some((m) => m.id === id));
});

test('memo: a raw legacy doc (text only, no body_md/color/updated_at) is readable and updatable', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(home, 'data', 'secretary.db'));
  db.prepare('INSERT OR REPLACE INTO sec_memo (id, doc) VALUES (?, ?)').run('memo::raw-legacy', JSON.stringify({
    id: 'memo::raw-legacy', text: '옛 메모', remind_at: null, status: 'active', created_at: '2026-09-01T00:00:00.000Z', modified_at: '2026-09-02T00:00:00.000Z',
  }));
  db.close();
  const got = await call('sec_memo_get', { id: 'memo::raw-legacy' });
  assert.deepStrictEqual([got.body_md, got.color, got.updated_at], ['옛 메모', 'yellow', '2026-09-02T00:00:00.000Z']);
  const upd = await call('sec_memo_update', { id: 'memo::raw-legacy', body_md: '새 메모', expected_updated_at: got.updated_at });
  assert.strictEqual(upd.ok, true);
  assert.strictEqual(upd.memo.created_at, '2026-09-01T00:00:00.000Z');
});

test('node put: location round-trips; null clears end/description/location; omission preserves', async () => {
  const base = { id: 'event::loc-1', kind: 'event', title: '회의', start: '2026-10-05T10:00', end: '2026-10-05T11:00', description: '안건', location: '  본사 3층  ' };
  const put = await call('sec_node_put', base);
  assert.strictEqual(put.node.location, '본사 3층');
  assert.strictEqual((await call('sec_node_get', { id: base.id })).location, '본사 3층');
  assert.strictEqual((await call('sec_node_list', { kind: 'event' })).find((n) => n.id === base.id).location, '본사 3층');

  const kept = await call('sec_node_put', { id: base.id, kind: 'event', title: '회의2' });
  assert.deepStrictEqual([kept.node.location, kept.node.end, kept.node.description], ['본사 3층', '2026-10-05T11:00', '안건']);

  const cleared = await call('sec_node_put', { id: base.id, kind: 'event', title: '회의2', end: null, description: null, location: null });
  assert.deepStrictEqual([cleared.node.location, cleared.node.end, cleared.node.description], [null, null, '']);
  assert.strictEqual((await call('sec_node_get', { id: base.id })).end, null);

  const tooLong = await client.callTool({ name: 'sec_node_put', arguments: { ...base, id: 'event::loc-2', location: 'x'.repeat(201) } });
  assert.ok(tooLong.isError || /ok":\s*false/.test(tooLong.content[0].text));
});
