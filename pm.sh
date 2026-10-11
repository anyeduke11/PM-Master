#!/bin/bash
# PM-Master 一键管理脚本
# 用法: ./pm.sh {start|stop|restart|status|log|doctor|backup|restore|reset-demo}
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
SERVER="$ROOT/server"
WEB="$ROOT/web"
DATA="$SERVER/data"
LOG_DIR="$ROOT/.logs"
PID_DIR="$ROOT/.pids"
DB="$DATA/pm-master.db"
BACKUP_DIR="$ROOT/.backups"

SERVER_PORT=8735
WEB_PORT=8736
SERVER_URL="http://127.0.0.1:$SERVER_PORT"
WEB_URL="http://localhost:$WEB_PORT"

mkdir -p "$LOG_DIR" "$PID_DIR" "$BACKUP_DIR"

c_ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
c_bad()  { printf "\033[31m✗\033[0m %s\n" "$*"; }
c_info() { printf "\033[36m•\033[0m %s\n" "$*"; }

pid_of_file() { local f="$1"; [ -f "$f" ] && cat "$f" 2>/dev/null || true; }
is_running()  { local p="$1"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

port_listen_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; return 0; }

wait_http() { # url timeout
  local url="$1" t="${2:-15}" i=0
  while [ $i -lt $t ]; do
    curl -sf -o /dev/null --max-time 2 "$url" && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

# ---------- start ----------
do_start() {
  # 依赖检查
  command -v node >/dev/null || { c_bad "未安装 Node.js（需 ≥22.5）"; exit 1; }
  [ -d "$SERVER/node_modules" ] || { c_info "安装 server 依赖…"; (cd "$SERVER" && npm install --no-audit --no-fund >/dev/null 2>&1); }
  [ -d "$WEB/node_modules" ]    || { c_info "安装 web 依赖…"; (cd "$WEB" && npm install --no-audit --no-fund >/dev/null 2>&1); }

  # server
  if SP=$(port_listen_pid $SERVER_PORT) && [ -n "$SP" ]; then
    c_ok "server 已在运行 (pid $SP · $SERVER_URL)"
  else
    c_info "启动 server…"
    ( cd "$SERVER"
      nohup bash scripts/with-env.sh src/index.mjs < /dev/null >> "$LOG_DIR/server.log" 2>&1 &
      disown
      echo $! > "$PID_DIR/server.pid" )
    if wait_http "$SERVER_URL/api/health" 20; then c_ok "server 就绪 → $SERVER_URL"; else c_bad "server 启动失败，查看: ./pm.sh log server"; fi
  fi

  # web
  if WP=$(port_listen_pid $WEB_PORT) && [ -n "$WP" ]; then
    c_ok "web 已在运行 (pid $WP · $WEB_URL)"
  else
    c_info "启动 web…"
    ( cd "$WEB"
      nohup npx vite --port $WEB_PORT < /dev/null >> "$LOG_DIR/web.log" 2>&1 &
      disown
      echo $! > "$PID_DIR/web.pid" )
    if wait_http "$WEB_URL" 20; then c_ok "web 就绪 → $WEB_URL"; else c_bad "web 启动失败，查看: ./pm.sh log web"; fi
  fi

  echo
  c_info "打开 $WEB_URL 开始使用（首访为冷启动向导）"
}

# ---------- stop ----------
do_stop() {
  local stopped=0
  # 只杀监听端口的进程本体（TERM 单发；不 pkill 树——避免误杀调用方 shell）
  for port in $SERVER_PORT $WEB_PORT; do
    for p in $(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null); do
      kill -TERM "$p" 2>/dev/null && { c_ok "端口 $port 进程 $p 已停止"; stopped=1; }
    done
  done
  rm -f "$PID_DIR"/*.pid 2>/dev/null
  [ $stopped -eq 0 ] && c_info "无运行中的进程"
  return 0
}

# ---------- status ----------
do_status() {
  echo "═══ PM-Master 状态 ═══"
  # server
  sp=$(port_listen_pid $SERVER_PORT)
  if [ -n "$sp" ]; then
    h=$(curl -sf --max-time 3 "$SERVER_URL/api/health" 2>/dev/null || true)
    if [ -n "$h" ]; then
      info=$(echo "$h" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(f"provider={d[\"provider\"]} tables={d[\"tables\"]}")' 2>/dev/null || echo "")
      c_ok "server  pid=$sp  $SERVER_URL  $info"
    else
      c_bad "server  pid=$sp  $SERVER_URL  (健康检查失败)"
    fi
  else
    c_bad "server  未运行"
  fi
  # web
  wp=$(port_listen_pid $WEB_PORT)
  if [ -n "$wp" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$WEB_URL" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && c_ok "web     pid=$wp  $WEB_URL" || c_bad "web     pid=$wp  (HTTP $code)"
  else
    c_bad "web     未运行"
  fi
  # 飞书 / LLM 配置
  fs=$(curl -sf --max-time 3 "$SERVER_URL/api/feishu/status" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["mode"])' 2>/dev/null || echo "-")
  c_info "飞书: $fs"
  # 密钥状态
  (cd "$SERVER" && bash scripts/secrets.sh status 2>/dev/null | sed 's/^/• /') || true
  # 数据统计（一次性取齐，避免重复行）
  if [ -f "$DB" ]; then
    stats=$(cd "$SERVER" && node -e "
import('node:sqlite').then(({DatabaseSync})=>{
  const db=new DatabaseSync('data/pm-master.db');
  const t=(n)=>{try{return n+':'+db.prepare('SELECT count(*) c FROM '+n).get().c}catch{return null}};
  const out=['coach_sessions','evidence','projects','knowledge_cards','alerts'].map(t).filter(Boolean).join('  ');
  console.log(out||'(空)');
}).catch(()=>console.log('(读库失败)'))" 2>/dev/null || echo "(读库失败)")
    c_info "数据统计: $stats"
  fi
}

# ---------- log ----------
do_log() {
  local which="${1:-all}"
  case "$which" in
    server) tail -n 50 "$LOG_DIR/server.log" 2>/dev/null || c_info "无 server 日志" ;;
    web)    tail -n 50 "$LOG_DIR/web.log" 2>/dev/null || c_info "无 web 日志" ;;
    all)    for f in server web; do echo "── $f ──"; tail -n 20 "$LOG_DIR/$f.log" 2>/dev/null || echo "(空)"; done ;;
    *) echo "用法: ./pm.sh log {server|web|all}"; exit 1 ;;
  esac
}

# ---------- doctor ----------
do_doctor() {
  echo "═══ PM-Master 体检 ═══"
  fail=0
  # node
  nv=$(node -v 2>/dev/null | sed 's/v//' || echo 0)
  major=$(echo "$nv" | cut -d. -f1)
  [ "${major:-0}" -ge 22 ] && c_ok "Node $nv (≥22.5 ✓)" || { c_bad "Node $nv 过低（需 ≥22.5）"; fail=1; }
  # pi（可选）
  command -v pi >/dev/null && c_ok "pi CLI $(pi --version 2>/dev/null | head -1)（可选 provider 可用）" || c_info "pi CLI 未安装（可选）"
  # python3/yaml（标准库校验）
  python3 -c "import yaml" 2>/dev/null && c_ok "python3+yaml（YAML 校验可用）" || c_info "python3 缺 yaml（仅影响脚本校验，不影响运行）"
  # 标准 YAML
  for f in "$ROOT"/standard/*.yaml; do
    python3 -c "import yaml,sys;yaml.safe_load(open('$f'))" 2>/dev/null && c_ok "$(basename $f) 语法 OK" || { c_bad "$(basename $f) 语法错误"; fail=1; }
  done
  # 密钥
  (cd "$SERVER" && [ -f .env ] || [ -f .env.enc ]) && c_ok "凭据已配置（.env/.env.enc）" || c_info "无凭据：将以 mock provider 运行（server/.env.example）"
  # 语法检查全部源码
  bad=0
  for f in "$SERVER"/src/*.mjs; do node --check "$f" 2>/dev/null || { c_bad "$(basename $f) 语法错误"; bad=1; fail=1; }; done
  [ $bad -eq 0 ] && c_ok "server 8 个源文件语法 OK"
  # 端口占用冲突（非本系统进程）
  for port in $SERVER_PORT $WEB_PORT; do
    p=$(port_listen_pid $port)
    [ -n "$p" ] && c_info "端口 $port 被 pid $p 占用（若非本系统请处理）"
  done
  echo
  [ $fail -eq 0 ] && c_ok "体检通过" || c_bad "存在问题（见上）"
}

# ---------- backup / restore ----------
do_backup() {
  local ts=$(date +%Y%m%d-%H%M%S)
  local f="$BACKUP_DIR/pm-master-$ts.db"
  if [ ! -f "$DB" ]; then c_bad "无数据库可备份"; exit 1; fi
  # WAL checkpoint 后拷贝
  (cd "$SERVER" && node -e "import('node:sqlite').then(({DatabaseSync})=>{const db=new DatabaseSync('data/pm-master.db');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close()})" 2>/dev/null || true)
  cp "$DB" "$f"
  # 只保留最近 10 份
  ls -t "$BACKUP_DIR"/pm-master-*.db 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
  c_ok "已备份 -> $f ($(du -h "$f" | cut -f1))"
}
do_restore() {
  local f="${1:-}"
  if [ -z "$f" ]; then
    echo "可恢复的备份："
    ls -t "$BACKUP_DIR"/pm-master-*.db 2>/dev/null | head -5 | nl
    echo "用法: ./pm.sh restore <文件路径>"
    exit 0
  fi
  [ -f "$f" ] || { c_bad "文件不存在: $f"; exit 1; }
  sp=$(port_listen_pid $SERVER_PORT)
  [ -n "$sp" ] && { c_info "先停止 server…"; kill "$sp" 2>/dev/null || true; sleep 1; }
  do_backup   # 恢复前先备份当前
  cp "$f" "$DB"
  c_ok "已恢复 $(basename $f)"
  do_start
}

# ---------- reset-demo（演示数据重置：清库重建骨架） ----------
do_reset_demo() {
  read -r -p "将清空全部数据（教练会话/成长记录/项目/卡片进度），输入 yes 确认: " ans
  [ "$ans" = "yes" ] || { c_info "已取消"; exit 0; }
  sp=$(port_listen_pid $SERVER_PORT)
  [ -n "$sp" ] && { kill "$sp" 2>/dev/null || true; sleep 1; }
  do_backup >/dev/null 2>&1 || true
  rm -f "$DB" "$DB-wal" "$DB-shm"
  c_ok "已清空数据库（备份保留在 .backups/）"
  # 重新初始化（跑一次 db.mjs 建表+种子档案）
  (cd "$SERVER" && node -e "import('./src/db.mjs').then(()=>{console.log('schema 重建 OK');process.exit(0)})")
  c_info "下次启动后：首访为冷启动向导"
  do_start
}

# ---------- main ----------
case "${1:-status}" in
  start)      do_start ;;
  stop)       do_stop ;;
  restart)    do_stop; sleep 1; do_start ;;
  status)     do_status ;;
  log)        do_log "${2:-all}" ;;
  doctor)     do_doctor ;;
  backup)     do_backup ;;
  restore)    do_restore "${2:-}" ;;
  reset-demo) do_reset_demo ;;
  *)
    cat << 'USAGE'
PM-Master 一键管理

  ./pm.sh start        启动 server(:8735) + web(:8736)
  ./pm.sh stop         停止全部
  ./pm.sh restart      重启
  ./pm.sh status       状态总览（进程/健康/凭据/数据量）
  ./pm.sh log [t]      查看日志 server|web|all
  ./pm.sh doctor       体检（Node/依赖/YAML/源码语法/端口）
  ./pm.sh backup       备份数据库（保留最近 10 份）
  ./pm.sh restore [f]  恢复备份
  ./pm.sh reset-demo   清空数据重新冷启动（自动备份）
USAGE
    ;;
esac
