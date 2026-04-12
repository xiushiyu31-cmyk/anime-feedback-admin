import { getSupabaseAdminOrError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Status = "pending" | "processing" | "done";
type PatchBody = {
  status?: string;
  needs_review?: boolean;
  title?: string;
  category?: string;
  detail?: string;
  essence_key?: string;
  ai_summary?: string | null;
  ai_model?: string | null;
  ai_error?: string | null;
};

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  const supabaseAdmin = client;
  const { id } = await context.params;

  const body = (await req.json()) as PatchBody;
  const status = body.status as Status | undefined;

  if (
    status !== undefined &&
    !["pending", "processing", "done"].includes(status)
  ) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (status !== undefined) patch.status = status;
  if (body.needs_review !== undefined) patch.needs_review = body.needs_review;
  if (body.title !== undefined) patch.title = body.title;
  if (body.category !== undefined) patch.category = body.category;
  if (body.detail !== undefined) patch.detail = body.detail;
  if (body.essence_key !== undefined) patch.essence_key = body.essence_key;
  if (body.ai_summary !== undefined) patch.ai_summary = body.ai_summary;
  if (body.ai_model !== undefined) patch.ai_model = body.ai_model;
  if (body.ai_error !== undefined) patch.ai_error = body.ai_error;

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("feedback_submissions")
    .update(patch)
    .eq("id", id)
    .select(
      "id, created_at, updated_at, user_nickname, operator_name, category, essence_key, title, detail, status, screenshot_bucket, screenshot_path, screenshot_public_url, ai_summary"
    )
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ item: data });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  const supabaseAdmin = client;
  const { id } = await context.params;

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("feedback_submissions")
    .select("id, screenshot_bucket, screenshot_path")
    .eq("id", id)
    .single();

  if (rowErr) {
    return Response.json({ error: rowErr.message }, { status: 500 });
  }

  if (row?.screenshot_bucket && row.screenshot_path) {
    await supabaseAdmin.storage.from(row.screenshot_bucket).remove([row.screenshot_path]);
  }

  const { error } = await supabaseAdmin
    .from("feedback_submissions")
    .delete()
    .eq("id", id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}

