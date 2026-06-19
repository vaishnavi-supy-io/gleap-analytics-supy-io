// Redirects to Google OAuth — stores `next` destination and CSRF nonce in state param
export async function onRequestGet({ request, env }) {
  const url      = new URL(request.url);
  const clientId = env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return new Response('GOOGLE_CLIENT_ID not configured', { status: 500 });
  }

  // Validate next is a same-origin relative path before encoding into state
  const rawNext = url.searchParams.get('next') || '/';
  const next = (typeof rawNext === 'string' && rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\'))
    ? rawNext : '/';

  // Generate a random CSRF nonce — stored in cookie and embedded in state
  const nonce = crypto.randomUUID();
  const state = btoa(JSON.stringify({ next, nonce }));

  const redirectUri = `${url.origin}/api/auth/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         'openid email profile');
  authUrl.searchParams.set('state',         state);
  authUrl.searchParams.set('hd',            'supy.io');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      // Short-lived HttpOnly cookie to verify nonce in callback
      'Set-Cookie': `oauth_state=${nonce}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
