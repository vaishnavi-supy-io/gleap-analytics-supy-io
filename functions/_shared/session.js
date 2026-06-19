// Session cookie helpers using Web Crypto (Workers-native, no libraries needed)

const COOKIE_NAME = 'gleap_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function getHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSession(email, secret) {
  const key = await getHmacKey(secret);
  const ts  = Date.now().toString();
  const data = `${email}|${ts}`;
  const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}|${sigB64}`;
}

export async function verifySession(token, secret) {
  try {
    const lastPipe = token.lastIndexOf('|');
    if (lastPipe === -1) return null;
    const data  = token.slice(0, lastPipe);
    const sigB64 = token.slice(lastPipe + 1);
    const [email, tsStr] = data.split('|');
    if (!email || !tsStr) return null;
    if (Date.now() - parseInt(tsStr) > SESSION_MAX_AGE_MS) return null;

    const key      = await getHmacKey(secret);
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    return valid ? email : null;
  } catch {
    return null;
  }
}

export function getSessionCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function makeSessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
