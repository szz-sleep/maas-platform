#!/bin/bash
# MaaS 平台生产部署脚本
# 用途：一键构建和部署所有服务
#
# 前置条件：
#   1. Node.js 20+ / npm
#   2. PostgreSQL 16 已安装并运行
#   3. Redis 7 已安装并运行
#   4. （可选）nginx + certbot（域名 + HTTPS）
#
# 使用方式:
#   chmod +x deploy.sh
#   ./deploy.sh              # 完整部署
#   ./deploy.sh --build      # 仅构建
#   ./deploy.sh --start      # 仅启动（需先构建）
#   ./deploy.sh --stop       # 停止所有服务
#   ./deploy.sh --restart    # 重启所有服务
#   ./deploy.sh --status     # 查看状态

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[MaaS]${NC} $1"; }
warn() { echo -e "${YELLOW}[警告]${NC} $1"; }
err()  { echo -e "${RED}[错误]${NC} $1"; exit 1; }

# ─── 环境检查 ───
check_env() {
  log "检查运行环境..."
  command -v node >/dev/null 2>&1 || err "未安装 Node.js"
  command -v npm >/dev/null 2>&1 || err "未安装 npm"
  command -v psql >/dev/null 2>&1 || warn "未检测到 psql，请确认 PostgreSQL 已安装并运行"
  command -v redis-cli >/dev/null 2>&1 || warn "未检测到 redis-cli，请确认 Redis 已安装并运行"

  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -lt 20 ]; then
    err "需要 Node.js 20+，当前版本: $(node -v)"
  fi
  log "环境检查通过 (Node $(node -v))"
}

# ─── 安装依赖 ───
install_deps() {
  log "安装依赖..."
  for dir in server client admin-client; do
    cd "$ROOT_DIR/$dir"
    log "  $dir..."
    npm install --loglevel=error
  done
  cd "$ROOT_DIR"
  log "依赖安装完成"
}

# ─── 数据库迁移 ───
migrate_db() {
  log "数据库迁移..."
  cd "$ROOT_DIR/server"
  npx prisma generate
  npx prisma db push
  npx tsx prisma/seed.ts 2>/dev/null && log "种子数据已加载" || warn "种子数据加载跳过（可能已存在）"
  cd "$ROOT_DIR"
}

# ─── 构建前端 ───
build_clients() {
  log "构建前端..."
  cd "$ROOT_DIR/client"
  npm run build
  log "  用户端构建完成"

  cd "$ROOT_DIR/admin-client"
  npm run build
  log "  管理端构建完成"

  cd "$ROOT_DIR/.."
}

# ─── 编译后端 ───
build_server() {
  log "编译后端..."
  cd "$ROOT_DIR/server"
  npx tsc
  log "后端编译完成"
  cd "$ROOT_DIR"
}

# ─── 创建日志目录 ───
ensure_logs() {
  mkdir -p "$ROOT_DIR/logs"
  mkdir -p "$ROOT_DIR/backups"
}

# ─── PM2 启动 ───
pm2_start() {
  log "启动服务..."
  if ! command -v pm2 >/dev/null 2>&1; then
    warn "PM2 未安装，正在安装..."
    npm install -g pm2
  fi
  ensure_logs
  pm2 start ecosystem.config.cjs
  pm2 save
  log "所有服务已启动"
  pm2 status
}

# ─── PM2 停止 ───
pm2_stop() {
  log "停止服务..."
  pm2 stop ecosystem.config.cjs 2>/dev/null || warn "部分服务可能未运行"
  log "服务已停止"
}

# ─── PM2 重启 ───
pm2_restart() {
  log "重启服务..."
  pm2 restart ecosystem.config.cjs 2>/dev/null || pm2 start ecosystem.config.cjs
  log "服务已重启"
}

# ─── PM2 状态 ───
pm2_status() {
  pm2 status
}

# ─── 备份数据库 ───
backup_db() {
  ensure_logs
  local BACKUP_FILE="$ROOT_DIR/backups/maas_$(date +%Y%m%d_%H%M%S).sql"
  log "备份数据库到 $BACKUP_FILE ..."
  pg_dump maas_platform > "$BACKUP_FILE" 2>/dev/null || warn "数据库备份失败，请确认 PostgreSQL 正在运行"
  log "备份完成: $BACKUP_FILE"

  # 保留最近 7 天的备份
  find "$ROOT_DIR/backups" -name "maas_*.sql" -mtime +7 -delete 2>/dev/null
  log "已清理过期备份"
}

# ============================================================
# 主流程
# ============================================================
case "${1:-deploy}" in
  --build|build)
    check_env
    install_deps
    migrate_db
    build_clients
    build_server
    log "✅ 构建完成！可用 ./deploy.sh --start 启动服务"
    ;;
  --start|start)
    pm2_start
    ;;
  --stop|stop)
    pm2_stop
    ;;
  --restart|restart)
    pm2_restart
    ;;
  --status|status)
    pm2_status
    ;;
  --backup|backup)
    backup_db
    ;;
  deploy)
    check_env
    install_deps
    migrate_db
    build_server
    build_clients
    pm2_start
    log ""
    log "============================================"
    log "  🚀 MaaS 平台部署完成！"
    log "  API:       http://localhost:3001"
    log "  用户端:    http://localhost:3000"
    log "  管理后台:  http://localhost:3002"
    log "  API 文档:  http://localhost:3001/documentation"
    log "============================================"
    log ""
    log "常用命令:"
    log "  pm2 status                查看服务状态"
    log "  pm2 logs maas-server      查看后端日志"
    log "  ./deploy.sh --restart     重启所有服务"
    log "  ./deploy.sh --backup      备份数据库"
    ;;
  *)
    echo "用法: $0 [deploy|--build|--start|--stop|--restart|--status|--backup]"
    exit 1
    ;;
esac
