-- 智能导入：断点续传（在 Supabase SQL Editor 执行一次）
-- 1) 私有临时文件桶（仅服务端 service_role 可读写）
insert into storage.buckets (id, name, public)
values ('import-temp', 'import-temp', false)
on conflict (id) do nothing;

-- 2) 解析会话表
create table if not exists public.import_parse_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  storage_path text not null,
  original_filename text,
  total_rows int not null default 0,
  next_index int not null default 0,
  status text not null default 'active' check (status in ('active', 'completed', 'failed')),
  last_processed_excel_row int
);

create index if not exists import_parse_sessions_status_idx
  on public.import_parse_sessions (status);

alter table public.import_parse_sessions enable row level security;

-- 无面向 anon 的 policy：仅服务端用 service_role 访问（绕过 RLS）
