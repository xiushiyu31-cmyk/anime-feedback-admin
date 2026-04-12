"use client";

import {
  LayoutDashboard,
  Sparkles,
  PlusCircle,
  FileUp,
  Layers,
  BarChart3,
  Trophy,
  ClipboardCheck,
} from "lucide-react";
import { useMemo } from "react";
import type { MainView } from "@/lib/types/feedback";

type SidebarProps = {
  view: MainView;
  setView: (v: MainView) => void;
  thisWeekCount: number;
  totalCount: number;
  reviewCount?: number;
};

const sidebarItems: Array<{
  key: MainView;
  label: string;
  icon: React.ReactNode;
  subtitle: string;
}> = [
  {
    key: "submit",
    label: "提交新反馈",
    icon: <PlusCircle className="size-4" aria-hidden />,
    subtitle: "粘贴截图 / AI 识别",
  },
  {
    key: "import",
    label: "智能导入中心",
    icon: <FileUp className="size-4" aria-hidden />,
    subtitle: "导入钉钉文档（docx/xlsx）",
  },
  {
    key: "review",
    label: "人工审核",
    icon: <ClipboardCheck className="size-4" aria-hidden />,
    subtitle: "AI 无法判断的内容",
  },
  {
    key: "pool",
    label: "需求池",
    icon: <Layers className="size-4" aria-hidden />,
    subtitle: "列表 / 筛选 / 状态流转",
  },
  {
    key: "ranking",
    label: "总排名",
    icon: <BarChart3 className="size-4" aria-hidden />,
    subtitle: "累计热度排行榜",
  },
  {
    key: "weekly",
    label: "周榜单",
    icon: <Trophy className="size-4" aria-hidden />,
    subtitle: "本周新增需求排名",
  },
];

export function Sidebar({ view, setView, thisWeekCount, totalCount, reviewCount = 0 }: SidebarProps) {
  return (
    <aside className="hidden w-72 shrink-0 lg:block">
      <div className="sticky top-6">
        <div className="rounded-2xl border border-zinc-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
                <Sparkles className="size-4 shrink-0" aria-hidden />
                二次元修图 · 需求统计
              </div>
              <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                管理系统（Supabase + AI）
              </div>
            </div>
            <div className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm">
              <LayoutDashboard className="size-5" aria-hidden />
            </div>
          </div>

          <nav className="mt-4 flex flex-col gap-1">
            {sidebarItems.map((it) => {
              const active = view === it.key;
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => setView(it.key)}
                  className={`group flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition ${
                    active
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  }`}
                >
                  <div
                    className={`mt-0.5 inline-flex size-8 items-center justify-center rounded-lg transition ${
                      active
                        ? "bg-white/15"
                        : "bg-zinc-100 text-violet-700 group-hover:bg-zinc-200 dark:bg-zinc-900 dark:text-violet-300 dark:group-hover:bg-zinc-800"
                    }`}
                  >
                    {it.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {it.label}
                      {it.key === "review" && reviewCount > 0 && (
                        <span className={`inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${active ? "bg-white/25 text-white" : "bg-amber-500 text-white"}`}>
                          {reviewCount}
                        </span>
                      )}
                    </div>
                    <div className={`mt-0.5 truncate text-xs ${active ? "text-white/80" : "text-zinc-500 dark:text-zinc-400"}`}>
                      {it.subtitle}
                    </div>
                  </div>
                </button>
              );
            })}
          </nav>

          <div className="mt-4 rounded-xl border border-zinc-200 bg-white/70 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-300">
            <div className="flex items-center justify-between">
              <span>本周新增</span>
              <span className="font-semibold text-zinc-900 dark:text-zinc-50">{thisWeekCount}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span>总需求</span>
              <span className="font-semibold text-zinc-900 dark:text-zinc-50">{totalCount}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
