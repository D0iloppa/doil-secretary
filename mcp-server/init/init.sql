-- doil-secretary mcp-server 초기화 SQL.
--
-- 이 파일은 두 가지를 한다:
--   1. 테이블/인덱스 DDL — djinn.define()이 서버 시작 시마다 하는 것과 동일(멱등).
--      다만 djinn이 collection을 내부 상태에 등록해야 get/find/put이 동작하므로,
--      이 SQL만 실행해서는 부족하다 — mcp-server/src/db.js가 실제 진입점이다.
--      이 파일은 문서/외부 도구(sqlite3 CLI 등)용 참조 스키마이자, npm run init이
--      실제로 실행하는 초기화 스크립트다.
--   2. 스킬의 "기본 골격" 시드 — sec_catalog(root, 빈 calendars)만 심는다. 노드/로그는
--      전부 사용자별 실사용으로 채워지는 개인 데이터라 git에 공유하지 않는다(비어있는
--      골격만 시드).

CREATE TABLE IF NOT EXISTS sec_catalog (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_catalog__modified_at ON sec_catalog(json_extract(doc, '$.modified_at'));

CREATE TABLE IF NOT EXISTS sec_profile (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_profile__modified_at ON sec_profile(json_extract(doc, '$.modified_at'));

-- sec_node.doc 필드(공통): { id, kind:'event'|'anniversary'|'routine'|'person'|'project',
--   title, description?, tags:[...], relates_to:[{node_id, rel?, note?}](비계층 참조),
--   belongs_to?(project 노드를 향한 계층 edge, nullable), curations:[{catalog, reason,
--   note?}](연계 스킬 큐레이션 제안), created_at, modified_at }
-- 시간형 kind(event/anniversary/routine) 추가 필드: { start(ISO date|datetime), end?,
--   all_day?, timezone?, recurrence:null|{freq, interval, byday?, until?},
--   status:'active'|'done'|'cancelled' }
-- person 추가 필드: { contact?, relation? }. project는 그룹핑 노드(belongs_to 대상)로,
-- 추가 필드 없이 공통 필드만 쓴다.
CREATE TABLE IF NOT EXISTS sec_node (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_node__kind        ON sec_node(json_extract(doc, '$.kind'));
CREATE INDEX IF NOT EXISTS idx_sec_node__start       ON sec_node(json_extract(doc, '$.start'));
CREATE INDEX IF NOT EXISTS idx_sec_node__status      ON sec_node(json_extract(doc, '$.status'));
CREATE INDEX IF NOT EXISTS idx_sec_node__belongs_to  ON sec_node(json_extract(doc, '$.belongs_to'));
CREATE INDEX IF NOT EXISTS idx_sec_node__modified_at ON sec_node(json_extract(doc, '$.modified_at'));

CREATE TABLE IF NOT EXISTS sec_log (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_log__node_id    ON sec_log(json_extract(doc, '$.node_id'));
CREATE INDEX IF NOT EXISTS idx_sec_log__event      ON sec_log(json_extract(doc, '$.event'));
CREATE INDEX IF NOT EXISTS idx_sec_log__created_at ON sec_log(json_extract(doc, '$.created_at'));

-- sec_memo.doc: { id, text, remind_at?(ISO, nullable=상시), status:'active'|'discarded',
-- created_at, modified_at }. 폐기는 항상 소프트(status:'discarded')이며 hard delete는
-- 없다.
CREATE TABLE IF NOT EXISTS sec_memo (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_memo__status      ON sec_memo(json_extract(doc, '$.status'));
CREATE INDEX IF NOT EXISTS idx_sec_memo__remind_at   ON sec_memo(json_extract(doc, '$.remind_at'));
CREATE INDEX IF NOT EXISTS idx_sec_memo__modified_at ON sec_memo(json_extract(doc, '$.modified_at'));

-- root 카탈로그 시드 (빈 calendars — 향후 캘린더 연동 설정은 sec_catalog 갱신으로 채운다)
INSERT OR IGNORE INTO sec_catalog (id, doc) VALUES ('root', '{"default_timezone":null,"calendars":{},"created_at":"1970-01-01T00:00:00.000Z","modified_at":"1970-01-01T00:00:00.000Z"}');
