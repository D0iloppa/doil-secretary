'use strict';

// 반복 일정 전개 — 결정적(deterministic) 계산 코드다. LLM에게 "다음 반복일이 언제냐"를
// 추론시키지 않는다(compute-over-inference) — sec_agenda가 이 모듈에만 의존한다.
//
// expandOccurrences(node, fromISO, toISO)
//   node: sec_node 문서(시간형 kind만 의미 있음). { start, end?, all_day?, recurrence }
//   fromISO/toISO: 조회 창(inclusive) ISO 문자열
//   반환: 창 안에 떨어지는 occurrence 시작시각(ISO 문자열, all_day면 YYYY-MM-DD) 배열,
//         오름차순 정렬 + 중복 제거.
//
// recurrence: null | { freq:'daily'|'weekly'|'monthly'|'yearly', interval?:number(기본1),
//   byday?:['MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU', ...], until?:ISO }
//
// 지원 범위: interval 반복 + weekly의 byday. monthly/yearly는 시작일의
// day-of-month/month-day를 그대로 유지한다(예: 매달 31일처럼 짧은 달에 없는 날짜는
// JS Date의 롤오버 동작을 그대로 따른다 — 별도 보정 없음, 스펙상 "간단하고 정확하면
// 충분"이라 이 이상의 캘린더 예외 처리는 하지 않는다).

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITER = 20000; // 무한루프 안전장치(예: until 없이 매우 넓은 창)

function formatOccurrence(date, allDay) {
  if (allDay) return date.toISOString().slice(0, 10);
  return date.toISOString();
}

function addPeriod(date, freq, n) {
  const d = new Date(date.getTime());
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (freq === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  else if (freq === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}

function expandOccurrences(node, fromISO, toISO) {
  if (!node || !node.start) return [];
  const start = new Date(node.start);
  if (isNaN(start.getTime())) return [];
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return [];

  const allDay = !!node.all_day;
  const rec = node.recurrence || null;

  if (!rec) {
    if (start >= from && start <= to) return [formatOccurrence(start, allDay)];
    return [];
  }

  const freq = rec.freq;
  const interval = Number.isInteger(rec.interval) && rec.interval > 0 ? rec.interval : 1;
  const until = rec.until ? new Date(rec.until) : null;
  const results = [];

  if (freq === 'weekly' && Array.isArray(rec.byday) && rec.byday.length) {
    let weekAnchor = new Date(start.getTime());
    let iter = 0;
    while (weekAnchor <= to && iter < MAX_ITER) {
      iter++;
      for (const bd of rec.byday) {
        const targetDow = DOW[bd];
        if (targetDow === undefined) continue;
        const occ = new Date(weekAnchor.getTime());
        occ.setUTCDate(occ.getUTCDate() + (targetDow - occ.getUTCDay()));
        if (occ < start) continue;
        if (until && occ > until) continue;
        if (occ >= from && occ <= to) results.push(formatOccurrence(occ, allDay));
      }
      weekAnchor = addPeriod(weekAnchor, 'weekly', interval);
    }
  } else {
    let occ = new Date(start.getTime());
    let iter = 0;
    while (occ <= to && iter < MAX_ITER) {
      iter++;
      if (until && occ > until) break;
      if (occ >= from) results.push(formatOccurrence(occ, allDay));
      occ = addPeriod(occ, freq, interval);
    }
  }

  return [...new Set(results)].sort();
}

module.exports = { expandOccurrences };
