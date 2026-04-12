import { getSupabaseAdminOrError } from "@/lib/supabase/server";
import {
  AnalyzeFeedbackError,
  analyzeFeedbackWithAi,
  type AnalyzeFeedbackResult,
} from "@/lib/ai/analyze-feedback";

export const runtime = "nodejs";

function parseBooleanFormValue(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

function buildSourceContext(opts: {
  source: string;
  sourceGroup: string;
  sourceTime: string;
  sourceSender: string;
  note: string;
  aiDetails: string;
}) {
  const tags: string[] = [];
  if (opts.source) tags.push(`来源: ${opts.source}`);
  if (opts.sourceGroup) tags.push(`群聊: ${opts.sourceGroup}`);
  if (opts.sourceTime) tags.push(`时间: ${opts.sourceTime}`);
  if (opts.sourceSender) tags.push(`发送者: ${opts.sourceSender}`);

  const blocks: string[] = [];
  if (tags.length > 0) blocks.push(`[${tags.join("] [")}]`);
  if (opts.note) blocks.push(`原文：${opts.note}`);
  if (opts.aiDetails) blocks.push(opts.aiDetails);
  return blocks.filter(Boolean).join("\n\n");
}

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

  const select =
    "id, created_at, updated_at, user_nickname, operator_name, category, essence_key, weight, title, detail, status, needs_review, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary";

  const needsReviewFilter = searchParams.get("needs_review");

  let query = supabaseAdmin
    .from("feedback_submissions")
    .select(select)
    .order("created_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);
  if (needsReviewFilter === "true") query = query.eq("needs_review", true);
  if (needsReviewFilter === "false") query = query.eq("needs_review", false);

  const { data, error } = await query.returns<FeedbackRow[]>();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ items: data ?? [] });
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
  const source = String(formData.get("source") ?? "").trim();
  const sourceGroup = String(formData.get("source_group") ?? "").trim();
  const sourceTime = String(formData.get("source_time") ?? "").trim();
  const sourceSender = String(formData.get("source_sender") ?? "").trim();
  const autoAnalyze = parseBooleanFormValue(formData.get("auto_analyze"));
  const formNeedsReview = parseBooleanFormValue(formData.get("needs_review"));

  if (!userNickname || !operatorName) {
    return Response.json(
      { error: "user_nickname and operator_name are required" },
      { status: 400 }
    );
  }
  if (!["乌木", "青柠"].includes(operatorName)) {
    return Response.json({ error: "invalid operator_name" }, { status: 400 });
  }

  if (!note && !providedTitle) {
    return Response.json(
      { error: "至少需要提供 note（用户原话）或 title" },
      { status: 400 }
    );
  }

  const screenshotFiles = formData.getAll("screenshots");
  const fallbackSingle = formData.get("screenshot");
  const firstFileCandidate = screenshotFiles?.[0] ?? fallbackSingle;
  const hasScreenshot =
    !!firstFileCandidate &&
    typeof (firstFileCandidate as any).arrayBuffer === "function";

  const id = crypto.randomUUID();

  let screenshotPublicUrl: string | null = null;
  let objectPath: string | null = null;

  if (hasScreenshot) {
    const file = firstFileCandidate as File;
    const extFromName = (() => {
      const name = file.name || "";
      const m = name.match(/\.([a-zA-Z0-9]+)$/);
      return m?.[1]?.toLowerCase();
    })();
    const ext = extFromName || (file.type === "image/png" ? "png" : "jpg");

    objectPath = `${id}/${id}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());

    const uploadRes = await supabaseAdmin.storage
      .from("screenshots")
      .upload(objectPath, buf, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadRes.error) {
      return Response.json(
        { error: uploadRes.error.message },
        { status: 500 }
      );
    }

    const { data: publicData } = supabaseAdmin.storage
      .from("screenshots")
      .getPublicUrl(objectPath);
    screenshotPublicUrl = publicData.publicUrl;
  }

  const needsPlatformAnalysis =
    autoAnalyze ||
    (!providedTitle && !providedCategory && !providedDetails && !providedEssenceKey);

  let analyzed: AnalyzeFeedbackResult | null = null;

  if (needsPlatformAnalysis) {
    try {
      const images =
        screenshotPublicUrl
          ? [{ type: "url" as const, url: screenshotPublicUrl }]
          : [];
      analyzed = await analyzeFeedbackWithAi({ note, images });
    } catch (e: any) {
      if (e instanceof AnalyzeFeedbackError) {
        return Response.json(
          { error: e.message, ...(e.details ?? {}) },
          { status: e.status }
        );
      }
      return Response.json(
        { error: e?.message ?? "平台自动分析失败" },
        { status: 500 }
      );
    }
  }

  const aiModel = process.env.AI_MODEL || null;
  const sourceCtx = buildSourceContext({
    source,
    sourceGroup,
    sourceTime,
    sourceSender: sourceSender || userNickname,
    note,
    aiDetails: "",
  });

  const demands =
    analyzed && analyzed.demands.length > 0
      ? analyzed.demands
      : [
          {
            summary: providedTitle || "（待总结）",
            category: providedCategory || "用户其他反馈",
            details: providedDetails || "",
            essenceKey: providedEssenceKey || providedTitle || "（待总结）",
          },
        ];

  const needsReview = formNeedsReview || (analyzed?.needsReview === true);

  const insertRows = demands.map((demand) => ({
    id: crypto.randomUUID(),
    user_nickname: userNickname,
    operator_name: operatorName,
    category: demand.category,
    essence_key: demand.essenceKey,
    title: demand.summary,
    detail:
      demand.details
        ? [sourceCtx, demand.details].filter(Boolean).join("\n\n")
        : sourceCtx || note || "",
    status: "pending" as const,
    needs_review: needsReview,
    screenshot_bucket: objectPath ? "screenshots" : null,
    screenshot_path: objectPath,
    screenshot_public_url: screenshotPublicUrl,
    ai_summary: demand.summary,
    ai_error: null,
    ai_model: aiModel,
  }));

  const { data, error } = await supabaseAdmin
    .from("feedback_submissions")
    .insert(insertRows)
    .select(
      "id, created_at, updated_at, user_nickname, operator_name, category, essence_key, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary"
    )
    .returns<FeedbackRow[]>();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    items: data ?? [],
    item: data?.[0] ?? null,
    demand_count: demands.length,
  });
}

