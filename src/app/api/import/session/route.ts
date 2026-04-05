import { getSupabaseAdminOrError } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** 查询断点续传会话（刷新页面后恢复进度用） */
export async function GET(req: Request) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  const supabaseAdmin = client;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "missing id" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("import_parse_sessions")
    .select(
      "id, created_at, updated_at, storage_path, original_filename, total_rows, next_index, status, last_processed_excel_row"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    const msg = error.message || "";
    if (msg.includes("does not exist") && msg.includes("import_parse_sessions")) {
      return Response.json(
        {
          error: "数据库未创建 import_parse_sessions 表",
          sqlHint: "请执行项目内 supabase/import_parse_sessions.sql",
        },
        { status: 500 }
      );
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  return Response.json({ session: data });
}
