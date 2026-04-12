export const CATEGORIES = [
  "现有破次元功能优化",
  "破次元新功能需求",
  "软件非破次元功能需求",
  "用户其他反馈",
] as const;

export type Category = (typeof CATEGORIES)[number];

const CATEGORY_ALIAS_MAP: Record<string, Category> = {
  "功能新增": "破次元新功能需求",
  "二次元新需求": "破次元新功能需求",
  "二次元新功能需求": "破次元新功能需求",
  "性能优化": "现有破次元功能优化",
  "现有功能优化": "现有破次元功能优化",
  "现有破次元活动功能优化": "现有破次元功能优化",
  "用户活动": "用户其他反馈",
  "非二次元需求": "软件非破次元功能需求",
  "其他": "用户其他反馈",
};

export function normalizeCategoryToDb(raw: string): Category {
  const s = String(raw ?? "").trim();
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  if (CATEGORY_ALIAS_MAP[s]) return CATEGORY_ALIAS_MAP[s];

  if (s.includes("破次元") && (s.includes("优化") || s.includes("改进"))) return "现有破次元功能优化";
  if (s.includes("破次元") || s.includes("二次元")) return "破次元新功能需求";
  if (s.includes("性能") || s.includes("卡") || s.includes("慢") || s.includes("液化") || s.includes("美颜"))
    return "软件非破次元功能需求";
  if (s.includes("活动") || s.includes("运营")) return "用户其他反馈";
  if (s.includes("新增") || s.includes("支持") || s.includes("增加")) return "破次元新功能需求";

  return "用户其他反馈";
}

export const CATEGORY_COLORS: Record<Category, { bg: string; text: string; darkBg: string; darkText: string }> = {
  "现有破次元功能优化": {
    bg: "bg-amber-100", text: "text-amber-700",
    darkBg: "dark:bg-amber-950/30", darkText: "dark:text-amber-200",
  },
  "破次元新功能需求": {
    bg: "bg-violet-100", text: "text-violet-700",
    darkBg: "dark:bg-violet-950/40", darkText: "dark:text-violet-200",
  },
  "软件非破次元功能需求": {
    bg: "bg-sky-100", text: "text-sky-700",
    darkBg: "dark:bg-sky-950/30", darkText: "dark:text-sky-200",
  },
  "用户其他反馈": {
    bg: "bg-zinc-100", text: "text-zinc-700",
    darkBg: "dark:bg-zinc-900", darkText: "dark:text-zinc-200",
  },
};

export function getCategoryColorClass(category: string | null | undefined): string {
  const normalized = normalizeCategoryToDb(category ?? "");
  const c = CATEGORY_COLORS[normalized];
  return `${c.bg} ${c.text} ${c.darkBg} ${c.darkText}`;
}
