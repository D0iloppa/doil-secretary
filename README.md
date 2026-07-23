# doil-secretary

일정/기념일/루틴을 관리하는 풀(pull)-기반 AI 비서 Claude Code 스킬. 캘린더가 주 소스이며,
자동 cron/push 알림은 없다 — 스킬이 호출됐을 때만(수동 agenda 확인처럼) 표면화한다.
다른 스킬(ai-echo/sun-sang/doil-research/doil-supervise)로의 연계는 **큐레이션(제안)만**
하고 직접 호출하지 않는다. 자세한 절차는 [`SKILL.md`](./SKILL.md) 참고.

## 설치

```bash
./install.sh                 # 스킬 심볼릭 링크 + mcp-server npm install + 데이터 홈 초기화까지 한 번에
./install.sh --all-profiles  # ~ 아래 모든 Claude 프로필에 설치
```

MCP는 선택이지만 권장이다(없으면 SKILL.md의 세션 내 임시 진행 폴백). 수동으로 하려면:

```bash
cd mcp-server
npm install
npm run init   # 데이터 홈(기본 ~/.doil-secretary)에 init/init.sql로 스키마+빈 카탈로그를 시드(멱등)
```

Claude Code MCP 설정(`~/.claude/settings.json` 등)에 stdio 서버로 등록:

```json
{
  "mcpServers": {
    "doil-secretary": {
      "command": "node",
      "args": ["/absolute/path/to/doil-secretary/mcp-server/src/index.js"]
    }
  }
}
```

또는 `claude mcp add doil-secretary -- node /absolute/path/to/doil-secretary/mcp-server/src/index.js`.

## 데이터는 이 repo 밖에 산다

**git(이 skills repo)은 스킬 코드 공유용일 뿐이다.** 일정 데이터는 사용자에 귀속되며
워크스페이스·repo와 무관하게 관리된다 — 스킬 repo를 재클론하거나 코드를 업데이트해도
데이터는 그대로 보존된다. 그래서 데이터는 스킬 설치경로(`doil-secretary/`)가 아니라
**데이터 홈**에 저장된다.

- **데이터 홈**: 기본값 `~/.doil-secretary`. `DOILSECRETARY_HOME` 환경변수로 오버라이드
  가능. 서버 최초 기동 시 하위 디렉토리가 없으면 자동 생성된다.
  - `~/.doil-secretary/data/secretary.db` — 그래프 카탈로그(노드/로그)의 실물 저장소.
  - `~/.doil-secretary/secrets/` — 향후 캘린더 연동 자격증명 보관용(현재는 예약만, mode 0700).
  - `~/.doil-secretary/onboard.lock` — 온보딩 완료 마커. 존재하면 온보딩 완료로 간주한다.
- **repo(`doil-secretary/`) 안에는 코드만 남는다.** `mcp-server/data/`, `mcp-server/secrets/`,
  `onboard.lock` 등은 정상 동작 시 이 repo 안에 생기지 않는다. `.gitignore`에 해당
  패턴이 남아있는 건(예: `mcp-server/data/`, `*.db*`) 오설정·구버전 실행 등으로 혹시
  데이터가 repo 안에 생기는 사고를 막는 안전망이다.

## 스키마

```
sec_catalog  // root, 1-row(id='root'). { default_timezone, calendars:{}, created_at, modified_at }
sec_profile  // root, 1-row(id='root'). { name, timezone, working_hours?, onboarded_at, created_at, modified_at }
sec_node     // 그래프 노드. id는 호출자가 부여하는 전역 유일 slug(예: "event::2026-08-01-dentist").
             // 공통: { id, kind:'event'|'anniversary'|'routine'|'person'|'project', title,
             //   description?, tags:[...], relates_to:[{node_id, rel?, note?}](비계층 참조),
             //   belongs_to?(project 노드를 향한 계층 edge, nullable),
             //   curations:[{catalog, reason, note?}](연계 스킬 큐레이션 제안), created_at, modified_at }
             // 시간형(event/anniversary/routine) 추가: { start, end?, all_day?, timezone?,
             //   recurrence:null|{freq, interval, byday?, until?}, status:'active'|'done'|'cancelled' }
             // person 추가: { contact?, relation? }. project는 그룹핑 노드(추가 필드 없음).
sec_log      // 이벤트 로그(append). { id, node_id?, event:'create'|'update'|'complete'|'remind'|'curate', detail?, created_at }
```

엣지는 별도 테이블이 아니라 `sec_node.doc` 안의 JSON 필드(`relates_to`/`belongs_to`)로만
표현한다(sun-sang의 concept refs/parent와 동일한 패턴). 반복 규칙(`recurrence`) 전개는
LLM 추론이 아니라 `src/recurrence.js`의 결정적 코드(`expandOccurrences`)가 담당한다.
인덱스: `sec_node`(kind/start/status/belongs_to/modified_at), `sec_log`(node_id/event/created_at),
그 외는 각각 modified_at 기준.

## 툴

| 툴 | 용도 |
|---|---|
| `sec_onboard_status` | onboard.lock 존재 여부 + 저장된 프로파일 + 데이터 홈/DB 경로 조회 |
| `sec_onboard_complete` | 사용자 프로파일 저장 + onboard.lock 생성 |
| `sec_node_put` | 노드 upsert(kind별 필드 검증) — 성공 후 create/update 로그 |
| `sec_node_get` | 노드 하나 조회 |
| `sec_node_list` | 노드 목록(kind/status/belongs_to/tag/날짜범위 필터) |
| `sec_node_del` | 노드 삭제(cascade 없음) |
| `sec_node_link` | 노드 간 비계층 참조(relates_to) 하나 추가/갱신 |
| `sec_node_unlink` | 노드 간 비계층 참조(relates_to) 하나 제거 |
| `sec_node_curate` | 노드에 연계 스킬 큐레이션 제안 하나 추가/갱신 |
| `sec_node_uncurate` | 노드의 큐레이션 제안 하나 제거 |
| `sec_agenda` | CORE — 창(window) 안의 일정/기념일/루틴을 반복 규칙까지 전개해 시간순 반환 |
| `sec_status` | kind/status별 집계 + 다음 어젠다 항목 + overdue 개수 |
| `sec_log_add` | 이벤트를 로그에 append |
| `sec_log_list` | 로그 조회(node_id/event/limit 필터) |
| `sec_export_md` | 어젠다 스냅샷을 markdown으로 렌더링 |

자세한 사용 규칙(온보딩, 커맨드 흐름, 큐레이션 계약, 데이터 홈 원칙)은
[`SKILL.md`](./SKILL.md) 참고.
