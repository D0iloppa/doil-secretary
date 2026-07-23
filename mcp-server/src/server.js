'use strict';

const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { djinn, CATALOG_ID, PROFILE_ID, makeLogId } = require('./db');
const { ONBOARD_LOCK_PATH, DOILSECRETARY_HOME } = require('./paths');
const { expandOccurrences } = require('./recurrence');

const TEMPORAL_KINDS = ['event', 'anniversary', 'routine'];
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

function addLog({ node_id, event, detail }) {
  const id = makeLogId(event);
  const doc = {
    id,
    node_id: node_id ?? null,
    event,
    detail: detail ?? null,
    created_at: now(),
  };
  djinn.put('sec_log', id, doc);
  return doc;
}

// 'today'/'week'/'next_days:N' 프리셋 또는 명시적 from/to를 [fromISO, toISO] 창으로
// 해석한다. 아무것도 안 주면 기본 'week'(오늘부터 +7일).
function resolveWindow({ from, to, preset, days }) {
  if (from && to) return { from, to };
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const p = preset || 'week';
  if (p === 'today') {
    const end = new Date(start.getTime());
    end.setUTCHours(23, 59, 59, 999);
    return { from: from ?? start.toISOString(), to: to ?? end.toISOString() };
  }
  if (p === 'next_days') {
    const n = Number.isInteger(days) && days > 0 ? days : 7;
    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + n);
    end.setUTCHours(23, 59, 59, 999);
    return { from: from ?? start.toISOString(), to: to ?? end.toISOString() };
  }
  // 'week' 기본값
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 7);
  end.setUTCHours(23, 59, 59, 999);
  return { from: from ?? start.toISOString(), to: to ?? end.toISOString() };
}

function buildAgenda({ from, to, kind }) {
  const filter = {};
  if (kind) filter.kind = kind;
  const candidates = djinn
    .find('sec_node', filter)
    .filter((n) => TEMPORAL_KINDS.includes(n.kind));

  const items = [];
  for (const node of candidates) {
    const occurrences = expandOccurrences(node, from, to);
    for (const occurrence of occurrences) {
      items.push({
        node_id: node.id,
        kind: node.kind,
        title: node.title,
        occurrence,
        status: node.status ?? null,
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
    })
    .nullable();

  server.tool(
    'sec_node_put',
    '그래프 노드(일정/기념일/루틴/인물/프로젝트)를 upsert한다. kind가 event/anniversary/routine(시간형)이면 start가 필수이고 recurrence/status 등 시간형 필드가 함께 저장된다 — 비시간형(person/project)은 이 필드들을 무시한다. relates_to/belongs_to/curations는 명시하지 않으면 기존 값을 보존한다(부분 갱신). 성공 후 create 또는 update 로그를 남긴다.',
    {
      id: z.string().describe('전역 유일 slug, 예: "event::2026-08-01-dentist", "person::mom"'),
      kind: z.enum(['event', 'anniversary', 'routine', 'person', 'project']),
      title: z.string(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      relates_to: z.array(relatesToSchema).optional().describe('비계층 참조 목록(전체 교체). 점진적 추가/삭제는 sec_node_link/sec_node_unlink 권장'),
      belongs_to: z.string().nullable().optional().describe('상위 프로젝트 노드 id(계층 edge), 없으면 null'),
      curations: z.array(curationSchema).optional().describe('연계 스킬 큐레이션 제안 목록(전체 교체). 점진적 추가/삭제는 sec_node_curate/sec_node_uncurate 권장'),
      start: z.string().optional().describe('시간형 kind 필수 — ISO date 또는 datetime'),
      end: z.string().optional(),
      all_day: z.boolean().optional(),
      timezone: z.string().optional(),
      recurrence: recurrenceSchema.optional().describe('null=단발성. 생략 시 기존 값 보존'),
      status: z.enum(['active', 'done', 'cancelled']).optional().describe('시간형 kind만 사용, 기본 active'),
      contact: z.string().optional().describe('person kind 전용'),
      relation: z.string().optional().describe('person kind 전용'),
    },
    async (args) => {
      const {
        id, kind, title, description, tags, relates_to, belongs_to, curations,
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
        description: description ?? existing?.description ?? '',
        tags: tags ?? existing?.tags ?? [],
        relates_to: relates_to ?? existing?.relates_to ?? [],
        belongs_to: belongs_to === undefined ? existing?.belongs_to ?? null : belongs_to,
        curations: curations ?? existing?.curations ?? [],
        created_at: existing?.created_at ?? ts,
        modified_at: ts,
      };
      if (isTemporal) {
        doc.start = start ?? existing?.start;
        doc.end = end ?? existing?.end ?? null;
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
      kind: z.enum(['event', 'anniversary', 'routine', 'person', 'project']).optional(),
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
      kind: z.enum(['event', 'anniversary', 'routine']).optional(),
    },
    async ({ from, to, preset, days, kind }) => {
      const window = resolveWindow({ from, to, preset, days });
      const items = buildAgenda({ from: window.from, to: window.to, kind });
      return json({ window, items });
    }
  );

  server.tool(
    'sec_status',
    '전체 상태를 요약한다: kind별/status별 노드 개수, 다가오는 다음 어젠다 항목 1개(향후 365일 창), overdue(active 상태 event이면서 start가 현재시각보다 과거인 것) 개수.',
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
      const overdue = all.filter((n) => n.kind === 'event' && n.status === 'active' && n.start && n.start < ts);
      return json({
        by_kind: byKind,
        by_status: byStatus,
        next: upcoming[0] ?? null,
        overdue_count: overdue.length,
      });
    }
  );

  // ---- 로그 -------------------------------------------------------

  server.tool(
    'sec_log_add',
    '이벤트를 로그에 append한다(예: remind 알림 발송 기록, 수동 complete 기록).',
    {
      node_id: z.string().optional(),
      event: z.enum(['create', 'update', 'complete', 'remind', 'curate']),
      detail: z.record(z.any()).optional(),
    },
    async ({ node_id, event, detail }) => json({ ok: true, log: addLog({ node_id, event, detail }) })
  );

  server.tool(
    'sec_log_list',
    '로그를 조회한다. node_id/event로 필터링, limit으로 최신 N개만(기본 50).',
    {
      node_id: z.string().optional(),
      event: z.enum(['create', 'update', 'complete', 'remind', 'curate']).optional(),
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
      kind: z.enum(['event', 'anniversary', 'routine']).optional(),
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

  return server;
}

async function serve() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { createServer, serve };
