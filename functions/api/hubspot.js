// _middleware.js enforces session auth before this runs — X-User-Email is always present.
// team-hub.html is served from the same origin so no CORS headers are needed.

const ALLOWED_TICKET_PROPERTIES = [
  'subject', 'hs_pipeline', 'hs_ticket_stage', 'hs_pipeline_stage',
  'hs_due_date', 'hs_ticket_id', 'hubspot_owner_id', 'hs_lastmodifieddate',
  'createdate', 'content',
];

export async function onRequest({ request, env }) {
  // Secondary guard: middleware sets this header; reject if absent
  if (!request.headers.get('X-User-Email')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const HS_TOKEN = env.HUBSPOT_TOKEN;
  if (!HS_TOKEN) {
    return Response.json({ error: 'HUBSPOT_TOKEN env var not set' }, { status: 500 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  try {
    if (action === 'get_owner') {
      const email = url.searchParams.get('email');
      if (!email || !email.endsWith('@supy.io')) return Response.json({ error: 'valid @supy.io email required' }, { status: 400 });

      const res = await fetch(
        `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`,
        { headers: { Authorization: `Bearer ${HS_TOKEN}` } }
      );
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action === 'get_tickets') {
      const raw = await request.json().catch(() => null);
      if (!raw) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });

      // Constrain to the fields Team Hub actually uses — never forward arbitrary payloads
      const body = {
        filterGroups: raw.filterGroups,
        properties:   (raw.properties || []).filter(p => ALLOWED_TICKET_PROPERTIES.includes(p)),
        limit:        Math.min(Number(raw.limit) || 100, 200),
        after:        Number(raw.after) || 0,
      };

      const res = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
