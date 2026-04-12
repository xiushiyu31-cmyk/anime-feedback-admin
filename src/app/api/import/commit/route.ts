import { getSupabaseAdminOrError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type CommitBody = {
  operatorName?: string; // 可选：导入时指定归属运营官
  items: Array<{
    essence_key: string;
    original_text: string;
    category: string;
    weight?: number;
    image_data_url?: string | null;
    image_url?: string | null; // xlsx 里可能是链接
  }>;
};

import { normalizeCategoryToDb } from "@/lib/constants/categories";

type InsertPayload = Record<string, unknown>;

function dataUrlToBuffer(dataUrl: string): { buf: Buffer; contentType: string; ext: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error("invalid data_url");
  const contentType = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, "base64");
  const ext =
    contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
        ? "webp"
        : contentType === "image/jpeg"
          ? "jpg"
          : "png";
  return { buf, contentType, ext };
}


export async function POST(req: Request) {
  const { client, error: envErr } = getSupabaseAdminOrError();
  if (!client) return Response.json({ error: envErr ?? "Missing Supabase env" }, { status: 500 });
  const supabaseAdmin = client;
  const body = (await req.json()) as CommitBody;
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) {
    return Response.json({ error: "items is required" }, { status: 400 });
  }
  if (items.length > 50) {
    return Response.json({ error: "too many items (max 50)" }, { status: 400 });
  }

  const operatorName = String(body?.operatorName ?? "").trim();
  if (operatorName && !["乌木", "青柠"].includes(operatorName)) {
    return Response.json({ error: "invalid operatorName" }, { status: 400 });
  }

  const createdIds: string[] = [];

  for (const it of items) {
    const essenceKey = String(it?.essence_key ?? "").trim();
    const originalText = String(it?.original_text ?? "").trim();
    const category = normalizeCategoryToDb(String(it?.category ?? "").trim() || "其他");
    const weight = Math.max(1, Math.min(10, Math.round(Number(it?.weight ?? 3) || 3)));
    const imageDataUrl = it?.image_data_url ? String(it.image_data_url) : "";
    const imageUrl = it?.image_url ? String(it.image_url).trim() : "";

    if (!essenceKey || !originalText) continue;

    const id = crypto.randomUUID();

    let screenshotPublicUrl: string | null = null;
    let screenshotPath: string | null = null;
    if (imageDataUrl && imageDataUrl.startsWith("data:")) {
      try {
        const { buf, contentType, ext } = dataUrlToBuffer(imageDataUrl);
        const objectPath = `${id}/${id}.${ext}`;
        const uploadRes = await supabaseAdmin.storage.from("screenshots").upload(objectPath, buf, {
          contentType,
          upsert: false,
        });
        if (!uploadRes.error) {
          screenshotPath = objectPath;
          const { data: publicData } = supabaseAdmin.storage
            .from("screenshots")
            .getPublicUrl(objectPath);
          screenshotPublicUrl = publicData.publicUrl;
        }
      } catch {
        // 忽略图片失败，仍可入库文字
      }
    }
    // 如果是链接图片（xlsx），直接存 public_url，暂不做下载入库
    if (!screenshotPublicUrl && imageUrl && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) {
      screenshotPublicUrl = imageUrl;
    }

    const title = essenceKey;
    const detail = originalText;

    const payload: InsertPayload = {
      id,
      user_nickname: null,
      operator_name: operatorName || null,
      category,
      essence_key: essenceKey,
      title,
      detail,
      weight,
      status: "pending",
      // feedback_submissions.screenshot_bucket is NOT NULL in schema;
      // keep it stable even when this imported row has no image.
      screenshot_bucket: "screenshots",
      screenshot_path: screenshotPath,
      screenshot_public_url: screenshotPublicUrl,
      ai_summary: title,
      ai_error: null,
      ai_model: process.env.AI_MODEL || null,
    };

    const { error } = await supabaseAdmin.from("feedback_submissions").insert(payload);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    createdIds.push(id);
  }

  return Response.json({ ok: true, created: createdIds.length, ids: createdIds });
}

