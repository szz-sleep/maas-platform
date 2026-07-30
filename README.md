# MaaS 模型服务平台

统一大模型服务平台（Model as a Service），整合自部署模型集群与火山引擎模型，提供统一的 API 调用接口、用户管理系统、资源配额控制和可视化后台。

**一 KEY 通用，一平台调用所有模型。**

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端框架 | Fastify (Node.js) |
| 数据库 ORM | Prisma 7 + PostgreSQL 16 |
| 缓存 | Redis 7 |
| 鉴权 | JWT (用户) + API Key HMAC (模型调用) |
| 前端框架 | Next.js 16 + React 19 |
| 样式 | Tailwind CSS 4 + Lucide Icons |
| 状态管理 | Zustand + React Query |

## 项目结构

```
后台管理/
├── server/              # 后端服务
│   ├── src/
│   │   ├── config/      # 配置（数据库、Redis、环境变量）
│   │   ├── middleware/   # 中间件（JWT、API Key、管理员鉴权）
│   │   ├── routes/       # 路由（认证、用户、Key、模型、管理员）
│   │   ├── utils/        # 工具函数（加密、JWT、Key生成、表单验证）
│   │   └── index.ts      # 入口文件
│   ├── prisma/
│   │   ├── schema.prisma # 数据库模型定义
│   │   └── seed.ts       # 种子数据
│   └── package.json
├── client/              # 前端应用
│   ├── src/
│   │   ├── app/          # Next.js App Router 页面
│   │   │   ├── login/         # 登录页
│   │   │   ├── register/      # 注册页
│   │   │   ├── dashboard/     # 用户仪表盘
│   │   │   ├── models/         # 模型中心
│   │   │   ├── keys/          # Key 管理
│   │   │   ├── settings/      # 用户设置
│   │   │   └── admin/         # 管理后台
│   │   ├── components/   # 组件（布局、侧边栏）
│   │   └── lib/          # 工具（API 客户端、Zustand Store）
│   └── package.json
├── docker-compose.yml   # Docker 编排
├── init-db/             # 数据库初始化脚本
└── platform_architecture.md  # 架构设计文档
```

## 快速开始

### 1. 环境要求

- Node.js 20+
- PostgreSQL 16
- Redis 7
- （或使用 Docker Compose）

### 2. 启动数据库

**方式 A：Docker Compose（推荐）**
```bash
docker-compose up -d
```

**方式 B：手动安装**
```bash
bash init-db/setup.sh
```

### 3. 初始化数据库

```bash
cd server
npx prisma db push        # 创建表
npx prisma generate       # 生成客户端
npx tsx prisma/seed.ts    # 加载种子数据
```

### 4. 启动后端

```bash
cd server
npm run dev
# 服务运行在 http://localhost:3001
```

### 5. 启动前端

```bash
cd client
npm run dev
# 前端运行在 http://localhost:3000
```

## 测试账号

| 角色 | 账号 | 密码 |
|------|------|------|
| 管理员 | admin@maas.com | admin123 |
| 用户 | user@maas.com | test1234 |

测试 API Key：`mks-test-key-for-development-00000000`（配额已激活）

## 核心 API

### 模型调用

```bash
curl -X POST http://localhost:3001/api/v1/generate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance2.0-text2video",
    "prompt": "一只可爱的樱花树下的猫，电影感"
  }'
```

### 认证

```bash
# 发送验证码
POST /api/v1/auth/send-code
# 注册
POST /api/v1/auth/register
# 登录
POST /api/v1/auth/login
```

详见 `platform_architecture.md`。

## 开发阶段

- [x] Phase 1：基础设施（Docker Compose、Prisma、数据库设计）
- [x] Phase 2：后端核心（认证、Key管理、消息路由、调用日志）
- [x] Phase 3：前端开发（所有用户端 + 管理端页面）
- [x] Phase 4：管理后台（数据大屏、用户/Key/模型管理、调用审计）
- [x] 🔍 代码审查&修复（2026-07-29，详见下方审查记录）
- [ ] Phase 5：火山引擎集成（AK/SK完整签名、素材代理、限流增强）
- [ ] Phase 6：部署优化（Nginx 反向代理、PM2、HTTPS、备份验证）

### 🔍 代码审查修复记录（2026-07-29）

对 Phase 1-4 已完成代码进行全面审查，修复 20+ 问题：

| 类别 | 数量 | 关键改动 |
|------|------|----------|
| 🔴 安全漏洞 | 4 | 绑定邮箱/手机加验证码校验；注销账户改为密码验证；注册字段 superRefine 校验；启动密钥默认值告警/拦截 |
| 🔴 性能炸弹 | 1 | API Key 全表解密扫描 → keyHash SHA256 O(1) 查询 |
| 🔴 功能缺失 | 2 | 注册 @fastify/multipart + @fastify/swagger 插件；understand 路由写入 modelId |
| 🟡 中等 | 15+ | 登录支持用户名；验证码60秒限流；计费从模型配置读取；模型ID映射表；stream 返回400；管理员路由保护；pending_quota 状态限制；删除Key外键异常处理；设置页历史明文兼容；delete 配置静默吞错修复；dashboard loading/error 处理；JSON解析异常处理；refresh_token 清理等 |

**编译验证：** 后端 0 错误 / 前端 0 错误（tsc --noEmit ✅）  
**数据库：** Schema 新增 ApiKey.keyHash 字段，已有数据已回填