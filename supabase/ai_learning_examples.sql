-- AI 学习示例表：存储用户对 AI 分类/标题的修正记录
-- 用于在后续 AI 分析时注入 few-shot 示例，提升准确率
-- 在 Supabase SQL Editor 执行

create table if not exists public.ai_learning_examples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  original_text text not null,
  ai_essence_key text not null,
  ai_category text not null,
  corrected_essence_key text not null,
  corrected_category text not null,

  correction_type text not null default 'both'
    check (correction_type in ('category', 'essence_key', 'both'))
);

create index if not exists ai_learning_examples_created_at_idx
  on public.ai_learning_examples (created_at desc);

alter table public.ai_learning_examples enable row level security;

create policy "public read ai_learning_examples"
on public.ai_learning_examples for select
to anon, authenticated
using (true);

create policy "public insert ai_learning_examples"
on public.ai_learning_examples for insert
to anon, authenticated
with check (true);
