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

type InsertPayload = Record<string, unknown>;

function mapImportCategoryToDb(category: string) {
  const s = String(category ?? "").trim();
  // 新导入分类（GPT-4o 归纳）
  if (s === "功能新增" || s === "性能优化" || s === "用户活动" || s === "其他") return s;
  // 兼容旧值/手填（历史三分类）
  if (s === "二次元新需求") return "功能新增";
  if (s === "现有功能优化") return "性能优化";
  if (s === "二次元新功能需求" || s === "现有破次元活动功能优化" || s === "非二次元需求") return s;
  if (s.includes("性能") || s.includes("卡") || s.includes("慢") || s.includes("发热") || s.includes("耗电"))
    return "性能优化";
  if (s.includes("活动") || s.includes("运营")) return "用户活动";
  if (s.includes("新增") || s.includes("支持") || s.includes("增加")) return "功能新增";
  return "其他";
}

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

function omitKeys(payload: InsertPayload, keys: string[]) {
  const next: InsertPayload = { ...payload };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

async function insertFeedbackWithFallback(supabaseAdmin: any, payload: InsertPayload) {
  const variants: InsertPayload[] = [
    payload,
    // 某些线上库虽然 screenshot_bucket 有默认值，但显式写入会被旧逻辑/迁移状态影响，回退为让 DB 默认值接管。
    omitKeys(payload, ["screenshot_bucket"]),
    // 兼容仍处于旧 schema 的库：缺少 user/operator/essence/weight 等列时，至少先把主文本导入进去。
    omitKeys(payload, ["user_nickname", "operator_name", "essence_key", "weight", "ai_error", "ai_model"]),
    omitKeys(payload, [
      "user_nickname",
      "operator_name",
      "essence_key",
      "weight",
      "ai_error",
      "ai_model",
      "screenshot_bucket",
    ]),
  ];

  let lastError: any = null;
  for (const variant of variants) {
    const { error } = await supabaseAdmin.from("feedback_submissions").insert(variant);
    if (!error) return { error: null };
    lastError = error;

    const msg = String(error.message || "");
    const canRetry =
      msg.includes('null value in column "screenshot_bucket"') ||
      (msg.includes("does not exist") &&
        ["user_nickname", "operator_name", "essence_key", "weight", "ai_error", "ai_model", "screenshot_bucket"].some(
          (k) => msg.includes(k)
        ));
    if (!canRetry) break;
  }

  return { error: lastError };
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
    const category = mapImportCategoryToDb(String(it?.category ?? "").trim() || "其他");
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

    const { error } = await insertFeedbackWithFallback(supabaseAdmin, payload);

    if (error) {
      const msg = error.message || "";
      if (msg.includes("essence_key") && msg.includes("does not exist")) {
        return Response.json(
          {
            error: "数据库缺少 essence_key 列，无法导入",
            sql:
              "alter table public.feedback_submissions add column if not exists essence_key text;",
          },
          { status: 400 }
        );
      }
      if (msg.includes("weight") && msg.includes("does not exist")) {
        return Response.json(
          {
            error: "数据库缺少 weight 列，无法写入权重（热度）",
            sql:
              "alter table public.feedback_submissions add column if not exists weight int not null default 1;",
          },
          { status: 400 }
        );
      }
      if (msg.includes("user_nickname") && msg.includes("does not exist")) {
        return Response.json(
          {
            error: "数据库仍是旧版 feedback_submissions 结构，缺少 user_nickname / operator_name 等列；接口已尝试兼容但仍失败",
          },
          { status: 400 }
        );
      }
      if (msg.includes("category")) {
        return Response.json(
          {
            error: "数据库的 category 约束与当前导入分类不兼容，请检查 feedback_submissions.category 的 CHECK 约束",
          },
          { status: 400 }
        );
      }
      return Response.json({ error: error.message }, { status: 500 });
    }

    createdIds.push(id);
  }

  return Response.json({ ok: true, created: createdIds.length, ids: createdIds });
}

