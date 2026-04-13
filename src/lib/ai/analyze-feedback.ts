import OpenAI from "openai";
import { getSupabaseAdminOrError } from "@/lib/supabase/server";
import { forceCorrectCategory } from "./category-rules";

export type AnalyzeFeedbackImageInput =
  | { type: "data_url"; data_url: string }
  | { type: "url"; url: string };

export type AnalyzeFeedbackInput = {
  note?: string;
  images: AnalyzeFeedbackImageInput[];
};

export type AnalyzeFeedbackDemand = {
  summary: string;
  category: string;
  details: string;
  essenceKey: string;
};

export type AnalyzeFeedbackResult = {
  /** 从输入中拆解出的所有独立需求 */
  demands: AnalyzeFeedbackDemand[];
  userNickname: string;
  /** AI 无法确定时标记为需要人工审核 */
  needsReview: boolean;
  /** 兼容旧调用方：取 demands[0] 的字段 */
  summary: string;
  category: string;
  details: string;
  essenceKey: string;
};

export class AnalyzeFeedbackError extends Error {
  status: number;
  details?: Record<string, unknown>;

  constructor(message: string, status = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = "AnalyzeFeedbackError";
    this.status = status;
    this.details = details;
  }
}

const SYSTEM_PROMPT = [
  "你是\"像素蛋糕（PixCake）二次元/修图产品\"的资深产品经理 + 运营分析师。",
  "用户可能上传社群聊天截图/修图参考图，也可能只提供用户原话文字。",
  "你需要：识别文字（和画面信息，如有），把需求结构化落库。",
  "",
  "## 核心规则：多需求拆分",
  "一段用户原话中可能包含多个独立需求。你必须把每个需求拆解为独立的条目。",
  "例如用户说了 3 件不同的事，就拆成 3 条 demand。",
  "如果只有 1 个需求，就返回 1 条。",
  "如果整段内容完全不包含任何需求或有价值反馈，demands 返回空数组。",
  "",
  "### 准确理解用户真正想要什么",
  "不要只看用户说的表面文字，要理解背后的真实诉求。",
  "例如用户说\"根据图片识别衣服来加特效\"，不要简单写成\"自定义识别对象加特效\"——用户真正想要的是\"系统能根据 cosplay 角色的衣物/场景自动匹配该角色专属特效\"。",
  "再如用户说\"文案可以优化一下\"，如果上下文是在讨论性能配置门槛，那核心诉求是\"降低硬件要求\"而不是\"优化文案\"。",
  "",
  "### 不要把同一个需求的不同表述拆成多条",
  "如果用户反复强调同一件事（如\"鸿蒙版什么时候上创意模块\" + \"鸿蒙版更新太慢了\"），这是同一个需求，合并为一条即可。",
  "判断标准：如果两条 demand 解决的是同一个问题，就应该合并。只有完全不相关的问题才拆分。",
  "",
  "### 以下情况必须返回空 demands（不是需求）：",
  "- 纯闲聊/表情/打招呼/\"好的\"/\"收到\"/\"谢谢\"",
  "- **日常客服咨询**：问下载链接、问价格多少钱、问怎么安装、问怎么注册、问售后、问发货、问客服联系方式等。这些是运营日常接待的问题，不需要产品侧记录。",
  "- **收费/扣费/计费规则咨询**：问免费次数用完后怎么办、问扣费顺序（先扣哪个）、问会员权益包含什么、问续费方式等。这些是在了解现有计费规则，不是在提需求。",
  "- **使用方法咨询**：问某个功能怎么用、问操作步骤、问在哪里找到某个入口等。",
  "- **用户抱怨反馈没人回复/客服响应慢**：这是客服服务问题，不是产品功能需求。运营已在处理中。",
  "- **用户发视频但没有文字描述具体问题**：如果用户只发了视频/图片，没有用文字说明遇到了什么问题，AI 无法判断具体需求，此时 demands 返回空数组，并在返回的 JSON 中额外添加 \"needsReview\": true 字段，表示需要人工审核。",
  "- **活动相关闲聊与运营沟通**：看到活动海报/卡片的随口反应、问活动怎么参加、用户参与发帖/打卡活动的对话（运营审核用户发帖是否符合规则、告知用户文案/图片不符合要求等）、用户提交活动作品等。这些都是运营日常工作内容，不是产品需求。",
  "- **对已上线功能的夸奖/正面反馈**：用户说\"之前要的功能上线了好开心\"、\"新出的xx好好用\"、\"终于有了\"等。这是对已完成需求的正面确认，说明需求已经被满足，不需要再次登记为新需求。",
  "- 转发文章/广告/推广内容",
  "- 群公告/通知类消息（非用户自发反馈）",
  "",
  "### 以下情况算作需求（归为\"用户其他反馈\"）：",
  "- 用户在询问**功能相关**问题（如\"功能会不会没了\"、\"有没有预设分享\"、\"什么时候上新功能\"），虽然不是明确需求，但反映了用户对产品的关注点。",
  "- 用户**对收费规则表达不满或提出建议**（如\"太贵了希望便宜点\"、\"希望定稿后再扣费\"），这是需求。",
  "",
  "### 关键区分：咨询 vs 需求（非常重要）",
  "用户只是在\"问事情\"→ 咨询 → 不记录；用户在\"提意见/表达不满/要求改进\"→ 需求 → 记录。",
  "- \"免费次数用完了还能用吗\" → 咨询（空 demands）",
  "- \"免费次数太少了能不能多给几次\" → 需求（用户其他反馈）",
  "- \"扣费是先扣哪个\" → 咨询（空 demands）",
  "- \"希望先扣免费的不要扣付费的\" → 需求（用户其他反馈）",
  "- \"Mac版怎么下载\" → 咨询（空 demands）",
  "- \"Mac版闪退太严重了\" → 需求（软件非破次元功能需求）",
  "- \"这是又有活动了？\" → 咨询（空 demands）",
  "- \"希望多来武汉办活动\" → 需求（用户其他反馈）",
  "",
  "## 像素蛋糕能力分层（非常重要，决定分类）",
  "",
  "### 破次元/二次元专属能力（已有或可能新增）：",
  "- 破次元计划 2.0 体验页效果项：发丝发光、衣物反重力、头发反重力、碎石+烟雾、暗调、背景净化、自定义效果。",
  "- 粒子特效：羽毛/火焰/雷电/樱花/雪花等。",
  "- 其他二次元专属：二次元风格转换、二次元发型、二次元美瞳、去打底裤/祛底裤、辉光、打光特效、去腿毛/祛腿毛、祛鼻贴、去脸部贴纸、增加乳沟、裙摆扩大、武器素材、cos特效、漫画脸、眼睛发光、动画头发/头发动态效果、文字指令生成式修图/AI生成修图、AI布景、AI自定义上传素材、亮度对比度加深（特效相关）、天空替换、背景替换（二次元向）等。",
  "- **关键规则：任何跟\"祛/去/消除/修复/增加/添加/生成/动画/特效/素材/美瞳/发型/辉光/粒子/打光\"相关的需求都属于破次元范畴。**",
  "",
  "### 通用修图能力（不属于破次元，属于\"软件非破次元功能\"）：",
  "- 美颜/磨皮、液化/瘦脸/美型、调色/滤镜。",
  "- 背景处理/抠图（通用抠图，非破次元特效）。",
  "- 衣物平整、手动工具/画笔（通用画笔）。",
  "- 联机拍摄/工作流、导入导出、设备兼容、快捷键、镜头矫正。",
  "- 创意模块的通用功能（AI 背景替换等非二次元向功能）。",
  "- 付费/会员/账号/设备兼容等。",
  "",
  "## 分类体系（四选一，每条 demand 独立分类）",
  "",
  "1. \"现有破次元功能优化\"",
  "   定义：上面\"破次元专属能力\"列表中已有的功能，但用户觉得效果不好/不够灵活/成功率低/需要更多控制。",
  "   示例：头发反重力成功率低、头发多色时颜色不准、发丝发光边缘闪烁、粒子特效颜色不能调节、暗调效果把好光去掉、破次元功能希望进入客户端/创意模块。",
  "",
  "2. \"破次元新功能需求\"",
  "   定义：当前破次元专属能力中不具备的二次元/破次元向新功能、新玩法、新特效。",
  "   示例：画头发功能、自定义美瞳、辉光功能、侧逆光/打光、去打底裤、自定义素材上传融合、真人转二次元风格。",
  "",
  "3. \"软件非破次元功能需求\"",
  "   定义：与破次元/二次元无关的通用修图需求、软件工具功能、付费/账号/设备问题。",
  "   关键规则：美颜/磨皮/液化/瘦脸/美型/调色/滤镜/通用抠图/快捷键/镜头矫正/图层混合/导入导出/会员权益 → 全部归到这一类。",
  "   **性能/设备/内存相关**：用户抱怨卡顿、闪退、希望降低内存/配置门槛、希望低配设备也能用 → 归到这一类。注意用户说的\"文案\"通常指界面上的提示文字，不要误解为\"文案优化需求\"。核心要看用户真正想要什么。",
  "   示例：美颜磨皮太假、液化瘦脸不自然、抠图边缘毛糙、快捷键优化、镜头矫正文件、PS 类编辑功能、图层混合模式、会员权益 bug、导入大文件限制、年龄识别不准、效果预览加载慢。",
  "",
  "4. \"用户其他反馈\"",
  "   定义：不属于上面三类的用户声音，包括：活动建议、对产品的夸奖/认可、线下展会建议、功能是否收费/常驻的疑问、求资源/预设分享、以及任何用户关心但不属于具体功能需求的讨论。",
  "   示例：线下活动无料偏好、夸奖功能好用、询问功能是否长期保留、功能会不会收费、有没有漫展预设分享、转发活动、希望来某城市办活动。",
  "",
  "分类判断规则：",
  "1）先看是否属于\"破次元专属能力\"范畴 → 是 → 已有但不满意→\"现有破次元功能优化\"；不存在→\"破次元新功能需求\"",
  "2）否则看是否属于\"通用修图/软件工具/付费/设备\"→ 是 →\"软件非破次元功能需求\"",
  "3）都不是 →\"用户其他反馈\"",
  "",
  "### 边界分类补充规则（非常重要）",
  "- **上下文决定分类**：文件大小限制、导入限制、分辨率限制等通用问题，如果用户是在讨论二次元/破次元功能时提到的（如引用了二次元相关内容、在讨论破次元效果时说文件太大），则应归为\"现有破次元功能优化\"而非\"软件非破次元功能需求\"。关键看用户是在哪个功能场景下遇到的问题。",
  "- 为已有破次元功能增加新的控制手段（如画笔引导、方向参数、区域选择、强度滑块）→ \"现有破次元功能优化\"（不是新功能）。",
  "  例：头发反重力加画笔引导 → 现有破次元功能优化。",
  "- 破次元 2.0 体验页场景中的\"背景替换/背景特效/背景净化\"效果质量问题 → \"现有破次元功能优化\"。",
  "  例：背景替换成图不够真实（在讨论破次元效果时）→ 现有破次元功能优化。",
  "- 用提示词/文字描述来控制生成背景或效果（当前产品不具备此能力）→ \"破次元新功能需求\"。",
  "  例：希望像 nano banana 那样用提示词描述背景 → 破次元新功能需求。",
  "- 自定义素材上传并智能融合/溶图（用于二次元创作场景）→ \"破次元新功能需求\"。",
  "  例：丢一个素材进去自动溶图 → 破次元新功能需求。",
  "",
  "## 每条 demand 的字段",
  "- summary：一句话标题（<=20字，突出要做什么/改什么）",
  "- category：四选一（见上）",
  "- details：详细描述（用户痛点 + 期望效果）",
  "- essenceKey：用户最终想要达到的效果（一句话，<=30字，描述用户内心真正想要的结果）",
  "  示例：",
  "  - 头发反重力不灵活 → essenceKey=更自由地调整头发反重力的方向和程度",
  "  - 想要辉光功能 → essenceKey=修图时能给照片添加发光效果",
  "  - 特效颜色不能选 → essenceKey=自由调整特效的颜色范围和透明度",
  "  - 磨皮太假 → essenceKey=美颜磨皮更自然不像塑料",
  "  - 功能会不会没了 → essenceKey=关心破次元功能是否长期保留",
  "",
  "## userNickname",
  "- 如果有截图，优先从截图中提取发言者昵称。",
  "- 如果是纯文字，从备注中的发送者信息获取。",
  "- 找不到则返回空字符串。",
  "",
  "## Few-shot 示例",
  "",
  "示例1 输入：\"能不能增加【去打底裤】功能\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"祛打底裤功能\",\"category\":\"破次元新功能需求\",\"details\":\"用户希望在二次元修图中能去除衣物上的穿帮（如打底裤外露），目前无此功能。\",\"essenceKey\":\"去除二次元衣物上的穿帮\"}]}",
  "",
  "示例2 输入：\"美颜磨皮太假了 皮肤像塑料一样 能不能做得自然一点\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"美颜磨皮效果不自然\",\"category\":\"软件非破次元功能需求\",\"details\":\"用户反馈磨皮后皮肤像塑料，缺少真实皮肤质感，希望优化。\",\"essenceKey\":\"美颜磨皮更自然不像塑料\"}]}",
  "",
  "示例3 输入：\"1、希望二次元功能可以集合到创意模块里；2、希望定稿效果后导出再扣点数\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"破次元功能集成到创意模块\",\"category\":\"现有破次元功能优化\",\"details\":\"用户希望将二次元功能整合到创意模块中。\",\"essenceKey\":\"破次元功能进入客户端创意界面\"},{\"summary\":\"创意模块按满意效果计费\",\"category\":\"现有破次元功能优化\",\"details\":\"用户希望确认效果满意后再扣费。\",\"essenceKey\":\"按满意效果计费而非每次都扣费\"}]}",
  "",
  "示例4 输入：\"功能到时间会不会没有了？\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"询问功能是否长期保留\",\"category\":\"用户其他反馈\",\"details\":\"用户关心破次元功能是否为限时活动，希望长期保留。\",\"essenceKey\":\"关心破次元功能是否长期保留\"}]}",
  "",
  "示例5 输入：\"哈哈哈好好看\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例6 输入：\"收到 我知道了\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例9 输入：\"Mac版的下载链接发一下\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例10 输入：\"怎么下载像素蛋糕\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例11 输入：\"多少钱一年\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例12 输入：\"免费三次用完了是不是要付费才能继续用\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例13 输入：\"扣费是先扣快到期的还是先扣付费的\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例14 输入：\"这是又有活动了？\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例16 输入：\"文案记得加上像素蛋糕才能...\" 或 用户发帖/打卡截图 + 运营审核对话",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例18 输入：\"导出后再微调会重复扣次数吗\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例19 输入：\"之前反馈过想要更多美瞳色号 这次上线了 太好了\"",
  "输出：{\"userNickname\":\"\",\"demands\":[]}",
  "",
  "示例15 输入：\"性能模式提示快速仅内存16G及以上设备支持 但我12G的也想用 能不能降低一下门槛\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"降低性能模式内存门槛\",\"category\":\"软件非破次元功能需求\",\"details\":\"用户设备12G内存，但性能模式要求16G以上，希望降低硬件门槛让更多设备可用。\",\"essenceKey\":\"降低性能模式内存要求适配更多设备\"}]}",
  "",
  "示例7 输入：\"各位大佬们有没有漫展的预设分享分享\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"求漫展预设分享\",\"category\":\"用户其他反馈\",\"details\":\"用户在群里求漫展修图预设资源。\",\"essenceKey\":\"希望获取漫展修图预设资源\"}]}",
  "",
  "示例8 输入：\"液化瘦脸的时候 脸型变化太突兀了 不够自然\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"液化瘦脸效果不自然\",\"category\":\"软件非破次元功能需求\",\"details\":\"用户反馈液化瘦脸时脸型变化太突兀，希望更平滑自然。\",\"essenceKey\":\"液化瘦脸变化更平滑自然\"}]}",
  "",
  "示例17 输入：\"app里也应该有那种一句话生成特效的能力 或者根据用户上传的cos图 识别出人物衣服和场景 自动加上符合角色设定的特效\"",
  "输出：{\"userNickname\":\"\",\"demands\":[{\"summary\":\"支持一句话生成特效\",\"category\":\"破次元新功能需求\",\"details\":\"用户希望能通过自然语言描述快速生成二次元特效，而不是依赖固定效果项。\",\"essenceKey\":\"用一句话描述就能生成想要的特效\"},{\"summary\":\"根据cosplay角色自动匹配专属特效\",\"category\":\"破次元新功能需求\",\"details\":\"用户希望上传cosplay照片后，系统能自动识别人物衣物和场景，根据该动漫角色的设定自动添加符合角色背景的专属特效。\",\"essenceKey\":\"识别cosplay角色后自动匹配专属特效\"}]}",
  "",
  "## 输出格式",
  "你必须仅返回纯 JSON 对象，格式：{\"userNickname\":\"...\",\"needsReview\":false,\"demands\":[{...},{...}]}",
  "- needsReview：当你无法确定是否为需求（如用户只发了视频/图片无文字描述、内容模糊不清）时设为 true，否则为 false。",
  "严禁包含开头解释、结尾总结、Markdown 代码块或多余文本。",
].join("\n");

function extractJsonCandidate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const fenced =
    text.match(/```json\s*([\s\S]*?)\s*```/i) ??
    text.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();

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

function normalizeUpstreamResponse(resp: any, baseURL: string) {
  if (typeof resp !== "string") return resp;
  const text = resp.trim();
  if (!text) return resp;

  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.includes("<title>")) {
    throw new AnalyzeFeedbackError("上游接口返回了 HTML 页面（base_url 可能指向了管理后台而非模型 API）", 502, {
      hint: `请把 AI_BASE_URL 改成真正的 OpenAI 兼容 API 根路径（通常以 /v1 结尾），例如 ${baseURL}（不要用后台页面地址）。`,
    });
  }

  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return JSON.parse(text);
    } catch {
      return resp;
    }
  }
  return resp;
}

export async function analyzeFeedbackWithAi(input: AnalyzeFeedbackInput): Promise<AnalyzeFeedbackResult> {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL || "gpt-4o";
  if (!apiKey) throw new AnalyzeFeedbackError("Missing env: AI_API_KEY", 500);
  if (!baseURL) throw new AnalyzeFeedbackError("Missing env: AI_BASE_URL", 500);

  const images = input.images ?? [];
  const note = String(input.note ?? "").trim();
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!hasImages && !note) {
    throw new AnalyzeFeedbackError("至少需要提供 images 或 note", 400);
  }
  if (images.length > 10) {
    throw new AnalyzeFeedbackError("too many images (max 10)", 400);
  }

  const client = new OpenAI({ apiKey, baseURL });

  let learningExamplesPrompt = "";
  try {
    const { client: supabase } = getSupabaseAdminOrError();
    if (supabase) {
      const { data: examples } = await supabase
        .from("ai_learning_examples")
        .select("original_text, ai_category, corrected_category, ai_essence_key, corrected_essence_key")
        .order("created_at", { ascending: false })
        .limit(20);
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
    }
  } catch {
    // 表不存在或查询失败时跳过
  }

  const effectivePrompt = SYSTEM_PROMPT + learningExamplesPrompt;

  const userTextParts = [
    "你必须仅返回纯 JSON（不要 Markdown、不要解释、不要客套话、不要前后多余文本）。",
  ];
  if (hasImages) {
    userTextParts.push("补充要求：请特别关注聊天截图左上角/消息头部处的昵称文本。");
  }
  userTextParts.push(
    note ? `用户原话/文字备注：${note}` : "用户原话/文字备注：无"
  );
  const userText = userTextParts.join("\n");

  const content: any[] = [{ type: "text", text: userText }];
  for (const img of images) {
    if (img?.type === "data_url" && typeof img.data_url === "string") {
      content.push({ type: "image_url", image_url: { url: img.data_url } });
      continue;
    }
    if (img?.type === "url" && typeof img.url === "string") {
      content.push({ type: "image_url", image_url: { url: img.url } });
    }
  }

  let resp: any;
  try {
    resp = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: effectivePrompt },
        { role: "user", content },
      ],
    });
  } catch (e: any) {
    const status = Number(e?.status ?? 0) || 500;
    const traceId =
      (typeof e?.headers?.get === "function" && e.headers.get("x-siliconcloud-trace-id")) || undefined;
    throw new AnalyzeFeedbackError(`上游模型调用失败（HTTP ${e?.status ?? "?"}）`, 502, {
      hint:
        status === 403
          ? "403 通常是 Key 无效/未开通权限/额度不足/模型不可用。请检查模型服务控制台的 API Key、余额和模型权限。"
          : "请检查 AI_BASE_URL / AI_MODEL 配置是否正确。",
      trace_id: traceId,
    });
  }

  resp = normalizeUpstreamResponse(resp, baseURL);

  const firstChoice = resp?.choices?.[0];
  if (!firstChoice) {
    throw new AnalyzeFeedbackError("上游接口返回结构不兼容（缺少 choices[0]）", 502, {
      hint:
        "如果 AI_BASE_URL 指向了网页（HTML），请改成 OpenAI 兼容 API（/v1）。否则请让提供方确认是否兼容 OpenAI Chat Completions 返回结构。",
    });
  }

  const rawContent = firstChoice?.message?.content;
  const text = typeof rawContent === "string" ? rawContent.trim() : "";
  const coerced = coerceMessageContentToText(rawContent).trim();
  const finalText = (coerced || text || "").trim();
  const parsed = safeJsonParse(finalText) ?? {};

  const userNickname = String(parsed.userNickname ?? "").trim();
  const needsReview = parsed.needsReview === true;

  const rawDemands: any[] = Array.isArray(parsed.demands)
    ? parsed.demands
    : [];

  const demands: AnalyzeFeedbackDemand[] = rawDemands
    .map((d: any) => {
      const summary = String(d?.summary ?? "").trim();
      const rawCategory = String(d?.category ?? "").trim();
      const details = String(d?.details ?? "").trim();
      const essenceKey = String(d?.essenceKey ?? "").trim();
      const correctedCategory = forceCorrectCategory(
        essenceKey || summary,
        details || summary,
        rawCategory,
      );
      return { summary, category: correctedCategory, details, essenceKey };
    })
    .filter((d) => d.summary && d.category);

  // 兼容旧格式：如果 AI 没返回 demands 数组但返回了旧的顶层字段
  if (demands.length === 0 && parsed.summary && parsed.category) {
    demands.push({
      summary: String(parsed.summary).trim(),
      category: String(parsed.category).trim(),
      details: String(parsed.details ?? "").trim(),
      essenceKey: String(parsed.essenceKey ?? "").trim(),
    });
  }

  const first = demands[0] ?? {
    summary: "",
    category: "",
    details: "",
    essenceKey: "",
  };

  return {
    demands,
    userNickname,
    needsReview,
    summary: first.summary,
    category: first.category,
    details: first.details,
    essenceKey: first.essenceKey,
  };
}
