# 二次元修图 · 需求管理后台

基于 **Next.js 16 (App Router)** + **Supabase** + **AI (OpenAI 兼容)** 构建的内部工具，用于像素蛋糕（PixCake）二次元 / 修图产品的用户需求收集、分类和排名。

## 核心功能

- **截图 + AI 识别**：粘贴社群截图，GPT-4o 自动识别并结构化需求
- **需求池管理**：CRUD、状态流转、筛选、CSV 导出
- **总排名 / 周榜**：按分类和权重语义聚合，自动生成热度排行
- **文档导入**：支持 docx / xlsx，流式解析 + 断点续传
- **企业微信群聊自动抓取**：Playwright 自动化脚本定时扫描群消息
- **实时更新**：通过 Supabase Realtime 订阅表变更，前端自动刷新
- **基础认证**：密码保护管理后台

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 16 (App Router, React 19, TypeScript) |
| 样式 | Tailwind CSS v4, Lucide React |
| 数据库 | Supabase (PostgreSQL + Storage + Realtime) |
| AI | OpenAI 兼容协议 (GPT-4o / GPT-5.4) |
| 自动化 | Playwright (企业微信群聊抓取脚本) |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.local.example`（或直接编辑 `.env.local`）：

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

AI_BASE_URL=https://api.example.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=gpt-4o

ADMIN_PASSWORD=your_admin_password
```

### 3. 初始化数据库

在 Supabase SQL Editor 中执行：

```bash
supabase/schema.sql          # 首次建表
supabase/migrate-v2.sql      # 从旧版升级（幂等安全）
```

### 4. 启动开发服务器

```bash
npm run dev          # localhost:3000
npm run dev:lan      # 0.0.0.0:3001（局域网访问）
```

### 5. 企业微信群聊抓取（可选）

```bash
npm run wechat:capture             # dry-run 模式
npm run wechat:capture:submit      # 正式提交模式
```

## 项目结构

```
src/
├── app/
│   ├── api/
│   │   ├── auth/         # 登录认证 API
│   │   ├── feedback/     # 需求 CRUD API
│   │   ├── analyze/      # AI 分析 API
│   │   └── import/       # 文档导入 API（parse/commit/session）
│   └── login/            # 登录页面
├── components/
│   ├── feedback-dashboard.tsx  # 主仪表盘
│   ├── DetailDrawer.tsx        # 需求详情抽屉
│   └── layout/
│       └── Sidebar.tsx         # 侧边栏导航
├── hooks/
│   └── useRealtimeFeedback.ts  # Supabase Realtime 订阅
├── lib/
│   ├── ai/
│   │   └── analyze-feedback.ts # AI 分析核心逻辑
│   ├── constants/
│   │   └── categories.ts       # 统一分类体系
│   ├── supabase/
│   │   ├── client.ts           # 前端 Supabase 客户端
│   │   └── server.ts           # 服务端 Supabase 客户端
│   └── types/
│       └── feedback.ts         # 共享类型定义
├── middleware.ts               # 认证中间件
scripts/
├── wechat-demand-capture.mjs   # 企业微信群聊自动抓取
└── evaluate-platform-analysis.mjs
supabase/
├── schema.sql                  # 数据库建表 SQL
└── migrate-v2.sql              # v2 迁移脚本
```

## 分类体系

统一四分类：

1. **现有破次元功能优化** — 已有破次元功能的效果/体验改进
2. **破次元新功能需求** — 新的二次元/破次元向功能
3. **软件非破次元功能需求** — 通用修图、工具、付费等
4. **用户其他反馈** — 活动建议、表扬、疑问等
