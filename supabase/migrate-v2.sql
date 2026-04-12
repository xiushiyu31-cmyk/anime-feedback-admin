-- 迁移脚本：将旧版 feedback_submissions 升级到当前代码所需结构
-- 在 Supabase SQL Editor 执行，幂等安全

-- 1. 添加新列（IF NOT EXISTS 保证幂等）
alter table public.feedback_submissions add column if not exists user_nickname text;
alter table public.feedback_submissions add column if not exists operator_name text;
alter table public.feedback_submissions add column if not exists essence_key text;
alter table public.feedback_submissions add column if not exists weight int not null default 1;
alter table public.feedback_submissions add column if not exists ai_model text;
alter table public.feedback_submissions add column if not exists ai_error text;

-- 2. screenshot_bucket：确保 NOT NULL + 默认值，并 backfill 历史 null
update public.feedback_submissions
  set screenshot_bucket = 'screenshots'
  where screenshot_bucket is null;

alter table public.feedback_submissions
  alter column screenshot_bucket set default 'screenshots';

alter table public.feedback_submissions
  alter column screenshot_bucket set not null;

-- 3. 如果旧表有 nickname 列但没有 user_nickname，迁移数据
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'feedback_submissions'
      and column_name = 'nickname'
  ) then
    update public.feedback_submissions
      set user_nickname = nickname
      where user_nickname is null and nickname is not null;
  end if;
end $$;

-- 4. 移除旧版 priority 的 CHECK 约束（如果存在）
-- detail 和 title 保留 NOT NULL 但允许空字符串
do $$
begin
  alter table public.feedback_submissions drop constraint if exists feedback_submissions_priority_check;
exception when undefined_object then null;
end $$;

-- 5. 添加 needs_review 列
alter table public.feedback_submissions add column if not exists needs_review boolean not null default false;
