import { getCachedJson, getGleapHeaders } from '../_shared/gleap.js';

export async function onRequestGet({ env }) {
  // Probe: one direct Gleap API call to confirm auth + response shape
  let gleapProbe = null;
  try {
    const headers = getGleapHeaders(env);
    const r = await fetch('https://api.gleap.io/v3/tickets?limit=2&skip=0', { headers });
    const raw = await r.json();
    gleapProbe = {
      status: r.status,
      keys: Object.keys(raw),
      ticketsLength: Array.isArray(raw.tickets) ? raw.tickets.length : null,
      totalCount: raw.totalCount ?? null,
      firstCreatedAt: raw.tickets?.[0]?.createdAt ?? null,
    };
  } catch (e) {
    gleapProbe = { error: e.message };
  }

  // Pages secrets are write-only — neither the dashboard nor Wrangler can show
  // what a deployment actually holds. So when the key is rejected there is no
  // way to tell "wrong value stored" from "stored fine, something else broke"
  // except to have the running code report on the value it was handed. Nothing
  // here can reconstruct the key: a length, the public `sk-or-v1-` prefix, and
  // a truncated SHA-256 to compare against a known-good fingerprint.
  let openrouterProbe = null;
  try {
    const raw = env.OPENROUTER_KEY;
    if (!raw) {
      openrouterProbe = { bound: false };
    } else {
      const trimmed = raw.trim().replace(/^\uFEFF/, '');
      const digest  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(trimmed));
      const fp      = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);

      // Ask OpenRouter what it thinks of the value this deployment holds. Its
      // wording is the diagnosis: "User not found" = a dead key still bound,
      // "Invalid credentials" = wrong value, "Missing Authentication header"
      // = stray bytes in the header.
      let verdict = null;
      try {
        const r = await fetch('https://openrouter.ai/api/v1/key', {
          headers: { 'Authorization': `Bearer ${trimmed}` },
        });
        const body = await r.json().catch(() => ({}));
        verdict = { status: r.status, message: body?.error?.message ?? (r.ok ? 'accepted' : 'unknown') };
      } catch (e) {
        verdict = { status: null, message: `probe failed: ${e.message}` };
      }

      openrouterProbe = {
        bound: true,
        length: raw.length,
        lengthTrimmed: trimmed.length,
        prefix: trimmed.slice(0, 9),
        hasBOM: raw.charCodeAt(0) === 0xFEFF,
        hasWhitespace: /\s/.test(raw),
        looksDoubled: trimmed.length > 100,
        fingerprint: fp,
        verdict,
      };
    }
  } catch (e) {
    openrouterProbe = { error: e.message };
  }

  return Response.json({
    ok: true,
    timestamp: new Date().toISOString(),
    projectId: env.PROJECT_ID,
    hasGleapKey: !!env.GLEAP_API_KEY,
    hasOpenRouterKey: !!env.OPENROUTER_KEY,
    hasHubspotToken: !!env.HUBSPOT_TOKEN,
    cachedLastSkip: await getCachedJson('lastskip'),
    gleapProbe,
    openrouterProbe,
  });
}
