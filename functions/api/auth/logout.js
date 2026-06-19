import { clearSessionCookie } from '../../_shared/session.js';

export async function onRequestGet() {
  return new Response(null, {
    status: 302,
    headers: { Location: '/login', 'Set-Cookie': clearSessionCookie() },
  });
}
