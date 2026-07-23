'use strict';

// 데이터 홈 — 일정/기념일/루틴 데이터는 사용자에 귀속되며 스킬 코드(git repo)와 무관하게
// 관리된다. git(skills repo)은 스킬 코드 공유용일 뿐이다 — 실제 데이터(dJinn DB, 온보딩
// 마커, 향후 캘린더 연동 자격증명)는 스킬 설치경로가 아니라 사용자 홈의 데이터 디렉토리에
// 둔다. 이렇게 하면 스킬 repo를 재클론하거나 스킬 코드를 업데이트해도 데이터가 보존된다.
// 기본값은 `~/.doil-secretary`이며 `DOILSECRETARY_HOME` 환경변수로 오버라이드할 수 있다.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DOILSECRETARY_HOME = process.env.DOILSECRETARY_HOME
  ? path.resolve(process.env.DOILSECRETARY_HOME)
  : path.join(os.homedir(), '.doil-secretary');

const DATA_DIR = path.join(DOILSECRETARY_HOME, 'data');
const SECRETS_DIR = path.join(DOILSECRETARY_HOME, 'secrets');

const DB_PATH = path.join(DATA_DIR, 'secretary.db');
const ONBOARD_LOCK_PATH = path.join(DOILSECRETARY_HOME, 'onboard.lock');

// 서버 기동/최초 사용 시 데이터 홈 하위 디렉토리가 없으면 자동 생성한다(멱등).
function ensureDataHome() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  return DOILSECRETARY_HOME;
}

module.exports = {
  DOILSECRETARY_HOME,
  DATA_DIR,
  SECRETS_DIR,
  DB_PATH,
  ONBOARD_LOCK_PATH,
  ensureDataHome,
};
