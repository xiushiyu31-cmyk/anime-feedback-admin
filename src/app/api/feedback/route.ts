import { getSupabaseAdminOrError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type FeedbackRow = {
  id: string;
  created_at: string;
  updated_at: string;
  user_nickname: string | null;
  operator_name: string | null;
  category: string | null;
  essence_key: string | null;
  weight?: number | null;
  title: string;
  detail: string;
  status: "pending" | "processing" | "done";
  screenshot_bucket: string | null;
  screenshot_path: string | null;
  screenshot_public_url: string | null;
  ai_summary: string | null;
};

export async function GET(req: Request) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) {
    return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  }
  const supabaseAdmin = client;
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "all";

  const baseSelect =
    "id, created_at, updated_at, user_nickname, operator_name, category, essence_key, weight, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary";
  const midSelect =
    "id, created_at, updated_at, user_nickname, operator_name, category, weight, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary";
  const legacySelect =
    "id, created_at, updated_at, category, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary";

  async function run(select: string) {
    let query = supabaseAdmin
      .from("feedback_submissions")
      .select(select)
      .order("created_at", { ascending: false });
    if (status !== "all") query = query.eq("status", status);
    return await query.returns<FeedbackRow[]>();
  }

  const first = await run(baseSelect);
  if (!first.error) return Response.json({ items: first.data ?? [] });

  // 兼容：如果你还没在 Supabase 加新列，先降级查询以保证历史能显示
  const msg = first.error.message || "";
  // 1) 仅缺少 essence_key：先退化到 midSelect（保留 user/operator）
  if (msg.includes("does not exist") && msg.includes("essence_key")) {
    const second = await run(midSelect);
    if (!second.error) return Response.json({ items: second.data ?? [] });
    // 若又报缺 user/operator，则继续走 legacy
    const msg2 = second.error.message || "";
    if (msg2.includes("does not exist") && (msg2.includes("user_nickname") || msg2.includes("operator_name"))) {
      const third = await run(legacySelect);
      if (third.error) return Response.json({ error: third.error.message }, { status: 500 });
      return Response.json({ items: third.data ?? [] });
    }
    return Response.json({ error: second.error.message }, { status: 500 });
  }

  // 2) 缺 user/operator（以及可能缺 essence）：直接退化 legacySelect
  if (msg.includes("does not exist") && (msg.includes("user_nickname") || msg.includes("operator_name"))) {
    const second = await run(legacySelect);
    if (second.error) {
      return Response.json({ error: second.error.message }, { status: 500 });
    }
    return Response.json({ items: second.data ?? [] });
  }
  // 3) 仅缺 weight：退化到不含 weight 的 select（但保留 essence_key 等）
  if (msg.includes("does not exist") && msg.includes("weight")) {
    const noWeightSelect =
      "id, created_at, updated_at, user_nickname, operator_name, category, essence_key, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary";
    const second = await run(noWeightSelect);
    if (!second.error) return Response.json({ items: second.data ?? [] });
    return Response.json({ error: second.error.message }, { status: 500 });
  }

  return Response.json({ error: first.error.message }, { status: 500 });
}

export async function POST(req: Request) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) {
    return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  }
  const supabaseAdmin = client;
  const formData = await req.formData();

  const note = String(formData.get("note") ?? "").trim();
  const userNickname = String(formData.get("user_nickname") ?? "").trim();
  const operatorName = String(formData.get("operator_name") ?? "").trim();
  const providedTitle = String(formData.get("title") ?? "").trim();
  const providedCategory = String(formData.get("category") ?? "").trim();
  const providedDetails = String(formData.get("details") ?? "").trim();
  const providedEssenceKey = String(formData.get("essence_key") ?? "").trim();

  if (!userNickname || !operatorName) {
    return Response.json(
      { error: "user_nickname and operator_name are required" },
      { status: 400 }
    );
  }
  if (!["乌木", "青柠"].includes(operatorName)) {
    return Response.json({ error: "invalid operator_name" }, { status: 400 });
  }

  // 兼容多图：前端会把每张图都以字段名 screenshots 发送
  const screenshotFiles = formData.getAll("screenshots");
  const fallbackSingle = formData.get("screenshot");
  const firstFileCandidate = screenshotFiles?.[0] ?? fallbackSingle;

  if (!firstFileCandidate || typeof (firstFileCandidate as any).arrayBuffer !== "function") {
    return Response.json({ error: "screenshot(s) is required" }, { status: 400 });
  }

  const id = crypto.randomUUID();

  const file = firstFileCandidate as File;
  const extFromName = (() => {
    const name = file.name || "";
    const m = name.match(/\.([a-zA-Z0-9]+)$/);
    return m?.[1]?.toLowerCase();
  })();
  const ext = extFromName || (file.type === "image/png" ? "png" : "jpg");

  const objectPath = `${id}/${id}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const uploadRes = await supabaseAdmin.storage.from("screenshots").upload(objectPath, buf, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });

  if (uploadRes.error) {
    return Response.json({ error: uploadRes.error.message }, { status: 500 });
  }

  const { data: publicData } = supabaseAdmin.storage
    .from("screenshots")
    .getPublicUrl(objectPath);
  const screenshotPublicUrl = publicData.publicUrl;

  const category = providedCategory || "非二次元需求";
  const title = providedTitle || "（待总结）";
  const details = providedDetails || note || "";
  const essenceKey = providedEssenceKey || title;
  const aiSummary = title;
  const aiError: string | null = null;
  const aiModel = process.env.AI_MODEL || null;

  const { data, error } = await supabaseAdmin
    .from("feedback_submissions")
    .insert({
      id,
      user_nickname: userNickname,
      operator_name: operatorName,
      category,
      essence_key: essenceKey,
      title,
      detail: details,
      status: "pending",
      screenshot_bucket: "screenshots",
      screenshot_path: objectPath,
      screenshot_public_url: screenshotPublicUrl,
      ai_summary: aiSummary,
      ai_error: aiError,
      ai_model: aiModel,
    })
    .select(
      "id, created_at, updated_at, user_nickname, operator_name, category, essence_key, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary"
    )
    .single()
    .returns<FeedbackRow>();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ item: data });
}

