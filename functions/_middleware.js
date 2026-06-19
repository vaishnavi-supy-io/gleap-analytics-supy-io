import { verifySession, getSessionCookie } from './_shared/session.js';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
];

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Allow public auth routes and static assets through
  if (PUBLIC_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p + '?'))) {
    return next();
  }

  const token = getSessionCookie(request);
  const email = token ? await verifySession(token, env.SESSION_SECRET) : null;

  if (!email) {
    // Preserve the original destination for redirect after login
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('next', url.pathname + url.search);
    return Response.redirect(loginUrl.toString(), 302);
  }

  // Attach email to request headers so functions can read it if needed
  const modifiedRequest = new Request(request, {
    headers: new Headers({ ...Object.fromEntries(request.headers), 'X-User-Email': email }),
  });
  return next(modifiedRequest);
}
