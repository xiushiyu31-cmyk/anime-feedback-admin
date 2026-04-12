import { verifySignature, decryptMessage } from "@/lib/scrm/crypto";
import { getSupabaseAdminOrError } from "@/lib/supabase/server";
import { analyzeFeedbackWithAi } from "@/lib/ai/analyze-feedback";

export const runtime = "nodejs";

// --- 事件类型 ---
const EVENT_PASSIVE_GROUP_MSG = 40024;
const EVENT_PASSIVE_PRIVATE_MSG = 40023;

// 仅处理文字消息
const MSG_TYPE_TEXT = 1;

type ScrmEvent = {
  event_type: number;
  msg_type: number;
  msg_id?: string;
  msg_content?: string;
  sender_id?: string;
  receiver_id?: string;
  robot_id?: string;
  sender_union_id?: string;
  sender_external_user_id?: string;
  sender_type?: number;
  msg_time?: string;
  at_list?: string;
  [key: string]: unknown;
};

/**
 * GET: URL 验证（SCRM 平台配置系统事件接收 URL 时会发送验证请求）
 *
 * 平台发 GET 请求，带 msg_signature / timestamp / nonce / echostr
 * 验签通过后，原样返回 echostr（部分平台要求解密后返回）
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const msgSignature = searchParams.get("msg_signature") || searchParams.get("signature") || "";
  const timestamp = searchParams.get("timestamp") || "";
  const nonce = searchParams.get("nonce") || "";
  const echostr = searchParams.get("echostr") || "";

  if (!echostr) {
    return new Response("SCRM Webhook is active", { status: 200 });
  }

  // 验签
  if (msgSignature && !verifySignature(msgSignature, timestamp, nonce, echostr)) {
    console.error("[SCRM webhook] signature verification failed");
    return new Response("signature mismatch", { status: 403 });
  }

  // 尝试解密 echostr，失败则原样返回
  try {
    const decrypted = decryptMessage(echostr);
    return new Response(decrypted, { status: 200, headers: { "Content-Type": "text/plain" } });
  } catch {
    return new Response(echostr, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
}

/**
 * POST: 接收事件回调
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const msgSignature = searchParams.get("msg_signature") || searchParams.get("signature") || "";
  const timestamp = searchParams.get("timestamp") || "";
  const nonce = searchParams.get("nonce") || "";

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ errcode: 400, errmsg: "invalid json" }, { status: 400 });
  }

  // 平台可能直接推 JSON（明文模式）或包裹在 encoding_content 中（加密模式）
  let event: ScrmEvent;

  if (body.encoding_content) {
    // 加密模式：验签 + 解密
    if (msgSignature && !verifySignature(msgSignature, timestamp, nonce, body.encoding_content)) {
      console.error("[SCRM webhook] POST signature verification failed");
      return Response.json({ errcode: 403, errmsg: "signature mismatch" }, { status: 403 });
    }

    try {
      const decrypted = decryptMessage(body.encoding_content);
      event = JSON.parse(decrypted);
    } catch (e: any) {
      console.error("[SCRM webhook] decrypt failed:", e?.message);
      return Response.json({ errcode: 500, errmsg: "decrypt failed" }, { status: 500 });
    }
  } else if (body.event_type) {
    // 明文模式
    event = body as ScrmEvent;
  } else {
    console.log("[SCRM webhook] unknown body format:", JSON.stringify(body).slice(0, 200));
    return Response.json({ errcode: 0, errmsg: "ok" });
  }

  console.log(`[SCRM webhook] event_type=${event.event_type} msg_type=${event.msg_type} sender=${event.sender_id}`);

  // 快速响应 SCRM 平台（避免超时重发），异步处理消息
  // Next.js edge/node 不支持 waitUntil，用 fire-and-forget
  processEventAsync(event).catch((err) => {
    console.error("[SCRM webhook] processEvent error:", err);
  });

  return Response.json({ errcode: 0, errmsg: "ok" });
}

// ========== 异步消息处理 ==========

async function processEventAsync(event: ScrmEvent) {
  // 仅处理被动群消息中的文字消息
  if (event.event_type !== EVENT_PASSIVE_GROUP_MSG) {
    console.log(`[SCRM] skip event_type=${event.event_type}`);
    return;
  }
  if (event.msg_type !== MSG_TYPE_TEXT) {
    console.log(`[SCRM] skip non-text msg_type=${event.msg_type}`);
    return;
  }

  const content = String(event.msg_content ?? "").trim();
  if (!content || content.length < 4) {
    console.log("[SCRM] skip too short message");
    return;
  }

  // 跳过机器人自己和员工发的消息，只处理外部用户
  // sender_type: 0=机器人, 1=员工, 2=微信外部联系人, 3=企微外部联系人
  if (event.sender_type === 0 || event.sender_type === 1) {
    console.log(`[SCRM] skip internal sender_type=${event.sender_type}`);
    return;
  }

  console.log(`[SCRM] processing group msg: "${content.slice(0, 80)}" from sender=${event.sender_id} group=${event.receiver_id}`);

  // AI 分析
  let analyzed;
  try {
    analyzed = await analyzeFeedbackWithAi({ note: content, images: [] });
  } catch (e: any) {
    console.error("[SCRM] AI analysis failed:", e?.message);
    return;
  }

  // 如果 AI 判断无有效需求（纯闲聊），跳过
  if (!analyzed.demands || analyzed.demands.length === 0) {
    console.log("[SCRM] AI found no demands, skipping");
    return;
  }

  // 入库
  const { client } = getSupabaseAdminOrError();
  if (!client) {
    console.error("[SCRM] missing Supabase env");
    return;
  }

  const aiModel = process.env.AI_MODEL || null;
  const sourceInfo = [
    `[来源: SCRM-Webhook]`,
    event.receiver_id ? `[群ID: ${event.receiver_id}]` : "",
    event.sender_id ? `[发送者ID: ${event.sender_id}]` : "",
    event.msg_time ? `[时间: ${event.msg_time}]` : "",
    `\n\n原文：${content}`,
  ].filter(Boolean).join(" ");

  const rows = analyzed.demands.map((demand) => ({
    id: crypto.randomUUID(),
    user_nickname: analyzed.userNickname || event.sender_id || null,
    operator_name: null,
    category: demand.category,
    essence_key: demand.essenceKey,
    title: demand.summary,
    detail: [sourceInfo, demand.details].filter(Boolean).join("\n\n"),
    status: "pending" as const,
    screenshot_bucket: "screenshots",
    screenshot_path: null,
    screenshot_public_url: null,
    ai_summary: demand.summary,
    ai_error: null,
    ai_model: aiModel,
  }));

  const { error } = await client.from("feedback_submissions").insert(rows);

  if (error) {
    console.error("[SCRM] insert failed:", error.message);
    return;
  }

  console.log(`[SCRM] inserted ${rows.length} demand(s) from group message`);
}
