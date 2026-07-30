#!/bin/bash
# MaaS 平台 — 环境初始化脚本
# 用法：bash init-db/setup.sh

set -e

echo "=== MaaS 环境初始化 ==="
echo ""

# 1. 修复 Homebrew 权限
echo "步骤1: 修复 Homebrew 目录权限..."
sudo chown -R $(whoami) /usr/local/lib /usr/local/lib/pkgconfig
sudo chmod u+w /usr/local/lib /usr/local/lib/pkgconfig

# 2. 安装 PostgreSQL 16
echo "步骤2: 安装 PostgreSQL 16..."
if ! command -v psql &> /dev/null; then
  brew install postgresql@16
  brew link postgresql@16 --force
else
  echo "  PostgreSQL 已安装"
fi

# 3. 安装 Redis
echo "步骤3: 安装 Redis..."
if ! command -v redis-server &> /dev/null; then
  brew install redis
else
  echo "  Redis 已安装"
fi

# 4. 启动 PostgreSQL
echo "步骤4: 启动 PostgreSQL..."
brew services start postgresql@16 2>/dev/null || pg_ctl -D /usr/local/var/postgresql@16 start 2>/dev/null || echo "  请手动启动 PostgreSQL"

# 5. 启动 Redis
echo "步骤5: 启动 Redis..."
brew services start redis 2>/dev/null || redis-server --daemonize yes 2>/dev/null || echo "  请手动启动 Redis"

# 6. 创建数据库
echo "步骤6: 创建数据库..."
sleep 2
createdb maas_platform 2>/dev/null || echo "  maas_platform 数据库已存在（或 PostgreSQL 未就绪）"

echo ""
echo "=== 安装完成 ==="
echo ""
echo "接下来请执行："
echo "  cd server"
echo "  npx prisma db push"
echo "  npx tsx prisma/seed.ts"
echo "  npm run dev"