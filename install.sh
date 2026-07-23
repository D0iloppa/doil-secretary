#!/usr/bin/env bash
# 이 스킬을 Claude Code 스킬 디렉토리로 심볼릭 링크한다(글로벌 설치).
# 링크만 걸므로 이 repo에서 편집하면 즉시 반영된다.
#
# 사용법:
#   ./install.sh                 # 기본: $CLAUDE_CONFIG_DIR(없으면 ~/.claude) 한 곳에 설치
#   ./install.sh --all-profiles  # ~ 아래 모든 Claude 프로필(settings.json 보유)에 설치
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="$(basename "$SKILL_DIR")"

link_into() {  # $1 = config dir
  local dest="$1/skills"
  mkdir -p "$dest"
  ln -sfn "$SKILL_DIR" "$dest/$NAME"
  echo "linked: $dest/$NAME -> $SKILL_DIR"
}

setup_mcp_server() {
  local mcp_dir="$SKILL_DIR/mcp-server"
  [ -d "$mcp_dir" ] || return 0
  echo "setting up mcp-server..."
  (cd "$mcp_dir" && npm install --silent)
  # 데이터 홈(기본 ~/.doil-secretary, DOILSECRETARY_HOME 환경변수로 오버라이드)에 DB를
  # 초기화한다. init/init.sql은 CREATE ... IF NOT EXISTS / INSERT OR IGNORE라 이미
  # 데이터가 있는 DB에 다시 실행해도 기존 개인 데이터를 건드리지 않는다(멱등). 데이터는
  # 스킬 repo(이 폴더)가 아니라 사용자 홈에 귀속된다 — git은 코드 공유용일 뿐이다.
  (cd "$mcp_dir" && node scripts/init-db.js)
  local data_home="${DOILSECRETARY_HOME:-$HOME/.doil-secretary}"
  echo "data home: $data_home (DOILSECRETARY_HOME으로 오버라이드 가능)"
}

if [ "${1:-}" = "--all-profiles" ]; then
  found=0
  for cfg in "$HOME"/.claude "$HOME"/.claude-*; do
    [ -d "$cfg" ] || continue
    [ -f "$cfg/settings.json" ] || continue   # 실제 프로필만(계정 스냅샷 등 제외)
    link_into "$cfg"
    found=$((found + 1))
  done
  echo "done. linked into $found profile(s)."
else
  CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  link_into "$CONFIG_DIR"
  echo "done. config dir: $CONFIG_DIR"
fi

setup_mcp_server

echo ""
echo "MCP 서버를 Claude Code에 등록하려면:"
echo "  claude mcp add doil-secretary -- node \"$SKILL_DIR/mcp-server/src/index.js\""
echo "또는 ~/.claude/settings.json의 mcpServers에 직접 추가:"
echo '  {"mcpServers": {"doil-secretary": {"command": "node", "args": ["'"$SKILL_DIR"'/mcp-server/src/index.js"]}}}'
