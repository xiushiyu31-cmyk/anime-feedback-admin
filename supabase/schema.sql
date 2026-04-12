-- 在 Supabase：SQL Editor → New query → 粘贴执行
-- 文档：https://supabase.com/docs/guides/database/overview

create extension if not exists "pgcrypto";

create table if not exists public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  user_nickname text,
  operator_name text,
  category text,
  essence_key text,
  weight int not null default 1,
  title text not null,
  detail text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done')),

  screenshot_bucket text not null default 'screenshots',
  screenshot_path text,
  screenshot_public_url text,

  needs_review boolean not null default false,

  ai_summary text,
  ai_model text,
  ai_error text
);

create index if not exists feedback_submissions_created_at_idx
  on public.feedback_submissions (created_at desc);

create index if not exists feedback_submissions_status_idx
  on public.feedback_submissions (status);

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

alter table public.feedback_submissions enable row level security;

create policy "public read submissions"
on public.feedback_submissions for select
to anon, authenticated
using (true);

-- ---------- Storage（截图）----------
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

create policy "Public read screenshots"
on storage.objects for select
using (bucket_id = 'screenshots');

-- ---------- 智能导入断点续传（大 xlsx）----------
-- 另见：同目录 import_parse_sessions.sql（表 import_parse_sessions + 桶 import-temp）
