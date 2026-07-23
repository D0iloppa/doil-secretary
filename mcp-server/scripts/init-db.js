#!/usr/bin/env node
'use strict';

// 데이터 홈(기본 ~/.doil-secretary, DOILSECRETARY_HOME으로 오버라이드)의
// data/secretary.db를 init/init.sql로 초기화한다. 테이블/인덱스는
// CREATE ... IF NOT EXISTS, 시드 row(root 카탈로그)는 INSERT OR IGNORE라 이미 데이터가
// 있는 DB에 다시 실행해도 안전하다(멱등) — 기존 개인 데이터를 덮어쓰지 않는다. 스킬
// repo(doil-secretary/)에는 데이터가 생기지 않는다 — 데이터는 사용자 홈에 귀속되며
// git과 무관하다.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH, ensureDataHome } = require('../src/paths');

const SQL_PATH = path.join(__dirname, '..', 'init', 'init.sql');

function main() {
  ensureDataHome();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(fs.readFileSync(SQL_PATH, 'utf8'));
  db.close();
  console.log(`[ok] initialized ${DB_PATH} from ${SQL_PATH}`);
}

main();
