import OpenAI from "openai";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

export const runtime = "nodejs";

type ParseResultItem = {
  essence_key: string;
  original_text: string;
  category: "二次元新功能需求" | "现有破次元活动功能优化" | "非二次元需求";
  image_index: number | null;
};

function normalizeCategory(raw: string): ParseResultItem["category"] {
  const s = String(raw ?? "").trim();
  if (s === "二次元新功能需求" || s === "现有破次元活动功能优化" || s === "非二次元需求") return s;
  if (s.includes("二次元")) return "二次元新功能需求";
  if (s.includes("破次元") || s.includes("优化")) return "现有破次元活动功能优化";
  return "非二次元需求";
}

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
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
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

async function parseDocx(file: File): Promise<{ text: string; imageDataUrls: string[]; segments: string[] }> {
  const buf = Buffer.from(await file.arrayBuffer());

  const imageDataUrls: string[] = [];

  // mammoth 会在转换 HTML 时回调 convertImage，我们借此拿到内嵌图片
  await mammoth.convertToHtml(
    { buffer: buf },
    {
      convertImage: (mammoth as any).images.inline(async (image: any) => {
        const b64 = await image.read("base64");
        const ct = image.contentType || "image/png";
        const dataUrl = `data:${ct};base64,${b64}`;
        imageDataUrls.push(dataUrl);
        // 返回一个占位 img 标签，便于后续把文本里“有图的位置”保留一些痕迹
        return { src: dataUrl };
      }),
    }
  );

  const raw = await mammoth.extractRawText({ buffer: buf });
  const text = String(raw?.value ?? "").trim();
  // docx 一般文本不至于极长；但仍做一次轻量分段
  const segments = text ? [text.slice(0, 18_000)] : [];
  return { text, imageDataUrls, segments };
}

function chunkLines(lines: string[], opts?: { maxChars?: number; maxLines?: number; maxChunks?: number }) {
  const maxChars = opts?.maxChars ?? 14_000;
  const maxLines = opts?.maxLines ?? 220;
  const maxChunks = opts?.maxChunks ?? 8;
  const chunks: string[] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const ln of lines) {
    const addLen = ln.length + 1;
    if (cur.length >= maxLines || curChars + addLen > maxChars) {
      if (cur.length) chunks.push(cur.join("\n"));
      cur = [];
      curChars = 0;
      if (chunks.length >= maxChunks) break;
    }
    cur.push(ln);
    curChars += addLen;
  }
  if (cur.length && chunks.length < maxChunks) chunks.push(cur.join("\n"));
  return chunks;
}

function parseXlsx(file: File): Promise<{ text: string; imageDataUrls: string[]; segments: string[] }> {
  // 注意：xlsx 标准库不易稳定抽取图片（需要更复杂的 OOXML 解包）。
  // 先把表格文本提取出来，图片后续如有强需求再做增强。
  return file.arrayBuffer().then((ab) => {
    const wb = XLSX.read(ab, { type: "array" });
    const previewParts: string[] = [];
    const allLines: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true }) as any[][];
      if (!rows || rows.length === 0) continue;
      allLines.push(`【Sheet：${name}】`);
      // 行数可能很大：只取前 5000 行参与 AI 分段解析，避免卡死
      const limited = rows.slice(0, 5000);
      for (const r of limited) {
        const line = (r ?? [])
          .map((c) => String(c ?? "").trim())
          .filter((s) => s.length > 0)
          .join(" | ");
        if (line) allLines.push(line);
      }
      // 预览只取前 80 行
      const p = limited.slice(0, 80).map((r) =>
        (r ?? [])
          .map((c) => String(c ?? "").trim())
          .filter((s) => s.length > 0)
          .join(" | ")
      );
      const pText = p.filter(Boolean).join("\n").trim();
      if (pText) previewParts.push(`【Sheet：${name}】\n${pText}`);
    }
    const previewText = previewParts.join("\n\n").trim();
    const segments = chunkLines(allLines);
    return { text: previewText, imageDataUrls: [], segments };
  });
}

const SYSTEM_PROMPT = [
  "你是“像素蛋糕（PixCake）二次元/修图产品”的资深产品经理 + 运营分析师。",
  "用户给你一份从钉钉导出的历史需求文档（文字 + 可能包含配图）。请你把混乱的描述拆成可入库的需求条目。",
  "",
  "像素蛋糕现有能力线索（用于对比‘已有功能 vs 需要新增/优化’）：",
  "- 破次元计划2.0 体验页效果项：发丝发光、衣物反重力、头发反重力、碎石+烟雾、暗调、背景净化、自定义效果。",
  "- 产品能力目录（示例）：重塑无瑕皮肤（美颜/磨皮）、雕刻自然美型（液化/瘦脸等）、丰富色彩可能（调色/滤镜）、纯净背景再现（背景处理/抠图/净化）、衣物平整如新、精致手动工具。",
  "",
  "输出：请返回 JSON 数组，每个元素是一条需求：",
  `[{ "essence_key": "中文本质(2~10字)", "original_text": "原始描述(保留关键上下文)", "category": "二次元新功能需求|现有破次元活动功能优化|非二次元需求", "image_index": 0 } ]`,
  "",
  "强制规则：",
  "- category 必须严格三选一。",
  "- 如果你判断该需求是像素蛋糕已有能力但效果不好/不自然/不好用/体验差，必须归类为【现有破次元活动功能优化】。",
  "- essence_key 必须稳定可复用：同义表达归并到同一 essence_key（例如：脸太圆/下巴尖/瘦脸 → 二次元脸型液化）。",
  "- image_index：如果某条需求对应某张配图，填写对应图片索引（从 0 开始）。如果不确定，填 null。",
  "- 只输出纯 JSON，禁止 markdown、禁止解释。",
].join("\n");

export async function POST(req: Request) {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  const requestedModel = (process.env.AI_MODEL || "gpt-4o").trim();
  // Guardrail: 如果误配了 gpt-3.5/3.x，为了准确率统一升级到 gpt-4o
  const model =
    /gpt-3(\.|-)?5/i.test(requestedModel) || /gpt-3/i.test(requestedModel)
      ? "gpt-4o"
      : requestedModel;
  if (model !== requestedModel) {
    console.warn(`[import/parse] AI_MODEL=${requestedModel} overridden to model=${model}`);
  }
  if (!apiKey) return Response.json({ error: "Missing env: AI_API_KEY" }, { status: 500 });
  if (!baseURL) return Response.json({ error: "Missing env: AI_BASE_URL" }, { status: 500 });

  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof (file as any).arrayBuffer !== "function") {
    return Response.json({ error: "file is required" }, { status: 400 });
  }

  const f = file as File;
  const name = (f.name || "").toLowerCase();
  let parsed: { text: string; imageDataUrls: string[]; segments: string[] };
  try {
    if (name.endsWith(".docx")) parsed = await parseDocx(f);
    else if (name.endsWith(".xlsx")) parsed = await parseXlsx(f);
    else return Response.json({ error: "only .docx/.xlsx supported" }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "parse failed" }, { status: 500 });
  }

  if (!parsed.text && parsed.imageDataUrls.length === 0) {
    return Response.json({ error: "文档内容为空，无法解析" }, { status: 400 });
  }

  const client = new OpenAI({ apiKey, baseURL });
  const startAt = Date.now();
  const hardDeadlineMs = 80_000;
  const segments = parsed.segments.length ? parsed.segments : [parsed.text].filter(Boolean);
  const totalSegments = segments.length;
  const allItems: ParseResultItem[] = [];
  let processed = 0;
  let partial = false;

  for (const seg of segments) {
    if (Date.now() - startAt > hardDeadlineMs) {
      partial = true;
      break;
    }
    const userText = [
      `文件名：${f.name}`,
      `分段进度：${processed + 1}/${totalSegments}`,
      `文档片段内容：\n${seg || "（无）"}`,
      `配图数量：${parsed.imageDataUrls.length}`,
    ].join("\n\n");

    const content: any[] = [{ type: "text", text: userText }];
    for (const url of parsed.imageDataUrls.slice(0, 10)) {
      content.push({ type: "image_url", image_url: { url } });
    }

    let resp: any;
    try {
      resp = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      });
    } catch (e: any) {
      return Response.json(
        {
          error: `上游模型调用失败（HTTP ${e?.status ?? "?"}）`,
          hint: "请检查 AI_BASE_URL / AI_KEY / 模型是否可用。",
        },
        { status: 502 }
      );
    }

    const rawContent = resp?.choices?.[0]?.message?.content;
    const text = coerceMessageContentToText(rawContent).trim();
    const parsedJson = safeJsonParse(text);
    const arr = Array.isArray(parsedJson) ? parsedJson : parsedJson?.items;
    if (!Array.isArray(arr)) {
      console.error("[import/parse] AI raw content:", text);
      return Response.json({ error: "AI 返回内容不符合预期 JSON 数组", raw: text }, { status: 502 });
    }
    const items: ParseResultItem[] = arr
      .map((x: any) => ({
        essence_key: String(x?.essence_key ?? "").trim(),
        original_text: String(x?.original_text ?? "").trim(),
        category: normalizeCategory(String(x?.category ?? "")),
        image_index:
          x?.image_index === null || x?.image_index === undefined || x?.image_index === ""
            ? null
            : Number(x.image_index),
      }))
      .filter((it) => it.essence_key && it.original_text && it.category);
    allItems.push(...items);
    processed += 1;
    // 简单限流：避免连续打爆上游
    await new Promise((r) => setTimeout(r, 350));
  }

  return Response.json({
    text: parsed.text,
    images: parsed.imageDataUrls.slice(0, 10),
    items: allItems,
    meta: { segmentsProcessed: processed, segmentsTotal: totalSegments, partial },
  });
}

