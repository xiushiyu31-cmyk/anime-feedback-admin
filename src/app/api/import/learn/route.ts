import { getSupabaseAdminOrError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type CorrectionItem = {
  original_text: string;
  ai_essence_key: string;
  ai_category: string;
  corrected_essence_key: string;
  corrected_category: string;
};

export async function POST(req: Request) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const corrections: CorrectionItem[] = Array.isArray(body?.corrections) ? body.corrections : [];
  if (corrections.length === 0) {
    return Response.json({ ok: true, saved: 0 });
  }

  const rows = corrections
    .filter((c) => {
      const catChanged = c.ai_category !== c.corrected_category;
      const ekChanged = c.ai_essence_key !== c.corrected_essence_key;
      return catChanged || ekChanged;
    })
    .map((c) => {
      const catChanged = c.ai_category !== c.corrected_category;
      const ekChanged = c.ai_essence_key !== c.corrected_essence_key;
      return {
        original_text: String(c.original_text ?? "").slice(0, 500),
        ai_essence_key: String(c.ai_essence_key ?? "").slice(0, 100),
        ai_category: String(c.ai_category ?? "").slice(0, 50),
        corrected_essence_key: String(c.corrected_essence_key ?? "").slice(0, 100),
        corrected_category: String(c.corrected_category ?? "").slice(0, 50),
        correction_type: catChanged && ekChanged ? "both" : catChanged ? "category" : "essence_key",
      };
    });

  if (rows.length === 0) {
    return Response.json({ ok: true, saved: 0 });
  }

  const { error } = await client.from("ai_learning_examples").insert(rows);
  if (error) {
    console.error("[import/learn] insert error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, saved: rows.length });
}

export async function GET() {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });

  const { data, error } = await client
    .from("ai_learning_examples")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ examples: data ?? [] });
}
