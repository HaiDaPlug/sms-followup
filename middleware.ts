import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { requirePublicConfig } from "@/lib/supabase/keys";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const { url, key } = requirePublicConfig();

  const supabase = createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        }
      }
    }
  );

  // Refresh session — must not run any logic between createServerClient and getUser
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Cron and webhook routes use their own secret auth — skip
  const isPublicApi =
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/api/webhooks/");

  // Allow login page and public API through
  if (pathname === "/login" || isPublicApi) {
    return supabaseResponse;
  }

  // Protect all /app/* and /api/* routes
  const isProtected =
    pathname.startsWith("/app/") ||
    pathname.startsWith("/api/");

  if (isProtected && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Also protect the root redirect
  if (pathname === "/" && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"
  ]
};
