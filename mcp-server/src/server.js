'use strict';

const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { djinn, CATALOG_ID, PROFILE_ID, makeLogId, makeMemoId } = require('./db');
const { ONBOARD_LOCK_PATH, DOILSECRETARY_HOME } = require('./paths');
const {
  expandOccurrences, occurrenceKey, resolveTimezone, parseWall, formatWallISO, wallDate,
  instantToWall, wallToInstant, DAY,
} = require('./recurrence');

// 'todo'(할 일): start = 기한(due), 단발이면 완료 시 status:'done'. 반복 항목의 완료는
// 발생(occurrence)별 sec_log 기록으로 남긴다(sec_complete).
const TEMPORAL_KINDS = ['event', 'anniversary', 'routine', 'todo'];
const NODE_KINDS = [...TEMPORAL_KINDS, 'person', 'project'];
const LOG_EVENTS = ['create', 'update', 'complete', 'uncomplete', 'remind', 'curate'];
const OCCURRENCE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const CURATION_CATALOGS = ['ai-echo', 'sun-sang', 'doil-research', 'doil-supervise'];

function json(text) {
  return { content: [{ type: 'text', text: JSON.stringify(text, null, 2) }] };
}

function now() {
  return new Date().toISOString();
}

function getCatalog() {
  return djinn.get('sec_catalog', CATALOG_ID);
}

function ensureCatalog() {
  let root = getCatalog();
  if (!root) {
    const ts = now();
    root = { default_timezone: null, calendars: {}, created_at: ts, modified_at: ts };
    djinn.put('sec_catalog', CATALOG_ID, root);
  }
  return root;
}

function addLog({ node_id, event, detail, occurrence }) {
  const id = makeLogId(event);
  const doc = {
    id,
    node_id: node_id ?? null,
    event,
    detail: detail ?? null,
    created_at: now(),
  };
  if (occurrence) doc.occurrence = occurrence;
  djinn.put('sec_log', id, doc);
  return doc;
}

// 사용자 기본 타임존(프로파일) → 'Asia/Seoul'. 노드에 timezone이 있으면 그쪽이 우선한다.
function defaultTimezone() {
  return resolveTimezone(djinn.get('sec_profile', PROFILE_ID)?.timezone);
}

// 'today'/'week'/'next_days:N' 프리셋 또는 명시적 from/to를 [fromISO, toISO] 창으로
// 해석한다. 아무것도 안 주면 기본 'week'(오늘부터 +7일). 프리셋의 하루 경계는 UTC가 아니라
// 사용자 타임존의 로컬 자정이며, 창은 오프셋 포함 ISO로 반환한다.
function resolveWindow({ from, to, preset, days }) {
  if (from && to) return { from, to };
  const tz = defaultTimezone();
  const todayStart = Math.floor(instantToWall(Date.now(), tz) / DAY) * DAY;
  const p = preset || 'week';
  let spanDays = 0;
  if (p === 'next_days') spanDays = Number.isInteger(days) && days > 0 ? days : 7;
  else if (p !== 'today') spanDays = 7; // 'week' 기본값
  const endWall = todayStart + spanDays * DAY + DAY - 1000; // 해당 날짜 23:59:59
  return {
    from: from ?? formatWallISO(todayStart, tz),
    to: to ?? formatWallISO(endWall, tz),
  };
}

// 발생(occurrence)별 완료 상태: sec_log의 complete/uncomplete 중 가장 마지막 기록이 이긴다.
// 반환: Map("node_id|occurrenceKey" → true(완료)|false(되돌림)).
function completionMap() {
  const state = new Map();
  const rows = [
    ...djinn.find('sec_log', { event: 'complete' }),
    ...djinn.find('sec_log', { event: 'uncomplete' }),
  ].filter((r) => r.node_id && r.occurrence);
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  for (const r of rows) state.set(`${r.node_id}|${r.occurrence}`, r.event === 'complete');
  return state;
}

function isDone(node, key, completions) {
  const logged = completions.get(`${node.id}|${key}`);
  if (logged !== undefined) return logged;
  return !node.recurrence && node.status === 'done';
}

function buildAgenda({ from, to, kind }) {
  const filter = {};
  if (kind) filter.kind = kind;
  const candidates = djinn
    .find('sec_node', filter)
    .filter((n) => TEMPORAL_KINDS.includes(n.kind));

  const items = [];
  const tz = defaultTimezone();
  const completions = completionMap();
  for (const node of candidates) {
    const occurrences = expandOccurrences(node, from, to, { timezone: tz });
    for (const occurrence of occurrences) {
      const key = occurrenceKey(occurrence);
      items.push({
        node_id: node.id,
        kind: node.kind,
        title: node.title,
        occurrence,
        occurrence_key: key,
        all_day: !!node.all_day,
        timezone: resolveTimezone(node.timezone, tz),
        status: node.status ?? null,
        done: isDone(node, key, completions),
        curations: node.curations ?? [],
      });
    }
  }
  items.sort((a, b) => (a.occurrence < b.occurrence ? -1 : a.occurrence > b.occurrence ? 1 : 0));
  return items;
}

function createServer() {
  const server = new McpServer({ name: 'doil-secretary', version: '0.1.0' });

  // ---- 온보딩 게이트 -------------------------------------------------

  server.tool(
    'sec_onboard_status',
    '온보딩 완료 여부를 확인한다. 데이터 홈(기본 ~/.doil-secretary, DOILSECRETARY_HOME으로 오버라이드)의 onboard.lock 파일 존재 여부가 기준이다(파일 없음 = 미완료). 저장된 사용자 프로파일과 데이터 홈/DB 경로도 함께 반환한다. 차단 게이트가 아니라 유도용 — 미완료여도 진행 자체는 막지 않는다.',
    {},
    async () => {
      const onboarded = fs.existsSync(ONBOARD_LOCK_PATH);
      const profile = djinn.get('sec_profile', PROFILE_ID);
      return json({
        onboarded,
        profile: profile ?? null,
        data_home: DOILSECRETARY_HOME,
        db_path: require('./paths').DB_PATH,
      });
    }
  );

  server.tool(
    'sec_onboard_complete',
    '사용자 프로파일(이름/타임존/근무시간)을 저장하고 onboard.lock 파일을 생성해 온보딩을 완료 처리한다.',
    {
      name: z.string().describe('사용자 이름/호칭'),
      timezone: z.string().describe('기본 타임존, 예: "Asia/Seoul"'),
      working_hours: z.string().optional().describe('근무시간/가용시간 요약(선택), 예: "09:00-18:00"'),
    },
    async ({ name, timezone, working_hours }) => {
      const ts = now();
      const existing = djinn.get('sec_profile', PROFILE_ID);
      const doc = {
        name,
        timezone,
        working_hours: working_hours ?? existing?.working_hours ?? null,
        onboarded_at: ts,
        created_at: existing?.created_at ?? ts,
        modified_at: ts,
      };
      djinn.put('sec_profile', PROFILE_ID, doc);
      fs.writeFileSync(
        ONBOARD_LOCK_PATH,
        JSON.stringify({ onboarded_at: ts, profile_summary: doc }, null, 2)
      );
      ensureCatalog();
      return json({ ok: true, onboarded_at: ts });
    }
  );

  // ---- 노드 -------------------------------------------------------

  const relatesToSchema = z.object({
    node_id: z.string(),
    rel: z.string().optional(),
    note: z.string().optional(),
  });
  const curationSchema = z.object({
    catalog: z.enum(CURATION_CATALOGS),
    reason: z.string(),
    note: z.string().optional(),
  });
  const recurrenceSchema = z
    .object({
      freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
      interval: z.number().int().positive().optional(),
      byday: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
      until: z.string().optional(),
      count: z.number().int().positive().optional().describe('start 포함 총 발생 횟수'),
      exdates: z.array(z.string()).optional().describe('제외할 발생 목록("YYYY-MM-DDTHH:mm" 또는 "YYYY-MM-DD")'),
    })
    .nullable();

  server.tool(
    'sec_node_put',
    '그래프 노드(일정/기념일/루틴/할 일/인물/프로젝트)를 upsert한다. kind가 event/anniversary/routine/todo(시간형; todo는 start=기한)이면 start가 필수이고 recurrence/status 등 시간형 필드가 함께 저장된다 — 비시간형(person/project)은 이 필드들을 무시한다. relates_to/belongs_to/curations는 명시하지 않으면 기존 값을 보존한다(부분 갱신). 성공 후 create 또는 update 로그를 남긴다.',
    {
      id: z.string().describe('전역 유일 slug, 예: "event::2026-08-01-dentist", "person::mom"'),
      kind: z.enum(NODE_KINDS),
      title: z.string(),
      description: z.string().nullable().optional().describe('null=비우기, 생략=기존 값 보존'),
      location: z.string().trim().max(200).nullable().optional().describe('장소(≤200자). null=비우기, 생략=기존 값 보존'),
      tags: z.array(z.string()).optional(),
      relates_to: z.array(relatesToSchema).optional().describe('비계층 참조 목록(전체 교체). 점진적 추가/삭제는 sec_node_link/sec_node_unlink 권장'),
      belongs_to: z.string().nullable().optional().describe('상위 프로젝트 노드 id(계층 edge), 없으면 null'),
      curations: z.array(curationSchema).optional().describe('연계 스킬 큐레이션 제안 목록(전체 교체). 점진적 추가/삭제는 sec_node_curate/sec_node_uncurate 권장'),
      start: z.string().optional().describe('시간형 kind 필수 — ISO date 또는 datetime'),
      end: z.string().nullable().optional().describe('null=비우기, 생략=기존 값 보존'),
      all_day: z.boolean().optional(),
      timezone: z.string().optional(),
      recurrence: recurrenceSchema.optional().describe('null=단발성. 생략 시 기존 값 보존'),
      status: z.enum(['active', 'done', 'cancelled']).optional().describe('시간형 kind만 사용, 기본 active'),
      contact: z.string().optional().describe('person kind 전용'),
      relation: z.string().optional().describe('person kind 전용'),
    },
    async (args) => {
      const {
        id, kind, title, description, location, tags, relates_to, belongs_to, curations,
        start, end, all_day, timezone, recurrence, status, contact, relation,
      } = args;
      const isTemporal = TEMPORAL_KINDS.includes(kind);
      const existing = djinn.get('sec_node', id);
      if (isTemporal && !start && !existing?.start) {
        return json({ ok: false, error: `kind:'${kind}' 노드는 start가 필수입니다.` });
      }
      const ts = now();
      const doc = {
        id,
        kind,
        title,
        description: description === undefined ? existing?.description ?? '' : description ?? '',
        location: location === undefined ? existing?.location ?? null : (location || null),
        tags: tags ?? existing?.tags ?? [],
        relates_to: relates_to ?? existing?.relates_to ?? [],
        belongs_to: belongs_to === undefined ? existing?.belongs_to ?? null : belongs_to,
        curations: curations ?? existing?.curations ?? [],
        created_at: existing?.created_at ?? ts,
        modified_at: ts,
      };
      if (isTemporal) {
        doc.start = start ?? existing?.start;
        doc.end = end === undefined ? existing?.end ?? null : end;
        doc.all_day = all_day ?? existing?.all_day ?? false;
        doc.timezone = timezone ?? existing?.timezone ?? null;
        doc.recurrence = recurrence === undefined ? existing?.recurrence ?? null : recurrence;
        doc.status = status ?? existing?.status ?? 'active';
      }
      if (kind === 'person') {
        doc.contact = contact ?? existing?.contact ?? null;
        doc.relation = relation ?? existing?.relation ?? null;
      }
      djinn.put('sec_node', id, doc);
      const log = addLog({ node_id: id, event: existing ? 'update' : 'create', detail: { kind } });
      return json({ ok: true, id, node: doc, log });
    }
  );

  server.tool(
    'sec_node_get',
    '노드 하나를 조회한다.',
    { id: z.string() },
    async ({ id }) => json(djinn.get('sec_node', id) ?? null)
  );

  server.tool(
    'sec_node_list',
    '노드 목록을 조회한다. kind/status/belongs_to/tag/날짜범위(start 기준)로 선택 필터링 가능.',
    {
      kind: z.enum(NODE_KINDS).optional(),
      status: z.enum(['active', 'done', 'cancelled']).optional(),
      belongs_to: z.string().optional(),
      tag: z.string().optional(),
      from: z.string().optional().describe('start >= from (ISO)'),
      to: z.string().optional().describe('start <= to (ISO)'),
    },
    async ({ kind, status, belongs_to, tag, from, to }) => {
      const filter = {};
      if (kind) filter.kind = kind;
      if (status) filter.status = status;
      if (belongs_to) filter.belongs_to = belongs_to;
      let rows = djinn.find('sec_node', filter, { orderBy: 'created_at', orderDir: 'asc' });
      if (tag) rows = rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
      if (from) rows = rows.filter((r) => r.start && r.start >= from);
      if (to) rows = rows.filter((r) => r.start && r.start <= to);
      return json(rows);
    }
  );

  server.tool(
    'sec_node_del',
    '노드 하나를 삭제한다(cascade 없음 — belongs_to/relates_to로 이 노드를 참조하던 다른 노드는 자동 정리되지 않는다).',
    { id: z.string() },
    async ({ id }) => {
      djinn.del('sec_node', id);
      return json({ ok: true });
    }
  );

  server.tool(
    'sec_node_link',
    '노드에 비계층 참조(relates_to) 하나를 추가/갱신한다(같은 node_id로 다시 호출하면 rel/note만 갱신).',
    {
      id: z.string().describe('참조를 추가할 노드 id'),
      node_id: z.string().describe('참조 대상 노드 id'),
      rel: z.string().optional().describe('관계 종류(자유 텍스트, 예: "attendee", "gift-for")'),
      note: z.string().optional(),
    },
    async ({ id, node_id, rel, note }) => {
      const existing = djinn.get('sec_node', id);
      if (!existing) return json({ ok: false, error: `node not found: ${id}` });
      const relates_to = [...(existing.relates_to ?? [])];
      const idx = relates_to.findIndex((r) => r.node_id === node_id);
      if (idx >= 0) relates_to[idx] = { node_id, rel: rel ?? relates_to[idx].rel, note: note ?? relates_to[idx].note };
      else relates_to.push({ node_id, rel: rel ?? '', note: note ?? '' });
      const doc = { ...existing, relates_to, modified_at: now() };
      djinn.put('sec_node', id, doc);
      return json({ ok: true, node: doc });
    }
  );

  server.tool(
    'sec_node_unlink',
    '노드의 비계층 참조(relates_to) 하나를 제거한다.',
    { id: z.string(), node_id: z.string() },
    async ({ id, node_id }) => {
      const existing = djinn.get('sec_node', id);
      if (!existing) return json({ ok: false, error: `node not found: ${id}` });
      const relates_to = (existing.relates_to ?? []).filter((r) => r.node_id !== node_id);
      const doc = { ...existing, relates_to, modified_at: now() };
      djinn.put('sec_node', id, doc);
      return json({ ok: true, node: doc });
    }
  );

  server.tool(
    'sec_node_curate',
    '노드에 연계 스킬 큐레이션 제안 하나를 추가/갱신한다(같은 catalog로 다시 호출하면 reason/note만 갱신). 큐레이션은 어디까지나 제안 저장일 뿐 — 이 도구는 다른 스킬을 호출/실행하지 않는다. 성공 후 curate 로그를 남긴다.',
    {
      id: z.string(),
      catalog: z.enum(CURATION_CATALOGS),
      reason: z.string().describe('왜 이 스킬 연계가 제안되는지'),
      note: z.string().optional(),
    },
    async ({ id, catalog, reason, note }) => {
      const existing = djinn.get('sec_node', id);
      if (!existing) return json({ ok: false, error: `node not found: ${id}` });
      const curations = [...(existing.curations ?? [])];
      const idx = curations.findIndex((c) => c.catalog === catalog);
      if (idx >= 0) curations[idx] = { catalog, reason, note: note ?? curations[idx].note };
      else curations.push({ catalog, reason, note: note ?? '' });
      const doc = { ...existing, curations, modified_at: now() };
      djinn.put('sec_node', id, doc);
      const log = addLog({ node_id: id, event: 'curate', detail: { catalog, reason } });
      return json({ ok: true, node: doc, log });
    }
  );

  server.tool(
    'sec_node_uncurate',
    '노드의 큐레이션 제안 하나(catalog 기준)를 제거한다.',
    { id: z.string(), catalog: z.enum(CURATION_CATALOGS) },
    async ({ id, catalog }) => {
      const existing = djinn.get('sec_node', id);
      if (!existing) return json({ ok: false, error: `node not found: ${id}` });
      const curations = (existing.curations ?? []).filter((c) => c.catalog !== catalog);
      const doc = { ...existing, curations, modified_at: now() };
      djinn.put('sec_node', id, doc);
      return json({ ok: true, node: doc });
    }
  );

  // ---- 어젠다(핵심) -------------------------------------------------------

  server.tool(
    'sec_agenda',
    "CORE. 창(window) 안의 일정/기념일/루틴을 반복 규칙까지 결정적으로(코드로, LLM 추론 아님) 전개해 시간순으로 반환한다. from/to를 명시하거나, preset('today'|'week'|'next_days')+days로 창을 지정한다(둘 다 생략하면 기본 'week' = 오늘부터 +7일). kind로 특정 종류만 필터링 가능.",
    {
      from: z.string().optional().describe('창 시작(ISO). to와 함께 주면 preset 무시'),
      to: z.string().optional().describe('창 끝(ISO)'),
      preset: z.enum(['today', 'week', 'next_days']).optional(),
      days: z.number().int().positive().optional().describe("preset:'next_days'일 때 일수(기본 7)"),
      kind: z.enum(TEMPORAL_KINDS).optional(),
    },
    async ({ from, to, preset, days, kind }) => {
      const window = resolveWindow({ from, to, preset, days });
      const items = buildAgenda({ from: window.from, to: window.to, kind });
      return json({ window, items });
    }
  );

  server.tool(
    'sec_status',
    '전체 상태를 요약한다: kind별/status별 노드 개수, 다가오는 다음 어젠다 항목 1개(향후 365일 창), overdue(active 상태 단발 event/todo이면서 start가 현재시각보다 과거인 것) 개수.',
    {},
    async () => {
      const all = djinn.find('sec_node', {});
      const byKind = {};
      const byStatus = {};
      for (const n of all) {
        byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
        if (n.status) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
      }
      const ts = now();
      const upcoming = buildAgenda({ from: ts, to: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() });
      // overdue: 단발 event/todo가 아직 active인데 시작(기한)이 지난 것 — 순간(instant) 기준 비교.
      const nowMs = Date.now();
      const tzDefault = defaultTimezone();
      const overdue = all.filter((n) => {
        if ((n.kind !== 'event' && n.kind !== 'todo') || n.status !== 'active' || !n.start || n.recurrence) return false;
        const p = parseWall(n.start, resolveTimezone(n.timezone, tzDefault));
        if (!p) return false;
        return n.all_day || p.dateOnly ? Math.floor(p.wall / DAY) < Math.floor(instantToWall(nowMs, tzDefault) / DAY) : wallToInstant(p.wall, resolveTimezone(n.timezone, tzDefault)) < nowMs;
      });
      return json({
        by_kind: byKind,
        by_status: byStatus,
        next: upcoming[0] ?? null,
        overdue_count: overdue.length,
      });
    }
  );

  server.tool(
    'sec_clear_cache',
    'djinn LRU 쿼리 캐시를 전부 비운다. secretary.db를 다른 프로세스/커넥션이 직접 고쳤을 가능성이 있을 때 호출 — 안 비우면 이 프로세스가 낡은 값을 들고 있다가 이후 노드 upsert 시 merge 베이스로 써서 외부 변경을 조용히 되돌릴 수 있다.',
    {},
    async () => {
      djinn.clearCache();
      return json(djinn.cacheStats());
    }
  );

  server.tool(
    'sec_complete',
    "일정/루틴/할 일의 한 발생(occurrence)을 완료(done:true, 기본) 또는 완료 취소(done:false)한다. occurrence는 sec_agenda 항목의 occurrence_key(\"YYYY-MM-DDTHH:mm\", all_day는 \"YYYY-MM-DD\")이며, 단발 노드는 생략하면 start 발생이다. 반복 노드는 status를 바꾸지 않고 발생별 complete/uncomplete 로그만 남긴다(노드 자체는 계속 active). 단발 노드는 status를 done/active로도 갱신한다. 이미 그 상태면 changed:false로 아무것도 쓰지 않는다(멱등).",
    {
      id: z.string().describe('노드 id'),
      occurrence: z.string().regex(OCCURRENCE_RE).optional(),
      done: z.boolean().optional().describe('기본 true. false면 완료 취소(undo)'),
    },
    async ({ id, occurrence, done }) => {
      const want = done !== false;
      const node = djinn.get('sec_node', id);
      if (!node) return json({ ok: false, error: `node not found: ${id}` });
      if (!TEMPORAL_KINDS.includes(node.kind) || !node.start) {
        return json({ ok: false, error: `kind:'${node.kind}' 노드는 완료 처리 대상이 아닙니다.` });
      }
      const tz = resolveTimezone(node.timezone, defaultTimezone());
      let key = occurrence;
      if (!key) {
        if (node.recurrence) return json({ ok: false, error: '반복 노드는 occurrence가 필요합니다.' });
        key = occurrenceKey(node.all_day ? wallDate(parseWall(node.start, tz).wall) : formatWallISO(parseWall(node.start, tz).wall, tz));
      }
      // 키가 실제 발생인지 그 날짜 하루를 전개해서 확인한다(존재하지 않는 발생에 기록을 남기지 않는다).
      const day = key.slice(0, 10);
      const found = expandOccurrences(node, `${day}T00:00:00`, `${day}T23:59:59`, { timezone: tz })
        .some((o) => occurrenceKey(o) === key);
      if (!found) return json({ ok: false, error: `occurrence not found: ${id} @ ${key}` });

      const current = isDone(node, key, completionMap());
      if (current === want) return json({ ok: true, node_id: id, occurrence: key, done: want, changed: false });
      let updated = node;
      if (!node.recurrence) {
        updated = { ...node, status: want ? 'done' : 'active', modified_at: now() };
        djinn.put('sec_node', id, updated);
      }
      const log = addLog({ node_id: id, event: want ? 'complete' : 'uncomplete', occurrence: key, detail: { kind: node.kind } });
      return json({ ok: true, node_id: id, occurrence: key, done: want, changed: true, status: updated.status, log });
    }
  );

  // ---- 로그 -------------------------------------------------------

  server.tool(
    'sec_log_add',
    '이벤트를 로그에 append한다(예: remind 알림 발송 기록, 수동 complete 기록).',
    {
      node_id: z.string().optional(),
      event: z.enum(LOG_EVENTS),
      detail: z.record(z.any()).optional(),
      occurrence: z.string().regex(OCCURRENCE_RE).optional().describe('complete/uncomplete 대상 발생 키("YYYY-MM-DDTHH:mm" 또는 all_day의 "YYYY-MM-DD"). 완료 처리는 sec_complete 권장'),
    },
    async ({ node_id, event, detail, occurrence }) => json({ ok: true, log: addLog({ node_id, event, detail, occurrence }) })
  );

  server.tool(
    'sec_log_list',
    '로그를 조회한다. node_id/event로 필터링, limit으로 최신 N개만(기본 50).',
    {
      node_id: z.string().optional(),
      event: z.enum(LOG_EVENTS).optional(),
      limit: z.number().optional().default(50),
    },
    async ({ node_id, event, limit }) => {
      const filter = {};
      if (node_id) filter.node_id = node_id;
      if (event) filter.event = event;
      const rows = djinn.find('sec_log', filter, { orderBy: 'created_at', orderDir: 'desc', limit: limit ?? 50 });
      return json(rows);
    }
  );

  // ---- 내보내기 -------------------------------------------------------

  server.tool(
    'sec_export_md',
    '어젠다(또는 기념일) 스냅샷을 markdown으로 렌더링한다. sec_agenda와 동일한 창 지정 방식.',
    {
      from: z.string().optional(),
      to: z.string().optional(),
      preset: z.enum(['today', 'week', 'next_days']).optional(),
      days: z.number().int().positive().optional(),
      kind: z.enum(TEMPORAL_KINDS).optional(),
    },
    async ({ from, to, preset, days, kind }) => {
      const window = resolveWindow({ from, to, preset, days });
      const items = buildAgenda({ from: window.from, to: window.to, kind });
      const lines = [`# doil-secretary agenda (${window.from} ~ ${window.to})`, ''];
      if (items.length === 0) {
        lines.push('_(no items)_');
      } else {
        const byDate = {};
        for (const it of items) {
          const dateKey = it.occurrence.slice(0, 10);
          (byDate[dateKey] ??= []).push(it);
        }
        for (const dateKey of Object.keys(byDate).sort()) {
          lines.push(`## ${dateKey}`, '');
          for (const it of byDate[dateKey]) {
            const curationNote = it.curations.length
              ? ` (curations: ${it.curations.map((c) => c.catalog).join(', ')})`
              : '';
            lines.push(`- [${it.kind}] **${it.title}** — ${it.occurrence} (${it.status ?? 'n/a'})${curationNote}`);
          }
          lines.push('');
        }
      }
      const markdown = lines.join('\n');
      return json({ window, markdown });
    }
  );

  // ---- 메모 -------------------------------------------------------

  // sec_memo 문서 모양(콘솔 빠른 메모와 공유): { id, text(레거시, body_md의 거울), body_md, color, remind_at, status,
  // created_at, modified_at, updated_at }. updated_at은 서버가 모든 쓰기에서 갱신하는 낙관적 동시성 버전(ISO, 단조 증가)이다.
  // 읽을 때 마이그레이션: body_md 없으면 text, color 없으면 yellow, updated_at 없으면 modified_at/created_at.
  const MEMO_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
  const MEMO_MAX = 20000;
  const memoRead = (doc) => {
    if (!doc) return doc;
    const body_md = typeof doc.body_md === 'string' ? doc.body_md : typeof doc.text === 'string' ? doc.text : '';
    return {
      ...doc,
      text: typeof doc.text === 'string' ? doc.text : body_md,
      body_md,
      color: MEMO_COLORS.includes(doc.color) ? doc.color : 'yellow',
      updated_at: doc.updated_at ?? doc.modified_at ?? doc.created_at ?? null,
    };
  };
  // Strictly newer than the previous version even inside the same millisecond, so a stale writer can never match.
  const nextVersion = (prev) => {
    let at = Date.now();
    const before = prev ? Date.parse(prev) : NaN;
    if (Number.isFinite(before) && at <= before) at = before + 1;
    return new Date(at).toISOString();
  };

  server.tool(
    'sec_memo_add',
    '빠른 메모를 캡처한다(status:active). 본문은 body_md(마크다운) 또는 레거시 text 중 하나 이상 필요하다(둘 다 있으면 body_md가 우선, text는 body_md의 거울로 유지). color(yellow 기본|green|blue|pink|purple|gray). id를 명시하고 기존 메모가 있으면 upsert(갱신) — 없으면 makeMemoId()로 새 id를 발급한다. remind_at(ISO, 선택)을 주면 그 시각 이후에만 표면화되고, 생략/null이면 상시(standing) 메모다. 모든 쓰기는 updated_at(버전)을 갱신한다.',
    {
      id: z.string().optional().describe('생략하면 새로 발급'),
      text: z.string().max(MEMO_MAX).optional().describe('레거시 본문(body_md와 같게 유지됨)'),
      body_md: z.string().max(MEMO_MAX).optional().describe('마크다운 본문'),
      color: z.enum(MEMO_COLORS).optional(),
      remind_at: z.string().nullable().optional().describe('ISO 시각, 없으면 상시 메모'),
    },
    async ({ id, text, body_md, color, remind_at }) => {
      const existing = id ? memoRead(djinn.get('sec_memo', id)) : null;
      const body = body_md ?? text;
      if (body === undefined) return json({ ok: false, error: 'body_md or text is required' });
      const memoId = id ?? makeMemoId();
      const ts = now();
      const doc = {
        id: memoId,
        text: body,
        body_md: body,
        color: color ?? existing?.color ?? 'yellow',
        remind_at: remind_at === undefined ? existing?.remind_at ?? null : remind_at,
        status: existing?.status ?? 'active',
        created_at: existing?.created_at ?? ts,
        modified_at: ts,
        updated_at: nextVersion(existing?.updated_at),
      };
      djinn.put('sec_memo', memoId, doc);
      return json({ ok: true, memo: doc });
    }
  );

  server.tool(
    'sec_memo_update',
    '메모를 낙관적 동시성으로 수정한다. expected_updated_at(마지막으로 본 updated_at)이 현재 값과 같을 때만 body_md/color를 바꾸고 {ok:true, memo}를 돌려준다. 다르면 아무것도 쓰지 않고 {ok:false, conflict:true, memo:<현재 메모>}를 돌려준다. 다른 곳에서 폐기된 메모도 conflict로 돌려준다(memo.status로 구분, 조용히 되살리지 않는다).',
    {
      id: z.string(),
      body_md: z.string().max(MEMO_MAX).optional(),
      color: z.enum(MEMO_COLORS).optional(),
      expected_updated_at: z.string().describe('클라이언트가 마지막으로 본 updated_at'),
    },
    async ({ id, body_md, color, expected_updated_at }) => {
      const raw = djinn.get('sec_memo', id);
      if (!raw) return json({ ok: false, error: `memo not found: ${id}` });
      const existing = memoRead(raw);
      // A memo discarded elsewhere is a conflict too (memo.status says so): the writer never revives it silently.
      if (existing.updated_at !== expected_updated_at || existing.status !== 'active') return json({ ok: false, conflict: true, memo: existing });
      const body = body_md ?? existing.body_md;
      const doc = {
        ...existing,
        text: body,
        body_md: body,
        color: color ?? existing.color,
        modified_at: now(),
        updated_at: nextVersion(existing.updated_at),
      };
      djinn.put('sec_memo', id, doc);
      return json({ ok: true, memo: doc });
    }
  );

  server.tool(
    'sec_memo_list',
    '메모 목록을 조회한다. status 기본값 active. due_only:true면 remind_at==null(상시) 이거나 remind_at<=now인 것만 남긴다(now 생략 시 서버 현재시각). order 기본 due: remind_at 오름차순(상시는 맨 앞) → created_at 오름차순. order:recent면 updated_at 내림차순(가장 최근 수정 먼저).',
    {
      status: z.enum(['active', 'discarded']).optional().describe('기본 active'),
      due_only: z.boolean().optional().describe('true면 remind_at==null 이거나 remind_at<=now인 것만'),
      now: z.string().optional().describe('due 판정 기준 시각(ISO), 생략 시 서버 현재시각'),
      order: z.enum(['due', 'recent']).optional().describe('기본 due'),
    },
    async ({ status, due_only, now: nowArg, order }) => {
      const filter = { status: status ?? 'active' };
      let rows = djinn.find('sec_memo', filter).map(memoRead);
      if (due_only) {
        const cutoff = nowArg ?? now();
        rows = rows.filter((m) => m.remind_at == null || m.remind_at <= cutoff);
      }
      if (order === 'recent') rows.sort((a, b) => (a.updated_at === b.updated_at ? 0 : a.updated_at < b.updated_at ? 1 : -1));
      else
        rows.sort((a, b) => {
          const ra = a.remind_at ?? '';
          const rb = b.remind_at ?? '';
          if (ra !== rb) return ra < rb ? -1 : 1;
          return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
        });
      return json(rows);
    }
  );

  server.tool(
    'sec_memo_get',
    '메모 하나를 조회한다(레거시 text 메모는 body_md/color/updated_at이 채워져 나온다).',
    { id: z.string() },
    async ({ id }) => {
      const memo = djinn.get('sec_memo', id);
      if (!memo) return json({ ok: false, error: `memo not found: ${id}` });
      return json(memoRead(memo));
    }
  );

  server.tool(
    'sec_memo_discard',
    '메모를 소프트 폐기한다(status:discarded로 갱신, modified_at/updated_at 갱신). hard delete는 하지 않는다. 사용자 확인 뒤에만 호출한다.',
    { id: z.string() },
    async ({ id }) => {
      const existing = memoRead(djinn.get('sec_memo', id));
      if (!existing) return json({ ok: false, error: `memo not found: ${id}` });
      const doc = { ...existing, status: 'discarded', modified_at: now(), updated_at: nextVersion(existing.updated_at) };
      djinn.put('sec_memo', id, doc);
      return json({ ok: true, memo: doc });
    }
  );

  return server;
}

async function serve() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { createServer, serve };
