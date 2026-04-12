import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "admin_token";

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

export function middleware(request: NextRequest) {
  const adminPassword = getAdminPassword();
  if (!adminPassword) return NextResponse.next();

  const { pathname } = request.nextUrl;

  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhook/")
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE)?.value;
  const expected = makeToken(adminPassword);

  if (token === expected) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
