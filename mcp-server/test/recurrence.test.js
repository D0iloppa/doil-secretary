'use strict';
// recurrence.js 순수 전개 테스트 — DB/시계/프로세스 TZ에 의존하지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const { expandOccurrences, occurrenceKey, formatWallISO, parseWall, nowInTimezone } = require('../src/recurrence');


test('Asia/Seoul: naive start is wall clock, output carries +09:00', () => {
  const node = { start: '2026-10-01T07:30:00', all_day: false, recurrence: { freq: 'daily' } };
  const out = expandOccurrences(node, '2026-10-01T00:00:00', '2026-10-03T23:59:59');
  assert.deepStrictEqual(out, ['2026-10-01T07:30:00+09:00', '2026-10-02T07:30:00+09:00', '2026-10-03T07:30:00+09:00']);
  assert.strictEqual(occurrenceKey(out[0]), '2026-10-01T07:30');
});

test('window with Z instant is converted into the node timezone', () => {
  // 2026-09-30T15:00Z == 2026-10-01T00:00+09:00
  const node = { start: '2026-10-01T00:30:00', recurrence: null };
  assert.deepStrictEqual(expandOccurrences(node, '2026-09-30T15:00:00Z', '2026-10-01T14:59:59Z'), ['2026-10-01T00:30:00+09:00']);
  assert.deepStrictEqual(expandOccurrences(node, '2026-10-01T15:00:00Z', '2026-10-02T14:59:59Z'), []);
});

test('start with an explicit offset is normalized to the node timezone', () => {
  const node = { start: '2026-07-30T13:00:00+09:00' };
  assert.deepStrictEqual(expandOccurrences(node, '2026-07-30', '2026-07-30T23:59:59'), ['2026-07-30T13:00:00+09:00']);
  const utc = { start: '2026-07-30T04:00:00Z' };
  assert.deepStrictEqual(expandOccurrences(utc, '2026-07-30', '2026-07-30T23:59:59'), ['2026-07-30T13:00:00+09:00']);
});

test('another IANA timezone is honored (node.timezone beats the default)', () => {
  const node = { start: '2026-01-15T09:00:00', timezone: 'America/New_York' };
  assert.deepStrictEqual(expandOccurrences(node, '2026-01-15', '2026-01-15T23:59:59'), ['2026-01-15T09:00:00-05:00']);
  assert.deepStrictEqual(expandOccurrences(node, '2026-01-15', '2026-01-15T23:59:59', { timezone: 'Asia/Seoul' }), ['2026-01-15T09:00:00-05:00']);
  const plain = { start: '2026-01-15T09:00:00' };
  assert.deepStrictEqual(expandOccurrences(plain, '2026-01-15', '2026-01-15T23:59:59', { timezone: 'Europe/Paris' }), ['2026-01-15T09:00:00+01:00']);
});

test('all_day yields date strings and matches by date', () => {
  const node = { start: '1992-02-01', all_day: true, timezone: 'Asia/Seoul', recurrence: { freq: 'yearly' } };
  assert.deepStrictEqual(expandOccurrences(node, '2026-01-01', '2026-12-31'), ['2026-02-01']);
  // from = a time later the same day still includes today's all-day item
  assert.deepStrictEqual(expandOccurrences({ start: '2026-10-03', all_day: true }, '2026-10-03T15:00:00+09:00', '2026-10-04T00:00:00+09:00'), ['2026-10-03']);
  assert.strictEqual(occurrenceKey('2026-02-01'), '2026-02-01');
});

test('month-end clamps to the last day of the month without drifting', () => {
  const node = { start: '2026-01-31T09:00:00', recurrence: { freq: 'monthly' } };
  const out = expandOccurrences(node, '2026-01-01', '2026-06-30T23:59:59').map((o) => o.slice(0, 10));
  assert.deepStrictEqual(out, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  const leap = expandOccurrences({ start: '2028-01-31T09:00:00', recurrence: { freq: 'monthly' } }, '2028-02-01', '2028-02-29T23:59:59');
  assert.deepStrictEqual(leap.map((o) => o.slice(0, 10)), ['2028-02-29']);
  const yearly = expandOccurrences({ start: '2024-02-29', all_day: true, recurrence: { freq: 'yearly' } }, '2025-01-01', '2028-12-31');
  assert.deepStrictEqual(yearly, ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  const interval = expandOccurrences({ start: '2026-01-31', all_day: true, recurrence: { freq: 'monthly', interval: 2 } }, '2026-01-01', '2026-07-31');
  assert.deepStrictEqual(interval, ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
});

test('exdates drop single occurrences (key, date or ISO form)', () => {
  const node = { start: '2026-10-01T07:30:00', recurrence: { freq: 'daily', exdates: ['2026-10-02T07:30', '2026-10-04', '2026-10-05T07:30:00+09:00'] } };
  const out = expandOccurrences(node, '2026-10-01', '2026-10-06T23:59:59').map(occurrenceKey);
  assert.deepStrictEqual(out, ['2026-10-01T07:30', '2026-10-03T07:30', '2026-10-06T07:30']);
  const allDay = { start: '2026-10-01', all_day: true, recurrence: { freq: 'daily', exdates: ['2026-10-02'] } };
  assert.deepStrictEqual(expandOccurrences(allDay, '2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-03']);
});

test('count limits the series (start included) and exdates still consume the count', () => {
  const node = { start: '2026-10-01T07:30:00', recurrence: { freq: 'daily', count: 3 } };
  assert.strictEqual(expandOccurrences(node, '2026-01-01', '2027-01-01').length, 3);
  const withEx = { start: '2026-10-01T07:30:00', recurrence: { freq: 'daily', count: 3, exdates: ['2026-10-02'] } };
  assert.deepStrictEqual(expandOccurrences(withEx, '2026-01-01', '2027-01-01').map((o) => o.slice(0, 10)), ['2026-10-01', '2026-10-03']);
  // a window after the series ends is empty; count counts from start, not from the window
  assert.deepStrictEqual(expandOccurrences(node, '2026-10-10', '2026-10-20'), []);
  const weekly = { start: '2026-10-05T10:00:00', recurrence: { freq: 'weekly', byday: ['MO', 'WE'], count: 3 } }; // Mon
  assert.deepStrictEqual(expandOccurrences(weekly, '2026-10-01', '2026-12-31').map((o) => o.slice(0, 10)), ['2026-10-05', '2026-10-07', '2026-10-12']);
});

test('until is inclusive (date-only until covers the whole day)', () => {
  const node = { start: '2026-10-01T22:00:00', recurrence: { freq: 'daily', until: '2026-10-03' } };
  assert.strictEqual(expandOccurrences(node, '2026-10-01', '2026-10-10').length, 3);
  const timed = { start: '2026-10-01T22:00:00', recurrence: { freq: 'daily', until: '2026-10-02T21:00:00' } };
  assert.strictEqual(expandOccurrences(timed, '2026-10-01', '2026-10-10').length, 1);
});

test('weekly byday keeps working (Sunday-based weeks, interval)', () => {
  const node = { start: '2026-09-28T09:00:00', recurrence: { freq: 'weekly', byday: ['MO', 'FR'], interval: 2 } };
  assert.deepStrictEqual(expandOccurrences(node, '2026-09-28', '2026-10-31').map((o) => o.slice(0, 10)), ['2026-09-28', '2026-10-02', '2026-10-12', '2026-10-16', '2026-10-26', '2026-10-30']);
});

test('todo-like one-shot, backward compatible node shapes from existing data', () => {
  // shapes seen in a real secretary.db
  assert.deepStrictEqual(expandOccurrences({ start: '2026-08-22T21:40:00', end: '2026-08-23T01:20:00', all_day: false, timezone: 'Asia/Seoul', recurrence: null, status: 'active' }, '2026-08-22', '2026-08-22T23:59:59'), ['2026-08-22T21:40:00+09:00']);
  assert.deepStrictEqual(expandOccurrences({ start: '2026-07-25', all_day: true, timezone: 'Asia/Seoul', recurrence: null }, '2026-07-25', '2026-07-25'), ['2026-07-25']);
  assert.deepStrictEqual(expandOccurrences({ start: '1992-02-01', all_day: true, recurrence: { freq: 'yearly' } }, '2027-02-01', '2027-02-01'), ['2027-02-01']);
  assert.deepStrictEqual(expandOccurrences({ kind: 'todo', start: '2026-10-02T18:00', recurrence: null, status: 'done' }, '2026-10-02', '2026-10-02T23:59:59'), ['2026-10-02T18:00:00+09:00']);
  // missing / invalid inputs never throw
  assert.deepStrictEqual(expandOccurrences(null, 'a', 'b'), []);
  assert.deepStrictEqual(expandOccurrences({ start: 'nonsense' }, '2026-01-01', '2026-01-02'), []);
  assert.deepStrictEqual(expandOccurrences({ start: '2026-01-01', recurrence: { freq: 'bogus' } }, '2026-01-01', '2026-01-05'), ['2026-01-01T00:00:00+09:00']);
});

test('helpers: parseWall / formatWallISO / nowInTimezone', () => {
  const p = parseWall('2026-10-01T07:30:00Z', 'Asia/Seoul');
  assert.strictEqual(formatWallISO(p.wall, 'Asia/Seoul'), '2026-10-01T16:30:00+09:00');
  const n = nowInTimezone('Asia/Seoul', Date.UTC(2026, 8, 30, 15, 5));
  assert.strictEqual(n.date, '2026-10-01');
  assert.strictEqual(n.iso, '2026-10-01T00:05:00+09:00');
  assert.strictEqual(nowInTimezone('Not/AZone', 0).timezone, 'Asia/Seoul');
});
