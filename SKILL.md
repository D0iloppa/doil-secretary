---
name: doil-secretary
description: >-
  일정을 챙기는 AI 비서 스킬. 주 소스는 캘린더다 — 일정(event)·기념일(anniversary)·
  루틴(routine)을 중심으로, 필요하면 인물(person)·프로젝트(project) 노드도 함께 관리해
  이들을 서로 연결한다. dJinn MCP(`mcp__doil-secretary__*`)에 그래프 카탈로그로
  영속화한다: 별도 엣지 테이블 없이 노드(`sec_node`)의 JSON 필드(`relates_to`/
  `belongs_to`)만으로 비계층 참조와 계층(프로젝트 소속)을 표현하고, `secretary.db`에
  저장한다. 데이터 홈은 `~/.doil-secretary`(`DOILSECRETARY_HOME`으로 오버라이드)이며
  스킬 설치경로(git repo)와 무관하게 보존된다. **자동 cron/push 알림은 전혀 없다** —
  풀(pull) 기반이다: 이 스킬이 세션에서 명시적으로 호출됐을 때만(수동으로 agenda를
  확인하듯) 다가오는 일정이 표면화된다. 반복 규칙(매일/매주/매월/매년) 전개는 LLM
  추론이 아니라 결정적 코드로 계산한다(compute-over-inference). **옵션 카탈로그
  큐레이션** 역할도 겸한다 — 답장이 필요한 노드는 ai-echo에, 학습이 필요한 개념은
  sun-sang에, 조사가 필요한 태스크는 doil-research에, 복합 오케스트레이션이 필요한
  하루/노드는 doil-supervise에 **제안만** 한다(직접 호출/지시하지 않음, 실행은 항상
  사용자). 캘린더 노드와 별개로 **빠른 메모(memo)** 캡처/조회/폐기도 지원한다 — 급히
  적어두는 용도로, 비서 호출 시 활성 due 메모를 재표면화하고(풀 기반, 자동 알림 아님)
  사용자 확인 후에만 소프트 폐기한다. "일정 관리해줘 / 오늘 일정 뭐 있어 / 이번주 일정
  알려줘 / 일정 추가해줘 / 기념일 등록 / 매주 반복되는 루틴 추가 / 이거 큐레이션해줘 /
  상태 확인 / 어젠다 내보내기 / 메모해줘 / 메모 보여줘 / 이거 폐기해줘" 류에서
  트리거된다. onboard / agenda / add / list / anniversaries / routine / curate / status
  / export / memo / memos / discard 커맨드를 제공한다.
---

# doil-secretary

일정·기념일·루틴을 중심으로 관리하는 풀(pull) 기반 AI 비서 스킬이다. **먼저 나서서
알리지 않는다** — 세션에서 호출됐을 때만 다가오는 일정을 표면화한다. 다른 스킬로의
연계는 언제나 제안일 뿐이다.

> **카파시 4원칙**(Karpathy's agentic-coding guidelines) — 아래 절차 전체에 우선한다:
> 1. **Think Before Coding** — 가정하지 말고, 불확실하면 먼저 묻는다. 해석이 둘 이상이면 모두 제시.
> 2. **Simplicity First** — 요청을 푸는 최소한의 코드. 과설계·요청 안 한 유연성 금지.
> 3. **Surgical Changes** — 시킨 것만 건드린다. 무관한 리팩터링·정리 금지.
> 4. **Goal-Driven Execution** — 작업을 검증 가능한 목표로 바꾼다.
>
> 레포에 자체 에이전트 지침(CLAUDE.md 등)이 있으면 그것을 **함께** 따른다.

## 1. 핵심 원칙

- **먼저 '지금'을 확정한다 (current / now anchor).** 비서 업무의 모든 시간 판단 —
  임박한 일정, 지난 일정, 오늘/이번주 구분, overdue — 은 `current`(현재 시각)를
  기준으로 갈린다. 따라서 이 스킬은 **어떤 커맨드든 진입 시 가장 먼저 현재 날짜·시각을
  권위 있게 확정한다**: 기억이나 대화 맥락으로 '오늘'을 가정하지 말고, 시스템 시계(`date`
  명령 등)로 실제 now를 읽는다. 타임존은 프로파일 값([3장](#3-온보딩-onboard))을 쓰되
  미지정이면 시스템 로컬 타임존으로 폴백한다. 이후 임박/지난 판정, `agenda`의 window,
  `status`의 overdue는 전부 이 `current`에 상대적으로 계산한다 — 서버 쪽
  (`sec_agenda`/`recurrence.js`)도 같은 now를 기준으로 동작하므로, AI가 인지한 '지금'과
  서버의 '지금'이 어긋나지 않게 맞춘다. `current`가 불확실하면 추정하지 말고 다시
  확인한다(카파시 #1).
- **캘린더가 SoT(Source of Truth)다.** 일정/기념일/루틴은 `mcp__doil-secretary__sec_node_put`으로
  저장되고, 이후 모든 조회/큐레이션은 이 노드를 기준으로 진행한다 — AI가 세션마다
  일정을 다르게 기억하지 않도록 하는 referential grounding이 목적이다.
- **엣지는 별도 테이블이 아니라 노드 안의 JSON 필드다.** `relates_to`(비계층 참조)와
  `belongs_to`(프로젝트를 향한 계층 edge)만으로 그래프를 표현한다 — 둘을 혼동하지
  않는다. 자세한 구성 원칙은 [6장](#6-노드-구성-원칙).
- **풀(pull) 기반 — 자동 cron/push 알림은 없다.** 이 스킬은 백그라운드에서 스스로
  깨어나 알림을 보내지 않는다. 사용자가 `agenda`/`status` 등을 호출했을 때만(수동으로
  다이어리를 펼쳐보는 것과 같다) 다가오는 일정이 드러난다. "리마인드해줘"도 세션 내
  호출 시점에 조회하는 것이지, 예약 알림을 거는 것이 아니다.
- **반복 규칙 전개는 결정적 코드로 한다(compute-over-inference).** "다음 반복일이
  언제냐"를 AI가 추론하지 않는다 — `mcp-server/src/recurrence.js`의
  `expandOccurrences()`가 daily/weekly(+byday)/monthly/yearly + interval + until +
  count + exdates를 계산한다. `sec_agenda`가 이 함수 위에서 동작한다. 순수 함수라
  doil-console도 이 파일을 그대로 가져다 쓴다(로직 복제 금지).
  - **타임존은 명시적이다**: `node.timezone` → 프로파일 `timezone` → `Asia/Seoul` 순서.
    오프셋 없는 `start`("2026-08-22T21:40:00")는 그 타임존의 벽시계로 해석하고, 출력은
    항상 `2026-10-01T07:30:00+09:00` 같은 오프셋 포함 로컬 ISO(`all_day`는
    `YYYY-MM-DD`)라 모호하지 않다. `sec_agenda`의 `today`/`week`/`next_days` 창도 UTC가
    아니라 이 타임존의 로컬 자정 기준이다.
  - **월말은 clamp한다**: 매달 31일은 짧은 달에 그 달 마지막 날로 떨어진다(1/31 → 2/28
    (윤년 2/29) → 3/31 …, 직전 발생이 아니라 start 기준이라 어긋나지 않는다). 2/29 매년은
    평년에 2/28이다.
  - **발생 키**: 각 발생은 `occurrence_key`(로컬 `YYYY-MM-DDTHH:mm`, 종일은
    `YYYY-MM-DD`)로 식별한다. 완료·제외(exdates) 모두 이 키를 쓴다.
- **큐레이션은 제안일 뿐, 실행이 아니다.** 다른 스킬로의 연계는 항상 "이 노드엔 X 스킬을
  써보는 게 어떨까요" 제안으로 그친다 — 비서가 직접 다른 스킬을 호출/지시하지 않는다.
  자세한 계약은 [14장](#14-optional-catalog-스킬-연계-큐레이션).
- **MCP가 없으면 절차를 막지 않되** [15장 optional requirements](#15-optional-requirements)의
  폴백을 따른다. 세션에 `mcp__doil-secretary__*` 도구가 노출돼 있는지로 설치 여부를
  판단한다.
- **온보딩은 차단 게이트가 아니라 유도다.** 어떤 커맨드든 진입 시 `sec_onboard_status()`로
  가볍게 확인한다. `onboarded`가 `false`면 온보딩을 유도하되, 사용자가 건너뛰면 기본값
  (타임존 미지정 등)으로 그대로 진행한다. 자세한 절차는 [3장](#3-온보딩-onboard).
- **데이터는 이 repo 밖, 사용자 홈에 산다.** git(이 skills repo)은 스킬 **코드** 공유용일
  뿐이다. 일정 데이터(dJinn DB·온보딩 마커·향후 캘린더 연동 secrets)는 스킬
  설치경로가 아니라 데이터 홈(`~/.doil-secretary`, `DOILSECRETARY_HOME` 환경변수로
  오버라이드)에 저장되어 repo 재클론이나 스킬 코드 업데이트와 무관하게 보존된다. 자세한
  내용은 [15장](#15-optional-requirements).

## 2. 커맨드

| 커맨드 | 하는 일 | 상세 |
|---|---|---|
| `onboard` | 사용자 프로파일(이름·타임존·근무시간) 수집 → 온보딩 완료 처리 | [3장](#3-온보딩-onboard) |
| `agenda [오늘\|이번주\|N일]` | 창(window) 안의 일정·기념일·루틴을 반복 전개해 시간순 조회 | [4장](#4-어젠다-agenda) |
| `add <종류> ...` | 일정/기념일/루틴/인물/프로젝트 노드 추가·수정 | [5장](#5-노드-추가수정-add) |
| `list [필터]` | 노드 목록 조회(kind/status/tag/기간) | [7장](#7-목록-조회-list) |
| `anniversaries` | 기념일만 필터링한 어젠다 조회 | [8장](#8-기념일-anniversaries) |
| `routine` | 루틴만 필터링한 어젠다 조회 | [9장](#9-루틴-routine) |
| `link` / `unlink` | 노드 간 비계층 참조 추가/제거 | [6장](#6-노드-구성-원칙) |
| `curate <노드> <스킬>` / `uncurate` | 노드에 연계 스킬 큐레이션 제안 저장/제거 | [14장](#14-optional-catalog-스킬-연계-큐레이션) |
| `status` | kind/status별 집계 + 다음 일정 + overdue 개수 | [10장](#10-상태-status) |
| `complete <노드> [발생]` | 일정/할 일/루틴의 한 발생 완료·완료 취소(`sec_complete`) | [11장](#11-완료-처리-complete) |
| `log [필터]` | 이벤트 로그 조회 | [12장](#12-로그-log) |
| `export` | 어젠다 스냅샷을 markdown으로 내보내기 | [13장](#13-내보내기-export) |
| `memo <내용> [remind <시각>]` | 빠른 메모 저장(선택적 remind 시각) | [16장](#16-메모-memo) |
| `memos` | 활성 메모 조회(due 우선) | [16장](#16-메모-memo) |
| `discard <메모>` | 메모 폐기(확인 후) | [16장](#16-메모-memo) |

## 3. 온보딩 (onboard)

1. `sec_onboard_status()`로 이미 완료됐는지 먼저 확인한다(중복 온보딩 방지). 이 호출은
   데이터 홈 경로(`data_home`/`db_path`)도 함께 반환한다.
2. 대화로 세 가지를 확인한다: ① 이름/호칭 ② 기본 타임존(예: "Asia/Seoul") ③ 근무시간/
   가용시간(선택, 예: "09:00-18:00").
3. `sec_onboard_complete({name, timezone, working_hours?})`를 호출한다 — 내부적으로
   프로파일을 저장하고 데이터 홈에 `onboard.lock` 파일을 생성해 완료를 표시한다(스킬
   설치경로가 아니다 — [15장](#15-optional-requirements) 참고).
4. 이후 `agenda`/`add` 등에서 이 타임존을 기본값 참고로 쓴다(노드별 `timezone`이
   명시되면 그쪽이 우선).

> 차단 게이트가 아니다 — 사용자가 건너뛰면 타임존 미지정 상태로 그대로 진행한다.

## 4. 어젠다 (agenda)

`agenda [오늘|이번주|N일]` — 이 스킬의 핵심 조회 커맨드. **모든 표면화는 이 호출
시점에만 일어난다** — 예약된 알림이 아니다([§1](#1-핵심-원칙) 풀 기반 원칙).

0. **먼저 현재 시각을 확정한다**([§1](#1-핵심-원칙) current 원칙). window의 시작점도,
   "임박(다가옴)"과 "지난(overdue/경과)"의 구분선도 모두 이 `current`다 — 이 기준 없이
   어젠다를 해석하지 않는다.
1. `sec_agenda({preset, days?, kind?})`를 호출한다.
   - `preset:'today'` — 오늘.
   - `preset:'week'`(기본값, 인자 생략 시) — 오늘부터 +7일.
   - `preset:'next_days', days:N` — 오늘부터 N일.
   - 특정 기간을 직접 지정하려면 `from`/`to`(ISO)를 준다(이 경우 preset은 무시된다).
   - `kind`로 event/todo/anniversary/routine 중 하나만 좁혀볼 수 있다(생략하면 전부).
2. 반환된 `items`(각 `{node_id, kind, title, occurrence, occurrence_key, all_day,
   timezone, status, done, curations}`)를 날짜순으로 사용자에게 보여준다. `done`은 그
   발생의 완료 상태다([11장](#11-완료-처리-complete)). `curations`가 비어있지 않은 항목은
   [14장](#14-optional-catalog-스킬-연계-큐레이션) 제안이 저장돼 있다는 뜻이므로 함께
   짚어준다.
3. 반복 일정(recurrence)의 다음 발생일 계산은 서버가 `recurrence.js`의 결정적 코드로
   수행한다 — AI가 "다음 화요일이니까..." 식으로 직접 계산하지 않는다.

## 5. 노드 추가/수정 (add)

`add <종류> ...` — `sec_node_put`으로 노드를 upsert한다. 신규/기존 무관하게 같은
도구를 쓴다(id가 이미 있으면 갱신, 없으면 생성).

1. `kind`를 정한다: `event`(일정, 보통 recurrence 없음) / `todo`(할 일 — `start`가
   기한(due), 단발이면 완료 시 `status:'done'`) / `anniversary`(기념일,
   보통 `recurrence.freq:'yearly'`, `all_day:true`) / `routine`(루틴, cadence에 맞는
   recurrence) / `person`(인물) / `project`(프로젝트, 그룹핑 노드).
2. `id`는 호출자가 짓는 전역 유일 slug다(예: `event::2026-08-01-dentist`,
   `person::mom`, `project::office-move`) — 이후 모든 세션에서 이 id로 같은 노드를
   가리킨다.
3. 시간형(event/todo/anniversary/routine)은 `start`가 필수다. `end`/`all_day`/`timezone`/
   `recurrence`/`status`(기본 `active`)를 함께 지정할 수 있다. `recurrence`는 생략하면
   기존 값을 보존하고, 명시적으로 없애려면 `null`을 준다. `recurrence`는
   `{freq, interval?, byday?, until?, count?, exdates?}`다 — `count`는 start 포함 총
   발생 횟수, `exdates`는 제외할 발생 키 목록(예: `["2026-10-03T07:30"]`, 날짜만 줘도
   된다). `start`는 오프셋 없이 `YYYY-MM-DDTHH:mm`(로컬 벽시계)로 주는 것이 가장 단순하다.
4. 다른 노드와 소속 관계(프로젝트 하위)가 있으면 `belongs_to`에 프로젝트 노드 id를
   준다. 소속은 아니지만 연관이 있으면(예: 참석자, 관련 인물) `sec_node_link({id,
   node_id, rel?, note?})`로 `relates_to`에 추가한다 — `belongs_to`(계층)와 혼동하지
   않는다. 제거는 `sec_node_unlink`.
5. `sec_node_put`을 호출한다. 응답의 `log`로 create/update 여부를 확인할 수 있다.

## 6. 노드 구성 원칙

노드를 추가/연결할 때(주로 [5장 add](#5-노드-추가수정-add)) 지키는 기준.

- **`belongs_to`=계층, `relates_to`=비계층**: `belongs_to`는 오직 "이 노드가 어느
  프로젝트에 속하는가"만 나타낸다(예: 여러 event가 하나의 `project::office-move`에
  속함). 그 외의 모든 연관 — 참석자, 선물 대상 인물, 비교/참고할 다른 일정 — 은
  `relates_to`로 표현한다. 하나의 관계를 양쪽에 중복 표현하지 않는다.
- **`curations`는 그래프 edge가 아니라 제안 목록이다.** `curations`는 다른 노드를
  가리키지 않고 "이 노드에 어떤 연계 스킬이 어울리는지"를 담는다 — [14장](#14-optional-catalog-스킬-연계-큐레이션)
  전용 필드다.
- **id는 안정적인 slug로 짓는다.** 날짜가 바뀌지 않는 한 같은 이벤트는 같은 id를
  유지한다(예: 매년 반복되는 생일은 `person::mom`에 `anniversary` 노드 하나로 관리하고,
  매년 새 노드를 만들지 않는다 — recurrence로 전개한다).

## 7. 목록 조회 (list)

`list [필터]` — `sec_node_list({kind?, status?, belongs_to?, tag?, from?, to?})`로
전체 노드(반복 전개 없이 노드 원본)를 조회한다. 반복 일정의 "다음 발생일까지 포함한
시간순 목록"이 필요하면 `agenda`([4장](#4-어젠다-agenda))를 쓴다 — `list`는 노드
자체의 목록(예: "등록된 프로젝트 전부", "person 노드 전부")을 볼 때 쓴다.

## 8. 기념일 (anniversaries)

`anniversaries` — `sec_agenda({kind:'anniversary', preset:'next_days', days:365})`
류로 향후 1년(또는 사용자가 지정한 범위)의 기념일만 뽑아 보여준다. 생일·기일·창립일
등 매년 반복되는 노드를 이 방식으로 관리한다([5장](#5-노드-추가수정-add) 참고 —
`recurrence.freq:'yearly'`).

## 9. 루틴 (routine)

`routine` — `sec_agenda({kind:'routine', preset:'week'})` 류로 이번 주(또는 지정
범위)의 루틴 발생 목록을 보여준다. 데일리/위클리 습관 등을 이 kind로 관리한다.

## 10. 상태 (status)

`status` — `sec_status()`로 kind별/status별 노드 개수, 다음 다가오는 어젠다 항목 1개,
overdue(활성 상태인데 시작시각이 이미 지난 event) 개수를 받아 요약해 보여준다.
overdue가 있으면 짚어주고 `complete`/재조정을 유도한다.

## 11. 완료 처리 (complete)

`complete <노드> [발생]` — 일정/할 일/루틴의 **한 발생**을 완료 처리하거나(기본) 취소한다.

1. `sec_complete({id, occurrence?, done?})`를 호출한다. `occurrence`는 `sec_agenda`
   항목의 `occurrence_key`(`YYYY-MM-DDTHH:mm`, 종일은 `YYYY-MM-DD`)이고, **단발 노드는
   생략하면 start 발생**이다. 반복 노드는 `occurrence`가 필수다. `done:false`는 완료
   취소(undo)다.
2. 단발 노드는 `status`도 `done`(취소 시 `active`)으로 갱신되고, 반복 노드는 노드
   `status`를 건드리지 않고(계속 `active`) 발생별 기록만 남는다. 어느 쪽이든 sec_log에
   `{node_id, event:'complete'|'uncomplete', occurrence}`가 쌓이고, **같은 발생의 마지막
   기록이 이긴다**(`sec_agenda`의 `done`).
3. 멱등이다: 이미 그 상태면 `changed:false`를 돌려주고 아무것도 쓰지 않는다. 실제
   발생이 아닌 키(exdates로 제외됐거나 규칙에 없는 날짜)는 `ok:false`로 거절한다.
4. 예전 방식(`sec_node_put status:'done'` + `sec_log_add complete`)으로 만든 단발 완료
   기록도 그대로 `done:true`로 읽힌다(하위 호환).

## 12. 로그 (log)

`log [필터]` — `sec_log_list({node_id?, event?, limit?})`로 create/update/complete/
uncomplete/remind/curate 이벤트 로그를 최신순으로 조회한다(`complete`/`uncomplete`에는
`occurrence`가 붙는다). 특정 노드의 변경 이력을 추적하거나,
언제 큐레이션이 제안됐는지 확인할 때 쓴다.

## 13. 내보내기 (export)

`export` — `sec_export_md({from?, to?, preset?, days?, kind?})`로 어젠다(또는
기념일만) 스냅샷을 markdown으로 렌더링해 받는다. 날짜별로 그룹핑된 목록이며, 각 항목에
큐레이션 제안이 있으면 함께 표시된다. 파일로 저장하거나 사용자에게 그대로 보여준다.

## 14. optional catalog (스킬 연계 큐레이션)

이 스킬은 다른 스킬로의 연계를 **제안(큐레이션)만** 한다 — doil-secretary가 다른
스킬을 직접 호출하거나 실행을 지시하지 않는다. 실행 주체는 항상 사용자다.

- **`/ai-echo`** — 연락·답장이 필요한 노드(생일 축하 메시지, 회신 마감이 있는 일정,
  인물 노드에 연결된 연락 태스크)에 "사용자 톤 답장 초안" 큐레이션을 제안한다.
- **`/sun-sang`** — 학습/복습 루틴(routine 노드), 그리고 사용자가 "이거 모르겠어"라고
  할 때 **학습이 필요한 개념이면** 튜터링/복습 확인 큐레이션을 제안한다.
- **`/doil-research`** — 조사가 필요한 태스크(project/event에 딸린 준비 작업), 그리고
  "이거 모르겠어"가 **외부 정보 수집이 필요한** 경우 리서치 큐레이션을 제안한다.
- **`/doil-supervise`** — 하루 또는 특정 노드에 복합 작업이 얽혀 오케스트레이션이
  필요할 때(예: project 노드 하위에 여러 종류의 하위 작업이 섞여 있음) 큐레이션을
  제안한다.

**규칙(반드시 지킨다):**

- **큐레이션 ONLY.** 비서는 다른 스킬을 직접 호출/지시하지 않고 **제안만** 한다 —
  실행 주체는 언제나 사용자다(예: "이 노드는 ai-echo로 답장 초안을 잡아두면 좋을 것
  같아요"까지가 이 스킬의 역할이고, 실제로 ai-echo를 부를지는 사용자가 결정한다).
- **설치 여부는 세션 노출로 판단한다.** 연계 대상 스킬이 설치돼 있는지는 세션에 해당
  스킬의 슬래시 커맨드나 `mcp__<skill>__*` 도구가 노출돼 있는지로 판단한다. 미설치면
  그 제안은 조용히 스킵한다 — optional catalog이므로 폴백이 필요 없다(단순히 그
  제안을 하지 않을 뿐, 다른 동작에 영향 없음).
- **저장은 선택이다.** 지속적으로 남기고 싶은 힌트는 `sec_node_curate({id, catalog,
  reason, note?})`로 노드에 저장할 수 있으나(다음 세션에서도 `agenda`/`list`에
  `curations`로 노출됨), 매번 저장이 강제되지 않는다 — 그 자리에서 한 번 언급만 하고
  끝낼 수도 있다.

## 15. [optional requirements]

- **doil-secretary MCP** — 이 스킬 저장소 안의 `mcp-server/`(dJinn/SQLite 기반). 일정
  그래프 카탈로그/로그의 SoT 역할을 하는 선택적 요구사항이다 — 있으면 우선 사용하고,
  없으면 아래 폴백을 따른다.
  - **데이터 홈 원칙**: git(이 skills repo)은 스킬 **코드** 공유용일 뿐이다. 일정
    데이터는 사용자에 귀속되며 워크스페이스·repo와 무관하게 관리되어야 하므로, 스킬
    설치경로(`doil-secretary/`)가 아니라 사용자 홈의 데이터 홈에 저장한다.
    - 기본값: `~/.doil-secretary` — `DOILSECRETARY_HOME` 환경변수로 오버라이드 가능.
    - 하위: `data/secretary.db`(dJinn DB), `secrets/`(향후 캘린더 연동 자격증명 보관용,
      mode 0700, 현재는 예약만), `onboard.lock`(온보딩 완료 마커).
    - 서버 기동/최초 사용 시 데이터 홈과 하위 디렉토리가 없으면 자동 생성된다.
    - 이렇게 분리해두면 이 skills repo를 재클론하거나 스킬 코드를 업데이트해도 일정
      데이터는 그대로 보존된다.
  - **설치**: 저장소 루트의 `./install.sh`가 심볼릭 링크 설치와 함께 `npm install`,
    `npm run init`(데이터 홈 자동 생성 + 스키마 시드)까지 자동 실행한다. 수동으로
    하려면:
    ```bash
    cd mcp-server
    npm install
    npm run init   # 데이터 홈(~/.doil-secretary 또는 $DOILSECRETARY_HOME)에 init/init.sql로 스키마+빈 카탈로그를 시드한다
    ```
    `init/init.sql`은 `CREATE ... IF NOT EXISTS`/`INSERT OR IGNORE`라 이미 데이터가 있는
    DB에 다시 실행해도 기존 개인 데이터를 건드리지 않는다(멱등). Claude Code MCP 설정에
    stdio 서버로 등록:
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
    데이터 홈을 바꾸려면 이 설정의 `env`에 `DOILSECRETARY_HOME`을 추가한다.
  - **설치돼 있으면**: 위 장들 그대로 `mcp__doil-secretary__*` 툴을 사용한다.
  - **설치돼 있지 않으면**: 어젠다를 세션 내에서만 텍스트로 유지하며 진행한다(세션 간
    영속 없음, 세션 내 텍스트로만 유지하고 강제하지 않음). MCP 설치 시 일정/기념일/
    루틴이 세션 간에도 이어진다고 짧게 제안할 수 있다. 설치 여부는 세션에
    `mcp__doil-secretary__*` 도구가 노출돼 있는지로 판단한다.
  - **git으로 공유되는 것과 안 되는 것**: `mcp-server/init/init.sql`은 스키마 DDL과 빈
    카탈로그 골격만 담은 범용 기본 데이터라 git에 커밋된다. 실제 데이터(DB, secrets,
    onboard.lock)는 애초에 데이터 홈(`~/.doil-secretary`)에만 생기므로 이 repo 안에는
    없다 — `.gitignore`의 관련 패턴은 오설정·구버전 실행 등으로 혹시 데이터가 repo
    안에 생기는 사고를 막는 안전망일 뿐이다.

- **void-notify MCP (선택) — 메시지 발송 채널.** 세션에 `mcp__void-notify__*` 도구가
  노출돼 있으면, 비서가 표면화한 내용(다가오는 일정·due 메모·리마인드 등)을 세션 안
  텍스트로만 두지 않고 **실제 메시지로 발송하는 출력 채널**로 활용할 수 있다. 예: 사용자가
  "이건 알림으로 보내줘"라고 하거나, 호출 시점에 발견한 due 항목을 void-notify로 내보낸다.
  - **이것도 풀(pull) 원칙을 바꾸지 않는다.** 이 스킬은 여전히 스스로 깨어나지 않는다 —
    void-notify는 비서가 (호출돼) 이미 돌고 있을 때 결과를 내보내는 통로일 뿐, 예약·
    백그라운드 발송 수단이 아니다. 진짜 무인 발송이 필요하면 외부 스케줄러가 이 스킬을
    호출해야 한다.
  - **노출돼 있지 않으면**: 발송 없이 세션 내 텍스트로만 표면화한다(강제하지 않음). 설치
    여부는 세션에 `mcp__void-notify__*` 도구가 노출돼 있는지로 판단한다.

## 16. 메모 (memo)

캘린더 노드(`sec_node`)와는 별개의 저장소(`sec_memo`)를 쓰는 가벼운 캡처 기능이다 —
그래프 edge(`relates_to`/`belongs_to`)도, 반복 규칙 전개도 없는 단순 텍스트 메모다.

- **"메모해줘"** → `sec_memo_add({text, remind_at?})`로 빠르게 캡처한다(status:
  `active`). 급히 적어두는 용도이지 일정/기념일/루틴을 대체하지 않는다 — 시간형 정보가
  구조화되어야 하면 [5장 add](#5-노드-추가수정-add)로 `sec_node_put`을 쓴다. `id`를
  이미 아는 기존 메모를 명시하면 upsert(갱신)된다.
- **비서 호출 시(agenda/status/체크인) 활성 due 메모를 재표면화한다** — due 판정은
  [§1 current 원칙](#1-핵심-원칙)의 현재 시각 기준이다: `sec_memo_list({due_only:true})`를
  호출하고 `now`는 명시하지 않으면 서버가 현재시각으로 채운다. `remind_at`이 없는
  메모는 상시 표면화 대상이고, `remind_at`이 있으면 그 시각 이후부터 표면화된다.
- **재표면화할 때는 "폐기할까요?"라고 물어보고, 사용자가 확인해야만**
  `sec_memo_discard({id})`로 폐기한다(소프트 삭제, `status:'discarded'`로만 바뀌고
  hard delete는 없다). **절대 자동으로 폐기하지 않는다** — 사용자 확인 없이 조용히
  치우면 안 된다.
- **`remind_at`은 풀(pull) 기반 재표면화일 뿐, 외부 push/알림이 아니다.** 지정한
  시각이 되었다고 텔레그램/cron 등으로 알림이 오지 않는다 — 이 스킬이 세션에서
  다시 호출됐을 때에만(agenda/status/memos 등) 그 메모가 다시 눈에 띈다([§1](#1-핵심-원칙)
  풀 기반 원칙과 일관). 이 스킬은 외부 연동(텔레그램/API/크론)이 전혀 없는
  자기완결형(self-contained) 기능이다.
- **메모 문서 모양과 콘솔 빠른 메모**: `{id, text(레거시, body_md의 거울), body_md(마크다운),
  color(yellow 기본|green|blue|pink|purple|gray), remind_at, status, created_at,
  modified_at, updated_at}`. `updated_at`은 서버가 **모든 쓰기에서** 갱신하는 ISO 버전이며
  낙관적 동시성에 쓴다(같은 밀리초 안에서도 반드시 증가). `text`만 있는 옛 메모는 **읽을 때**
  `body_md=text`, `color=yellow`, `updated_at=modified_at`로 마이그레이션되어 나오고 다음 쓰기에
  저장된다. `sec_memo_add({body_md?, text?, color?, remind_at?, id?})`(둘 중 하나 이상의 본문 필요),
  `sec_memo_update({id, body_md?, color?, expected_updated_at})` → `{ok:true, memo}` 또는 버전이
  다르거나 이미 폐기된 경우 쓰지 않고 `{ok:false, conflict:true, memo:<현재>}`,
  `sec_memo_list({order:'recent'})`는 updated_at 내림차순이다. doil-console 오른쪽 패널의 빠른
  메모는 이 `sec_memo`가 단일 정본이다(콘솔은 읽기 전용 어댑터와 이 MCP의 쓰기 도구로만
  접근). 폐기는 여전히 소프트이며, 콘솔은 사용자가 확인 대화상자에서 확인한 뒤에만
  `sec_memo_discard`를 호출한다.
- `memos` 커맨드는 기본 `status:'active'`로 `sec_memo_list`를 호출하고, due 메모를
  먼저 보여준다. `discard <메모>`는 대상 메모를 `sec_memo_get`/`sec_memo_list`로 특정한
  뒤 위 확인 절차를 거쳐 `sec_memo_discard`를 호출한다.
