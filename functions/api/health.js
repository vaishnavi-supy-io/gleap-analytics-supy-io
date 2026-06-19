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

  return Response.json({
    ok: true,
    timestamp: new Date().toISOString(),
    projectId: env.PROJECT_ID,
    hasGleapKey: !!env.GLEAP_API_KEY,
    hasOpenRouterKey: !!env.OPENROUTER_KEY,
    cachedLastSkip: await getCachedJson('lastskip'),
    gleapProbe,
  });
}
