import OpenAI from "openai";

export type AiDemandResult = {
  tag: "现有功能优化" | "功能新增" | "二次元专项优化" | "其他";
  summary: string; // 一句话总结
};

const openaiApiKey = process.env.OPENAI_API_KEY;

function getClient() {
  if (!openaiApiKey) {
    throw new Error("Missing env: OPENAI_API_KEY");
  }
  return new OpenAI({ apiKey: openaiApiKey });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 有些模型会把 JSON 包在 ```json 里
    const m = text.match(/```json\s*([\s\S]*?)\s*```/i) ?? text.match(/```\s*([\s\S]*?)\s*```/);
    if (m?.[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function summarizeDemandFromImage(params: {
  imageUrl: string;
  note?: string;
}): Promise<AiDemandResult> {
  const client = getClient();

  const note = (params.note ?? "").trim();

  const prompt = [
    "你是一个产品/运营助理，正在为“二次元社群需求统计”做结构化提取。",
    "请根据截图内容提取用户需求，并用严格 JSON 输出。",
    "",
    "输出 JSON schema：",
    `{ "tag": "现有功能优化|功能新增|二次元专项优化|其他", "summary": "一句话概括用户想要什么（中文，<=30字）" }`,
    "",
    "要求：",
    "- 只输出 JSON，不要任何解释或 markdown。",
    "- tag 必须从给定枚举中选择最贴近的一项。",
    "- summary 不要包含多余的背景，突出“要做什么/改什么”。",
    note ? `补充备注（可能为空）：${note}` : "补充备注：无",
  ].join("\n");

  const resp = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: params.imageUrl } },
        ],
      },
    ],
  });

  const text = resp.choices?.[0]?.message?.content?.trim() ?? "";
  const parsed = safeJsonParse(text);
  const obj = (parsed ?? {}) as any;

  const rawTag = String(obj.tag ?? "").trim();
  const tag =
    rawTag === "现有功能优化" ||
    rawTag === "功能新增" ||
    rawTag === "二次元专项优化" ||
    rawTag === "其他"
      ? rawTag
      : "其他";

  const summary = String(obj.summary ?? "").trim();
  if (!summary) {
    return { tag: "其他", summary: "（AI 未能提取需求）" };
  }

  return { tag, summary: summary.slice(0, 60) };
}

