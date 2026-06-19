import { signSession, makeSessionCookie } from '../../_shared/session.js';

const ALLOWED_DOMAIN = 'supy.io';

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) {
    return Response.redirect('/login?error=no_code', 302);
  }

  // Verify CSRF nonce: cookie set in login.js must match nonce embedded in state
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookieNonce = cookieHeader.split(';').map(c => c.trim())
    .find(c => c.startsWith('oauth_state='))?.slice('oauth_state='.length) || '';

  let next = '/';
  try {
    const decoded = JSON.parse(atob(state));
    // Reject if nonce is missing or doesn't match the cookie
    if (!decoded.nonce || decoded.nonce !== cookieNonce) {
      return Response.redirect('/login?error=invalid_state', 302);
    }
    // Validate next is a same-origin relative path (prevent open redirect)
    const candidate = decoded.next;
    if (typeof candidate === 'string' && candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.startsWith('/\\')) {
      next = candidate;
    }
  } catch {
    return Response.redirect('/login?error=invalid_state', 302);
  }

  // Exchange code for tokens
  const redirectUri = `${url.origin}/api/auth/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    console.error('Token exchange failed:', await tokenRes.text());
    return Response.redirect('/login?error=token_failed', 302);
  }

  const { access_token } = await tokenRes.json();

  // Fetch user profile to get email
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!profileRes.ok) {
    return Response.redirect('/login?error=profile_failed', 302);
  }

  const { email, name } = await profileRes.json();

  // Enforce @supy.io domain
  if (!email || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    return Response.redirect(`/login?error=unauthorized&email=${encodeURIComponent(email || '')}`, 302);
  }

  // Issue signed session cookie and redirect to original destination
  const token  = await signSession(email, env.SESSION_SECRET);
  const cookie = makeSessionCookie(token);

  console.log(`✅ Login: ${email} (${name})`);
  return new Response(null, {
    status: 302,
    headers: { Location: next, 'Set-Cookie': cookie },
  });
}
