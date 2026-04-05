"use client";

import {
  Funnel,
  LayoutDashboard,
  ListTodo,
  MessageSquarePlus,
  ImagePlus,
  X,
  Send,
  Sparkles,
  Trash2,
  Layers,
  Trophy,
  BarChart3,
  PlusCircle,
  FileUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FeedbackStatus = "pending" | "processing" | "done";
type MainView = "submit" | "pool" | "ranking" | "weekly" | "import";

type FeedbackItem = {
  id: string;
  createdAt: string;
  userNickname: string | null;
  operatorName: string | null;
  category: string | null;
  essenceKey: string | null;
  weight: number | null;
  title: string;
  detail: string;
  status: FeedbackStatus;
  screenshotPublicUrl: string | null;
  aiSummary: string | null;
};

type FormState = {
  note: string;
  userNickname: string;
  operatorName: string;
};

const emptyForm: FormState = {
  note: "",
  userNickname: "",
  operatorName: "",
};

const statusLabels: Record<FeedbackStatus, string> = {
  pending: "待处理",
  processing: "处理中",
  done: "已完成",
};

type UiImage = {
  id: string;
  file: File;
  previewUrl: string;
};

function makeId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

async function downscaleImageToJpegDataUrl(
  file: File,
  opts?: { maxW?: number; maxH?: number; quality?: number }
) {
  // 更激进的缩放/压缩以加快视觉模型推理与网络传输
  const maxW = opts?.maxW ?? 896;
  const maxH = opts?.maxH ?? 896;
  const quality = opts?.quality ?? 0.76;

  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  bitmap.close();
  return dataUrl;
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeImportCategory(raw: string | null | undefined) {
  const s = String(raw ?? "").trim();
  if (s === "功能新增" || s === "性能优化" || s === "用户活动" || s === "其他") return s;
  if (s === "二次元新需求" || s === "二次元新功能需求") return "功能新增";
  if (s === "现有功能优化" || s === "现有破次元活动功能优化") return "性能优化";
  if (!s || s === "非二次元需求") return "其他";
  if (s.includes("活动") || s.includes("运营")) return "用户活动";
  if (s.includes("优化") || s.includes("性能") || s.includes("卡") || s.includes("慢")) return "性能优化";
  if (s.includes("新增") || s.includes("支持") || s.includes("增加")) return "功能新增";
  return "其他";
}

function normalizeImportEssence(raw: string | null | undefined) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[【】[\]()（）"'`~!@#$%^&*_+=|\\/:;,.?，。！？、\s-]+/g, "")
    .replace(/(需求|功能|问题|建议|优化|支持|体验|能力|方案|功能点)$/g, "");
}

function candidateImpactScore(weight?: number, feedbackCount?: number | null) {
  const w = Math.max(1, Math.min(10, Math.round(Number(weight ?? 1) || 1)));
  const count = Math.max(1, Math.round(Number(feedbackCount ?? 1) || 1));
  return w + Math.min(8, count - 1);
}

function csvEscapeCell(v: unknown): string {
  const s = String(v ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 导出当前需求池列表（UTF-8 BOM，便于 Excel 打开） */
function exportFeedbackPoolCsv(rows: FeedbackItem[], filenameBase: string) {
  const headers = [
    "id",
    "created_at",
    "status",
    "category",
    "essence_key",
    "weight",
    "title",
    "detail",
    "user_nickname",
    "operator_name",
    "ai_summary",
    "screenshot_url",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscapeCell(r.id),
        csvEscapeCell(r.createdAt),
        csvEscapeCell(r.status),
        csvEscapeCell(r.category),
        csvEscapeCell(r.essenceKey),
        csvEscapeCell(r.weight ?? ""),
        csvEscapeCell(r.title),
        csvEscapeCell(r.detail),
        csvEscapeCell(r.userNickname),
        csvEscapeCell(r.operatorName),
        csvEscapeCell(r.aiSummary),
        csvEscapeCell(r.screenshotPublicUrl),
      ].join(",")
    );
  }
  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase.replace(/[/\\?%*:|"<>]/g, "_")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function FeedbackDashboard() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [images, setImages] = useState<UiImage[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisDone, setAnalysisDone] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    category: "",
    details: "",
    essenceKey: "",
  });
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "all">("all");
  const [origin, setOrigin] = useState<string>("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const [view, setView] = useState<MainView>("pool");
  const [viewTransitioning, setViewTransitioning] = useState(false);
  useEffect(() => {
    setViewTransitioning(true);
    const t = window.setTimeout(() => setViewTransitioning(false), 220);
    return () => window.clearTimeout(t);
  }, [view]);

  const uploadBoxRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pasteArmed, setPasteArmed] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter === "all" ? "" : `?status=${encodeURIComponent(statusFilter)}`;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(`/api/feedback${qs}`, { signal: controller.signal });
      window.clearTimeout(timeout);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { items: any[] };
      setItems(
        (json.items ?? []).map((i) => ({
          id: i.id,
          createdAt: i.created_at,
          userNickname: i.user_nickname,
          operatorName: i.operator_name,
          category: i.category,
          essenceKey: i.essence_key ?? null,
          weight: i.weight ?? null,
          title: i.title,
          detail: i.detail,
          status: i.status,
          screenshotPublicUrl: i.screenshot_public_url,
          aiSummary: i.ai_summary,
        }))
      );
    } catch (e: any) {
      const msg =
        e?.name === "AbortError"
          ? "列表加载超时（20 秒）。请点击“重新拉取列表”，或检查 Supabase 网络连接。"
          : e?.message ?? "加载失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return items;
    return items.filter((i) => i.status === statusFilter);
  }, [items, statusFilter]);

  const normalizeCategory = useCallback((raw: string | null | undefined) => {
    const s = String(raw ?? "").trim();
    if (s === "二次元新功能需求" || s === "现有破次元活动功能优化" || s === "非二次元需求")
      return s;
    if (!s) return "非二次元需求";
    // 兼容历史字段/旧枚举：尽量收敛到三类，避免筛选空白
    if (s.includes("二次元")) return "二次元新功能需求";
    if (s.includes("破次元") || s.includes("优化")) return "现有破次元活动功能优化";
    return "非二次元需求";
  }, []);

  const [categoryFilter, setCategoryFilter] = useState<
    "all" | "二次元新功能需求" | "现有破次元活动功能优化" | "非二次元需求"
  >("all");

  const poolItems = useMemo(() => {
    const base = filtered;
    if (categoryFilter === "all") return base;
    return base.filter((i) => normalizeCategory(i.category) === categoryFilter);
  }, [categoryFilter, filtered, normalizeCategory]);

  const exportPoolCsv = useCallback(() => {
    if (poolItems.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const catSlug =
      categoryFilter === "all"
        ? "all-categories"
        : categoryFilter.replace(/\s+/g, "_").slice(0, 40);
    exportFeedbackPoolCsv(poolItems, `二次元需求池_${statusFilter}_${catSlug}_${stamp}`);
  }, [poolItems, statusFilter, categoryFilter]);

  const aggregateByDemand = useCallback(
    (list: FeedbackItem[]) => {
      const m = new Map<
        string,
        {
          key: string;
          essenceKey: string;
          category: string;
          count: number; // 热度（sum weight）
          latestAt: string;
          sampleScreenshotUrl: string | null;
        }
      >();
      for (const i of list) {
        const essence = (i.essenceKey ?? "").trim() || (i.title ?? "").trim() || "（未命名需求）";
      const category = normalizeCategory(i.category);
      const key = `${category}::${essence}`;
        const w = Number(i.weight ?? 1) || 1;
        const prev = m.get(key);
        if (!prev) {
          m.set(key, {
            key,
            essenceKey: essence,
            category,
            count: w,
            latestAt: i.createdAt,
            sampleScreenshotUrl: i.screenshotPublicUrl ?? null,
          });
        } else {
          prev.count += w;
          if (new Date(i.createdAt).getTime() > new Date(prev.latestAt).getTime()) {
            prev.latestAt = i.createdAt;
            if (i.screenshotPublicUrl) prev.sampleScreenshotUrl = i.screenshotPublicUrl;
          }
        }
      }
      const rows = Array.from(m.values());
      rows.sort((a, b) => b.count - a.count || new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
      return rows;
    },
    [normalizeCategory]
  );

  const counts = useMemo(() => {
    return items.reduce(
      (acc, i) => {
        acc[i.status] += 1;
        acc.all += 1;
        return acc;
      },
      { all: 0, pending: 0, processing: 0, done: 0 }
    );
  }, [items]);

  const weekRange = useMemo(() => {
    const now = new Date();
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(d);
    start.setDate(d.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }, []);

  const thisWeekItems = useMemo(() => {
    return items.filter((i) => {
      const t = new Date(i.createdAt).getTime();
      return t >= weekRange.start.getTime() && t < weekRange.end.getTime();
    });
  }, [items, weekRange.end, weekRange.start]);

  const rankingAll = useMemo(() => aggregateByDemand(items), [aggregateByDemand, items]);
  const rankingWeek = useMemo(
    () => aggregateByDemand(thisWeekItems),
    [aggregateByDemand, thisWeekItems]
  );

  const topCategories = useMemo(() => {
    const allMap = new Map<string, number>();
    const weekMap = new Map<string, number>();
    for (const i of items) {
      const k = (i.category ?? "其他").trim() || "其他";
      allMap.set(k, (allMap.get(k) ?? 0) + 1);
    }
    for (const i of thisWeekItems) {
      const k = (i.category ?? "其他").trim() || "其他";
      weekMap.set(k, (weekMap.get(k) ?? 0) + 1);
    }
    const rows = Array.from(allMap.entries()).map(([category, total]) => ({
      category,
      total,
      week: weekMap.get(category) ?? 0,
    }));
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }, [items, thisWeekItems]);

  const topOperatorsThisWeek = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of thisWeekItems) {
      const k = (i.operatorName ?? "未填写").trim() || "未填写";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    const rows = Array.from(m.entries()).map(([name, count]) => ({ name, count }));
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [thisWeekItems]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      (async () => {
        if (images.length === 0) {
          alert("请先粘贴/上传至少一张截图");
          return;
        }

        setAnalyzing(true);
        setAnalysisError(null);
        setAnalysisDone(false);
        try {
          // 先压缩/缩放截图，避免 base64 太大导致请求很慢
          const dataUrls = await Promise.all(
            images.map((img) => downscaleImageToJpegDataUrl(img.file))
          );

          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 45_000);
          const res = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              note: form.note.trim(),
              images: dataUrls.map((u) => ({ type: "data_url", data_url: u })),
            }),
          });
          window.clearTimeout(timeout);

          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            throw new Error(json?.error ?? `HTTP ${res.status}`);
          }

          const json = (await res.json()) as {
            summary: string;
            category: string;
            details: string;
            userNickname?: string;
            essenceKey?: string;
          };
          setDraft({
            title: json.summary,
            category: json.category,
            details: json.details,
            essenceKey: json.essenceKey?.trim?.() ? json.essenceKey.trim() : "",
          });
          if (json.userNickname && json.userNickname.trim()) {
            setForm((f) => ({ ...f, userNickname: json.userNickname!.trim() }));
          }
          setAnalysisDone(true);
        } finally {
          setAnalyzing(false);
        }
      })().catch((err) => {
        const msg =
          err?.name === "AbortError"
            ? "识别超时（45 秒）。建议减少图片张数或换更小的截图。"
            : err?.message ?? "识别失败";
        setAnalysisError(msg);
        setAnalyzing(false);
      });
    },
    [form.note, images]
  );

  const onSave = useCallback(async () => {
    if (images.length === 0) {
      alert("请先粘贴/上传至少一张截图");
      return;
    }
    if (!form.userNickname.trim() || !form.operatorName.trim()) {
      alert("请填写用户昵称和对应运营官");
      return;
    }
    if (!draft.title.trim() || !draft.category.trim() || !draft.details.trim()) {
      alert("请先完成识别，或手动补全 标题/分类/详细说明");
      return;
    }
    if (!draft.essenceKey.trim()) {
      alert("缺少需求本质（essenceKey）。请重新识别，或手动补全。");
      return;
    }

    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("note", form.note.trim());
      fd.append("user_nickname", form.userNickname.trim());
      fd.append("operator_name", form.operatorName.trim());
      fd.append("title", draft.title.trim());
      fd.append("category", draft.category.trim());
      fd.append("details", draft.details.trim());
      fd.append("essence_key", draft.essenceKey.trim());
      for (const img of images) fd.append("screenshots", img.file);

      const res = await fetch("/api/feedback", { method: "POST", body: fd });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }

      setForm(emptyForm);
      setDraft({ title: "", category: "", details: "", essenceKey: "" });
      setImages((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.previewUrl));
        return [];
      });
      await fetchItems();
    } catch (e: any) {
      alert(e?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }, [draft, fetchItems, form.note, form.operatorName, form.userNickname, images]);

  const updateStatus = useCallback(
    async (id: string, status: FeedbackStatus) => {
      const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      await fetchItems();
    },
    [fetchItems]
  );

  const removeItem = useCallback(
    async (id: string) => {
      if (!confirm("确定删除这条反馈及其截图吗？")) return;
      const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        alert(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      await fetchItems();
    },
    [fetchItems]
  );

  const addFiles = useCallback((files: File[]) => {
    const next: UiImage[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const id = makeId(f);
      const previewUrl = URL.createObjectURL(f);
      next.push({ id, file: f, previewUrl });
    }
    if (next.length === 0) return;
    setImages((prev) => [...prev, ...next]);
  }, []);

  const extractImageFilesFromPaste = useCallback(
    (e: ClipboardEvent | React.ClipboardEvent): File[] => {
    const dt: any = (e as any).clipboardData;
    if (!dt) return [];
    const fromFiles = Array.from(dt.files ?? []).filter(
      (f: any) => typeof f?.type === "string" && f.type.startsWith("image/")
    ) as File[];
    if (fromFiles.length) return fromFiles as File[];
    const items = Array.from(dt.items ?? []);
    const fromItems = items
      .filter((it: any) => it.kind === "file")
      .map((it: any) => it.getAsFile?.())
      .filter(Boolean)
      .filter((f: any) => typeof f?.type === "string" && f.type.startsWith("image/")) as File[];
    return fromItems as File[];
  },
    []
  );

  // 当虚线框获得焦点后，允许全局 Ctrl/Cmd+V 捕获图片
  useEffect(() => {
    if (!pasteArmed) return;
    const handler = (e: ClipboardEvent) => {
      const files = extractImageFilesFromPaste(e);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [addFiles, extractImageFilesFromPaste, pasteArmed]);

  useEffect(() => {
    return () => {
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sidebarItems: Array<{
    key: MainView;
    label: string;
    icon: React.ReactNode;
    subtitle: string;
  }> = useMemo(
    () => [
      {
        key: "submit",
        label: "提交新反馈",
        icon: <PlusCircle className="size-4" aria-hidden />,
        subtitle: "粘贴截图 / GPT-4o 识别",
      },
      {
        key: "import",
        label: "智能导入中心",
        icon: <FileUp className="size-4" aria-hidden />,
        subtitle: "导入钉钉文档（docx/xlsx）",
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
    ],
    []
  );

  return (
    <div className="min-h-[calc(100vh-0px)] bg-gradient-to-b from-violet-50/60 via-white to-white dark:from-violet-950/20 dark:via-zinc-950 dark:to-zinc-950">
      <header className="border-b border-violet-100/70 bg-gradient-to-b from-violet-100/60 via-violet-50/30 to-transparent dark:border-violet-900/30 dark:from-violet-950/40 dark:via-zinc-950 dark:to-transparent">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
                <Sparkles className="size-4 shrink-0" aria-hidden />
                二次元修图 · 需求管理后台
              </div>
              <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                截图粘贴识别入库 · 对照像素蛋糕能力自动分类 · 语义聚合榜单
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white/70 px-3 py-2 text-xs text-zinc-600 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300">
              <div className="flex items-center justify-between gap-6">
                <span>本周范围</span>
                <span className="font-mono text-zinc-900 dark:text-zinc-50">
                  {weekRange.start.toLocaleDateString("zh-CN")} -{" "}
                  {new Date(weekRange.end.getTime() - 1).toLocaleDateString("zh-CN")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
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
                        <div className="text-sm font-semibold">{it.label}</div>
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
                  <span className="font-semibold text-zinc-900 dark:text-zinc-50">{thisWeekItems.length}</span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span>总需求</span>
                  <span className="font-semibold text-zinc-900 dark:text-zinc-50">{counts.all}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">

          <div
            className={`transition-all duration-300 ${
              viewTransitioning ? "opacity-0 -translate-y-1 blur-[1px]" : "opacity-100 translate-y-0 blur-0"
            }`}
          >
            {view === "submit" ? (
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                  <MessageSquarePlus className="size-5 text-violet-500" aria-hidden />
                  提交新反馈
                </h2>
                <form onSubmit={onSubmit} className="flex flex-col gap-4">
                  {/* 复用同一套上传+识别+保存表单 */}
                  <div className="flex flex-col gap-1.5 text-sm">
                    <div className="font-medium text-zinc-700 dark:text-zinc-300">
                      截图粘贴/上传（必填）
                    </div>
                    <div
                      tabIndex={0}
                      ref={uploadBoxRef}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        uploadBoxRef.current?.focus();
                      }}
                      onFocus={() => setPasteArmed(true)}
                      onBlur={() => setPasteArmed(false)}
                      onPaste={(e) => {
                        const files = extractImageFilesFromPaste(e);
                        if (files.length) {
                          e.preventDefault();
                          addFiles(files);
                        }
                      }}
                      className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 outline-none ring-violet-500/30 focus:ring-2 dark:border-zinc-800 dark:bg-zinc-950/40"
                    >
                      <div className="flex items-center justify-between gap-3 text-sm text-zinc-600 dark:text-zinc-300">
                        <div className="flex items-center gap-2">
                          <ImagePlus className="size-4 text-violet-500" aria-hidden />
                          直接在此处粘贴截图 (Ctrl+V) 或点击上传
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            fileInputRef.current?.click();
                          }}
                          className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500"
                        >
                          点击上传
                        </button>
                      </div>

                      {images.length > 0 ? (
                        <div className="grid grid-cols-3 gap-2">
                          {images.map((img) => (
                            <div key={img.id} className="relative">
                              <img
                                src={img.previewUrl}
                                alt="预览"
                                className="h-20 w-full rounded-lg object-cover"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  setImages((prev) => {
                                    const target = prev.find((p) => p.id === img.id);
                                    if (target) URL.revokeObjectURL(target.previewUrl);
                                    return prev.filter((p) => p.id !== img.id);
                                  });
                                }}
                                className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/75"
                                aria-label="删除图片"
                              >
                                <X className="size-4" aria-hidden />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-zinc-300 bg-white/60 px-3 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950/30 dark:text-zinc-400">
                          还没有截图：选择多张，或在聊天里截图后直接粘贴到这里
                        </div>
                      )}

                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const fs = Array.from(e.target.files ?? []);
                          addFiles(fs);
                          e.currentTarget.value = "";
                        }}
                      />
                    </div>
                  </div>

                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      原始文字备注（可选）
                    </span>
                    <textarea
                      rows={4}
                      className="resize-y rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 placeholder:text-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      placeholder="例如：群聊原话、上下文补充（可留空）"
                      value={form.note}
                      onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                    />
                  </label>

                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      用户昵称（识别后自动回填，可修改）
                    </span>
                    <input
                      className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 placeholder:text-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      placeholder="例如：群里发言的修图师昵称"
                      value={form.userNickname}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, userNickname: e.target.value }))
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      运营官（必填）
                    </span>
                    <select
                      className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      value={form.operatorName}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, operatorName: e.target.value }))
                      }
                    >
                      <option value="" disabled>
                        请选择运营官
                      </option>
                      <option value="乌木">乌木</option>
                      <option value="青柠">青柠</option>
                    </select>
                  </label>

                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                    disabled={analyzing}
                  >
                    <Send className="size-4" aria-hidden />
                    {analyzing ? "AI 识别中…" : "识别（GPT-4o Vision）"}
                  </button>

                  {analysisError ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
                      {analysisError}
                    </div>
                  ) : analysisDone ? (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
                      识别完成，已自动回填到下方表单（可修改后保存）。
                    </div>
                  ) : null}

                  <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                      AI 自动回填（可修改）
                    </div>
                    <label className="flex flex-col gap-1.5 text-sm">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        需求标题
                      </span>
                      <input
                        className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 placeholder:text-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        placeholder="识别后自动生成"
                        value={draft.title}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, title: e.target.value }))
                        }
                      />
                    </label>
                    <label className="mt-3 flex flex-col gap-1.5 text-sm">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        分类
                      </span>
                      <input
                        className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 placeholder:text-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        placeholder="识别后自动生成"
                        value={draft.category}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, category: e.target.value }))
                        }
                      />
                    </label>
                    <label className="mt-3 flex flex-col gap-1.5 text-sm">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        详细说明
                      </span>
                      <textarea
                        rows={5}
                        className="resize-y rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 placeholder:text-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        placeholder="识别后自动生成"
                        value={draft.details}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, details: e.target.value }))
                        }
                      />
                    </label>
                    <label className="mt-3 flex flex-col gap-1.5 text-sm">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        需求本质（essenceKey，用于总排名语义聚合）
                      </span>
                      <input
                        className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900 outline-none ring-violet-500/30 placeholder:text-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        placeholder="识别后自动生成，例如：二次元脸型液化 / 背景处理优化"
                        value={draft.essenceKey}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, essenceKey: e.target.value }))
                        }
                      />
                    </label>

                    <button
                      type="button"
                      onClick={onSave}
                      disabled={saving}
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                    >
                      {saving ? "保存中…" : "保存到 Supabase"}
                    </button>
                  </div>
                </form>
              </section>
            ) : view === "import" ? (
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                      <FileUp className="size-5 text-violet-500" aria-hidden />
                      智能导入中心
                    </h2>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                      拖拽上传从钉钉导出的历史需求文档（<span className="font-mono">.docx</span> /{" "}
                      <span className="font-mono">.xlsx</span>）。后续将自动解析图文并生成待审核列表。
                    </p>
                  </div>
                </div>

                <ImportCenter />
              </section>
            ) : view === "pool" ? (
              <div className="flex flex-col gap-4">
                <details className="group rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                        需求池说明（点击展开/收起）
                      </div>
                      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        聚焦下方列表数据；用“状态/分类”快速筛选。
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                        本周 {thisWeekItems.length}
                      </span>
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                        总计 {counts.all}
                      </span>
                    </div>
                  </summary>
                  <div className="mt-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                    <div>
                      - 分类来自 GPT-4o 视觉识别并对照像素蛋糕能力对比，强制归类为三类。
                    </div>
                    <div>
                      - 总排名按 <span className="font-mono">essenceKey</span>（中文需求本质）语义聚合。
                    </div>
                  </div>
                </details>

                <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              <ListTodo className="size-5 text-violet-500" aria-hidden />
              反馈列表
              <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                共 {counts.all} 条
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                <Funnel className="size-3.5" aria-hidden />
                状态
              </span>
              {(["all", "pending", "processing", "done"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatusFilter(key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    statusFilter === key
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  }`}
                >
                  {key === "all"
                    ? `全部 (${counts.all})`
                    : `${statusLabels[key]} (${counts[key]})`}
                </button>
              ))}

              <span className="ml-1 hidden h-4 w-px bg-zinc-200 dark:bg-zinc-800 sm:block" />
              <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                分类
              </span>
              {(
                [
                  "all",
                  "二次元新功能需求",
                  "现有破次元活动功能优化",
                  "非二次元需求",
                ] as const
              ).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategoryFilter(key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    categoryFilter === key
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  }`}
                >
                  {key === "all" ? "全部" : key}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate">
                  当前访问地址：<span className="font-mono">{origin || "（未获取）"}</span>
                </div>
                <div className="truncate">
                  数据接口：{" "}
                  <a
                    className="font-mono text-violet-700 underline underline-offset-2 dark:text-violet-300"
                    href="/api/feedback?status=all"
                    target="_blank"
                    rel="noreferrer"
                  >
                    /api/feedback?status=all
                  </a>
                </div>
              </div>
              <button
                type="button"
                onClick={() => fetchItems()}
                className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                重新拉取列表
              </button>
              <button
                type="button"
                onClick={exportPoolCsv}
                disabled={poolItems.length === 0}
                className="inline-flex items-center justify-center rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-900/40 dark:bg-violet-950/40 dark:text-violet-200 dark:hover:bg-violet-950/60"
              >
                导出 CSV（当前筛选）
              </button>
            </div>
          </div>

          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-8 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : loading && poolItems.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 bg-white px-6 py-16 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
              加载中…
            </div>
          ) : poolItems.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/80 px-6 py-16 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-400">
              暂无记录。左侧提交一条反馈开始汇总需求。
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {poolItems.map((item) => (
                <li
                  key={item.id}
                  className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                          {item.title}
                        </h3>
                        <span className="rounded-md bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                          {item.category ?? "其他"}
                        </span>
                      </div>

                      {item.screenshotPublicUrl ? (
                        <img
                          src={item.screenshotPublicUrl}
                          alt="用户截图"
                          className="mt-3 h-32 w-full rounded-lg object-cover"
                        />
                      ) : null}

                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                        {item.detail || "（无备注）"}
                      </p>

                      {item.aiSummary ? (
                        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
                          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            AI 总结
                          </div>
                          <div className="whitespace-pre-wrap">{item.aiSummary}</div>
                        </div>
                      ) : (
                        <div className="mt-3 text-xs text-zinc-400">暂无 AI 总结</div>
                      )}

                      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-500">
                        <div>
                          <dt className="inline">标签：</dt>
                          <dd className="inline text-zinc-700 dark:text-zinc-300">
                            {item.category ?? "其他"}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline">时间：</dt>
                          <dd className="inline text-zinc-700 dark:text-zinc-300">
                            {new Date(item.createdAt).toLocaleString("zh-CN")}
                          </dd>
                        </div>
                        <div className="text-zinc-700 dark:text-zinc-300">
                          用户：{item.userNickname ?? "未填写"} | 运营官：{item.operatorName ?? "未填写"}
                        </div>
                      </dl>
                    </div>
                    <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                      <label className="flex flex-col gap-1 text-xs text-zinc-500">
                        <span>处理状态</span>
                        <select
                          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                          value={item.status}
                          onChange={(e) => {
                            const next = e.target.value as FeedbackStatus;
                            updateStatus(item.id, next).catch((err) => {
                              alert(err?.message ?? "更新失败");
                            });
                          }}
                        >
                          {(Object.keys(statusLabels) as FeedbackStatus[]).map((s) => (
                            <option key={s} value={s}>
                              {statusLabels[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeItem(item.id).catch((err) => alert(err?.message ?? "删除失败"))}
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-900 dark:hover:bg-red-950/50 dark:hover:text-red-300"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        删除
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
                </section>
              </div>
            ) : view === "ranking" ? (
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                    <BarChart3 className="size-5 text-violet-500" aria-hidden />
                    总排名
                  </h2>
                  <button
                    type="button"
                    onClick={() => fetchItems()}
                    className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    刷新数据
                  </button>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
                    <div className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                      累计热度排行榜（按出现次数聚合）
                    </div>
                    {rankingAll.length === 0 ? (
                      <div className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        暂无数据
                      </div>
                    ) : (
                      <ol className="flex flex-col gap-2">
                        {rankingAll.slice(0, 20).map((r, idx) => (
                          <li
                            key={r.key}
                            className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              {r.sampleScreenshotUrl ? (
                                <img
                                  src={r.sampleScreenshotUrl}
                                  alt="典型案例截图"
                                  className="h-11 w-16 shrink-0 rounded-lg object-cover ring-1 ring-zinc-200 dark:ring-zinc-800"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="h-11 w-16 shrink-0 rounded-lg bg-zinc-100 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800" />
                              )}
                              <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex size-6 items-center justify-center rounded-lg bg-zinc-100 text-xs font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                                  {idx + 1}
                                </span>
                                <div className="truncate font-semibold text-zinc-900 dark:text-zinc-50">
                                  {r.essenceKey}
                                </div>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                                <span className="rounded-md bg-violet-100 px-1.5 py-0.5 font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                                  {r.category}
                                </span>
                                <span>
                                  最近：{new Date(r.latestAt).toLocaleDateString("zh-CN")}
                                </span>
                              </div>
                              </div>
                            </div>
                            <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-semibold text-white">
                              {r.count}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
                    <div className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                      分类分布（总量 / 本周）
                    </div>
                    {topCategories.length === 0 ? (
                      <div className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        暂无数据
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {topCategories.slice(0, 10).map((r) => (
                          <li
                            key={r.category}
                            className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-zinc-900 dark:text-zinc-50">
                                {r.category}
                              </div>
                              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                本周 {r.week} · 总计 {r.total}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                                {r.total}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            ) : (
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                    <Trophy className="size-5 text-violet-500" aria-hidden />
                    周榜单
                  </h2>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    本周新增 {thisWeekItems.length} 条
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    {rankingWeek.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/80 px-6 py-16 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-400">
                        本周暂无新增需求。去「需求池」提交一条开始汇总。
                      </div>
                    ) : (
                      <ol className="flex flex-col gap-3">
                        {rankingWeek.slice(0, 20).map((r, idx) => (
                          <li
                            key={r.key}
                            className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex size-6 items-center justify-center rounded-lg bg-zinc-100 text-xs font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                                    {idx + 1}
                                  </span>
                                  <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                                    {r.essenceKey}
                                  </div>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                                  <span>
                                    最近：{new Date(r.latestAt).toLocaleString("zh-CN")}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                                  {r.category}
                                </span>
                                <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-semibold text-white">
                                  {r.count}
                                </span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                      本周分类榜
                    </div>
                    {topCategories.length === 0 ? (
                      <div className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        暂无数据
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {topCategories
                          .filter((r) => r.week > 0)
                          .sort((a, b) => b.week - a.week)
                          .slice(0, 8)
                          .map((r) => (
                            <li
                              key={r.category}
                              className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/30"
                            >
                              <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">
                                {r.category}
                              </span>
                              <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-semibold text-white">
                                {r.week}
                              </span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

const IMPORT_PARSE_LS = "anime_feedback_import_parse_v1";

function isDomAbortError(e: unknown): boolean {
  if (e instanceof Error && e.name === "AbortError") return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError")
    return true;
  return false;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
  });
}

function ImportCenter() {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedImages, setParsedImages] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [importSessionId, setImportSessionId] = useState<string | null>(null);
  const importSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    importSessionIdRef.current = importSessionId;
  }, [importSessionId]);
  const [importTotalRows, setImportTotalRows] = useState(0);
  const parseCancelRequestedRef = useRef(false);
  const importParseChainAbortRef = useRef<AbortController | null>(null);
  /** 自动分段解析当前轮次（仅 xlsx 链式请求时使用） */
  const [importAutoRound, setImportAutoRound] = useState(0);
  const [importLineProgress, setImportLineProgress] = useState({ done: 0, total: 0, lastRow: null as number | null });
  const [parseCanResume, setParseCanResume] = useState(false);
  const seenImportIdsRef = useRef<Set<string>>(new Set());
  /** 流式 item 批量入账，避免每条 setState 卡死主线程（大表关键） */
  type ImportCandRow = {
    id: string;
    item_id?: string;
    sub_index?: number;
    row_index?: number;
    date?: string;
    essence_key: string;
    original_text: string;
    feedback_summary?: string;
    image_url?: string | null;
    feedback_count?: number | null;
    weight?: number;
    category: string;
    keywords?: string[];
    tags?: string[];
    is_invalid?: boolean;
    image_index: number | null;
    selected: boolean;
  };
  const importCandPendingRef = useRef<ImportCandRow[]>([]);
  const importCandRafRef = useRef<number | null>(null);

  const resetImportCandidateBuffer = useCallback(() => {
    importCandPendingRef.current = [];
    if (importCandRafRef.current != null) {
      cancelAnimationFrame(importCandRafRef.current);
      importCandRafRef.current = null;
    }
  }, []);

  const persistImportLs = useCallback((sid: string, total: number, next: number) => {
    try {
      localStorage.setItem(
        IMPORT_PARSE_LS,
        JSON.stringify({ sessionId: sid, totalRows: total, nextIndex: next, updatedAt: Date.now() })
      );
    } catch {
      // ignore
    }
  }, []);

  const clearImportCheckpoint = useCallback(() => {
    try {
      localStorage.removeItem(IMPORT_PARSE_LS);
    } catch {
      // ignore
    }
    setImportSessionId(null);
    setImportTotalRows(0);
    setParseCanResume(false);
    seenImportIdsRef.current.clear();
    setProgressText("");
    setProgress(0);
    resetImportCandidateBuffer();
  }, [resetImportCandidateBuffer]);

  const resetForReimport = useCallback(() => {
    // 彻底清空当前导入状态：用于“重新导入分析”
    try {
      localStorage.removeItem(IMPORT_PARSE_LS);
    } catch {
      /* ignore */
    }
    parseCancelRequestedRef.current = false;
    importParseChainAbortRef.current?.abort();
    importParseChainAbortRef.current = null;

    setFiles([]);
    setCandidates([]);
    setParsedImages([]);
    resetImportCandidateBuffer();
    seenImportIdsRef.current.clear();

    setParseError(null);
    setCommitResult(null);
    setParseCanResume(false);
    setImportSessionId(null);
    setImportTotalRows(0);
    setImportLineProgress({ done: 0, total: 0, lastRow: null });
    setImportAutoRound(0);
    setProgressText("");
    setProgress(0);
    setParsing(false);
  }, [resetImportCandidateBuffer]);

  const deleteSelectedCandidates = useCallback(() => {
    setCandidates((prev) => prev.filter((x) => !x.selected));
  }, []);

  const deleteAllCandidates = useCallback(() => {
    setCandidates([]);
  }, []);

  const applySuggestedMerge = useCallback((ids: string[], essenceKey: string) => {
    const idSet = new Set(ids);
    setCandidates((prev) => prev.map((x) => (idSet.has(x.id) ? { ...x, essence_key: essenceKey } : x)));
  }, []);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(IMPORT_PARSE_LS);
        if (!raw) return;
        const j = JSON.parse(raw) as { sessionId?: string };
        if (!j.sessionId) return;
        const ac = new AbortController();
        const t = window.setTimeout(() => ac.abort(), 12_000);
        const res = await fetch(`/api/import/session?id=${encodeURIComponent(j.sessionId)}`, {
          signal: ac.signal,
        });
        window.clearTimeout(t);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const s = data?.session;
        if (res.ok && s && s.status === "active" && s.next_index < s.total_rows) {
          setImportSessionId(s.id);
          setImportTotalRows(s.total_rows);
          setParseCanResume(true);
          setProgressText(
            `检测到未完成的导入：服务端已记录进度约 ${s.next_index}/${s.total_rows} 行，可直接点「继续解析」（无需再选文件）。`
          );
          setProgress(s.total_rows > 0 ? clamp01(s.next_index / s.total_rows) : 0);
        } else {
          localStorage.removeItem(IMPORT_PARSE_LS);
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  const [candidates, setCandidates] = useState<ImportCandRow[]>([]);

  const displayCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      const impactDiff =
        candidateImpactScore(b.weight, b.feedback_count) -
        candidateImpactScore(a.weight, a.feedback_count);
      if (impactDiff !== 0) return impactDiff;
      const mentionDiff =
        Math.max(1, Math.round(Number(b.feedback_count ?? 1) || 1)) -
        Math.max(1, Math.round(Number(a.feedback_count ?? 1) || 1));
      if (mentionDiff !== 0) return mentionDiff;
      return (a.row_index ?? 0) - (b.row_index ?? 0);
    });
  }, [candidates]);

  const importInsights = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        category: string;
        ids: string[];
        itemCount: number;
        selectedCount: number;
        totalMentions: number;
        totalImpact: number;
        keywords: Set<string>;
        variants: Map<string, { mentions: number; score: number }>;
      }
    >();

    let selectedCount = 0;
    let highPriorityCount = 0;
    let totalMentions = 0;

    for (const c of candidates) {
      const category = normalizeImportCategory(c.category);
      const normalizedEssence = normalizeImportEssence(c.essence_key);
      const mentionCount = Math.max(1, Math.round(Number(c.feedback_count ?? 1) || 1));
      const impact = candidateImpactScore(c.weight, c.feedback_count);
      const key = `${category}::${normalizedEssence || c.essence_key.trim() || c.id}`;

      totalMentions += mentionCount;
      if (c.selected) selectedCount += 1;
      if ((c.weight ?? 0) >= 8 || mentionCount >= 5 || impact >= 10) highPriorityCount += 1;

      const prev = groups.get(key);
      if (!prev) {
        groups.set(key, {
          key,
          category,
          ids: [c.id],
          itemCount: 1,
          selectedCount: c.selected ? 1 : 0,
          totalMentions: mentionCount,
          totalImpact: impact,
          keywords: new Set((c.keywords ?? []).slice(0, 6)),
          variants: new Map([[c.essence_key.trim() || "待命名需求", { mentions: mentionCount, score: impact }]]),
        });
      } else {
        prev.ids.push(c.id);
        prev.itemCount += 1;
        prev.totalMentions += mentionCount;
        prev.totalImpact += impact;
        if (c.selected) prev.selectedCount += 1;
        for (const kw of c.keywords ?? []) {
          if (prev.keywords.size < 8) prev.keywords.add(kw);
        }
        const variantKey = c.essence_key.trim() || "待命名需求";
        const variantPrev = prev.variants.get(variantKey);
        if (variantPrev) {
          variantPrev.mentions += mentionCount;
          variantPrev.score += impact;
        } else {
          prev.variants.set(variantKey, { mentions: mentionCount, score: impact });
        }
      }
    }

    const grouped = Array.from(groups.values())
      .map((g) => {
        const recommendedEssence =
          Array.from(g.variants.entries()).sort(
            (a, b) =>
              b[1].mentions - a[1].mentions ||
              b[1].score - a[1].score ||
              a[0].length - b[0].length
          )[0]?.[0] ?? "待命名需求";
        return {
          ...g,
          recommendedEssence,
          keywords: Array.from(g.keywords),
        };
      })
      .sort((a, b) => b.totalImpact - a.totalImpact || b.totalMentions - a.totalMentions);

    return {
      selectedCount,
      highPriorityCount,
      totalMentions,
      duplicateGroups: grouped.filter((g) => g.itemCount > 1).slice(0, 5),
      topGroups: grouped.slice(0, 5),
    };
  }, [candidates]);

  const flushImportCandidateBuffer = useCallback(() => {
    importCandRafRef.current = null;
    const batch = importCandPendingRef.current;
    if (batch.length === 0) return;
    importCandPendingRef.current = [];
    setCandidates((prev) => [...prev, ...batch]);
  }, []);

  const scheduleImportCandidateFlush = useCallback(() => {
    if (importCandRafRef.current != null) return;
    importCandRafRef.current = requestAnimationFrame(() => flushImportCandidateBuffer());
  }, [flushImportCandidateBuffer]);
  const [operatorName, setOperatorName] = useState<"" | "乌木" | "青柠">("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string>("");
  const [progress, setProgress] = useState(0);

  const cancelParseReading = useCallback(() => {
    parseCancelRequestedRef.current = true;
    importParseChainAbortRef.current?.abort();
  }, []);

  const addFiles = useCallback((next: File[]) => {
    const filtered = next.filter((f) => {
      const name = (f.name || "").toLowerCase();
      return name.endsWith(".docx") || name.endsWith(".xlsx");
    });
    if (filtered.length === 0) return;
    setFiles((prev) => [...prev, ...filtered]);
  }, []);

  const startParse = useCallback(
    async (mode: "start" | "continue" = "start") => {
      const isContinue = mode === "continue";

      if (isContinue) {
        if (!importSessionId) {
          setParseError("没有可续传的会话。请先上传 xlsx 开始解析，或刷新页面后根据提示恢复。");
          return;
        }
      } else if (files.length === 0) {
        return;
      }

      setParsing(true);
      setParseError(null);
      setCommitResult(null);

      if (!isContinue) {
        setProgressText("");
        setProgress(0);
        resetImportCandidateBuffer();
        setCandidates([]);
        setParsedImages([]);
        seenImportIdsRef.current.clear();
        setParseCanResume(false);
        try {
          localStorage.removeItem(IMPORT_PARSE_LS);
        } catch {
          /* ignore */
        }
        setImportSessionId(null);
        setImportTotalRows(0);
        setImportLineProgress({ done: 0, total: 0, lastRow: null });
        setImportAutoRound(0);
      } else {
        setProgressText((prev) => prev || "正在从断点继续解析…");
      }

      try {
        parseCancelRequestedRef.current = false;
        const chainAc = new AbortController();
        importParseChainAbortRef.current = chainAc;

        const runXlsxStream = async (
          fd: FormData,
          round: number,
          sidRef: { current: string | null },
          chainSignal: AbortSignal
        ): Promise<{
          isFinished: boolean;
          fatal: boolean;
          lastRow: number | null;
          userCancelled?: boolean;
        }> => {
          const outcome: {
            isFinished: boolean;
            fatal: boolean;
            lastRow: number | null;
            userCancelled?: boolean;
          } = { isFinished: false, fatal: false, lastRow: null };
          const merged = new AbortController();
          const chainAbortHandler = () => merged.abort();
          chainSignal.addEventListener("abort", chainAbortHandler);
          const timeout = window.setTimeout(() => merged.abort(), 240_000);
          const cleanupRound = () => {
            window.clearTimeout(timeout);
            chainSignal.removeEventListener("abort", chainAbortHandler);
          };

          let res: Response;
          try {
            try {
              res = await fetch("/api/import/parse-stream", {
                method: "POST",
                body: fd,
                signal: merged.signal,
              });
            } catch (e: unknown) {
              if (isDomAbortError(e)) {
                if (parseCancelRequestedRef.current) {
                  outcome.userCancelled = true;
                } else {
                  outcome.fatal = true;
                  setParseError(
                    "单轮请求超时（240s），已停止自动解析。请检查网络后点「继续解析」重试。"
                  );
                }
              } else {
                outcome.fatal = true;
                const msg = e instanceof Error ? e.message : "网络请求失败";
                setParseError(msg);
              }
              return outcome;
            }
            if (!res.ok || !res.body) {
              outcome.fatal = true;
              const t = (await res.text().catch(() => "")).trim().slice(0, 800);
              setParseError(t || `HTTP ${res.status}`);
              return outcome;
            }

          const reader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buf = "";

          const pushCandidate = (it: any) => {
            const rowIndex = Number(it?.row_index);
            const essence = String(it?.essence_key ?? "").trim();
            const cat = String(it?.category ?? "").trim();
            const orig = String(it?.original_text ?? "").trim();
            const date = String(it?.date ?? "").trim();
            const sum = String(it?.feedback_summary ?? "").trim();
            const imgUrl = it?.image_url ? String(it.image_url).trim() : "";
            const feedbackCount = Number.isFinite(Number(it?.feedback_count))
              ? Math.max(1, Math.round(Number(it.feedback_count)))
              : null;
            const weight = Number.isFinite(Number(it?.weight)) ? Number(it.weight) : 3;
            const itemId = String(it?.item_id ?? "").trim();
            const subIndex = Number.isFinite(Number(it?.sub_index)) ? Number(it.sub_index) : null;
            const invalid = Boolean(it?.is_invalid ?? it?.invalid);
            const keywords = Array.isArray(it?.keywords)
              ? it.keywords.map((x: any) => String(x ?? "").trim()).filter(Boolean)
              : [];
            const tags = Array.isArray(it?.tags)
              ? it.tags.map((x: any) => String(x ?? "").trim()).filter(Boolean)
              : [];
            if (!Number.isFinite(rowIndex) || !essence || !orig) return;
            // 同一 row_index 可能拆出多条：优先使用 item_id 去重
            const id = itemId || `row-${rowIndex}-${subIndex ?? "n"}-${essence.slice(0, 10)}`;
            if (seenImportIdsRef.current.has(id)) return;
            seenImportIdsRef.current.add(id);
            // 无效条目默认不展示（但仍会计入后端进度/断点）
            if (invalid) return;
            importCandPendingRef.current.push({
              id,
              item_id: itemId || undefined,
              sub_index: subIndex ?? undefined,
              row_index: rowIndex,
              date,
              essence_key: essence,
              original_text: orig,
              feedback_summary: sum,
              image_url: imgUrl || null,
              feedback_count: feedbackCount,
              weight,
              category: cat,
              keywords,
              tags,
              is_invalid: invalid,
              image_index: null,
              selected: true,
            });
            scheduleImportCandidateFlush();
          };

          try {
            while (true) {
              let chunk: ReadableStreamReadResult<Uint8Array>;
              try {
                chunk = await reader.read();
              } catch (readErr: unknown) {
                if (parseCancelRequestedRef.current && isDomAbortError(readErr)) {
                  outcome.userCancelled = true;
                  break;
                }
                outcome.fatal = true;
                const msg =
                  readErr instanceof Error ? readErr.message : "读取响应流失败（网络可能中断）";
                setParseError(msg);
                break;
              }
              const { done, value } = chunk;
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              while (true) {
                const sep = buf.indexOf("\n\n");
                if (sep === -1) break;
                const sub = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                const lines = sub.split("\n");
                let event = "message";
                let dataLine = "";
                for (const ln of lines) {
                  if (ln.startsWith("event:")) event = ln.slice(6).trim();
                  if (ln.startsWith("data:")) dataLine += ln.slice(5).trim();
                }
                if (!dataLine) continue;
                let payload: any = null;
                try {
                  payload = JSON.parse(dataLine);
                } catch {
                  payload = null;
                }
                if (!payload) continue;
                if (event === "item") {
                  pushCandidate(payload);
                  continue;
                }
                if (event === "meta") {
                  const totalR = Number(payload.total_rows ?? 0);
                  const procR = Number(payload.processed_rows ?? 0);
                  const excelRow =
                    payload.last_processed_row != null && payload.last_processed_row !== ""
                      ? Number(payload.last_processed_row)
                      : null;
                  if (payload.session_id) {
                    const sid = String(payload.session_id);
                    sidRef.current = sid;
                    setImportSessionId(sid);
                  }
                  if (totalR > 0) {
                    setImportTotalRows(totalR);
                  }
                  if (payload.stage === "reading") {
                    setProgressText(`第 ${round} 轮：正在读取 Excel…`);
                    setProgress(0);
                  } else if (payload.stage === "queued") {
                    setProgressText(
                      `第 ${round} 轮：已载入表格，有效行约 ${payload.total_rows ?? "?"}（将自动连续分段直至完成）`
                    );
                    setProgress(0);
                    setImportLineProgress({
                      done: Number(payload.next_index ?? 0),
                      total: totalR,
                      lastRow: null,
                    });
                    if (payload.session_id != null && payload.total_rows != null) {
                      persistImportLs(
                        String(payload.session_id),
                        Number(payload.total_rows),
                        Number(payload.next_index ?? 0)
                      );
                    }
                  } else if (payload.stage === "progress") {
                    const fb = Number(payload.fallback_batches ?? 0);
                    const lr = excelRow != null && Number.isFinite(excelRow) ? excelRow : null;
                    setImportLineProgress({ done: procR, total: totalR, lastRow: lr });
                    setProgressText(
                      `正在使用 GPT-4o 解析中（第 ${round} 轮）：已完成 ${procR}/${totalR} 行（本段批次 ${payload.done_batches}/${payload.total_batches}，累计条目 ${payload.done_items ?? 0}）${lr != null ? ` · Excel 约至第 ${lr} 行` : ""}${fb > 0 ? ` · 规则兜底 ${fb}` : ""}`
                    );
                    setProgress(totalR > 0 ? clamp01(procR / totalR) : 0);
                    if (payload.session_id != null && totalR > 0) {
                      persistImportLs(String(payload.session_id), totalR, procR);
                    }
                  } else if (payload.stage === "paused") {
                    const fb = Number(payload.fallback_batches ?? 0);
                    const lr = excelRow != null && Number.isFinite(excelRow) ? excelRow : null;
                    setParseCanResume(false);
                    setImportLineProgress({ done: procR, total: totalR, lastRow: lr });
                    outcome.lastRow = lr ?? outcome.lastRow;
                    setProgressText(
                      `正在使用 GPT-4o 解析中（第 ${round} 轮）：本段已达单次上限，已处理 ${procR}/${totalR} 行${lr != null ? `（Excel 约 ${lr} 行）` : ""}，将自动开始下一轮…${fb > 0 ? ` 规则兜底 ${fb}` : ""}`
                    );
                    setProgress(totalR > 0 ? clamp01(procR / totalR) : 0);
                    if (payload.session_id != null && totalR > 0) {
                      persistImportLs(String(payload.session_id), totalR, procR);
                    }
                  } else if (payload.stage === "done") {
                    const fb = Number(payload.fallback_batches ?? 0);
                    const finished = Boolean(payload.is_finished ?? payload.complete);
                    const complete = Boolean(payload.complete);
                    const lr = excelRow != null && Number.isFinite(excelRow) ? excelRow : null;
                    outcome.isFinished = finished;
                    outcome.lastRow = lr ?? outcome.lastRow;
                    setImportLineProgress({
                      done: procR,
                      total: totalR,
                      lastRow: lr,
                    });
                    if (complete || finished) {
                      setParseCanResume(false);
                      try {
                        localStorage.removeItem(IMPORT_PARSE_LS);
                      } catch {
                        /* ignore */
                      }
                      setProgress(1);
                      setImportAutoRound(0);
                      setProgressText(
                        `全部完成（共 ${round} 轮）：条目 ${payload.done_items ?? 0} 条${fb > 0 ? `（规则兜底 ${fb}）` : ""}`
                      );
                    } else {
                      setParseCanResume(false);
                      setProgress(totalR > 0 ? clamp01(procR / totalR) : 0);
                      setProgressText(
                      `GPT-4o 解析中：第 ${round} 轮结束，已处理 ${procR}/${totalR} 行，条目 ${payload.done_items ?? 0} 条${lr != null ? ` · Excel 约 ${lr} 行` : ""}，即将自动续传…${fb > 0 ? ` · 规则兜底 ${fb}` : ""}`
                      );
                      if (payload.session_id != null && totalR > 0) {
                        persistImportLs(String(payload.session_id), totalR, procR);
                      }
                    }
                  }
                  continue;
                }
                if (event === "warning") {
                  const w = String(payload?.message ?? payload?.error ?? "").trim();
                  if (w) {
                    setProgressText((prev) => (prev ? `${prev}｜${w}` : w));
                  }
                  continue;
                }
                if (event === "error") {
                  outcome.fatal = true;
                  outcome.isFinished = true;
                  setParseError(payload.error ?? "解析失败");
                  continue;
                }
              }
            }
          } finally {
            if (importCandRafRef.current != null) {
              cancelAnimationFrame(importCandRafRef.current);
              importCandRafRef.current = null;
            }
            flushImportCandidateBuffer();
          }
          } finally {
            cleanupRound();
          }
          return outcome;
        };

        const isXlsxJob =
          isContinue || (files[0] && files[0].name.toLowerCase().endsWith(".xlsx"));
        if (isXlsxJob) {
          const sidRef = { current: isContinue ? importSessionId : null };
          const MAX_AUTO_ROUNDS = 5000;
          for (let round = 1; round <= MAX_AUTO_ROUNDS; round++) {
            setImportAutoRound(round);
            const fd = new FormData();
            if (round === 1 && !isContinue) {
              fd.append("file", files[0]!);
            } else {
              if (!sidRef.current) {
                setParseError("自动续传失败：未拿到 session_id，请重新上传文件或检查 Supabase 配置。");
                break;
              }
              fd.append("resume", "true");
              fd.append("sessionId", sidRef.current);
            }
            const seg = await runXlsxStream(fd, round, sidRef, chainAc.signal);
            if (seg.userCancelled) {
              setProgressText(
                "已取消读取。若服务端已记录进度，可点「继续解析」从断点接着跑。"
              );
              setParseCanResume(!!importSessionIdRef.current);
              setImportAutoRound(0);
              break;
            }
            if (seg.fatal) {
              setParseCanResume(true);
              break;
            }
            if (seg.isFinished) {
              break;
            }
            if (round === MAX_AUTO_ROUNDS) {
              setParseError(
                "自动解析轮数达到上限（5000），已停止。若未跑完全表，请点「继续解析」从断点接着跑。"
              );
              setParseCanResume(true);
              break;
            }
            setProgressText(
              (prev) =>
                `${prev ? `${prev} · ` : ""}第 ${round} 轮分段已完成${seg.lastRow != null ? `（Excel 约 ${seg.lastRow} 行）` : ""}，约 0.5 秒后自动开始第 ${round + 1} 轮…`
            );
            try {
              await abortableSleep(480, chainAc.signal);
            } catch {
              if (parseCancelRequestedRef.current) {
                setProgressText(
                  "已取消读取。若服务端已记录进度，可点「继续解析」从断点接着跑。"
                );
                setParseCanResume(!!importSessionIdRef.current);
              }
              setImportAutoRound(0);
              break;
            }
          }
          setImportAutoRound(0);
          return;
        }

        const f = files[0];
        const name = (f.name || "").toLowerCase();

        // docx：非流式（含图文）
        const fd = new FormData();
        fd.append("file", f);
        const mergedDocx = new AbortController();
        const chainAbortDocx = () => mergedDocx.abort();
        chainAc.signal.addEventListener("abort", chainAbortDocx);
        const docxTimeout = window.setTimeout(() => mergedDocx.abort(), 90_000);
        try {
          const res = await fetch("/api/import/parse", {
            method: "POST",
            body: fd,
            signal: mergedDocx.signal,
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
          const imgs = Array.isArray(json?.images) ? json.images : [];
          const items = Array.isArray(json?.items) ? json.items : [];
          setParsedImages(imgs);
          setCandidates(
            items.map((it: any, idx: number) => ({
              id: `cand-${idx}-${String(it?.essence_key ?? "").slice(0, 12)}-${String(it?.image_index ?? "n")}`,
              essence_key: String(it?.essence_key ?? "").trim(),
              original_text: String(it?.original_text ?? "").trim(),
              category: String(it?.category ?? "").trim(),
              feedback_count: null,
              image_index:
                it?.image_index === null || it?.image_index === undefined || it?.image_index === ""
                  ? null
                  : Number(it.image_index),
              selected: true,
            }))
          );
        } catch (docxErr: unknown) {
          if (isDomAbortError(docxErr) && parseCancelRequestedRef.current) {
            setProgressText("已取消读取。");
            return;
          }
          throw docxErr;
        } finally {
          window.clearTimeout(docxTimeout);
          chainAc.signal.removeEventListener("abort", chainAbortDocx);
        }
      } catch (e: unknown) {
        if (isDomAbortError(e) && parseCancelRequestedRef.current) {
          setProgressText(
            importSessionIdRef.current
              ? "已取消读取。若服务端已记录进度，可点「继续解析」从断点接着跑。"
              : "已取消读取。"
          );
          setParseCanResume(!!importSessionIdRef.current);
          return;
        }
        const name = e && typeof e === "object" && "name" in e ? String((e as Error).name) : "";
        const msg =
          name === "AbortError"
            ? "请求超时，请缩短单次内容或稍后重试。"
            : e instanceof Error
              ? e.message
              : "解析失败";
        setParseError(msg);
      } finally {
        importParseChainAbortRef.current = null;
        setParsing(false);
      }
  },
    [
      files,
      importSessionId,
      persistImportLs,
      resetImportCandidateBuffer,
      flushImportCandidateBuffer,
      scheduleImportCandidateFlush,
    ]
  );

  const commitImport = useCallback(async () => {
    const picked = candidates.filter((c) => c.selected);
    if (picked.length === 0) {
      setCommitResult("请选择至少一条需要导入的记录。");
      return;
    }
    setCommitting(true);
    setCommitResult(null);
    try {
      const body = {
        operatorName: operatorName || undefined,
        items: picked.map((c) => ({
          essence_key: c.essence_key,
          original_text: c.original_text,
          category: c.category,
          weight: Number(c.weight ?? 1) === 5 ? 5 : 1,
          image_data_url:
            c.image_index !== null && parsedImages[c.image_index]
              ? parsedImages[c.image_index]
              : null,
          image_url: c.image_url || null,
        })),
      };
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const sql = json?.sql ? `\n需要你在 Supabase 执行：\n${json.sql}` : "";
        throw new Error((json?.error ?? `HTTP ${res.status}`) + sql);
      }
      setCommitResult(`导入成功：新增 ${json?.created ?? 0} 条`);
    } catch (e: any) {
      setCommitResult(e?.message ?? "导入失败");
    } finally {
      setCommitting(false);
    }
  }, [candidates, operatorName, parsedImages]);

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          const dropped = Array.from(e.dataTransfer?.files ?? []);
          addFiles(dropped);
        }}
        className={`rounded-2xl border border-dashed p-6 transition ${
          dragging
            ? "border-violet-400 bg-violet-50/70 dark:border-violet-500 dark:bg-violet-950/20"
            : "border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/30"
        }`}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-800">
            <FileUp className="size-6 text-violet-600 dark:text-violet-300" aria-hidden />
          </div>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            拖拽上传文档到这里
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            支持 <span className="font-mono">.docx</span> / <span className="font-mono">.xlsx</span>
          </div>

          <label className="mt-2 inline-flex cursor-pointer items-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500">
            选择文件
            <input
              type="file"
              accept=".docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              multiple
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                addFiles(picked);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            待导入文件
            <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {files.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setFiles([])}
            disabled={files.length === 0}
            className="inline-flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            清空
          </button>
        </div>

        {files.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-zinc-300 bg-zinc-50/80 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/30 dark:text-zinc-400">
            还没有选择文档。把钉钉导出的 <span className="font-mono">.docx</span> /{" "}
            <span className="font-mono">.xlsx</span> 拖进来即可。
            {parseCanResume && importSessionId ? (
              <div className="mt-3 text-violet-600 dark:text-violet-300">
                检测到<strong>未完成的 xlsx 解析</strong>，无需再选文件即可点下方「继续解析」。
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {files.map((f, idx) => (
              <li
                key={`${f.name}-${f.size}-${f.lastModified}-${idx}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold text-zinc-900 dark:text-zinc-50">
                    {f.name}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {(f.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                  className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            支持：docx 图文抽取（含内嵌图片）/ xlsx 分段解析与断点续传（大表无需手动拆分）。
            {importSessionId && importTotalRows > 0 ? (
              <span className="mt-1 block text-violet-600 dark:text-violet-300">
                当前续传会话：{importSessionId.slice(0, 8)}…（约 {importTotalRows} 行有效数据）
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {parseCanResume && importSessionId ? (
              <button
                type="button"
                onClick={() => clearImportCheckpoint()}
                disabled={parsing}
                className="inline-flex items-center justify-center rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
              >
                放弃断点
              </button>
            ) : null}
            {parsing ? (
              <button
                type="button"
                onClick={cancelParseReading}
                className="inline-flex items-center justify-center rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-950/70"
              >
                取消读取
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => startParse(parseCanResume && importSessionId ? "continue" : "start")}
              disabled={
                parsing ||
                (!(parseCanResume && importSessionId) && files.length === 0)
              }
              className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950"
            >
              {parsing ? "解析中…" : parseCanResume && importSessionId ? "继续解析" : "开始解析"}
            </button>
          </div>
        </div>

        {parseError ? (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
            {parseError}
          </div>
        ) : null}

        {parsing || progressText ? (
          <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
            {importAutoRound > 0 ? (
              <div className="mb-1.5 font-semibold text-zinc-800 dark:text-zinc-100">
                {importLineProgress.total > 0
                  ? `正在使用 GPT-4o 解析中…（第 ${importAutoRound} 轮）已完成 ${importLineProgress.done}/${importLineProgress.total} 行${
                      importLineProgress.lastRow != null
                        ? `（Excel 约 ${importLineProgress.lastRow} 行）`
                        : ""
                    }`
                  : `正在使用 GPT-4o 解析中…（第 ${importAutoRound} 轮）`}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 truncate">
                {progressText || "AI 处理中：正在读取表格并调用模型…"}
              </div>
              {parsing ? (
                <div className="shrink-0 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                  AI 处理中…
                </div>
              ) : null}
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-2 rounded-full bg-violet-600 transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {candidates.length > 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              待审核列表（{candidates.length}）
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                value={operatorName}
                onChange={(e) => setOperatorName(e.target.value as any)}
              >
                <option value="">（可选）归属运营官</option>
                <option value="乌木">乌木</option>
                <option value="青柠">青柠</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  setCandidates((prev) => prev.map((x) => ({ ...x, selected: true })))
                }
                className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                全选
              </button>
              <button
                type="button"
                onClick={() =>
                  setCandidates((prev) => prev.map((x) => ({ ...x, selected: false })))
                }
                className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                全不选
              </button>
              <button
                type="button"
                onClick={deleteSelectedCandidates}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                删除已选
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteAllCandidates();
                }}
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200 dark:hover:bg-red-950/50"
              >
                全选删除
              </button>
              <button
                type="button"
                onClick={resetForReimport}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
              >
                重新导入分析
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">待导入条目</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {importInsights.selectedCount}/{candidates.length}
              </div>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">高优先级候选</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {importInsights.highPriorityCount}
              </div>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">覆盖历史反馈数</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {importInsights.totalMentions}
              </div>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">疑似重复组</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {importInsights.duplicateGroups.length}
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">智能洞察</div>
              <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                {importInsights.topGroups.map((g, idx) => (
                  <div
                    key={g.key}
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate font-medium">
                        {idx + 1}. {g.recommendedEssence}
                      </div>
                      <div className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                        热度 {g.totalImpact}
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {g.category} · 条目 {g.itemCount} · 历史反馈 {g.totalMentions}
                      {g.keywords.length > 0 ? ` · 关键词 ${g.keywords.slice(0, 4).join("、")}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">建议合并</div>
              {importInsights.duplicateGroups.length === 0 ? (
                <div className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                  暂未发现明显重复的需求关键词。
                </div>
              ) : (
                <div className="mt-3 flex flex-col gap-3">
                  {importInsights.duplicateGroups.map((g) => (
                    <div
                      key={g.key}
                      className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-sm text-zinc-800 dark:text-zinc-100">
                          建议将 {g.itemCount} 条同类需求统一为
                          <span className="ml-1 font-semibold text-violet-700 dark:text-violet-300">
                            {g.recommendedEssence}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => applySuggestedMerge(g.ids, g.recommendedEssence)}
                          className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100 dark:border-violet-900/40 dark:bg-violet-950/30 dark:text-violet-200 dark:hover:bg-violet-950/50"
                        >
                          一键统一
                        </button>
                      </div>
                      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {g.category} · 历史反馈 {g.totalMentions}
                        {g.keywords.length > 0 ? ` · 关键词 ${g.keywords.slice(0, 5).join("、")}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <ul className="mt-4 flex flex-col gap-3">
            {displayCandidates.map((c) => {
              const img =
                c.image_url ||
                (c.image_index !== null ? parsedImages[c.image_index] : null);
              return (
                <li
                  key={c.id}
                  className={`rounded-2xl border p-4 transition ${
                    c.selected
                      ? "border-violet-200 bg-violet-50/40 dark:border-violet-900/40 dark:bg-violet-950/10"
                      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={c.selected}
                      onChange={(e) =>
                        setCandidates((prev) =>
                          prev.map((x) => (x.id === c.id ? { ...x, selected: e.target.checked } : x))
                        )
                      }
                    />
                    {img ? (
                      <img
                        src={img}
                        alt="关联配图"
                        className="h-16 w-24 shrink-0 rounded-xl object-cover ring-1 ring-zinc-200 dark:ring-zinc-800"
                      />
                    ) : (
                      <div className="h-16 w-24 shrink-0 rounded-xl bg-zinc-100 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {c.date ? <span>日期：{c.date}</span> : null}
                        {typeof c.row_index === "number" ? (
                          <span className="font-mono">行号：{c.row_index}</span>
                        ) : null}
                        {typeof c.sub_index === "number" ? (
                          <span className="font-mono">子项：{c.sub_index}</span>
                        ) : null}
                        {c.category ? (
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              normalizeImportCategory(c.category) === "功能新增"
                                ? "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-200"
                                : normalizeImportCategory(c.category) === "性能优化"
                                  ? "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
                                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                            }`}
                          >
                            {normalizeImportCategory(c.category)}
                          </span>
                        ) : null}
                        {typeof c.weight === "number" ? (
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              c.weight >= 5
                                ? "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-200"
                                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200"
                            }`}
                          >
                            权重 {c.weight}
                          </span>
                        ) : null}
                        {typeof c.feedback_count === "number" ? (
                          <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/30 dark:text-sky-200">
                            历史反馈 {c.feedback_count}
                          </span>
                        ) : null}
                        {c.feedback_summary ? (
                          <span className="truncate">总结：{c.feedback_summary}</span>
                        ) : null}
                        {Array.isArray(c.keywords) && c.keywords.length > 0 ? (
                          <span className="truncate">关键词：{c.keywords.slice(0, 6).join("、")}</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setCandidates((prev) => prev.filter((x) => x.id !== c.id))}
                          className="ml-auto rounded-lg border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          删除
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className="min-w-[10rem] flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 outline-none ring-violet-500/30 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                          value={c.essence_key}
                          onChange={(e) =>
                            setCandidates((prev) =>
                              prev.map((x) =>
                                x.id === c.id ? { ...x, essence_key: e.target.value } : x
                              )
                            )
                          }
                        />
                        <select
                          className="rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                          value={c.category}
                          onChange={(e) =>
                            setCandidates((prev) =>
                              prev.map((x) =>
                                x.id === c.id ? { ...x, category: e.target.value } : x
                              )
                            )
                          }
                        >
                          <option value="功能新增">功能新增</option>
                          <option value="性能优化">性能优化</option>
                          <option value="用户活动">用户活动</option>
                          <option value="其他">其他</option>
                          <option value="二次元新需求">二次元新需求</option>
                          <option value="现有功能优化">现有功能优化</option>
                          <option value="二次元新功能需求">二次元新功能需求</option>
                          <option value="现有破次元活动功能优化">现有破次元活动功能优化</option>
                          <option value="非二次元需求">非二次元需求</option>
                        </select>
                      </div>
                      <textarea
                        rows={3}
                        className="mt-2 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none ring-violet-500/30 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        value={c.original_text}
                        onChange={(e) =>
                          setCandidates((prev) =>
                            prev.map((x) =>
                              x.id === c.id ? { ...x, original_text: e.target.value } : x
                            )
                          )
                        }
                      />
                      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                        关联图片索引：{c.image_index === null ? "无" : c.image_index}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              确认导入后：图片会上传到 Supabase Storage（screenshots），数据写入 feedback_submissions。
            </div>
            <button
              type="button"
              onClick={commitImport}
              disabled={committing}
              className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {committing ? "导入中…" : "确认导入"}
            </button>
          </div>

          {commitResult ? (
            <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-200">
              {commitResult}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
