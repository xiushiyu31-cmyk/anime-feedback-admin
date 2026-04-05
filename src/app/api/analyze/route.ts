import OpenAI from "openai";

export const runtime = "nodejs";

type AnalyzeBody = {
  note?: string;
  images: Array<
    | { type: "data_url"; data_url: string }
    | { type: "url"; url: string }
  >;
};

const SYSTEM_PROMPT =
  [
    "你是“像素蛋糕（PixCake）二次元/修图产品”的资深产品经理 + 运营分析师。",
    "用户会上传多张社群聊天截图/修图参考图。你需要：识别文字与画面信息，并把需求结构化落库。",
    "",
    "像素蛋糕现有能力线索（用于对比‘已有功能 vs 需要新增/优化’）：",
    "- 破次元计划2.0 体验页效果项：发丝发光、衣物反重力、头发反重力、碎石+烟雾、暗调、背景净化、自定义效果。",
    "- 产品能力目录（示例）：重塑无瑕皮肤（美颜/磨皮）、雕刻自然美型（液化/瘦脸等）、丰富色彩可能（调色/滤镜）、纯净背景再现（背景处理/抠图/净化）、衣物平整如新、精致手动工具。",
    "- 另有“联机拍摄/工作流”等能力（若用户提到联机相机、工作流、导入导出、设备兼容等，也视为已有方向）。",
    "",
    "你必须完成的输出字段：",
    "1) summary：一句话核心总结（突出要做什么/改什么，中文，<=40字）。",
    "2) details：详细拆解（条目化，写清楚用户痛点、期望效果、可能的验收标准）。",
    "3) userNickname：提取截图中发言者微信昵称/用户名。",
    "   - 优先从【截图左上角/聊天消息头部/头像旁边的名字】提取。",
    "   - 多个名字时，优先提取“正在表达需求/提意见”的那个人。",
    "   - 找不到则返回空字符串。",
    "4) category：必须严格从以下三类中选择其一（只能三选一）：",
    '   - "二次元新功能需求"：像素蛋糕现有功能不覆盖，需要新增的二次元向能力/玩法/特效/社区互动等。',
    '   - "现有破次元活动功能优化"：与“破次元计划/特效玩法”相关，或属于像素蛋糕已有能力（美颜/磨皮、液化/美型、调色滤镜、背景处理/抠图/净化等）的体验优化（更自然/更稳定/更好用/更丰富）。',
    '   - "非二次元需求"：偏通用修图需求、非二次元玩法，或与业务/流程/设备/账号/付费等非二次元功能相关。',
    "   关键规则：如果 AI 判断该需求“像素蛋糕已有功能但效果不好/不自然/不好用/失败率高/体验差”，必须归类为【现有破次元活动功能优化】。",
    "",
    "分类要求（非常重要）：你必须先对照“像素蛋糕现有能力线索”，判断是新增、优化还是非二次元，再决定 category。",
    "",
    "5) essenceKey：核心需求本质（中文短语，2~10字，尽量稳定可复用，用于把‘本质相同’的需求聚合排名）。",
    "   - 同义表达必须归并到同一个 essenceKey。",
    "   - 示例：脸太圆/下巴想尖/瘦脸 → essenceKey=二次元脸型液化；背景穿帮/背景净化/抠图边缘毛糙 → essenceKey=背景处理优化。",
    "   - essenceKey 需要能让运营/产品一眼看懂，不要句子，不要带标点。",
    "",
    '输出格式要求：你必须仅返回“纯 JSON 对象字符串”，严禁包含任何开头解释、结尾总结、Markdown 代码块（```json）、标签或多余文本。',
    '请以 JSON 格式返回：{ "summary": "...", "category": "二次元新功能需求|现有破次元活动功能优化|非二次元需求", "details": "...", "userNickname": "...", "essenceKey": "..." }',
  ].join("\n");

function extractJsonCandidate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // 1) 去掉 ```json ... ``` 或 ``` ... ``` 包裹
  const fenced =
    text.match(/```json\s*([\s\S]*?)\s*```/i) ??
    text.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  // 2) 若包含多余客套话，尝试截取第一段 JSON 对象 {...}
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
  // 兼容部分 OpenAI 兼容网关：content 可能是数组分段
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

export async function POST(req: Request) {
  // 使用 OpenAI 兼容协议的国内可直连服务（SiliconFlow / DeepSeek / 其他中转）
  // 通过环境变量配置 baseURL + key + model
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL || "gpt-4o";
  if (!apiKey) {
    return Response.json({ error: "Missing env: AI_API_KEY" }, { status: 500 });
  }
  if (!baseURL) {
    return Response.json({ error: "Missing env: AI_BASE_URL" }, { status: 500 });
  }

  const body = (await req.json()) as AnalyzeBody;
  const images = body?.images ?? [];
  const note = String(body?.note ?? "").trim();

  if (!Array.isArray(images) || images.length === 0) {
    return Response.json({ error: "images is required" }, { status: 400 });
  }
  if (images.length > 10) {
    return Response.json({ error: "too many images (max 10)" }, { status: 400 });
  }

  const client = new OpenAI({ apiKey, baseURL });

  const userText = [
    "你必须仅返回纯 JSON（不要 Markdown、不要解释、不要客套话、不要前后多余文本）。",
    "补充要求：请特别关注聊天截图左上角/消息头部处的昵称文本。",
    note ? `补充的原始文字备注：${note}` : "补充的原始文字备注：无",
  ].join("\n");

  const content: any[] = [{ type: "text", text: userText }];
  for (const img of images) {
    if (img?.type === "data_url" && typeof (img as any).data_url === "string") {
      content.push({ type: "image_url", image_url: { url: (img as any).data_url } });
      continue;
    }
    if (img?.type === "url" && typeof (img as any).url === "string") {
      content.push({ type: "image_url", image_url: { url: (img as any).url } });
      continue;
    }
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
    const status = Number(e?.status ?? 0) || 500;
    const traceId =
      (typeof e?.headers?.get === "function" && e.headers.get("x-siliconcloud-trace-id")) ||
      undefined;
    return Response.json(
      {
        error: `上游模型调用失败（HTTP ${e?.status ?? "?"}）`,
        hint:
          status === 403
            ? "403 通常是 Key 无效/未开通权限/额度不足/模型不可用。请检查 SiliconFlow 控制台：API Key、余额、以及该模型是否可用。"
            : "请检查 AI_BASE_URL / AI_MODEL 配置是否正确。",
        trace_id: traceId,
      },
      { status: 502 }
    );
  }

  // 兼容/诊断：部分网关可能把 JSON 响应包成字符串返回；或 baseURL 配错时返回 HTML 页面
  if (typeof resp === "string") {
    const s = resp.trim();
    if (s.startsWith("<!doctype html") || s.startsWith("<html") || s.includes("<title>")) {
      console.error("[analyze] Upstream returned HTML. Check AI_BASE_URL:", baseURL);
      return Response.json(
        {
          error: "上游接口返回了 HTML 页面（base_url 可能指向了管理后台而非模型 API）",
          hint:
            "请把 AI_BASE_URL 改成真正的 OpenAI 兼容 API 根路径（通常以 /v1 结尾），例如 https://api2.photoliv.com/v1（不要用 /keys/v1）。",
        },
        { status: 502 }
      );
    }
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        resp = JSON.parse(s);
      } catch {
        // 保留原字符串，后续会报结构不兼容并打印
      }
    }
  }

  const firstChoice = resp?.choices?.[0];
  if (!firstChoice) {
    console.error("[analyze] Unexpected upstream response shape (no choices[0]):", resp);
    return Response.json(
      {
        error: "上游接口返回结构不兼容（缺少 choices[0]）",
        hint:
          "如果你配置的 AI_BASE_URL 指向了网页（HTML），请改成 OpenAI 兼容 API（/v1）。否则请让公司平台确认是否完全兼容 OpenAI Chat Completions 返回结构（choices[].message.content）。",
      },
      { status: 502 }
    );
  }

  const rawContent = firstChoice?.message?.content;
  const text = typeof rawContent === "string" ? rawContent.trim() : "";
  const coerced = coerceMessageContentToText(rawContent).trim();
  const finalText = (coerced || text || "").trim();
  const parsed = safeJsonParse(finalText) ?? {};

  const summary = String(parsed.summary ?? "").trim();
  const category = String(parsed.category ?? "").trim();
  const details = String(parsed.details ?? "").trim();
  const userNickname = String(parsed.userNickname ?? "").trim();
  const essenceKey = String(parsed.essenceKey ?? "").trim();

  if (!summary || !category || !details || !essenceKey) {
    // 解析失败时打印原始内容，便于排查公司网关返回格式
    console.error("[analyze] AI raw content:", finalText);
    if (!finalText) {
      console.error("[analyze] Empty content. Full choice excerpt:", firstChoice);
    }
    return Response.json(
      {
        error: "AI 返回内容不符合预期 JSON",
        raw: finalText,
      },
      { status: 502 }
    );
  }

  return Response.json({ summary, category, details, userNickname, essenceKey });
}

