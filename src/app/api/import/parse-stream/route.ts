import OpenAI from "openai";
import * as XLSX from "xlsx";
import { getSupabaseAdminOrError } from "@/lib/supabase/server";

const IMPORT_TEMP_BUCKET = "import-temp";

export const runtime = "nodejs";

async function ensureImportTempBucketExists() {
  // 让解析逻辑“开箱即用”：避免用户忘记在 Supabase 控制台执行 SQL
  // 导致 upload/download 时报错：Storage 缺少 import-temp 桶。
  try {
    const { client: supabaseAdmin, error: envErr } = getSupabaseAdminOrError();
    if (!supabaseAdmin) {
      throw new Error(envErr ?? "Missing Supabase env");
    }
    const { error } = await supabaseAdmin.storage.createBucket(IMPORT_TEMP_BUCKET, {
      public: false,
    });
    if (!error) return;

    const msg = (error.message || "").toLowerCase();
    // createBucket 在已存在时可能返回冲突类错误；忽略即可继续解析
    if (
      msg.includes("already exists") ||
      msg.includes("duplicate") ||
      msg.includes("conflict") ||
      msg.includes("409")
    ) {
      return;
    }

    throw error;
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : "unknown error";
    throw new Error(`初始化 Storage bucket 失败：${IMPORT_TEMP_BUCKET}。原因：${msg}`);
  }
}

type OutCategory = "现有破次元功能优化" | "破次元新功能需求" | "软件非破次元功能需求" | "用户其他反馈";
type StreamItem = {
  row_index: number; // 1-based（不含表头）
  /** 同一 row_index 拆分出的子序号，从 1 开始 */
  sub_index: number;
  /** 唯一标识：建议 r{row_index}-{sub_index} */
  item_id: string;
  date: string;
  essence_key: string;
  category: OutCategory;
  original_text: string;
  feedback_summary: string;
  image_url: string | null;
  feedback_count?: number | null;
  weight: number;
  /** 关键词（用于排名聚合/热度统计） */
  keywords: string[];
  /** 可选标签（如：bug/建议/体验/崩溃等） */
  tags: string[];
  /** 无效/乱码/测试文本：true 则前端默认隐藏 */
  is_invalid?: boolean;
};

const JSON_RETRY_PROMPT = [
  "你上一条输出不符合要求。",
  "请严格转换为【纯 JSON】并只输出 JSON，不要 markdown，不要解释。",
  "格式必须是：{\"items\":[...]}。",
  "items 中每个元素必须包含：row_index, sub_index(从1开始), item_id, essence_key(2~10字), category(现有破次元功能优化|破次元新功能需求|软件非破次元功能需求|用户其他反馈), original_text, feedback_summary, keywords(字符串数组)。",
  "每一行输入都必须产出至少 1 条 item。如果原文已是简短需求标题，直接用原文作为 essence_key 和 feedback_summary。",
  "如果某一行反馈包含多个需求点，必须拆成多条，并为同一 row_index 递增 sub_index。",
  "如果你判断某条是无意义乱码/测试文本，请设置 is_invalid=true，并给出 keywords=[]。",
].join("\n");

function extractJsonCandidate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const fenced =
    text.match(/```json\s*([\s\S]*?)\s*```/i) ?? text.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1).trim();
  }
  return null;
}

function safeJsonParse(raw: string): any | null {
  const candidate = extractJsonCandidate(raw) ?? raw.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function extractJsonObjectCandidate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const fenced =
    text.match(/```json\s*([\s\S]*?)\s*```/i) ?? text.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
}

function parseAiToItemsArray(raw: string): any[] | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const tryFromParsed = (parsed: any): any[] | null => {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
    return null;
  };

  let parsed: any = safeJsonParse(text);
  let arr = tryFromParsed(parsed);
  if (arr) return arr;

  const objCand = extractJsonObjectCandidate(text);
  if (objCand) {
    try {
      parsed = JSON.parse(objCand);
      arr = tryFromParsed(parsed);
      if (arr) return arr;
    } catch {
      // ignore
    }
  }

  const arrCand = extractJsonCandidate(text);
  if (arrCand && arrCand !== objCand) {
    try {
      parsed = JSON.parse(arrCand);
      arr = tryFromParsed(parsed);
      if (arr) return arr;
    } catch {
      // ignore
    }
  }

  return null;
}

function truncateForModel(s: string, maxChars: number) {
  const t = String(s ?? "");
  if (t.length <= maxChars) return t;
  const head = Math.floor(maxChars * 0.72);
  const tail = maxChars - head - 12;
  return `${t.slice(0, head)}…(已截断)…${t.slice(-Math.max(0, tail))}`;
}

type RowForAi = {
  row_index: number;
  date: string;
  feedback_type: string;
  feedback_voice: string;
  feedback_summary: string;
  image_url: string | null;
  feedback_count: number | null;
};

function essenceFallbackFromText(primary: string, secondary: string) {
  const base = String(primary || secondary || "").replace(/\s+/g, " ").trim();
  if (!base) return "（无标题）";
  const cleaned = base.replace(/[#*【】\[\]()（）]/g, "").trim();
  if (!cleaned) return "（无标题）";
  return cleaned.slice(0, 20) || "（无标题）";
}

function buildFallbackItems(batch: RowForAi[]): StreamItem[] {
  const out: StreamItem[] = [];
  for (const r of batch) {
    const voice = r.feedback_voice.trim();
    const sum = r.feedback_summary.trim();
    const pain = truncateForModel(voice || sum, 80);
    const oneLine = truncateForModel(sum || voice, 40);
    const fc = Math.max(1, Math.round(Number(r.feedback_count ?? 1) || 1));
    out.push({
      row_index: r.row_index,
      sub_index: 1,
      item_id: `r${r.row_index}-1`,
      date: r.date,
      essence_key: essenceFallbackFromText(sum, voice),
      category: normalizeCategory(r.feedback_type),
      original_text: pain || oneLine || "（无正文）",
      feedback_summary: oneLine,
      image_url: r.image_url,
      feedback_count: r.feedback_count,
      weight: fc,
      keywords: [],
      tags: [],
    });
  }
  return out;
}

function coerceMessageContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.content === "string") return p.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeCategory(raw: string): OutCategory {
  const s = String(raw ?? "").trim();
  if (
    s === "现有破次元功能优化" ||
    s === "破次元新功能需求" ||
    s === "软件非破次元功能需求" ||
    s === "用户其他反馈"
  )
    return s;
  if (s.includes("破次元") && (s.includes("优化") || s.includes("改进") || s.includes("现有")))
    return "现有破次元功能优化";
  if (s.includes("破次元") || s.includes("二次元") || s.includes("新功能"))
    return "破次元新功能需求";
  if (s.includes("非破次元") || s.includes("软件") || s.includes("通用") || s.includes("付费") || s.includes("设备"))
    return "软件非破次元功能需求";
  if (s.includes("活动") || s.includes("反馈") || s.includes("其他") || s.includes("咨询"))
    return "用户其他反馈";
  // legacy mapping
  if (s === "功能新增") return "破次元新功能需求";
  if (s === "性能优化") return "现有破次元功能优化";
  if (s === "用户活动" || s === "其他") return "用户其他反馈";
  return "用户其他反馈";
}

function heuristicWeight(text: string, feedbackCount?: number | null) {
  const s = String(text ?? "");
  // 粗略兜底：严重崩溃/不可用 -> 9~10；明显影响体验 -> 7~8；普通建议 -> 3~5
  let base = 3;
  if (
    s.includes("崩溃") ||
    s.includes("闪退") ||
    s.includes("卡死") ||
    s.includes("无法使用") ||
    s.includes("打不开")
  )
    base = 10;
  else if (
    s.includes("很卡") ||
    s.includes("卡顿") ||
    s.includes("很慢") ||
    s.includes("发热") ||
    s.includes("耗电")
  )
    base = 8;
  else if (s.includes("希望") || s.includes("建议") || s.includes("能否") || s.includes("增加")) base = 5;

  const count = Number(feedbackCount ?? 0);
  if (Number.isFinite(count) && count > 0) {
    if (count >= 20) base = Math.max(base, 10);
    else if (count >= 10) base = Math.max(base, 9);
    else if (count >= 5) base = Math.max(base, 7);
    else if (count >= 3) base = Math.max(base, 6);
    else if (count >= 2) base = Math.max(base, 5);
  }

  return Math.max(1, Math.min(10, base));
}

function isLikelyTitleLine(text: string) {
  const s = text.trim();
  if (!s) return true;
  // 常见“分组标题/版本标题”噪声
  if (s.includes("版本") && s.length <= 30) return true;
  if (s.includes("破次元计划") && s.length <= 40) return true;
  if (/^[-=~_]{3,}$/.test(s)) return true;
  return false;
}

function cellToText(cell: any): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  // xlsx 的 cell 对象可能长这样：{ t, v, w, l }
  if (typeof cell === "object") {
    if (typeof cell.w === "string") return cell.w.trim();
    if (typeof cell.v === "string" || typeof cell.v === "number") return String(cell.v).trim();
    if (cell.l && typeof cell.l.Target === "string") return String(cell.l.Target).trim();
  }
  return String(cell).trim();
}

function extractImageUrlFromCell(cell: any): string | null {
  // 优先 hyperlink
  if (cell && typeof cell === "object" && cell.l && typeof cell.l.Target === "string") {
    const u = String(cell.l.Target).trim();
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
  }
  const s = cellToText(cell);
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return null;
}

function normalizeHeaderCell(s: string) {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "")
    .trim();
}

function isSimpleDemandCountHeader(row: any[]) {
  const c0 = normalizeHeaderCell(cellToText(row?.[0] ?? ""));
  const c1 = normalizeHeaderCell(cellToText(row?.[1] ?? ""));
  if (!c0 || !c1) return false;
  const summaryLike = ["功能详情", "需求详情", "需求内容", "反馈内容", "问题详情", "功能点", "需求点"].some(
    (k) => c0.includes(k)
  );
  const countLike = ["总反馈数", "反馈数", "数量", "次数", "总数"].some((k) => c1.includes(k));
  return summaryLike && countLike;
}

function findHeaderRowAndColumns(rows: any[][]) {
  const scanMax = Math.min(rows.length, 80);
  const headerKey = "反馈总结";
  for (let ri = 0; ri < scanMax; ri++) {
    const r = rows[ri] ?? [];
    for (let ci = 0; ci < r.length; ci++) {
      const v = normalizeHeaderCell(cellToText(r[ci]));
      if (!v) continue;
      if (v.includes(headerKey)) {
        // 以该行为表头行，做一次列名映射
        const headerMap = new Map<string, number>();
        for (let c2 = 0; c2 < r.length; c2++) {
          const k = normalizeHeaderCell(cellToText(r[c2]));
          if (!k) continue;
          if (!headerMap.has(k)) headerMap.set(k, c2);
        }
        const pick = (cands: string[]) => {
          for (const cand of cands) {
            for (const [k, idx] of headerMap.entries()) {
              if (k === cand || k.includes(cand)) return idx;
            }
          }
          return null;
        };
        return {
          headerRowIndex: ri,
          colSummary: pick(["反馈总结"]),
          colVoice: pick(["用户反馈原声", "反馈原声", "用户反馈", "原声"]),
          colType: pick(["反馈类型", "类型"]),
          colDate: pick(["日期", "时间"]),
          colImage: pick(["相关图片", "图片", "链接", "image", "img"]),
          colCount: null,
        };
      }
    }
  }

  // 兼容简化版汇总表：仅有「功能详情 | 总反馈数」两列
  for (let ri = 0; ri < Math.min(rows.length, 20); ri++) {
    const r = rows[ri] ?? [];
    if (isSimpleDemandCountHeader(r)) {
      return {
        headerRowIndex: ri,
        colSummary: 0,
        colVoice: null,
        colType: null,
        colDate: null,
        colImage: null,
        colCount: 1,
      };
    }
  }
  return null;
}

/** 从工作簿抽取有效数据行（支持表头不在第一行：自动识别『反馈总结』列） */
function extractRowsFromWorkbook(wb: XLSX.WorkBook): RowForAi[] {
  const rowsForAi: RowForAi[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true }) as any[][];
    if (!rows || rows.length === 0) continue;

    const found = findHeaderRowAndColumns(rows);
    const headerRowIndex = found?.headerRowIndex ?? 9;
    const startDataIndex = headerRowIndex + 1;
    // 行数可能很大：这里依然做上限保护，但不再因为表头错位导致 0 条
    const hardCap = Math.min(rows.length, startDataIndex + 60000);
    const dataRows = rows.slice(startDataIndex, hardCap);

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i] ?? [];
      const excelRowIndex = startDataIndex + i + 1;

      const colDate = found ? found.colDate : 0;
      const colType = found ? found.colType : 4;
      const colVoice = found ? found.colVoice : 5;
      const colSummary = found ? found.colSummary : 6;
      const colImage = found ? found.colImage : 8;
      const colCount = found?.colCount ?? null;

      const dateA = colDate == null ? "" : cellToText(r[colDate] ?? "");
      const typeE = colType == null ? "" : cellToText(r[colType] ?? "");
      const voiceF = colVoice == null ? "" : cellToText(r[colVoice] ?? "");
      const summaryG = colSummary == null ? "" : cellToText(r[colSummary] ?? "");
      const imgI = colImage == null ? null : extractImageUrlFromCell(r[colImage] ?? null);
      const rawCount = colCount == null ? "" : cellToText(r[colCount] ?? "");
      const countNum = Number(rawCount);

      // 关键：以“反馈总结”列为主，不要因为上方空白行/其它列为空而跳过
      const main = (summaryG || voiceF).trim();
      if (!main) continue;
      if (isLikelyTitleLine(main)) continue;

      rowsForAi.push({
        row_index: excelRowIndex,
        date: dateA,
        feedback_type: typeE,
        feedback_voice: voiceF,
        feedback_summary: summaryG,
        image_url: imgI,
        feedback_count: Number.isFinite(countNum) && countNum > 0 ? countNum : null,
      });
    }
  }
  return rowsForAi;
}

function toSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const SYSTEM_PROMPT = [
  "你是\"像素蛋糕（PixCake）二次元/修图产品\"的资深产品经理。",
  "你会收到从 Excel 提取的一批用户反馈（每批最多 5 行）。",
  "",
  "## 核心原则",
  "- 每一行输入都必须产出至少 1 条 item。不允许跳过任何行。",
  "- 如果输入行本身就是简短的需求标题（如\"打光特效\"、\"去腿毛\"、\"祛鼻贴\"），直接使用原文作为 essence_key 和 feedback_summary，不要过度改写。",
  "- 只有真正无法理解的乱码/测试文字才标记 is_invalid=true。",
  "- 如果同一行包含多个独立需求（1. 2. 3. 或分号/换行分隔），才拆成多条。",
  "",
  "## 分类判断核心规则（极其重要）",
  "像素蛋糕是一款二次元/Cosplay 修图软件。用户提交的需求绝大多数都跟修图/特效/美化相关。",
  "**默认分类思路：只要需求跟【图片处理/特效/美化/素材/修图工具】沾边，就应该归为破次元相关分类，不要归为【用户其他反馈】。**",
  "\"用户其他反馈\"仅用于：纯粹的咨询问题、活动建议、夸奖、疑问等完全不涉及功能需求的内容。",
  "",
  "## 像素蛋糕能力分层（决定分类）",
  "### 破次元/二次元专属能力（已有或可能新增）：",
  "发丝发光、衣物反重力、头发反重力、碎石+烟雾、暗调、背景净化、自定义效果、",
  "粒子特效（羽毛/火焰/雷电/樱花/雪花）、二次元风格转换、二次元发型、二次元美瞳、",
  "去打底裤/祛底裤、辉光、打光特效、漫画脸、眼睛发光、去腿毛/祛腿毛、裙摆扩大、",
  "武器素材、cos特效、祛鼻贴、去脸部贴纸、动画头发、头发动态效果、",
  "文字指令生成式修图/AI生成修图、一句话生成特效、AI布景、AI自定义上传素材、",
  "增加乳沟、去衣褶、衣物平整（cos服装）、自定义美瞳、美瞳色号扩展、",
  "背景替换、天空替换、画头发光功能、亮度/对比度加深（特效相关）、",
  "安卓版手机换天空、安卓版手机修复功能/仿制图章、手机版改头像查看氛围感、",
  "Raw格式支持、色彩管理/色彩空间、图层功能、批量处理、",
  "所有跟\"祛/去/消除/修复/增加/添加/生成/动画/特效/素材/美瞳/发型/辉光/粒子/打光\"相关的需求。",
  "### 通用修图/软件能力（非破次元）：",
  "美颜/磨皮、液化/瘦脸、调色/滤镜、抠图、快捷键、镜头矫正、导入导出、",
  "设备兼容、付费/会员、创意板块、跨端同步、性能优化/卡顿/崩溃等。",
  "",
  "## 分类体系（严格四选一）",
  "- \"破次元新功能需求\"：用户想要的新功能/新特效/新素材（默认首选此项）",
  "- \"现有破次元功能优化\"：已有功能但效果不好/需改进/有 Bug",
  "- \"软件非破次元功能需求\"：通用修图/软件工具/付费/设备/UI/性能问题",
  "- \"用户其他反馈\"：仅限日常咨询、活动建议、夸奖、疑问等纯非功能内容",
  "",
  "## 分类示例（必须学习）",
  "- \"祛鼻贴\" → 破次元新功能需求（去除面部修饰物=修图特效）",
  "- \"头发反重力支持动画头发\" → 破次元新功能需求（头发动态效果=二次元特效）",
  "- \"文字指令生成式修图\" → 破次元新功能需求（AI生成修图=新功能）",
  "- \"祛底裤\" → 破次元新功能需求（去除打底裤=修图特效）",
  "- \"打光特效\" → 破次元新功能需求",
  "- \"去腿毛\" → 破次元新功能需求",
  "- \"增加乳沟\" → 破次元新功能需求",
  "- \"美瞳色号\" → 现有破次元功能优化（已有美瞳功能，扩展色号）",
  "- \"AI布景自定义上传素材\" → 破次元新功能需求",
  "- \"亮度对比度加深\" → 现有破次元功能优化",
  "- \"cos4同步电脑端\" → 软件非破次元功能需求",
  "- \"软件卡顿\" → 软件非破次元功能需求",
  "",
  "## 每条 item 输出字段",
  "- item_id：格式 r{row_index}-{sub_index}",
  "- row_index：原 Excel 行号（必须原样返回）",
  "- sub_index：从 1 开始递增",
  "- essence_key：2~10 字核心需求关键词。如果原文已是简短标题，直接用原文。",
  "- category：严格四选一（见上）",
  "- keywords：关键词数组",
  "- tags：可选标签数组（没有就 []）",
  "- original_text：核心诉求/痛点（<=80字）。如果原文已是简短标题，直接用原文。",
  "- feedback_summary：一句话总结（<=40字）。如果原文已是简短标题，直接用原文。",
  "- is_invalid：仅乱码/无意义文本设为 true，其余为 false",
  "",
  "输出格式：只输出纯 JSON 对象（不要 markdown、不要解释），形如：",
  `{"items":[{"item_id":"r1-1","row_index":1,"sub_index":1,"essence_key":"祛鼻贴","category":"破次元新功能需求","keywords":["祛鼻贴","修图"],"tags":[],"original_text":"祛鼻贴","feedback_summary":"祛鼻贴","is_invalid":false}]}`,
  "",
  "强制要求：",
  "- 每一行输入都必须产出至少 1 条 item，row_index 必须原样返回。",
  "- 只输出纯 JSON，禁止 markdown、禁止解释。",
  "- category 必须严格四选一。",
  "- keywords 必须是 JSON 数组。",
  "- 跟修图/特效/美化/素材相关的需求不要归为\"用户其他反馈\"。",
].join("\n");

export async function POST(req: Request) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  const supabaseAdmin = client;
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  const requestedModel = (process.env.AI_MODEL || "gpt-4o").trim();
  // Guardrail: 如果误配了 gpt-3.5/3.x，为了准确率统一升级到 gpt-4o
  const model =
    /gpt-3(\.|-)?5/i.test(requestedModel) || /gpt-3/i.test(requestedModel)
      ? "gpt-4o"
      : requestedModel;
  if (model !== requestedModel) {
    console.warn(`[import/parse-stream] AI_MODEL=${requestedModel} overridden to model=${model}`);
  }
  if (!apiKey) return Response.json({ error: "Missing env: AI_API_KEY" }, { status: 500 });
  if (!baseURL) return Response.json({ error: "Missing env: AI_BASE_URL" }, { status: 500 });

  // 关键：确保临时桶存在，避免运行时报错 “Storage 缺少 import-temp 桶”
  await ensureImportTempBucketExists();

  // 兜底：确保数据库表存在（否则会出现：
  // Could not find the table public.import_parse_sessions in the schema cache）
  {
    const { error: tableCheckErr } = await supabaseAdmin
      .from("import_parse_sessions")
      .select("id")
      .limit(1);
    if (tableCheckErr) {
      const msg = tableCheckErr.message?.toLowerCase?.() ?? String(tableCheckErr);
      if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("import_parse_sessions")) {
        throw new Error(
          "缺少数据库表 public.import_parse_sessions。请在 Supabase SQL Editor 执行：supabase/import_parse_sessions.sql（用于创建表和 RLS 配置）。"
        );
      }
      // 其它错误直接抛出，便于你定位 Supabase 配置/网络问题
      throw tableCheckErr;
    }
  }

  const encoder = new TextEncoder();
  const segmentBudgetMs = Math.max(
    15_000,
    Math.min(240_000, Number(process.env.IMPORT_SEGMENT_BUDGET_MS) || 55_000)
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      (async () => {
        const startedAt = Date.now();
        // 兜底：当中途异常时，尽量把断点写回 import_parse_sessions
        let persistSid: string | null = null;
        let persistNextIndex = 0;
        let persistLastExcelRow: number | null = null;

        async function persistProgress(
          sid: string,
          nextIndex: number,
          excelRow: number | null,
          status?: "active" | "completed"
        ) {
          const patch: Record<string, unknown> = {
            next_index: nextIndex,
            last_processed_excel_row: excelRow,
            updated_at: new Date().toISOString(),
          };
          if (status) patch.status = status;
          const { error } = await supabaseAdmin.from("import_parse_sessions").update(patch).eq("id", sid);
          if (error) {
            controller.enqueue(
              encoder.encode(toSse("warning", { message: `进度写入失败（可继续点续传）：${error.message}` }))
            );
          }
        }

        try {
          controller.enqueue(encoder.encode(toSse("meta", { stage: "reading" })));

          const form = await req.formData();
          const resume =
            String(form.get("resume") ?? "") === "true" || String(form.get("resume") ?? "") === "1";
          const sessionIdIn = String(form.get("sessionId") ?? "").trim();
          const startRowRaw = form.get("startRow");
          const startExcelRow = Number(startRowRaw);

          let sessionId: string;
          let displayFileName: string;
          let rowsForAi: RowForAi[];
          let cursorStart: number;
          let sheetNames: string[] = [];

          if (resume && sessionIdIn) {
            const { data: sess, error: se } = await supabaseAdmin
              .from("import_parse_sessions")
              .select("*")
              .eq("id", sessionIdIn)
              .maybeSingle();

            if (se) throw new Error(se.message);
            if (!sess) throw new Error("续传失败：会话不存在");
            if (sess.status === "completed") {
              controller.enqueue(
                encoder.encode(
                  toSse("meta", {
                    stage: "done",
                    complete: true,
                    partial: false,
                    is_finished: true,
                    done_items: 0,
                    total_rows: sess.total_rows,
                    processed_rows: sess.total_rows,
                    session_id: sess.id,
                    next_index: sess.total_rows,
                    message: "该会话已在服务端标记为完成",
                  })
                )
              );
              controller.close();
              return;
            }

            sessionId = sess.id;
            persistSid = sessionId;
            displayFileName = sess.original_filename || "import.xlsx";
            const dl = await supabaseAdmin.storage.from(IMPORT_TEMP_BUCKET).download(sess.storage_path);
            if (dl.error) throw new Error(`读取临时文件失败：${dl.error.message}`);
            const ab = await dl.data.arrayBuffer();
            const wb = XLSX.read(ab, { type: "array" });
            sheetNames = wb.SheetNames ?? [];
            rowsForAi = extractRowsFromWorkbook(wb);
            cursorStart = Math.max(0, Math.min(Number(sess.next_index) || 0, rowsForAi.length));

            if (rowsForAi.length !== sess.total_rows) {
              controller.enqueue(
                encoder.encode(
                  toSse("warning", {
                    message: `当前文件解析出行数(${rowsForAi.length})与会话记录(${sess.total_rows})不一致，已以文件为准并裁剪游标`,
                  })
                )
              );
            }
            // 续传以数据库 next_index 为准，忽略 startRow，避免前端状态错乱
          } else {
            const file = form.get("file");
            if (!file || typeof (file as any).arrayBuffer !== "function") {
              throw new Error("请上传 .xlsx，或使用 sessionId + resume=1 继续解析");
            }
            const f = file as File;
            const name = (f.name || "").toLowerCase();
            if (!name.endsWith(".xlsx")) {
              throw new Error("only .xlsx supported for streaming");
            }

            sessionId = crypto.randomUUID();
            persistSid = sessionId;
            displayFileName = f.name || "upload.xlsx";
            const ab = await f.arrayBuffer();
            const objectPath = `${sessionId}/source.xlsx`;

            const up = await supabaseAdmin.storage.from(IMPORT_TEMP_BUCKET).upload(objectPath, Buffer.from(ab), {
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              upsert: true,
            });
            if (up.error) {
              const m = up.error.message || "";
              if (m.includes("Bucket not found") || m.toLowerCase().includes("not found")) {
                throw new Error(
                  "Storage 缺少 import-temp 桶。请在 Supabase 执行 supabase/import_parse_sessions.sql"
                );
              }
              throw new Error(`临时文件上传失败：${m}`);
            }

            const wb = XLSX.read(ab, { type: "array" });
            sheetNames = wb.SheetNames ?? [];
            rowsForAi = extractRowsFromWorkbook(wb);

            const { error: insErr } = await supabaseAdmin.from("import_parse_sessions").insert({
              id: sessionId,
              storage_path: objectPath,
              original_filename: displayFileName,
              total_rows: rowsForAi.length,
              next_index: 0,
              status: "active",
            });
            if (insErr) {
              const m = insErr.message || "";
              if (m.includes("import_parse_sessions") && m.includes("does not exist")) {
                throw new Error("数据库未创建 import_parse_sessions 表，请执行 supabase/import_parse_sessions.sql");
              }
              throw new Error(m);
            }

            cursorStart = 0;
            if (Number.isFinite(startExcelRow) && startExcelRow > 0) {
              const idx = rowsForAi.findIndex((r) => r.row_index >= startExcelRow);
              if (idx >= 0) cursorStart = idx;
            }
          }

          const totalRows = rowsForAi.length;
          cursorStart = Math.max(0, Math.min(cursorStart, totalRows));

          if (totalRows === 0) {
            // 调试：帮助定位为什么抽取不到行（表头错位 / sheet 空 / xlsx 解析失败）
            console.warn("[import/parse-stream] extracted 0 rows from workbook", {
              sessionId,
              file: displayFileName,
              sheets: sheetNames,
            });
          }

          controller.enqueue(
            encoder.encode(
              toSse("meta", {
                stage: "queued",
                total_rows: totalRows,
                session_id: sessionId,
                next_index: cursorStart,
                resume,
              })
            )
          );

          if (totalRows === 0) {
            controller.enqueue(
              encoder.encode(
                toSse("warning", {
                  message:
                    "Excel 解析为 0 行：请确认表内存在『反馈总结』列且该列下有内容；也可能是 xlsx 未读到 sheet 数据。服务端已输出调试日志。",
                })
              )
            );
            await persistProgress(sessionId, 0, null, "completed");
            controller.enqueue(
              encoder.encode(
                toSse("meta", {
                  stage: "done",
                  complete: true,
                  partial: false,
                  is_finished: true,
                  done_items: 0,
                  total_rows: 0,
                  processed_rows: 0,
                  session_id: sessionId,
                  next_index: 0,
                  fallback_batches: 0,
                })
              )
            );
            controller.close();
            return;
          }

          const client = new OpenAI({ apiKey, baseURL });
          const rowsSlice = rowsForAi.slice(cursorStart);
          const batches = chunk(rowsSlice, 5);
          const segmentTotalBatches = batches.length;

          let learningExamplesPrompt = "";
          try {
            const { data: examples } = await supabaseAdmin
              .from("ai_learning_examples")
              .select("original_text, ai_category, corrected_category, ai_essence_key, corrected_essence_key")
              .order("created_at", { ascending: false })
              .limit(30);
            if (examples && examples.length > 0) {
              const lines = examples.map((ex: any) => {
                const parts: string[] = [`输入："${ex.original_text}"`];
                if (ex.ai_category !== ex.corrected_category) {
                  parts.push(`AI 错误分类："${ex.ai_category}" → 正确分类："${ex.corrected_category}"`);
                }
                if (ex.ai_essence_key !== ex.corrected_essence_key) {
                  parts.push(`AI 错误标题："${ex.ai_essence_key}" → 正确标题："${ex.corrected_essence_key}"`);
                }
                return parts.join("，");
              });
              learningExamplesPrompt = [
                "",
                "## 历史修正记录（必须学习）",
                "以下是用户对 AI 过去分类/标题错误的修正。遇到类似内容时，请参照修正后的结果：",
                ...lines,
              ].join("\n");
            }
          } catch {
            // 表不存在或查询失败，跳过学习示例
          }

          const effectivePrompt = SYSTEM_PROMPT + learningExamplesPrompt;

          const results: StreamItem[] = [];
          let doneBatches = 0;
          let fallbackBatches = 0;
          let currentCursor = cursorStart;
          let lastExcelRow: number | null = null;
          persistNextIndex = currentCursor;
          persistLastExcelRow = lastExcelRow;

          async function callModelLocal(
            sys: string,
            userText: string,
            useJsonObject: boolean
          ): Promise<string> {
            const body: any = {
              model,
              temperature: 0,
              top_p: 1,
              messages: [
                { role: "system", content: sys },
                { role: "user", content: [{ type: "text", text: userText }] as any },
              ],
            };
            if (useJsonObject) body.response_format = { type: "json_object" };

            // 稳定性：单次调用失败自动重试 3 次（terminated/网络抖动/上游过载）
            const maxTries = 3;
            let lastErr: any = null;
            for (let t = 0; t < maxTries; t++) {
              try {
                if (t > 0) await sleep(450 * t * t);
                const resp = await client.chat.completions.create(body);
                return coerceMessageContentToText(resp?.choices?.[0]?.message?.content).trim();
              } catch (e: any) {
                lastErr = e;
                const msg = String(e?.message ?? e ?? "").toLowerCase();
                // 不可重试：明确的 4xx（除 429）直接抛
                const status = Number(e?.status ?? 0);
                if (status >= 400 && status < 500 && status !== 429) break;
                // 可重试：terminated/timeout/429/5xx/连接错误
                if (
                  msg.includes("terminated") ||
                  msg.includes("timeout") ||
                  msg.includes("rate") ||
                  msg.includes("429") ||
                  msg.includes("overload") ||
                  msg.includes("econnreset") ||
                  msg.includes("fetch failed") ||
                  status >= 500
                ) {
                  continue;
                }
                // 默认可重试一次，剩余直接退出循环抛错
                if (t < maxTries - 1) continue;
              }
            }
            throw lastErr ?? new Error("model call failed");
          }

          const worker = async (batch: RowForAi[]) => {
            if (Date.now() - startedAt > segmentBudgetMs) {
              return { items: [] as StreamItem[], skipped: true };
            }

            const userText = [
              `文件：${displayFileName}`,
              `你收到的是 5 行一组的记录（可能不足 5 行）。`,
              `必须输出 {"items":[...]}，每条带回 row_index。`,
              "",
              ...batch.map((r) =>
                [
                  `row_index: ${r.row_index}`,
                  `日期: ${r.date || "（空）"}`,
                  `反馈类型(可选参考): ${r.feedback_type || "（空）"}`,
                  `历史反馈次数: ${r.feedback_count ?? 1}`,
                  `反馈总结(优先): ${truncateForModel(r.feedback_summary || "", 1600)}`,
                  `用户反馈原声(可选): ${truncateForModel(r.feedback_voice, 1600)}`,
                  `相关图片(列I): ${r.image_url || "（无）"}`,
                ].join("\n")
              ),
            ].join("\n\n");

            const maxAttempts = 3;
            let lastText = "";
            let arr: any[] | null = null;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              if (Date.now() - startedAt > segmentBudgetMs) break;
              if (attempt > 0) await sleep(400 * attempt * attempt);

              try {
                const useJson = attempt === 0;
                try {
                  lastText = await callModelLocal(effectivePrompt, userText, useJson);
                } catch (e1: any) {
                  if (useJson) {
                    lastText = await callModelLocal(effectivePrompt, userText, false);
                  } else {
                    throw e1;
                  }
                }

                arr = parseAiToItemsArray(lastText);

                if (!arr) {
                  const retryText = await callModelLocal(
                    JSON_RETRY_PROMPT,
                    `原输出：\n${lastText.slice(0, 8000)}`,
                    false
                  );
                  lastText = retryText;
                  arr = parseAiToItemsArray(retryText);
                }

                if (arr) break;
              } catch (e: any) {
                lastText = e?.message ?? String(e);
              }
            }

            if (!arr) {
              fallbackBatches += 1;
              const fb = buildFallbackItems(batch);
              controller.enqueue(
                encoder.encode(
                  toSse("warning", {
                    message: `某批次模型未返回可用 JSON，已用规则兜底生成 ${fb.length} 条（可人工改 essence_key）`,
                  })
                )
              );
              return { items: fb, skipped: false, fallback: true };
            }

            const normalizeStringArray = (v: any): string[] => {
              if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);
              const s = String(v ?? "").trim();
              if (!s) return [];
              return s
                .split(/[,，;；\n]/g)
                .map((x) => x.trim())
                .filter(Boolean)
                .slice(0, 20);
            };

            let items: StreamItem[] = (arr as any[])
              .map((x) => {
                const rowIndex = Number(x?.row_index);
                const subIndexRaw = x?.sub_index;
                const subIndex = Number.isFinite(Number(subIndexRaw)) ? Number(subIndexRaw) : 0;
                const essence = String(x?.essence_key ?? "").trim();
                const invalid = Boolean(x?.is_invalid ?? x?.invalid);
                const keywords = normalizeStringArray(x?.keywords);
                const tags = normalizeStringArray(x?.tags);
                const itemIdRaw = String(x?.item_id ?? "").trim();
                const itemId =
                  itemIdRaw ||
                  (Number.isFinite(rowIndex) && subIndex > 0 ? `r${rowIndex}-${subIndex}` : "");
                return {
                  row_index: rowIndex,
                  sub_index: subIndex,
                  item_id: itemId,
                  essence_key: essence,
                  category: normalizeCategory(String(x?.category ?? "")),
                  keywords,
                  tags,
                  original_text: String(x?.original_text ?? "").trim().slice(0, 200),
                  feedback_summary: String(x?.feedback_summary ?? "").trim().slice(0, 120),
                  date: "",
                  image_url: null,
                  feedback_count: null,
                  weight: 1,
                  is_invalid: invalid,
                };
              })
              .filter((it) => Number.isFinite(it.row_index) && it.essence_key && it.original_text);

            // 如果模型没给 sub_index / item_id，为同一行自动补齐（按出现顺序递增）
            {
              const cnt = new Map<number, number>();
              for (const it of items) {
                const c = (cnt.get(it.row_index) ?? 0) + 1;
                cnt.set(it.row_index, c);
                if (!it.sub_index || it.sub_index <= 0) it.sub_index = c;
                if (!it.item_id) it.item_id = `r${it.row_index}-${it.sub_index}`;
              }
            }

            const byRow = new Map<number, RowForAi>();
            for (const r of batch) byRow.set(r.row_index, r);
            const got = new Set(items.filter((it) => !it.is_invalid).map((it) => it.row_index));
            const missing = batch.filter((r) => !got.has(r.row_index));
            if (missing.length > 0) {
              items = [...items, ...buildFallbackItems(missing)];
              controller.enqueue(
                encoder.encode(
                  toSse("warning", {
                    message: `批次内缺 ${missing.length} 行模型输出，已规则补齐`,
                  })
                )
              );
            }

            for (const it of items) {
              const src = byRow.get(it.row_index);
              if (src) {
                it.date = src.date;
                it.image_url = src.image_url;
                it.feedback_count = src.feedback_count;
                it.weight = Math.max(1, Math.round(Number(src.feedback_count ?? 1) || 1));
                if (!it.feedback_summary && src.feedback_summary) it.feedback_summary = src.feedback_summary;
              }
            }

            return { items, skipped: false, fallback: false };
          };

          let pausedByBudget = false;
          const CONCURRENCY = 3;

          for (let waveStart = 0; waveStart < batches.length; waveStart += CONCURRENCY) {
            if (Date.now() - startedAt > segmentBudgetMs) {
              pausedByBudget = true;
              await persistProgress(sessionId, currentCursor, lastExcelRow);
              controller.enqueue(
                encoder.encode(
                  toSse("meta", {
                    stage: "paused",
                    session_id: sessionId,
                    next_index: currentCursor,
                    total_rows: totalRows,
                    processed_rows: currentCursor,
                    last_processed_row: lastExcelRow,
                    reason: "segment_budget",
                    done_batches: doneBatches,
                    total_batches: segmentTotalBatches,
                    done_items: results.length,
                    fallback_batches: fallbackBatches,
                  })
                )
              );
              break;
            }

            const wave = batches.slice(waveStart, waveStart + CONCURRENCY);
            const waveResults = await Promise.all(wave.map((batch) => worker(batch)));

            let waveSkipped = false;
            for (let wi = 0; wi < waveResults.length; wi++) {
              const r = waveResults[wi];
              if (r.skipped) {
                waveSkipped = true;
                break;
              }

              for (const it of r.items) {
                results.push(it);
                lastExcelRow = it.row_index;
                controller.enqueue(encoder.encode(toSse("item", it)));
              }

              currentCursor += wave[wi].length;
              persistNextIndex = currentCursor;
              persistLastExcelRow = lastExcelRow;

              doneBatches += 1;
            }

            if (waveSkipped) {
              pausedByBudget = true;
              await persistProgress(sessionId, currentCursor, lastExcelRow);
              controller.enqueue(
                encoder.encode(
                  toSse("meta", {
                    stage: "paused",
                    session_id: sessionId,
                    next_index: currentCursor,
                    total_rows: totalRows,
                    processed_rows: currentCursor,
                    last_processed_row: lastExcelRow,
                    reason: "segment_budget_mid_batch",
                    done_batches: doneBatches,
                    total_batches: segmentTotalBatches,
                    done_items: results.length,
                    fallback_batches: fallbackBatches,
                  })
                )
              );
              break;
            }

            await persistProgress(sessionId, currentCursor, lastExcelRow);
            controller.enqueue(
              encoder.encode(
                toSse("meta", {
                  stage: "progress",
                  session_id: sessionId,
                  done_batches: doneBatches,
                  total_batches: segmentTotalBatches,
                  done_items: results.length,
                  fallback_batches: fallbackBatches,
                  total_rows: totalRows,
                  processed_rows: currentCursor,
                  next_index: currentCursor,
                  last_processed_row: lastExcelRow,
                })
              )
            );
          }

          const complete = !pausedByBudget && currentCursor >= totalRows;
          if (complete) {
            await persistProgress(sessionId, totalRows, lastExcelRow, "completed");
          }

          controller.enqueue(
            encoder.encode(
              toSse("meta", {
                stage: "done",
                complete,
                partial: !complete,
                is_finished: complete,
                done_items: results.length,
                total_batches: segmentTotalBatches,
                fallback_batches: fallbackBatches,
                session_id: sessionId,
                next_index: currentCursor,
                total_rows: totalRows,
                processed_rows: currentCursor,
                last_processed_row: lastExcelRow,
              })
            )
          );
          controller.close();
        } catch (e: any) {
          try {
            // 失败兜底：尽量把当前游标写回，避免前端断点续传丢进度
            if (persistSid) {
              await persistProgress(persistSid, persistNextIndex, persistLastExcelRow);
            }
          } catch {
            // ignore
          }
          controller.enqueue(encoder.encode(toSse("error", { error: e?.message ?? "unknown error" })));
          controller.close();
        }
      })().catch((e: any) => {
        controller.enqueue(encoder.encode(toSse("error", { error: e?.message ?? "unknown error" })));
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

