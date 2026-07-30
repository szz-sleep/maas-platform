# MaaS 模型服务平台 — 完整说明文档

> 统一大模型服务平台（Model as a Service），一 KEY 通用，一站式调用所有模型。

---

## 目录

1. [平台概述](#1-平台概述)
2. [核心价值](#2-核心价值)
3. [系统架构](#3-系统架构)
4. [功能模块](#4-功能模块)
5. [技术栈](#5-技术栈)
6. [数据库设计](#6-数据库设计)
7. [API 接口文档](#7-api-接口文档)
8. [部署指南](#8-部署指南)
9. [使用指南](#9-使用指南)
10. [模型管理](#10-模型管理)
11. [安全设计](#11-安全设计)
12. [开发规范](#12-开发规范)

---

## 1. 平台概述

MaaS（Model as a Service）是一个统一大模型服务平台。它解决了一个核心痛点：**当你有多个模型来源时，如何让用户用一个统一的入口来调用所有模型？**

平台整合两类模型：
- **火山引擎模型**：Seedance（视频生成）、Seedream（图片生成）、豆包系列（理解）等，通过 API 接入
- **自部署模型**：服务器上通过 Ollama / vLLM 等工具部署的开源模型，如 Llama、Gemma、Stable Diffusion 等

用户注册后获取一个 API Key，就能调用平台上的**所有可用模型**，不必关心每个模型跑在哪里、用什么格式请求。

---

## 2. 核心价值

### 一 KEY 通用
用户只需一个 API Key，就能调用平台上的所有模型，无论是火山引擎的 Seedance 视频生成还是服务器上自己跑的 Gemma 4。

### 模型动态发现
自部署模型（Ollama/vLLM）上线后，平台**自动检测并注册**，无需手动配置。模型下线也自动标记。用户端模型列表始终反映真实可用状态。

### OpenAI 兼容
平台提供 `/v1/chat/completions`、`/v1/images/generations`、`/v1/models` 等 OpenAI 兼容接口。用户可以直接用 `openai` Python SDK 调用：

```python
from openai import OpenAI
client = OpenAI(api_key="平台Key", base_url="http://your-domain/v1")
resp = client.chat.completions.create(model="gemma4:latest", messages=[...])
```

### 完整的管理后台
- 数据大屏：实时用户数、Key数、模型状态、调用趋势
- 用户管理：启用/禁用、角色分配
- Key 管理：配额分配、启用/禁用、明文查看
- 模型管理：手动上下线、一键扫描自部署模型
- 系统配置：火山引擎 API Key/AK/SK 管理、注册开关、限流参数

---

## 3. 系统架构

```
┌─────────────────────────────────────────────────────┐
│                      用户层                          │
│  Web 用户端 (Next.js)  │  OpenAI SDK  │  直接 API   │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS / API Key
┌──────────────▼──────────────────────────────────────┐
│              Nginx 反向代理 (可选)                    │
│         HTTPS 终结  │  IP 白名单  │  限流            │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│              Fastify API 服务 (3001)                  │
│  认证 · Key管理 · 模型路由 · 配额扣减 · 调用日志     │
│              OpenAI 兼容层 (/v1/*)                    │
└──┬───────────┬──────────┬───────────────────────────┘
   │           │           │
   ▼           ▼           ▼
┌──────┐ ┌──────┐ ┌──────────────┐
│PostgreSQL│ │Redis │ │ 模型同步服务 │
│ 用户/Key │ │限流/ │ │ 扫描Ollama/  │
│ 模型/日志│ │缓存  │ │ vLLM 自动注册│
└──────┘ └──────┘ └──────┬───────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  Ollama  │  │  vLLM    │  │ 火山引擎  │
   │ (本地)   │  │ (服务器)  │  │  Seedance │
   │ Gemma4   │  │ Llama3   │  │ Seedream  │
   └──────────┘  └──────────┘  │ 豆包系列  │
                               └──────────┘
```

---

## 4. 功能模块

### 4.1 用户端（client/ — 端口 3000）

| 页面 | 功能 |
|------|------|
| 登录/注册 | 账号密码登录，支持邮箱/手机号注册 |
| 仪表盘 | Key 数量、模型数、本月调用次数、配额消耗 |
| 模型中心 | 查看所有可用模型（动态加载），区分类型标签 |
| Key 管理 | 申请/查看/启用/禁用/删除 API Key，复制 Key 值 |
| 账号设置 | 修改密码、绑定邮箱/手机号 |

### 4.2 管理端（admin-client/ — 端口 3002）

| 页面 | 功能 |
|------|------|
| 数据大屏 | 用户/Key/模型数量统计，各模型调用分布图表 |
| 用户管理 | 列表查看、搜索、启用/禁用 |
| Key 管理 | 查看所有 Key、分配配额、启用/禁用、删除（含外键软删除） |
| 模型管理 | 模型列表、手动上下线、**一键扫描自部署模型** |
| 调用日志 | 按用户/模型/状态/日期筛选，查看调用详情 |
| 系统配置 | 火山引擎 API Key、AK/SK、注册开关、限流参数 |

### 4.3 后端 API（server/ — 端口 3001）

| 路由文件 | 端点前缀 | 功能 |
|---------|---------|------|
| auth.ts | `/api/v1/auth/` | 登录、注册、Token 刷新、发送验证码 |
| user.ts | `/api/v1/user/` | 个人信息、修改密码、绑定邮箱/手机、注销 |
| key.ts | `/api/v1/keys/` | 申请 Key、列表、状态管理、删除、查看明文 |
| model.ts | `/api/v1/models/` | 公开模型列表、模型详情、模型注册 |
| generate.ts | `/api/v1/generate/`、`/api/v1/tasks/` | 统一模型调用（视频/图片/对话）+ 任务轮询 |
| understand.ts | `/api/v1/understand/` | 理解类接口（视频/图片/文档/音频） |
| files.ts | `/api/v1/files/` | 文件上传（对接火山 Files API） |
| assets.ts | `/api/v1/assets/` | 素材管理（需要 AK/SK） |
| settings.ts | `/api/v1/public/settings/` | 系统配置管理 |
| openai-compat.ts | `/v1/` | OpenAI 兼容接口 |
| admin.ts | `/api/v1/admin/` | 管理后台所有接口 |

---

## 5. 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **后端框架** | Fastify | TypeScript |
| **数据库** | PostgreSQL | 16 |
| **ORM** | Prisma | 7 |
| **缓存/限流** | Redis | 7 |
| **鉴权** | JWT（用户） + SHA256 Key Hash（API 调用） |
| **加密** | bcrypt（密码）、AES-256（密钥） |
| **前端框架** | Next.js（App Router） | 16 |
| **UI 框架** | React | 19 |
| **样式** | Tailwind CSS | 4 |
| **图标** | Lucide Icons | |
| **图表** | ECharts | |
| **状态管理** | Zustand + React Query | |
| **部署** | PM2 + Nginx + Let's Encrypt | |

---

## 6. 数据库设计

### 6.1 实体关系

```
User (用户)
  ├── ApiKey (API Key)  — 一对多，用户删除时级联删除
  ├── CallLog (调用日志) — 一对多
  └── KeyQuotaHistory (配额记录) — 间接关联

Model (模型定义)
  └── CallLog (调用日志) — 一对多

ApiKey (API Key)
  ├── CallLog (调用日志) — 一对多
  └── KeyQuotaHistory (配额记录) — 一对多

SystemSetting (系统设置) — 独立的键值对表
```

### 6.2 核心表

| 表名 | 关键字段 | 说明 |
|------|---------|------|
| `users` | username, email, role, is_active | 用户表，角色分 user/admin |
| `api_keys` | key_name, key_value（加密）, key_hash（SHA256 快速查询）, status, quota_total/used | Key 的状态有 pending_quota/active/revoked |
| `models` | name, source(volcano/local), model_type(video/image/chat/audio/embedding), status, config(JSONB) | 模型注册中心 |
| `call_logs` | api_key_id, model_id, tokens_input/output, cost, status | 每次调用的完整记录 |
| `key_quota_history` | key_id, amount, reason | 配额变更审计 |
| `system_settings` | key, value（敏感值 AES 加密） | 系统配置存储 |

### 6.3 Model 表的状态机

```
offline ──(加载)──▶ loading ──(就绪)──▶ online
                                           │
                     offline ◀──(卸载)──────┘
```

- 自部署模型：由 `model-sync` 服务自动管理状态
- 火山引擎模型：管理员手动上下线

---

## 7. API 接口文档

### 7.1 认证相关

#### 发送验证码
```
POST /api/v1/auth/send-code
Body: { "type": "email|phone", "target": "user@example.com" }
限流: 同一目标 60秒/次
```

#### 注册
```
POST /api/v1/auth/register
Body: { "username": "xxx", "password": "xxx" }
返回: { accessToken, refreshToken, userId }
```

#### 登录
```
POST /api/v1/auth/login
Body: { "account": "用户名/邮箱/手机号", "password": "xxx" }
返回: { accessToken, refreshToken, userId, role }
限流: 同一 IP+账号 5次/5分钟，超限锁定
```

#### 刷新 Token
```
POST /api/v1/auth/refresh-token
Body: { "refreshToken": "xxx" }
```

### 7.2 模型调用（核心）

#### 统一生成接口
```
POST /api/v1/generate
Header: Authorization: Bearer <API_KEY>
Body: {
  "model": "模型名称",
  "prompt": "提示词",
  "images": ["图片URL"],     // 可选，多模态输入
  "videos": ["视频URL"],     // 可选
  "audios": ["音频URL"],     // 可选
  "duration": 5,             // 视频生成时长(秒)
  "ratio": "16:9",           // 视频比例
  "temperature": 0.7         // 对话温度
}
```

系统根据 Model 表中的 `source` + `modelType` 自动路由到正确的后端：
- `volcano + video` → Seedance 2.0 视频生成（异步，支持轮询）
- `volcano + image` → Seedream 图片生成（同步返回）
- `volcano + chat` → 豆包 Responses API（理解类）
- `local + chat` → Ollama/vLLM（OpenAI 兼容格式）
- `local + image` → Stable Diffusion WebUI API

#### 任务轮询（视频生成用）
```
GET /api/v1/tasks/:taskId
Header: Authorization: Bearer <API_KEY>
返回: { taskId, status: "queued|running|succeeded|failed", video_url, usage }
```

### 7.3 OpenAI 兼容接口

用户可以直接用 `openai` Python/Node.js SDK：

```
GET  /v1/models              # 模型列表（OpenAI 格式）
POST /v1/chat/completions    # 对话完成
POST /v1/images/generations  # 图片生成
```

Python 示例：
```python
from openai import OpenAI
client = OpenAI(
    api_key="mks-xxxxxxxxxxxxx",
    base_url="http://your-server:3001/v1"
)
# 对话
resp = client.chat.completions.create(
    model="gemma4:latest",
    messages=[{"role": "user", "content": "你好"}]
)
print(resp.choices[0].message.content)

# 图片生成
resp = client.images.generate(
    model="seedream5.0-pro",
    prompt="一只樱花树下的猫"
)
```

### 7.4 Key 管理

```
POST   /api/v1/keys                    # 申请新 Key
GET    /api/v1/keys                    # 我的 Key 列表
GET    /api/v1/keys/:id/value          # 查看 Key 明文（仅创建者）
PUT    /api/v1/keys/:id               # 修改 Key 状态
DELETE /api/v1/keys/:id               # 删除 Key
GET    /api/v1/stats/my-usage          # 我的用量统计
```

### 7.5 管理后台 API

所有接口需要 **管理员 JWT Token**（`Authorization: Bearer <ADMIN_TOKEN>`）。

```
# 数据大屏
GET    /api/v1/admin/overview          # 总览数据

# 用户管理
GET    /api/v1/admin/users             # 用户列表（分页+搜索）
PUT    /api/v1/admin/users/:id/toggle  # 启用/禁用用户
PUT    /api/v1/admin/users/:id         # 修改用户信息

# Key 管理
GET    /api/v1/admin/keys              # 所有 Key 列表
PUT    /api/v1/admin/keys/:id/quota    # 分配配额
PUT    /api/v1/admin/keys/:id/toggle   # 启用/禁用
DELETE /api/v1/admin/keys/:id          # 删除（自动软删除）
GET    /api/v1/admin/keys/:id/value    # 查看 Key 明文

# 模型管理
GET    /api/v1/admin/models/status     # 模型状态列表
POST   /api/v1/admin/models/load       # 上线模型
POST   /api/v1/admin/models/unload     # 下线模型
POST   /api/v1/admin/models/sync       # 扫描自部署模型

# 调用日志
GET    /api/v1/admin/logs              # 日志列表（多维度筛选）

# 系统配置
GET    /api/v1/public/settings         # 公开配置
# 设置 CRUD（内部使用）
```

---

## 8. 部署指南

### 8.1 环境要求

- Node.js 20+
- PostgreSQL 16
- Redis 7
- （可选）Nginx + Certbot（域名 + HTTPS）

### 8.2 快速开始（开发环境）

```bash
# 1. 克隆项目
cd ~/Documents/后台管理

# 2. 启动数据库（二选一）
# 方式 A: Docker
docker-compose up -d

# 方式 B: 手动（macOS）
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
createdb maas_platform

# 3. 初始化数据库
cd server
npx prisma db push
npx prisma generate
npx tsx prisma/seed.ts

# 4. 启动后端
npm run dev
# → http://localhost:3001

# 5. 启动前端（新终端）
cd ../client && npm run dev
# → http://localhost:3000

# 6. 启动管理端（新终端）
cd ../admin-client && npm run dev
# → http://localhost:3002
```

### 8.3 生产部署

```bash
# 一键部署
./deploy.sh

# 或分步操作
./deploy.sh --build    # 构建
./deploy.sh --start    # 启动（PM2）
./deploy.sh --stop     # 停止
./deploy.sh --restart  # 重启
./deploy.sh --status   # 查看状态
./deploy.sh --backup   # 备份数据库
```

### 8.4 环境变量（server/.env）

```env
DATABASE_URL="postgresql://user@host:5432/maas_platform"
JWT_SECRET="随机32位字符串"
JWT_REFRESH_SECRET="随机32位字符串"
API_KEY_ENCRYPTION_KEY="随机32位AES密钥"
REDIS_URL="redis://localhost:6379"
PORT=3001
NODE_ENV=production
```

### 8.5 HTTPS 配置

```bash
# 安装 certbot 获取免费 SSL 证书
certbot --nginx -d your-domain.com
# 证书自动续期
certbot renew --dry-run
```

Nginx 配置文件模板在 `nginx/maas-platform.conf`，支持：
- HTTPS 反向代理
- IP 白名单（管理后台）
- 请求大小限制（512MB，适配模型素材上传）
- 连接限流

---

## 9. 使用指南

### 9.1 测试账号

| 角色 | 账号 | 密码 |
|------|------|------|
| 管理员 | admin@maas.com | admin123 |
| 用户 | user@maas.com | test1234 |

### 9.2 用户操作流程

1. **注册/登录** → 访问用户端 `http://localhost:3000`
2. **申请 API Key** → 进入「Key 管理」→ 点击「申请新 Key」
3. **查看模型列表** → 进入「模型中心」查看可用模型
4. **调用模型** → 用获取的 Key 调用 `/api/v1/generate` 或 OpenAI 兼容接口
5. **查看用量** → 在仪表盘查看调用次数和配额消耗

### 9.3 管理员操作流程

1. **登录管理后台** → 访问 `http://localhost:3002`
2. **配置密钥** → 「系统配置」→ 填写火山引擎 API Key、AK/SK
3. **扫描模型** → 「模型管理」→ 点击「扫描自部署模型」→ 自动发现 Ollama 中的模型
4. **管理用户** → 「用户管理」→ 启用/禁用用户
5. **分配配额** → 「Key 管理」→ 为用户 Key 分配调用额度
6. **审计日志** → 「调用日志」→ 查看所有调用记录

---

## 10. 模型管理

### 10.1 火山引擎模型

系统预置了以下火山引擎模型：

| 平台名称 | 火山模型 ID | 类型 | 功能 |
|---------|------------|------|------|
| seedance2.0 | doubao-seedance-2-0-260128 | 视频生成 | 文生视频/图生视频 |
| seedance2.0-fast | doubao-seedance-2-0-fast-260128 | 视频生成 | 快速版 |
| seedance2.0-mini | doubao-seedance-2-0-mini-260615 | 视频生成 | 轻量版 |
| seedream5.0-pro | doubao-seedream-5-0-pro-260615 | 图片生成 | 高质量图片 |
| seed2.1-vision | doubao-seed-2-1-pro-260628 | 理解 | 视觉理解 |
| seed2.0-audio | doubao-seed-2-0-audio-260615 | 理解 | 音频理解 |

### 10.2 自部署模型自动发现

平台通过**模型同步服务**自动发现本机/服务器上的模型：

**Ollama 模型：**启动时扫描 `http://localhost:11434/api/tags`，发现的模型自动注册
- 命名规则：`ollama/<模型名>`（如 `ollama/gemma4:latest`）
- 根据模型能力自动分类（chat / embedding）

**vLLM / OpenAI 兼容端点：**扫描 `/v1/models`，自动注册
- 命名规则：`vllm/<模型名>` 或自定义标签

**同步频率：**每 60 秒自动检测一次，也可在管理端手动触发

### 10.3 模型生命周期

```
[Ollama 启动模型] → [平台自动检测] → [注册 online] → [用户可见]
                                                    ↓
[Ollama 卸载模型] → [平台检测到消失] → [标记 offline] → [用户不可见]
                                                    ↓
[Ollama 重新加载] → [平台检测到恢复] → [恢复 online] → [用户可见]
```

---

## 11. 安全设计

| 安全措施 | 实现方式 |
|---------|---------|
| **密码存储** | bcrypt 哈希，永不明文 |
| **API Key 存储** | AES-256 加密存储，SHA256 Hash 用于 O(1) 查询鉴权 |
| **JWT 鉴权** | Access Token（1h）+ Refresh Token（7d） |
| **密钥配置** | 火山引擎 API Key、AK/SK 通过管理后台填写，AES 加密存数据库 |
| **登录保护** | 同一 IP+账号 5次/5分钟自动锁定 |
| **验证码限流** | 同一目标 60秒/次 |
| **API 限流** | 全局限流（Redis 后端）+ 按配额扣减 |
| **注册防护** | 可选 Cloudflare Turnstile 人机验证 |
| **管理后台** | 管理员 JWT 鉴权 + 可选 Nginx IP 白名单 |
| **HTTPS** | Nginx 反向代理 + Let's Encrypt 证书 |
| **SQL 注入防护** | Prisma ORM 参数化查询 |
| **敏感信息** | 任何密钥不在日志/错误消息中输出 |

---

## 12. 开发规范

### 12.1 编译检查清单

```
✅ 改 Schema → prisma generate
✅ 改后端路由 → tsc --noEmit
✅ 改前端页面 → tsc --noEmit
✅ 跨层改动 → 完整编译验证
✅ 提交前 → 手动测试登录/注册/CRUD
```

### 12.2 端到端测试命令

```bash
# 后端编译
cd server && npx tsc --noEmit

# 前端编译
cd client && npx tsc --noEmit
cd admin-client && npx tsc --noEmit

# 服务测试
curl http://localhost:3001/api/health  # 健康检查
curl http://localhost:3001/api/v1/models  # 模型列表（公开）
```

---

## 项目文件清单

```
后台管理/
├── server/                        # 后端 API 服务
│   ├── src/
│   │   ├── config/                # 配置（数据库、Redis、环境变量）
│   │   │   ├── index.ts
│   │   │   ├── database.ts
│   │   │   └── redis.ts
│   │   ├── middleware/
│   │   │   └── auth.ts            # JWT、API Key、管理员鉴权
│   │   ├── routes/
│   │   │   ├── auth.ts            # 认证（登录/注册/刷新Token）
│   │   │   ├── user.ts            # 用户信息/密码/绑定
│   │   │   ├── key.ts             # API Key 管理
│   │   │   ├── model.ts           # 模型列表/注册
│   │   │   ├── generate.ts        # 统一模型调用网关
│   │   │   ├── understand.ts      # 理解类接口
│   │   │   ├── files.ts           # 文件上传
│   │   │   ├── assets.ts          # 素材管理（AK/SK）
│   │   │   ├── settings.ts        # 系统配置
│   │   │   ├── openai-compat.ts   # OpenAI 兼容接口
│   │   │   └── admin.ts           # 管理后台
│   │   ├── services/
│   │   │   ├── volcano.ts         # 火山引擎服务（读取密钥）
│   │   │   ├── volcano-signature.ts  # AK/SK HMAC-SHA256 签名
│   │   │   ├── model-sync.ts      # 自部署模型自动检测
│   │   │   └── model-sync-cron.ts # 模型同步定时任务
│   │   ├── utils/
│   │   │   ├── apiKey.ts          # Key 生成/加密/SHA256
│   │   │   ├── crypto.ts          # bcrypt 密码
│   │   │   ├── jwt.ts             # JWT 签发/验证
│   │   │   └── validators.ts      # Zod 表单验证
│   │   └── index.ts               # 服务入口
│   ├── prisma/
│   │   ├── schema.prisma          # 数据库模型
│   │   └── seed.ts                # 种子数据
│   ├── .env                       # 环境变量
│   └── package.json
├── client/                        # 用户端前端
│   └── src/app/
│       ├── login/ register/ dashboard/ models/ keys/ settings/
├── admin-client/                  # 管理端前端
│   └── src/app/
│       ├── login/
│       └── admin/ overview/ users/ keys/ models/ logs/ settings/
├── nginx/
│   └── maas-platform.conf         # Nginx 配置模板
├── ecosystem.config.cjs           # PM2 部署配置
├── deploy.sh                      # 一键部署脚本
├── docker-compose.yml             # Docker 编排
└── README.md
```

---

> 最后更新：2026-07-30
> 开发阶段：Phase 1-6 全部完成 ✅
