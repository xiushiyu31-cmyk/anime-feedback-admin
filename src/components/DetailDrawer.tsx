"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import type { FeedbackItem } from "@/lib/types/feedback";
import { statusLabels } from "@/lib/types/feedback";
import { getCategoryColorClass } from "@/lib/constants/categories";

type DetailDrawerProps = {
  item: FeedbackItem | null;
  onClose: () => void;
};

export function DetailDrawer({ item, onClose }: DetailDrawerProps) {
  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [item, onClose]);

  if (!item) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            需求详情
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                item.status === "done"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200"
                  : item.status === "processing"
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
                    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              }`}
            >
              {statusLabels[item.status]}
            </span>
            {item.category && (
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${getCategoryColorClass(item.category)}`}>
                {item.category}
              </span>
            )}
            {item.weight != null && (
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                item.weight >= 5
                  ? "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-200"
                  : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200"
              }`}>
                权重 {item.weight}
              </span>
            )}
          </div>

          <h3 className="mt-4 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {item.title}
          </h3>

          {item.essenceKey && (
            <div className="mt-3">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">本质需求</div>
              <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">{item.essenceKey}</div>
            </div>
          )}

          {item.aiSummary && item.aiSummary !== item.title && (
            <div className="mt-3">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">AI 摘要</div>
              <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">{item.aiSummary}</div>
            </div>
          )}

          <div className="mt-4">
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">详细内容</div>
            <div className="mt-1 whitespace-pre-wrap rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-200">
              {item.detail || "（无详细内容）"}
            </div>
          </div>

          {item.screenshotPublicUrl && (
            <div className="mt-4">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">截图</div>
              <a href={item.screenshotPublicUrl} target="_blank" rel="noopener noreferrer">
                <img
                  src={item.screenshotPublicUrl}
                  alt="反馈截图"
                  className="mt-1 max-h-80 rounded-xl border border-zinc-200 object-contain dark:border-zinc-800"
                />
              </a>
            </div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3 text-xs text-zinc-500 dark:text-zinc-400">
            <div>
              <div className="font-medium">用户昵称</div>
              <div className="mt-0.5 text-zinc-800 dark:text-zinc-200">{item.userNickname || "—"}</div>
            </div>
            <div>
              <div className="font-medium">运营官</div>
              <div className="mt-0.5 text-zinc-800 dark:text-zinc-200">{item.operatorName || "—"}</div>
            </div>
            <div>
              <div className="font-medium">创建时间</div>
              <div className="mt-0.5 text-zinc-800 dark:text-zinc-200">
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </div>
            </div>
            <div>
              <div className="font-medium">ID</div>
              <div className="mt-0.5 truncate font-mono text-zinc-800 dark:text-zinc-200">{item.id}</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
