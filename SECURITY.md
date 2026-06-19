# Security & Incident Log — Gleap Dashboard

This document records every security issue found in this project, what went wrong, why it went wrong, how it was fixed, and why that specific approach was chosen. It serves as a reference for future contributors and audits.

---

## Project Background

The Gleap Dashboard started as a simple Express.js analytics app for Supy's support team — a single `server.js` and a single `index.html`. Over time it grew to include a Team Hub attendance tracker, HubSpot ticket integration, an AI chat interface, and a Cloudflare Pages deployment with Google OAuth. Each new feature introduced new attack surface. This document tracks what was found and fixed as the surface expanded.

---

## Issue Log

---

### ISSUE-01 — HubSpot Token Exposed in Browser

**Severity:** Critical  
**File:** `public/team-hub.html`  
**Status:** Fixed

#### What went wrong

The original Team Hub made HubSpot API calls directly from the browser. The HubSpot Private App token was embedded in the JavaScript so the browser could authenticate directly against `api.hubapi.com`. Anyone who opened DevTools could copy the token and make arbitrary HubSpot API calls — reading, modifying, or deleting CRM data — with no restrictions.

#### Why it went wrong

The feature was built quickly to prove it worked. Putting the token in the browser is the shortest path to a working demo. The risk was not surfaced until the feature was in use.

#### How it was fixed

A server-side proxy endpoint `/api/hubspot` was added to `server.js`. The token lives only in the `.env` file on the server and is never sent to the browser. The browser calls `/api/hubspot?action=get_owner` or `/api/hubspot?action=get_tickets` — the server validates the request, adds the token, calls HubSpot, and returns the result.

The proxy enforces two additional constraints:
- **Property allowlist:** only a fixed set of HubSpot ticket fields can be requested. Arbitrary field access is blocked.
- **Email domain restriction:** `get_owner` lookups only work for `@supy.io` addresses.

On the Cloudflare Pages deployment, a separate `functions/api/hubspot.js` worker handles this behind the Google OAuth middleware — so unauthenticated users cannot reach the proxy at all.

#### Why this approach

A server-side proxy is the standard pattern for keeping API credentials out of the browser. It adds one network hop but completely eliminates credential exposure. The allowlist and domain restriction were added because a proxy that forwards arbitrary requests is only marginally better than direct browser access — it still lets someone enumerate HubSpot data by crafting requests.

---

### ISSUE-02 — HubSpot Proxy Accessible Without Authentication (Local Server)

**Severity:** High  
**File:** `server.js`  
**Status:** Fixed  
**Finding number in automated review:** #5

#### What went wrong

The `/api/hubspot` proxy on the local Express server had no authentication. Any process or browser that could reach `localhost:3000` — including other browser tabs, local scripts, or networked devices if the machine was on a shared network — could call HubSpot through the proxy without any credentials.

#### Why it went wrong

The local server was treated as a trusted environment. Since only the developer's machine runs it, the risk felt low. But "localhost-only" is not enforced unless the server explicitly checks — and Express by default accepts connections from any network interface.

#### How it was fixed

A loopback check was added to the `/api/hubspot` route. Requests from any IP other than `127.0.0.1`, `::1`, or `::ffff:127.0.0.1` receive a `403 Forbidden` immediately, before any HubSpot call is made.

```javascript
const ip = req.ip || req.socket?.remoteAddress || '';
const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
if (!isLocal) return res.status(403).json({ error: 'Forbidden' });
```

On the Cloudflare Pages deployment this issue does not exist — `functions/api/hubspot.js` requires a valid session header (`X-User-Email`) set by `_middleware.js`, and returns `401` if it is absent.

#### Why this approach

The loopback check is the minimal viable fix for a local dev server that has no session system. A proper fix would require adding session cookies to the local server, which is significant scope. Since the Cloudflare deployment already has full auth, restricting to loopback closes the risk on the only surface where the local server could be exploited.

---

### ISSUE-03 — Email Enumeration via HubSpot Owner Lookup (Cloudflare Function)

**Severity:** Medium  
**File:** `functions/api/hubspot.js`  
**Status:** Fixed  
**Finding number in automated review:** #6

#### What went wrong

The `get_owner` action in the Cloudflare Pages function accepted any email address. An authenticated user (any `@supy.io` Google account) could use it to look up whether arbitrary email addresses exist as HubSpot owners — mapping out HubSpot user accounts by brute-forcing emails.

#### Why it went wrong

The `server.js` version of the proxy already had an `@supy.io` restriction. When the Cloudflare Pages function was written, that check was not carried over — the two implementations drifted.

#### How it was fixed

The same domain check from `server.js` was added to `functions/api/hubspot.js`:

```javascript
if (!email || !email.endsWith('@supy.io'))
  return Response.json({ error: 'valid @supy.io email required' }, { status: 400 });
```

#### Why this approach

The HubSpot owner lookup is only ever used to resolve Supy team members' owner IDs. There is no legitimate reason for any other domain to be looked up. Restricting to `@supy.io` eliminates the enumeration vector entirely with one line.

---

### ISSUE-04 — Open Redirect in OAuth Callback

**Severity:** High  
**File:** `functions/api/auth/callback.js`  
**Status:** Fixed  
**Finding number in automated review:** #3

#### What went wrong

After Google OAuth completes, the callback redirects the user to a `next` URL decoded from the `state` parameter. There was no validation on that URL. An attacker could craft a login link like:

```
/api/auth/login?next=//evil.com
```

After the user authenticated with their real `@supy.io` Google account, they would be silently redirected to `//evil.com` — an attacker-controlled site. The attacker could use this for phishing (the user just logged in successfully, so the redirect feels legitimate) or to steal the session cookie via a malicious page.

#### Why it went wrong

The `next` parameter was added to preserve the user's original destination across the OAuth round-trip — a standard UX pattern. The developer validated that it decoded correctly but did not validate what kind of URL it contained. `//evil.com` is a protocol-relative URL that browsers treat as `https://evil.com` when used in a `Location` header.

#### How it was fixed

Validation was added before the redirect to ensure `next` is always a same-origin relative path:

```javascript
const candidate = decoded.next;
if (
  typeof candidate === 'string' &&
  candidate.startsWith('/') &&
  !candidate.startsWith('//') &&
  !candidate.startsWith('/\\')
) {
  next = candidate;
}
```

Any value that fails this check silently falls back to `'/'`. The same validation was also added in `login.js` before the value is encoded into `state`, so the check happens at both ends.

#### Why this approach

The validation rule — starts with `/`, does not start with `//` or `/\` — is the minimal correct check for same-origin relative paths. A full URL parser would also work but is heavier. The double-check in both `login.js` and `callback.js` provides defence in depth: even if a crafted `state` value bypasses `login.js`, `callback.js` will catch it.

---

### ISSUE-05 — Missing CSRF Protection on OAuth State

**Severity:** High  
**File:** `functions/api/auth/login.js`, `functions/api/auth/callback.js`  
**Status:** Fixed  
**Finding number in automated review:** #4

#### What went wrong

The OAuth `state` parameter contained only the destination URL (`next`). It had no nonce. This meant an attacker could:

1. Initiate their own OAuth flow and capture the `state` value
2. Trick a victim into clicking a crafted callback URL containing the attacker's `code` and `state`
3. The victim's browser would complete the attacker's OAuth session, potentially logging them in as the attacker (session fixation), or the attacker could use the code to extract the victim's tokens in some flow variants

#### Why it went wrong

The `state` parameter is commonly used just for storing redirect destinations. The CSRF-binding purpose of `state` (tying it to a specific browser session) was not implemented.

#### How it was fixed

A random UUID nonce is now generated in `login.js`, stored in a short-lived `HttpOnly` cookie (`oauth_state`), and embedded in the `state` JSON alongside `next`:

```javascript
// login.js
const nonce = crypto.randomUUID();
const state = btoa(JSON.stringify({ next, nonce }));

// Set-Cookie: oauth_state=<nonce>; HttpOnly; Secure; SameSite=Lax; Max-Age=600
```

In `callback.js`, the nonce from the decoded `state` is compared against the cookie. If they do not match — or if either is absent — the callback is rejected:

```javascript
// callback.js
if (!decoded.nonce || decoded.nonce !== cookieNonce) {
  return Response.redirect('/login?error=invalid_state', 302);
}
```

#### Why this approach

Storing a nonce in an `HttpOnly` cookie and verifying it in the callback is the OAuth 2.0 CSRF mitigation recommended by RFC 6819 and the OAuth Security BCP. `HttpOnly` prevents JavaScript from reading the cookie (so an XSS attack on the same origin cannot steal the nonce). `SameSite=Lax` prevents the cookie from being sent in cross-site top-level navigations initiated by third-party sites. The 600-second (`Max-Age=600`) expiry ensures stale nonces from abandoned flows do not persist.

---

### ISSUE-06 — XSS via Unescaped AI Response Rendering

**Severity:** High  
**File:** `public/index.html`  
**Status:** Fixed

#### What went wrong

AI responses from the chat interface were inserted directly into `innerHTML` after a simple markdown-to-HTML transform. The transform applied `<strong>` and `<br>` tags but did not HTML-escape the raw text first. If the AI response (or a manipulated API response) contained `<script>alert(1)</script>` or an `onerror` handler, it would execute in the user's browser.

Additionally, `e.message` from caught errors and the user's own input were also inserted into `innerHTML` without escaping.

#### Why it went wrong

The markdown renderer was written inline as a chain of `.replace()` calls. The instinct was to add the formatting transforms, not to think about the security boundary. `innerHTML` assignment is a common and easy DOM API — the danger is easy to miss when you are focused on making the output look right.

#### How it was fixed

An `escHtml()` function was added and called as the **first** step inside `mdToHtml()`, before any HTML tags are inserted:

```javascript
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mdToHtml(text) {
  return escHtml(text)                                   // escape first
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')   // then add safe tags
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}
```

Error messages (`e.message`) and user input were also updated to use `escHtml()` before being placed into `innerHTML`.

#### Why this approach

Escaping before transforming is the correct order because it ensures no raw content from an untrusted source (the AI API, the user, or the network) can be interpreted as HTML. The `<strong>` and `<br>` tags added after escaping are hardcoded strings from the application itself — not from user or AI input — so they are safe.

---

### ISSUE-07 — Hardcoded Admin Password in Client-Side Code

**Severity:** Critical  
**File:** `public/team-hub.html`  
**Status:** Deferred — architectural migration required

#### What went wrong

The Team Hub admin password (`Supy2026Admin!`) is hardcoded as a JavaScript constant in `team-hub.html`. Because this is a static file served to the browser, any user who opens DevTools can read it. Admin role grants access to clock in/out on behalf of other team members, edit schedules, manage team configuration, and view all HubSpot ticket counts.

#### Why it went wrong

The Team Hub was built as a standalone HTML file with no backend session system. Adding a simple password prompt was the fastest way to gate admin features. The password was hardcoded because there was nowhere else to put it — the local server has no auth layer, and Supabase's anon key (also used in the same file) cannot issue signed JWTs without a backend to verify identity.

#### Why it has not been fixed yet

Fixing this properly requires one of:

1. **Supabase Auth** — replace the password prompt with a Supabase Auth sign-in flow. Supabase issues JWTs that can be verified server-side, and Row Level Security can then restrict who can write to `attendance_state`, `attendance_log`, `schedule_data`, and `team_config`.
2. **Server-side session** — add a `/api/login` endpoint to `server.js` that issues a signed session cookie, and verify it on all write operations.

Both require significant changes to the attendance and scheduling logic that currently runs entirely client-side. This work has been scoped but not yet prioritised.

#### Current risk mitigation

On the **Cloudflare Pages deployment**, all routes (including `team-hub.html`) are gated behind Google OAuth via `_middleware.js`. Only `@supy.io` Google accounts can reach the page at all, which limits the exposure to internal users.

On the **local development server**, the password is visible in source. The local server should never be exposed to a public network.

**Action required:** Rotate `Supy2026Admin!` if it has been used as a password anywhere else. Do not reuse it.

---

### ISSUE-08 — Authorization Enforced Client-Side

**Severity:** High  
**File:** `public/team-hub.html`  
**Status:** Deferred — same migration as ISSUE-07

#### What went wrong

The user's role (`admin` vs `user`) is determined entirely in the browser. A user can open the browser console and set `currentRole = 'admin'` to gain admin access without knowing the password. All Supabase writes (attendance clock-in/out, schedule edits, team config changes) are performed using the Supabase anon key, which does not distinguish between roles.

#### Why it went wrong

Same root cause as ISSUE-07. The role system was designed for UX (showing/hiding UI elements) rather than security. Actual enforcement requires server-side role verification and Supabase Row Level Security policies — neither of which existed when the feature was built.

#### Why it has not been fixed yet

Same dependency as ISSUE-07. The fix requires Supabase Auth or a server-side session layer. Until that exists, there is no trustworthy identity to enforce roles against.

#### Current risk mitigation

Same as ISSUE-07 — the Cloudflare deployment limits access to `@supy.io` accounts. The impact of role bypass is limited to Supy team members clocking each other in/out or editing schedules, which is a low-severity internal ops issue rather than a data breach.

---

## Open Items

| ID | Severity | Status | Notes |
|---|---|---|---|
| ISSUE-07 | Critical | Deferred | Admin password in client HTML — needs Supabase Auth migration |
| ISSUE-08 | High | Deferred | Client-side role enforcement — blocked on same migration |

All other issues are fixed and shipped.

---

## Fix History

| Date | Issue | Commit |
|---|---|---|
| 2026-06-17 | ISSUE-01 — HubSpot token in browser | `feat: AI chat interface, Team Hub live timers, HubSpot ticket counts` |
| 2026-06-18 | ISSUE-04 — Open redirect in OAuth callback | `fix: prevent open redirect in OAuth callback` |
| 2026-06-18 | ISSUE-06 — XSS via AI response innerHTML | `feat: AI chat interface...` (same commit, pre-ship) |
| 2026-06-19 | ISSUE-02 — Unauthenticated HubSpot proxy | `fix: address security review findings` |
| 2026-06-19 | ISSUE-03 — Email enumeration in HubSpot function | `fix: address security review findings` |
| 2026-06-19 | ISSUE-05 — Missing CSRF on OAuth state | `fix: address security review findings` |
