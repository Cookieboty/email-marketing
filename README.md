# Email Marketing Platform

自托管的营销邮件平台，基于 Next.js 15 (App Router + API Routes) + TypeScript + PostgreSQL + Prisma + Resend API。

## 技术栈

| 层 | 选型 |
|----|------|
| 前端 | Next.js 15 (App Router), React 19, Tailwind CSS, shadcn/ui, TanStack Table, react-hook-form + zod, SWR |
| 服务端 | Next.js API Routes, Prisma ORM, PostgreSQL 16 |
| 邮件 | Resend API + svix（webhook 签名校验） |
| 后台任务 | 独立 Worker 进程（`tsx scripts/worker.ts`）+ node-cron + PostgreSQL advisory lock |
| 测试 | Vitest（单元 + 集成）+ Playwright（E2E） |
| 容器化 | docker-compose（本地 Postgres + Mailpit） |

## 部署模型（重要约束）

**本期采用单实例部署**：
- 1 个 Web 实例 + 1 个 Worker 实例
- 限流（登录、测试发送、自定义事件 API）使用 **进程内 `Map` + 时间窗口**
- Worker 单实例由 `pg_try_advisory_lock` 保证

如需未来水平扩展（多 Web 实例 / 多 Worker），必须新增独立 phase 引入 Redis 或数据库支持的限流与队列方案，**本期不实现**。

## 快速开始

### 1. 安装依赖

```bash
# 推荐用 corepack 锁定 pnpm 版本
corepack enable
pnpm install
```

### 2. 准备本地服务

```bash
cp .env.example .env
# 按需填写 ADMIN_TOKEN / SESSION_SECRET / RESEND_*

pnpm db:up               # 启动 PostgreSQL（仅 postgres 容器）
pnpm db:up:all           # 同时启动 Mailpit（http://localhost:8025）
```

### 3. 数据库迁移与种子（Phase 1 完成后可用）

```bash
pnpm prisma:migrate      # 开发环境：prisma migrate dev
pnpm prisma:generate     # 生成 @prisma/client 类型
# 生产环境必须使用：pnpm prisma:deploy（即 prisma migrate deploy）
```

### 4. 启动 Web 与 Worker

```bash
# 终端 1
pnpm dev                 # http://localhost:8000  

# 终端 2（Phase 0 仅骨架，仅打印日志）
pnpm worker:dev
```

## 测试

```bash
pnpm test                # Vitest（单元 + 集成）
pnpm test:watch          # Vitest watch 模式
pnpm test:e2e            # Playwright E2E（需先 pnpm dev）
pnpm typecheck           # 仅类型检查（tsc --noEmit）
pnpm lint                # ESLint
```

## 数据库迁移策略（强约束）

| 场景 | 命令 |
|------|------|
| 开发环境（创建并应用 migration） | `pnpm prisma:migrate` |
| 生产环境（仅应用已有 migration） | `pnpm prisma:deploy` |
| **禁止使用** | ~~`prisma db push`~~ ❌ 绕过 migration 历史，无法回滚 |

任何 schema 变更都必须以 migration 文件提交进版本库。

## 故障排查

### Worker advisory lock 卡死
当 worker 进程异常退出而未释放锁时，下次启动会拒绝。手动清理：

```sql
-- 在 Postgres 中执行（hashtext('email_worker') 必须与 worker.ts 中的 key 一致）
SELECT pg_advisory_unlock(hashtext('email_worker'));
```

或直接重启 Postgres 容器：

```bash
pnpm db:down && pnpm db:up
```

### macOS 资源建议
Docker Desktop 至少分配 4GB 内存。如 `pnpm db:up` 启动失败，检查 5432 端口冲突：

```bash
lsof -i :5432
```

## 项目结构

```
.
├── app/                  # Next.js App Router 路由（页面 + API）
├── components/           # shadcn/ui 组件 + 业务组件
├── lib/                  # 工具与业务模块（认证、模板引擎、Resend 封装等）
├── prisma/               # schema、migration、seed（Phase 1 创建）
├── scripts/
│   └── worker.ts         # 独立 Worker 进程入口
├── tests/
│   ├── unit/             # Vitest 单元测试
│   ├── integration/      # Vitest 集成测试（API + Prisma）
│   ├── e2e/              # Playwright 端到端测试
│   └── setup.ts          # 测试环境初始化
├── docs/superpowers/     # 规范（specs）+ 实施计划（plans）
├── docker-compose.yml    # 本地 Postgres + Mailpit
├── .env.example          # 环境变量样板（含 4 个 RATE_LIMIT_*）
└── package.json
```

## 实施计划

详见 `docs/superpowers/plans/README.md`，按 Phase 0 → Phase 7 顺序推进。
