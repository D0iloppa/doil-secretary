'use strict';

// 반복 일정 전개 — 결정적(deterministic) 계산 코드다. LLM에게 "다음 반복일이 언제냐"를
// 추론시키지 않는다(compute-over-inference) — sec_agenda가 이 모듈에만 의존한다.
// 이 모듈은 순수(pure)하다: 의존성/DB/시계 접근이 없고, doil-console도 이 파일을 그대로
// require해서 같은 전개를 쓴다(로직 중복 금지).
//
// expandOccurrences(node, fromISO, toISO, { timezone? })
//   node: sec_node 문서(시간형 kind만 의미 있음). { start, end?, all_day?, timezone?, recurrence }
//   fromISO/toISO: 조회 창(inclusive). 오프셋(Z/+09:00)이 있으면 순간(instant), 없으면 노드
//     타임존의 벽시계(wall clock)로 해석한다.
//   반환: 창 안에 떨어지는 occurrence 시작시각 배열, 오름차순 + 중복 제거.
//     - 시간 지정 발생: 로컬 ISO + 오프셋("2026-10-01T07:30:00+09:00") — 모호하지 않다.
//     - all_day: "YYYY-MM-DD".
//     occurrence 키(완료 기록 등에 쓰는 안정 식별자)는 occurrenceKey()로 얻는다:
//     "YYYY-MM-DDTHH:mm"(로컬 벽시계) 또는 all_day면 "YYYY-MM-DD".
//
// 타임존: node.timezone → opts.timezone(프로파일 기본값) → 'Asia/Seoul'(DEFAULT_TIMEZONE).
//   오프셋 없는 start("2026-08-22T21:40:00")는 그 타임존의 벽시계로 해석한다(예전처럼 프로세스
//   로컬/UTC 해석에 의존하지 않는다).
//
// recurrence: null | { freq:'daily'|'weekly'|'monthly'|'yearly', interval?:number(기본1),
//   byday?:['MO'|...], until?:ISO(date 또는 datetime, inclusive), count?:number(start 포함 총
//   발생 횟수), exdates?:[occurrenceKey|date|ISO, ...](제외할 발생) }
//   - count는 exdates로 제외된 발생도 센다(RFC 5545와 동일).
//   - monthly/yearly는 시작일의 day-of-month를 유지하되 짧은 달은 그 달의 마지막 날로 clamp한다
//     (1/31 매월 → 2/28(29), 3/31 …; 이전 발생이 아니라 start 기준으로 계산하므로 드리프트 없음).
//     2/29 매년은 평년에 2/28이다.
//   - weekly+byday의 한 주는 일요일 시작(기존 동작 유지).

const DEFAULT_TIMEZONE = 'Asia/Seoul';
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITER = 50000; // 무한루프 안전장치(예: until 없이 매우 넓은 창)
const MINUTE = 60000;
const DAY = 86400000;

// ---- 타임존/벽시계 헬퍼 -------------------------------------------------------------------
// "벽시계 값"(wall)은 해당 타임존의 달력 필드를 Date.UTC로 접어 만든 숫자(ms)다. 달력 산술을
// DST/프로세스 TZ와 무관하게 UTC 필드 연산으로 처리하기 위한 표현일 뿐, 실제 순간이 아니다.

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatterFor(tz); return true; } catch { return false; }
}

function resolveTimezone(...candidates) {
  for (const c of candidates) if (isValidTimezone(c)) return c;
  return DEFAULT_TIMEZONE;
}

// instant(ms) 시점의 tz UTC 오프셋(분).
function offsetMinutes(tz, instantMs) {
  const parts = {};
  for (const p of formatterFor(tz).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MINUTE);
}

const instantToWall = (ms, tz) => ms + offsetMinutes(tz, ms) * MINUTE;

function wallToInstant(wall, tz) {
  const guess = wall - offsetMinutes(tz, wall) * MINUTE;
  return wall - offsetMinutes(tz, guess) * MINUTE;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function offsetSuffix(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function wallDate(wall) {
  const d = new Date(wall);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function wallMinute(wall) {
  const d = new Date(wall);
  return `${wallDate(wall)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 로컬 ISO + 오프셋. 예: "2026-10-01T07:30:00+09:00"
function formatWallISO(wall, tz) {
  const d = new Date(wall);
  const off = offsetMinutes(tz, wallToInstant(wall, tz));
  return `${wallMinute(wall)}:${pad(d.getUTCSeconds())}${offsetSuffix(off)}`;
}

const STRING_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

// ISO 문자열/Date를 벽시계로. 오프셋이 있으면 순간으로 보고 tz 벽시계로 변환, 없으면 그대로 벽시계.
// 반환 { wall, dateOnly } 또는 null.
function parseWall(input, tz) {
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : { wall: instantToWall(input.getTime(), tz), dateOnly: false };
  }
  if (typeof input !== 'string') return null;
  const m = STRING_RE.exec(input.trim());
  if (m) {
    const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    if (isNaN(base)) return null;
    const dateOnly = m[4] === undefined;
    if (m[7] && !dateOnly) {
      const off = m[7] === 'Z' ? 0 : (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(-2));
      return { wall: instantToWall(base - off * MINUTE, tz), dateOnly: false };
    }
    return { wall: base, dateOnly };
  }
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : { wall: instantToWall(d.getTime(), tz), dateOnly: false };
}

// 완료 기록 등에 쓰는 안정 키: "YYYY-MM-DDTHH:mm"(로컬) 또는 all_day의 "YYYY-MM-DD".
function occurrenceKey(occurrence) {
  return typeof occurrence === 'string' ? occurrence.slice(0, occurrence.length === 10 ? 10 : 16) : null;
}

// ---- 달력 산술 ----------------------------------------------------------------------------

const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function withClampedDay(startWall, monthsToAdd) {
  const s = new Date(startWall);
  const total = s.getUTCFullYear() * 12 + s.getUTCMonth() + monthsToAdd;
  const y = Math.floor(total / 12);
  const m0 = total - y * 12;
  const day = Math.min(s.getUTCDate(), daysInMonth(y, m0));
  return Date.UTC(y, m0, day, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds());
}

// 시작(벽시계) 이후의 발생을 오름차순으로 만들어낸다. 호출자가 limit/until/count로 끊는다.
function* series(startWall, rec, interval) {
  const freq = rec.freq;
  if (freq === 'daily') {
    for (let k = 0; k < MAX_ITER; k++) yield startWall + k * interval * DAY;
  } else if (freq === 'weekly') {
    const days = Array.isArray(rec.byday)
      ? [...new Set(rec.byday.map((d) => DOW[d]).filter((d) => d !== undefined))].sort((a, b) => a - b)
      : [];
    if (!days.length) {
      for (let k = 0; k < MAX_ITER; k++) yield startWall + k * interval * 7 * DAY;
    } else {
      const weekStart = startWall - new Date(startWall).getUTCDay() * DAY; // 일요일 시작, start와 같은 시각
      for (let k = 0; k < MAX_ITER; k++) {
        for (const dow of days) {
          const occ = weekStart + (k * interval * 7 + dow) * DAY;
          if (occ >= startWall) yield occ;
        }
      }
    }
  } else if (freq === 'monthly') {
    for (let k = 0; k < MAX_ITER; k++) yield withClampedDay(startWall, k * interval);
  } else if (freq === 'yearly') {
    for (let k = 0; k < MAX_ITER; k++) yield withClampedDay(startWall, k * interval * 12);
  } else {
    yield startWall; // 알 수 없는 freq는 단발로 취급
  }
}

function exdateMatcher(exdates, tz) {
  const minutes = new Set();
  const days = new Set();
  for (const raw of Array.isArray(exdates) ? exdates : []) {
    const p = parseWall(raw, tz);
    if (!p) continue;
    if (p.dateOnly) days.add(wallDate(p.wall));
    else minutes.add(wallMinute(p.wall));
  }
  return (wall, allDay) => days.has(wallDate(wall)) || (!allDay && minutes.has(wallMinute(wall)));
}

function expandOccurrences(node, fromISO, toISO, opts = {}) {
  if (!node || !node.start) return [];
  const tz = resolveTimezone(node.timezone, opts.timezone);
  const startParsed = parseWall(node.start, tz);
  const from = parseWall(fromISO, tz);
  const to = parseWall(toISO, tz);
  if (!startParsed || !from || !to) return [];

  const allDay = !!node.all_day;
  const startWall = allDay ? Math.floor(startParsed.wall / DAY) * DAY : startParsed.wall;
  const inWindow = allDay
    ? (w) => Math.floor(w / DAY) >= Math.floor(from.wall / DAY) && Math.floor(w / DAY) <= Math.floor(to.wall / DAY)
    : (w) => w >= from.wall && w <= to.wall;
  const beyond = allDay ? (w) => Math.floor(w / DAY) > Math.floor(to.wall / DAY) : (w) => w > to.wall;
  const isExcluded = exdateMatcher(node.recurrence?.exdates, tz);
  const emit = (w) => (allDay ? wallDate(w) : formatWallISO(w, tz));

  const rec = node.recurrence || null;
  if (!rec) {
    return inWindow(startWall) && !isExcluded(startWall, allDay) ? [emit(startWall)] : [];
  }

  const interval = Number.isInteger(rec.interval) && rec.interval > 0 ? rec.interval : 1;
  const count = Number.isInteger(rec.count) && rec.count > 0 ? rec.count : Infinity;
  let until = null;
  if (rec.until) {
    const u = parseWall(rec.until, tz);
    if (u) until = u.dateOnly ? (w) => Math.floor(w / DAY) > Math.floor(u.wall / DAY) : (w) => w > u.wall;
  }

  const results = [];
  let produced = 0;
  let iter = 0;
  for (const occ of series(startWall, rec, interval)) {
    if (++iter > MAX_ITER || produced >= count) break;
    if (until && until(occ)) break;
    if (beyond(occ)) break;
    produced++;
    if (inWindow(occ) && !isExcluded(occ, allDay)) results.push(emit(occ));
  }
  return [...new Set(results)].sort();
}

// 지금(now) 기준 로컬 필드. 어젠다 창 계산 등 서버/콘솔이 같은 방식으로 now를 해석하도록 공유한다.
function nowInTimezone(tz, nowMs = Date.now()) {
  const timezone = resolveTimezone(tz);
  const wall = instantToWall(nowMs, timezone);
  return { timezone, wall, date: wallDate(wall), iso: formatWallISO(wall, timezone) };
}

module.exports = {
  DEFAULT_TIMEZONE,
  expandOccurrences,
  occurrenceKey,
  resolveTimezone,
  isValidTimezone,
  parseWall,
  formatWallISO,
  nowInTimezone,
  wallDate,
  wallMinute,
  wallToInstant,
  instantToWall,
  DAY,
};
