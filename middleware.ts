export { auth as proxy } from "@/auth";

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - /login (the sign-in page itself)
     * - /api/auth/* (Auth.js route handler)
     * - /_next/static, /_next/image (Next.js internals)
     * - /favicon.ico, /nstarx-logo.png (static assets)
     */
    "/((?!login|api/auth|_next/static|_next/image|favicon\\.ico|Logo\\.png).*)",
  ],
};
