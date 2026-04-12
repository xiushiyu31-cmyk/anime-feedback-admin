import { cookies } from "next/headers";

export const runtime = "nodejs";

const AUTH_COOKIE = "admin_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD || "admin123";
}

function makeToken(password: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + ":anime-feedback-salt");
  let hash = 0;
  for (const byte of data) {
    hash = ((hash << 5) - hash + byte) | 0;
  }
  return Math.abs(hash).toString(36);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const password = String(body?.password ?? "").trim();

  if (!password) {
    return Response.json({ error: "密码不能为空" }, { status: 400 });
  }

  if (password !== getAdminPassword()) {
    return Response.json({ error: "密码错误" }, { status: 401 });
  }

  const token = makeToken(password);
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });

  return Response.json({ ok: true });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE);
  return Response.json({ ok: true });
}
