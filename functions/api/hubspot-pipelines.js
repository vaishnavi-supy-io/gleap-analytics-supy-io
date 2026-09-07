// Onboarding + Operations pipeline metrics for the analytics dashboard.
//
// Deliberately separate from /api/hubspot, which is Team Hub's narrow proxy
// (?action=get_owner / get_tickets) and is covered by SECURITY.md — this route
// aggregates instead of proxying, so the two stay independent.
//
// _middleware.js enforces session auth before this runs; the X-User-Email
// check below mirrors the secondary guard /api/hubspot uses.

import { getCachedJson, setCachedJson } from '../_shared/gleap.js';
import { runHubspotPipeline } from '../_shared/hubspot.js';

export async function onRequestGet({ request, env }) {
  try {
    if (!request.headers.get('X-User-Email')) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url   = new URL(request.url);
    const now   = new Date();
    const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = url.searchParams.get('end')   || now.toISOString();
    const force = url.searchParams.get('force') === 'true';

    if (!env.HUBSPOT_TOKEN) {
      return Response.json({
        ok: false,
        error: 'HUBSPOT_TOKEN not configured. Run: npx wrangler pages secret put HUBSPOT_TOKEN --project-name gleap-dashboard',
      }, { status: 500 });
    }

    const cacheKey = `hubspot::${start.slice(0,10)}::${end.slice(0,10)}`;
    const cached   = force ? null : await getCachedJson(cacheKey);

    if (cached) {
      console.log(`⚡ HubSpot cache hit [${cacheKey}]`);
      return Response.json({ ...cached, ok: true, fromCache: true });
    }

    console.log(`🔃 HubSpot cache miss [${cacheKey}] — querying HubSpot`);
    const result = await runHubspotPipeline(start, end, env);
    await setCachedJson(cacheKey, result, 600);
    return Response.json({ ...result, ok: true, fromCache: false });
  } catch (e) {
    console.error('HubSpot pipelines error:', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
