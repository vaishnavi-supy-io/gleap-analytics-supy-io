// Shared HubSpot helpers — used by both functions/api/hubspot.js (Cloudflare
// Pages) and server.js (Node, via dynamic import). Workers-native fetch only;
// no npm modules, no caching here — each caller owns its own cache layer.
//
// Requires a HubSpot private-app token with the `tickets` read scope
// (and `crm.objects.owners.read` for owner names) exposed as HUBSPOT_TOKEN.

const HS_API = 'https://api.hubapi.com';

// ── Pipeline / stage metadata ────────────────────────────────────────────────
// IDs verified against the live portal. Stage order matches the HubSpot board
// left-to-right so the funnel breakdown renders in the same order the team
// sees in HubSpot.
export const PIPELINES = {
  onboarding: {
    key:   'onboarding',
    id:    '824860808',
    label: 'Onboarding',
    icon:  '🚀',
    stages: [
      { id: '1221821724', label: 'Scope and Triage' },
      { id: '1221821726', label: 'Assigned' },
      { id: '1230507583', label: 'Item List Building' },
      { id: '1230507584', label: 'PMS Draft' },
      { id: '1230507585', label: 'QA PMS' },
      { id: '1230507586', label: 'Client Review' },
      { id: '1394673510', label: 'Client Approval Received' },
      { id: '1221987902', label: 'Upload Sheet Prep' },
      { id: '1221987903', label: 'QA Upload Sheet' },
      { id: '1230507587', label: 'System Upload' },
      { id: '1372061208', label: 'Account Approval' },
      { id: '1221987904', label: 'Technical Support' },
      { id: '1331507345', label: 'Escalation' },
      { id: '1230507588', label: 'On Hold' },
      { id: '1221821727', label: 'Closed', terminal: 'closed' },
    ],
  },
  operations: {
    key:   'operations',
    id:    '45360784',
    label: 'Operations',
    icon:  '⚙️',
    stages: [
      { id: '93887652',   label: 'New' },
      { id: '1166520337', label: 'Assigned' },
      { id: '93887653',   label: 'In Progress' },
      { id: '93887654',   label: 'Waiting on Customer' },
      { id: '108525578',  label: 'Technical Support' },
      { id: '1331502346', label: 'Escalation' },
      { id: '93887655',   label: 'Closed',  terminal: 'closed'  },
      { id: '1168748088', label: 'Invalid', terminal: 'invalid' },
    ],
  },
};

// Properties pulled for every ticket. Kept lean — each extra property costs
// payload size on ranges with thousands of tickets.
const TICKET_PROPERTIES = [
  'hs_object_id', 'subject', 'createdate', 'closed_date',
  'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority',
  'sla_status', 'sla_deadline', 'sla_type',
  'hubspot_owner_id', 'hs_lastmodifieddate',
];

// HubSpot's search endpoint refuses to page past 10 000 results.
const HS_PAGE_SIZE  = 100;
const HS_MAX_PAGES  = 100;

// ── Helpers ─────────────────────────────────────────────────────────────────
export function hsHeaders(env) {
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new Error('HUBSPOT_TOKEN not configured');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}

function stageIndex(pipeline) {
  const map = new Map();
  pipeline.stages.forEach((s, i) => map.set(s.id, { ...s, order: i }));
  return map;
}

function toMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function dayKey(ms) {
  return ms === null ? 'unknown' : new Date(ms).toISOString().slice(0, 10);
}

export function fmtHours(h) {
  if (h === null || h === undefined || isNaN(h)) return 'N/A';
  if (h < 1)  return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} hrs`;
  return `${(h / 24).toFixed(1)} days`;
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

// ── HubSpot API ─────────────────────────────────────────────────────────────
async function hsPost(path, body, headers) {
  const res = await fetch(`${HS_API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HubSpot API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Every ticket in `pipeline` whose createdate falls inside [start, end].
 * This is the "cohort of the range" — closed/pending are then derived from
 * each ticket's *current* stage, so created = closed + pending + invalid.
 */
export async function fetchPipelineTickets(pipeline, start, end, headers) {
  const startMs = String(new Date(start).getTime());
  const endMs   = String(new Date(end).getTime());

  const out = [];
  let after = undefined;
  let truncated = false;

  for (let page = 0; page < HS_MAX_PAGES; page++) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: pipeline.id },
          { propertyName: 'createdate', operator: 'BETWEEN', value: startMs, highValue: endMs },
        ],
      }],
      properties: TICKET_PROPERTIES,
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: HS_PAGE_SIZE,
      ...(after ? { after } : {}),
    };

    const data = await hsPost('/crm/v3/objects/tickets/search', body, headers);
    out.push(...(data.results || []));

    after = data.paging?.next?.after;
    if (!after) break;
    if (page === HS_MAX_PAGES - 1) truncated = true;
  }

  return { results: out, truncated };
}

/**
 * Count of tickets currently sitting in a non-terminal stage, regardless of
 * when they were created — the true open backlog, shown alongside the
 * range-scoped cards so a growing queue can't hide behind a good month.
 */
export async function fetchOpenBacklog(pipeline, headers) {
  const openStages = pipeline.stages.filter(s => !s.terminal).map(s => s.id);
  const data = await hsPost('/crm/v3/objects/tickets/search', {
    filterGroups: [{
      filters: [
        { propertyName: 'hs_pipeline', operator: 'EQ', value: pipeline.id },
        { propertyName: 'hs_pipeline_stage', operator: 'IN', values: openStages },
      ],
    }],
    properties: ['hs_object_id'],
    limit: 1,
  }, headers);
  return data.total ?? 0;
}

/** ownerId → display name, for the per-owner breakdown. */
export async function fetchOwners(headers) {
  const map = {};
  try {
    let after = '';
    for (let page = 0; page < 10; page++) {
      const url = `${HS_API}/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`;
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = await res.json();
      for (const o of data.results || []) {
        const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
        map[String(o.id)] = name || o.email || `Owner ${o.id}`;
      }
      after = data.paging?.next?.after || '';
      if (!after) break;
    }
  } catch { /* owner names are cosmetic — never fail the dashboard over them */ }
  return map;
}

/**
 * Portal ID, needed to build clickable app.hubspot.com ticket links.
 * Read from env when provided so nothing account-specific is hardcoded;
 * otherwise resolved from the token itself.
 */
export async function resolvePortalId(env, headers) {
  if (env.HUBSPOT_PORTAL_ID) return String(env.HUBSPOT_PORTAL_ID);
  try {
    const res = await fetch(`${HS_API}/account-info/v3/details`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data.portalId) return String(data.portalId);
    }
  } catch { /* fall through — links are simply omitted */ }
  return '';
}

function ticketLink(portalId, id) {
  return portalId ? `https://app.hubspot.com/contacts/${portalId}/ticket/${id}` : '';
}

// ── Aggregation ─────────────────────────────────────────────────────────────
export function computePipelineStats(pipeline, rawTickets, opts = {}) {
  const { owners = {}, portalId = '', openBacklog = null, truncated = false } = opts;
  const stages  = stageIndex(pipeline);
  const nowMs   = Date.now();

  const rows = rawTickets.map(t => {
    const p        = t.properties || {};
    const stageId  = String(p.hs_pipeline_stage || '');
    const stage    = stages.get(stageId);
    const terminal = stage?.terminal || null;
    const createdMs = toMs(p.createdate);
    const closedMs  = toMs(p.closed_date);
    const sla       = p.sla_status || '';
    const id        = String(p.hs_object_id || t.id || '');

    const ageHrs   = createdMs === null ? null : ((closedMs ?? nowMs) - createdMs) / 3600000;
    const closeHrs = (createdMs !== null && closedMs !== null) ? (closedMs - createdMs) / 3600000 : null;

    // HubSpot bulk imports and manual close-date edits can leave closed_date
    // *before* createdate — roughly 9% of closed tickets on this portal. The
    // tickets are real and still counted as closed, but their durations are
    // meaningless, so they are flagged here and excluded from every average
    // rather than dragging avgCloseHrs down by ~10%.
    const suspectTimestamps = closeHrs !== null && closeHrs < 0;

    return {
      id,
      subject:     p.subject || '(No subject)',
      stageId,
      stage:       stage?.label || stageId || 'Unknown',
      stageOrder:  stage?.order ?? 999,
      isClosed:    terminal === 'closed',
      isInvalid:   terminal === 'invalid',
      isPending:   !terminal,
      priority:    (p.hs_ticket_priority || 'UNSET').toUpperCase(),
      slaStatus:   sla,
      slaBreached: sla === 'Breached',
      slaAtRisk:   sla === 'At Risk',
      slaType:     p.sla_type || '',
      slaDeadline: p.sla_deadline || '',
      owner:       owners[String(p.hubspot_owner_id || '')] || 'Unassigned',
      createdAt:   p.createdate || '',
      closedAt:    p.closed_date || '',
      updatedAt:   p.hs_lastmodifieddate || '',
      // Hours the ticket has existed (closed ones freeze at their close date).
      // Both are null when the timestamps are inconsistent — see below.
      ageHrs:      suspectTimestamps ? null : ageHrs,
      closeHrs:    suspectTimestamps ? null : closeHrs,
      suspectTimestamps,
      day:         dayKey(createdMs),
      link:        ticketLink(portalId, id),
    };
  });

  const closed  = rows.filter(r => r.isClosed);
  const pending = rows.filter(r => r.isPending);
  const invalid = rows.filter(r => r.isInvalid);
  const breached = rows.filter(r => r.slaBreached);

  const countBy = (list, keyFn) => {
    const m = {};
    for (const r of list) { const k = keyFn(r); m[k] = (m[k] || 0) + 1; }
    return m;
  };

  // Stage funnel, in HubSpot board order, zero-count stages included so the
  // shape of the pipeline stays readable week to week.
  const stageCounts = countBy(rows, r => r.stageId);
  const stageBreakdown = pipeline.stages.map(s => ({
    stage:    s.label,
    count:    stageCounts[s.id] || 0,
    terminal: s.terminal || null,
  }));

  const dailyMap = countBy(rows, r => r.day);
  const daily = Object.entries(dailyMap)
    .filter(([d]) => d !== 'unknown')
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count }));

  const closedDaily = (() => {
    const m = countBy(closed.filter(r => r.closedAt), r => dayKey(toMs(r.closedAt)));
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, count }));
  })();

  const ownerBreakdown = Object.entries(countBy(rows, r => r.owner))
    .map(([name, total]) => ({
      name,
      total,
      closed:   closed.filter(r => r.owner === name).length,
      pending:  pending.filter(r => r.owner === name).length,
      breached: breached.filter(r => r.owner === name).length,
    }))
    .sort((a, b) => b.total - a.total);

  const slaBreakdown = ['On Track', 'At Risk', 'Breached'].map(status => ({
    status,
    count: rows.filter(r => r.slaStatus === status).length,
  }));
  slaBreakdown.push({ status: 'Not set', count: rows.filter(r => !r.slaStatus).length });

  const avgCloseHrs = avg(closed.map(r => r.closeHrs).filter(v => v !== null));
  const avgPendingAgeHrs = avg(pending.map(r => r.ageHrs).filter(v => v !== null));

  return {
    pipeline:   pipeline.key,
    label:      pipeline.label,
    icon:       pipeline.icon,
    pipelineId: pipeline.id,
    truncated,

    // Headline cards — created reconciles against the rest by construction.
    created: rows.length,
    closed:  closed.length,
    pending: pending.length,
    invalid: invalid.length,
    slaBreached: breached.length,
    slaAtRisk:   rows.filter(r => r.slaAtRisk).length,
    // Closed tickets whose close date precedes their create date. Reported so
    // an unexplained gap between `closed` and the averages' sample size is
    // visible instead of silent.
    suspectTimestamps: rows.filter(r => r.suspectTimestamps).length,

    openBacklog,
    closeRate: rows.length ? Math.round((closed.length / rows.length) * 100) : 0,
    breachRate: rows.length ? Math.round((breached.length / rows.length) * 100) : 0,

    avgCloseHrs, avgCloseFmt: fmtHours(avgCloseHrs),
    avgPendingAgeHrs, avgPendingAgeFmt: fmtHours(avgPendingAgeHrs),

    stageBreakdown, daily, closedDaily, ownerBreakdown, slaBreakdown,
    priorityBreakdown: Object.entries(countBy(rows, r => r.priority))
      .map(([priority, count]) => ({ priority, count }))
      .sort((a, b) => b.count - a.count),

    // Worst-first queues for the drill-down tables.
    pendingTickets:  pending.slice().sort((a, b) => (b.ageHrs || 0) - (a.ageHrs || 0)),
    breachedTickets: breached.slice().sort((a, b) => (b.ageHrs || 0) - (a.ageHrs || 0)),
    tickets: rows,
  };
}

/** Full pipeline run for both boards — the single entry point for callers. */
export async function runHubspotPipeline(start, end, env) {
  const headers = hsHeaders(env);
  const [portalId, owners] = await Promise.all([
    resolvePortalId(env, headers),
    fetchOwners(headers),
  ]);

  const keys = Object.keys(PIPELINES);
  const results = await Promise.all(keys.map(async key => {
    const pipeline = PIPELINES[key];
    const [{ results: raw, truncated }, openBacklog] = await Promise.all([
      fetchPipelineTickets(pipeline, start, end, headers),
      fetchOpenBacklog(pipeline, headers),
    ]);
    return computePipelineStats(pipeline, raw, { owners, portalId, openBacklog, truncated });
  }));

  const byKey = {};
  keys.forEach((k, i) => { byKey[k] = results[i]; });

  return {
    generatedAt: new Date().toISOString(),
    range: { start, end },
    pipelines: byKey,
  };
}
