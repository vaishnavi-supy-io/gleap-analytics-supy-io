// Redirects to Google OAuth — stores `next` destination in state param
export async function onRequestGet({ request, env }) {
  const url      = new URL(request.url);
  const next     = url.searchParams.get('next') || '/';
  const clientId = env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return new Response('GOOGLE_CLIENT_ID not configured', { status: 500 });
  }

  const redirectUri = `${url.origin}/api/auth/callback`;
  const state       = btoa(JSON.stringify({ next }));

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         'openid email profile');
  authUrl.searchParams.set('state',         state);
  authUrl.searchParams.set('hd',            'supy.io'); // hint to Google to show only supy.io accounts

  return Response.redirect(authUrl.toString(), 302);
}
