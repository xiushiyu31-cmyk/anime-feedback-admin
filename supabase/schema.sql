-- 在 Supabase：SQL Editor → New query → 粘贴执行
-- 文档：https://supabase.com/docs/guides/database/overview

create extension if not exists "pgcrypto";

-- 反馈单：截图存 Storage 路径，AI 总结存文本（可后续加 JSON 元数据）
create table if not exists public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  nickname text,
  contact text,
  category text,
  title text not null,
  detail text not null,
  priority text not null default 'normal' check (priority in ('normal', 'urgent')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done')),

  -- Storage：bucket 内对象路径，例如 screenshots/2025/03/xxx.png
  screenshot_bucket text not null default 'screenshots',
  screenshot_path text,

  -- 公网访问 URL（可选，服务端上传后可用 getPublicUrl 写入，或仅用 path + 临时签名 URL）
  screenshot_public_url text,

  -- AI
  ai_summary text,
  ai_model text,
  ai_error text
);

create index if not exists feedback_submissions_created_at_idx
  on public.feedback_submissions (created_at desc);

create index if not exists feedback_submissions_status_idx
  on public.feedback_submissions (status);

-- updated_at 自动刷新（需已启用 supabase 常见写法）
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists feedback_submissions_set_updated_at on public.feedback_submissions;
create trigger feedback_submissions_set_updated_at
before update on public.feedback_submissions
for each row execute function public.set_updated_at();

-- RLS：先开启；具体策略按你的认证方式再收紧（匿名上传见下方说明）
alter table public.feedback_submissions enable row level security;

-- 开发阶段示例（生产请改为登录用户 或 仅服务端 service_role）
-- 允许匿名只读列表（管理后台若只用 service_role 查库，可删掉下列 policy）
create policy "public read submissions"
on public.feedback_submissions for select
to anon, authenticated
using (true);

-- 若希望浏览器直连 Supabase 插入，可打开下一行 policy（风险：任何人可写）。
-- 更安全做法：关闭 insert policy，只在 Next.js API 里用 service_role 插入。
-- create policy "public insert submissions"
-- on public.feedback_submissions for insert
-- to anon, authenticated
-- with check (true);

-- ---------- Storage（截图）----------
-- 也可在 Dashboard → Storage → New bucket 创建，名称与表里 screenshot_bucket 一致：screenshots
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

-- 公开读截图（bucket 设为 public 时，配合下列 policy 供前端展示）
create policy "Public read screenshots"
on storage.objects for select
using (bucket_id = 'screenshots');

-- 匿名/用户直传才需要 insert policy；仅服务端 service_role 上传时可删去下列 policy
-- create policy "Authenticated upload screenshots"
-- on storage.objects for insert
-- to authenticated
-- with check (bucket_id = 'screenshots');

-- ---------- 智能导入断点续传（大 xlsx）----------
-- 另见：同目录 import_parse_sessions.sql（表 import_parse_sessions + 桶 import-temp）
