'use strict';

const { DJinn } = require('@d0iloppa/djinn');
const { DB_PATH, ensureDataHome } = require('./paths');

// 데이터 홈(기본 ~/.doil-secretary, DOILSECRETARY_HOME으로 오버라이드)이 없으면 자동
// 생성한다 — 일정 데이터는 스킬 설치경로(git repo)가 아니라 사용자 홈에 귀속된다.
ensureDataHome();

const djinn = new DJinn(DB_PATH);

// sec_catalog: 루트 카탈로그(1-row, id='root'). 기본 타임존 + 캘린더 연동 설정(향후용).
djinn.define('sec_catalog', { indexes: ['modified_at'] });
const CATALOG_ID = 'root';

// sec_profile: 사용자 프로파일(1-row, id='root'). 이름/타임존/근무시간.
djinn.define('sec_profile', { indexes: ['modified_at'] });
const PROFILE_ID = 'root';

// sec_node: 그래프 노드(테이블 하나에 kind로 구분되는 다형 노드). id는 호출자가 부여하는
// 전역 유일 slug(예: "event::2026-08-01-dentist", "person::mom"). 엣지는 별도 테이블이
// 아니라 doc 안의 JSON 필드로 표현한다 — relates_to(비계층 참조), belongs_to(계층 edge,
// project 노드를 향한 상위 링크), curations(연계 스킬의 큐레이션 제안 목록). 시간형
// kind(event/anniversary/routine)는 start/end/all_day/timezone/recurrence/status를
// 추가로 갖는다. recurrence:null이면 단발성, 아니면
// {freq:'daily'|'weekly'|'monthly'|'yearly', interval, byday?, until?} 형태다.
djinn.define('sec_node', {
  indexes: ['kind', 'start', 'status', 'belongs_to', 'modified_at'],
});

// sec_log: 이벤트 로그(append 전용). create/update/complete/remind/curate 이벤트를 남긴다.
djinn.define('sec_log', {
  indexes: ['node_id', 'event', 'created_at'],
});

function makeLogId(suffix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return suffix != null ? `${Date.now()}-${suffix}-${rand}` : `${Date.now()}-${rand}`;
}

module.exports = {
  djinn,
  DB_PATH,
  CATALOG_ID,
  PROFILE_ID,
  makeLogId,
};
