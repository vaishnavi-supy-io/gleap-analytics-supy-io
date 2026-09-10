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
  // Custom property whose HubSpot *label* is "Ticket assignee". The internal
  // name reads like a creator field but is not one — this is who the ticket is
  // assigned to, which is what the team works from. `hubspot_owner_id`
  // ("Ticket owner") is kept alongside it because the two genuinely differ.
  'ticket_creation_by',
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

// The portal runs Asia/Dubai, and the team reads these numbers as their own
// working hours. Dubai has observed no DST since 1978, so a fixed offset is
// exact year-round — shifting the instant and then reading the UTC getters
// yields Dubai wall-clock without an Intl call per ticket.
export const PORTAL_TZ_LABEL = 'Dubai';
const PORTAL_OFFSET_MS = 4 * 60 * 60 * 1000;
const portalDate = ms => new Date(ms + PORTAL_OFFSET_MS);

function dayKey(ms) {
  return ms === null ? 'unknown' : portalDate(ms).toISOString().slice(0, 10);
}

// Heatmap axes. Monday-first because that is how the team reads a work week,
// and Dubai wall-clock throughout: a grid in UTC told the team to staff 06:00
// when the tickets actually land at 10:00 their time. Every viewer sees the
// same portal-local grid, and the dashboard labels it Dubai.
export const HEATMAP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dowIndex(ms) {
  return (portalDate(ms).getUTCDay() + 6) % 7; // JS weeks start Sunday; ours start Monday
}

/**
 * Day-of-week x hour-of-day grid over a list of epoch-ms timestamps, plus the
 * summary numbers the dashboard and the AI prompt both need. Answers the
 * coverage question ("when do these tickets land, and are we staffed then?")
 * that a daily volume line cannot.
 */
function buildHeatmap(timestamps) {
  const grid = HEATMAP_DAYS.map(() => new Array(24).fill(0));
  let total = 0;

  for (const ms of timestamps) {
    if (ms === null || ms === undefined) continue;
    grid[dowIndex(ms)][portalDate(ms).getUTCHours()]++;
    total++;
  }

  const cells = [];
  grid.forEach((row, d) => row.forEach((count, h) => {
    cells.push({ day: HEATMAP_DAYS[d], dayIndex: d, hour: h, count });
  }));

  const max   = Math.max(0, ...cells.map(c => c.count));
  const peaks = cells.filter(c => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 3);

  const byHour = new Array(24).fill(0);
  const byDay  = new Array(7).fill(0);
  for (const c of cells) { byHour[c.hour] += c.count; byDay[c.dayIndex] += c.count; }

  // "Busy stretch" = the hours carrying at least 60% of the busiest hour's
  // volume. That is the band worth staffing, not every hour with any traffic.
  // If it spans most of the clock there is no real stretch to name, so we
  // report none rather than printing "00:00-23:00" as though it were a finding.
  const hourMax    = Math.max(1, ...byHour);
  const busyHours  = byHour.map((n, h) => ({ n, h })).filter(x => x.n >= hourMax * 0.6).map(x => x.h);
  const hasStretch = busyHours.length > 0 && busyHours.length <= 14;

  const weekend = byDay[5] + byDay[6];
  const inBand  = hasStretch ? busyHours.reduce((n, h) => n + byHour[h], 0) : total;

  return {
    days: HEATMAP_DAYS,
    grid,
    total, max, peaks,
    byHour, byDay,
    busyFrom: hasStretch ? Math.min(...busyHours) : null,
    busyTo:   hasStretch ? Math.max(...busyHours) : null,
    busyHours: hasStretch ? busyHours : [],
    busiestDay:  total ? HEATMAP_DAYS[byDay.indexOf(Math.max(...byDay))] : null,
    busiestHour: total ? byHour.indexOf(Math.max(...byHour)) : null,
    weekendCount: weekend,
    weekendPct:   total ? Math.round((weekend / total) * 100) : 0,
    // Share landing outside the busy band — the tickets most likely to sit
    // untouched until the next working morning.
    offBandCount: total - inBand,
    offBandPct:   total ? Math.round(((total - inBand) / total) * 100) : 0,
  };
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

// HubSpot's own canonical record URL, confirmed against this portal:
// /record/0-5/{id}, where 0-5 is the tickets object-type id. The older
// /ticket/{id} form only survives as a redirect, so link the real one.
const HS_TICKET_OBJECT_TYPE = '0-5';

function ticketLink(portalId, id) {
  return portalId ? `https://app.hubspot.com/contacts/${portalId}/record/${HS_TICKET_OBJECT_TYPE}/${id}` : '';
}

/** The tickets index for a portal — where a "see them all" link lands. */
function ticketIndexLink(portalId) {
  return portalId ? `https://app.hubspot.com/contacts/${portalId}/objects/${HS_TICKET_OBJECT_TYPE}/views/all/list` : '';
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

    // "Ticket assignee" is a checkbox-type enumeration, so HubSpot serialises
    // multiple selections as a ';'-separated string. Ids resolve against the
    // same owners map as the ticket owner; an id with no match keeps its
    // number rather than silently vanishing from the scorecard.
    const assigneeIds = String(p.ticket_creation_by || '')
      .split(';')
      .map(x => x.trim())
      .filter(Boolean);
    const assigneeNames = assigneeIds.map(aid => owners[aid] || `Unknown (${aid})`);

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
      ownerId:     String(p.hubspot_owner_id || ''),
      owner:       owners[String(p.hubspot_owner_id || '')] || 'Unassigned',
      assigneeIds,
      // Multi-assignee tickets exist, so the scorecard groups by the first
      // (primary) id to keep its totals reconcilable with the ticket count,
      // while `assignees` carries the full list for display.
      assignee:    assigneeNames[0] || 'Unassigned',
      assignees:   assigneeNames.length ? assigneeNames.join(', ') : 'Unassigned',
      createdAt:   p.createdate || '',
      closedAt:    p.closed_date || '',
      updatedAt:   p.hs_lastmodifieddate || '',
      // Hours the ticket has existed (closed ones freeze at their close date).
      // Both are null when the timestamps are inconsistent — see below.
      ageHrs:      suspectTimestamps ? null : ageHrs,
      closeHrs:    suspectTimestamps ? null : closeHrs,
      suspectTimestamps,
      day:         dayKey(createdMs),
      // Portal-local (Dubai) weekday/hour of arrival, for the day x hour heatmap.
      dayOfWeek:   createdMs === null ? null : HEATMAP_DAYS[dowIndex(createdMs)],
      hour:        createdMs === null ? null : portalDate(createdMs).getUTCHours(),
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

  // Two grids, same axes: when tickets arrive vs when they actually get
  // closed. Read together they show whether the team's working hours line up
  // with the hours the work lands in — which a daily count cannot show.
  const heatmapCreated = buildHeatmap(rows.map(r => toMs(r.createdAt)));
  const heatmapClosed  = buildHeatmap(closed.map(r => toMs(r.closedAt)));

  // Assignee scorecard. Grouped once rather than re-filtering `rows` per person
  // per metric, because the assignee count is unbounded and the ticket list can
  // run into the thousands.
  const byAssignee = new Map();
  for (const r of rows) {
    if (!byAssignee.has(r.assignee)) byAssignee.set(r.assignee, []);
    byAssignee.get(r.assignee).push(r);
  }

  const assigneeBreakdown = [...byAssignee.entries()]
    .map(([name, list]) => {
      const oClosed   = list.filter(r => r.isClosed);
      const oPending  = list.filter(r => r.isPending);
      const oBreached = list.filter(r => r.slaBreached);
      const oAvgClose   = avg(oClosed.map(r => r.closeHrs).filter(v => v !== null));
      const oAvgPending = avg(oPending.map(r => r.ageHrs).filter(v => v !== null));
      const oldestPendingHrs = oPending.length
        ? Math.max(...oPending.map(r => r.ageHrs ?? 0))
        : null;
      // Where this person's open work is actually sitting — the single most
      // useful thing to know before reassigning any of it.
      const stageTally = {};
      for (const r of oPending) stageTally[r.stage] = (stageTally[r.stage] || 0) + 1;
      const topPendingStage = Object.entries(stageTally).sort((a, b) => b[1] - a[1])[0] || null;

      return {
        name,
        // Every ticket in a group shares an assignee, so the first row's id
        // is the group's id. Empty string for the Unassigned bucket.
        assigneeId: list[0]?.assigneeIds?.[0] || '',
        total:    list.length,
        closed:   oClosed.length,
        pending:  oPending.length,
        invalid:  list.filter(r => r.isInvalid).length,
        breached: oBreached.length,
        // Breaches still sitting open. Distinct from `breached`, which also
        // counts tickets that breached and were closed anyway — only the open
        // ones are still actionable.
        pendingBreached: oPending.filter(r => r.slaBreached).length,
        atRisk:   list.filter(r => r.slaAtRisk).length,
        unassigned: name === 'Unassigned',
        closeRate:  list.length ? Math.round((oClosed.length / list.length) * 100) : 0,
        breachRate: list.length ? Math.round((oBreached.length / list.length) * 100) : 0,
        sharePct:   rows.length ? Math.round((list.length / rows.length) * 100) : 0,
        avgCloseHrs: oAvgClose,   avgCloseFmt: fmtHours(oAvgClose),
        avgPendingAgeHrs: oAvgPending, avgPendingAgeFmt: fmtHours(oAvgPending),
        oldestPendingHrs, oldestPendingFmt: fmtHours(oldestPendingHrs),
        topPendingStage:      topPendingStage ? topPendingStage[0] : null,
        topPendingStageCount: topPendingStage ? topPendingStage[1] : 0,
        // Sample size behind avgCloseFmt — closed tickets minus the ones with
        // inconsistent HubSpot timestamps, same exclusion as the headline card.
        closedTimed: oClosed.filter(r => r.closeHrs !== null).length,
      };
    })
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
    portalId,
    ticketIndexUrl: ticketIndexLink(portalId),
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

    stageBreakdown, daily, closedDaily, assigneeBreakdown, slaBreakdown,
    heatmap: { created: heatmapCreated, closed: heatmapClosed },
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

// ── AI analysis ─────────────────────────────────────────────────────────────
/**
 * Compact, numbers-only view of a pipeline for the model. Deliberately drops
 * the full ticket array — only the worst pending/breached tickets earn a place,
 * because the model's job is to read the aggregates, not re-derive them.
 */
export function slimForAI(p, limit = 8) {
  const q = t => ({
    subject: t.subject, stage: t.stage, assignee: t.assignee,
    ageHrs: t.ageHrs === null ? null : Math.round(t.ageHrs),
    sla: t.slaStatus, priority: t.priority,
  });
  return {
    label: p.label,
    created: p.created, closed: p.closed, pending: p.pending, invalid: p.invalid,
    closeRate: p.closeRate, breachRate: p.breachRate,
    slaBreached: p.slaBreached, slaAtRisk: p.slaAtRisk,
    openBacklog: p.openBacklog,
    avgCloseFmt: p.avgCloseFmt, avgPendingAgeFmt: p.avgPendingAgeFmt,
    suspectTimestamps: p.suspectTimestamps, truncated: p.truncated,
    stageBreakdown: p.stageBreakdown.filter(s => s.count),
    slaBreakdown: p.slaBreakdown.filter(s => s.count),
    priorityBreakdown: p.priorityBreakdown,
    assigneeBreakdown: p.assigneeBreakdown.slice(0, 12),
    // The grid itself is 168 numbers of no use to a language model; the peaks
    // and bands are the part worth reasoning over.
    arrivals: heatmapSummary(p.heatmap?.created),
    closures: heatmapSummary(p.heatmap?.closed),
    oldestPending: p.pendingTickets.slice(0, limit).map(q),
    worstBreached: p.breachedTickets.slice(0, limit).map(q),
  };
}

const hh = h => `${String(h).padStart(2, '0')}:00`;

/** Prose-ready digest of one heatmap. Null when the grid is absent or empty. */
function heatmapSummary(hm) {
  if (!hm || !hm.total) return null;
  return {
    total: hm.total,
    busiestDay: hm.busiestDay,
    busiestHour: hm.busiestHour,
    // Full phrase, so a one-hour band doesn't render as "09:00-09:00".
    band: hm.busyFrom === null ? null
      : hm.busyFrom === hm.busyTo ? `the ${hh(hm.busyFrom)} ${PORTAL_TZ_LABEL} hour`
      : `the ${hh(hm.busyFrom)}-${hh(hm.busyTo)} ${PORTAL_TZ_LABEL} band`,
    peaks: (hm.peaks || []).map(c => `${c.day} ${hh(c.hour)} ${PORTAL_TZ_LABEL} (${c.count})`),
    weekendCount: hm.weekendCount, weekendPct: hm.weekendPct,
    offBandCount: hm.offBandCount, offBandPct: hm.offBandPct,
    byDay: (hm.days || []).map((d, i) => `${d}: ${hm.byDay[i]}`).join(' · '),
  };
}

export function buildHubspotInsightPrompt(p, other, range) {
  const s = slimForAI(p);
  const stages  = s.stageBreakdown.map(x => `${x.stage}: ${x.count}${x.terminal ? ` [${x.terminal}]` : ''}`).join('\n');
  const assignees = s.assigneeBreakdown.map(o => [
    `${o.name}: ${o.total} assigned (${o.sharePct}% of the period)`,
    `${o.closed} closed (${o.closeRate}%)`,
    `${o.pending} pending`,
    `${o.breached} breached${o.atRisk ? `, ${o.atRisk} at risk` : ''}`,
    o.closedTimed ? `avg close ${o.avgCloseFmt}` : 'avg close n/a',
    o.pending ? `oldest pending ${o.oldestPendingFmt}` : null,
    o.topPendingStage ? `most open work in "${o.topPendingStage}" (${o.topPendingStageCount})` : null,
  ].filter(Boolean).join(', ')).join('\n');

  const arrivals = s.arrivals;
  const closures = s.closures;
  const patternBlock = arrivals ? [
    `Busiest day: ${arrivals.busiestDay}. Busiest hour: ${hh(arrivals.busiestHour)} ${PORTAL_TZ_LABEL}.`,
    arrivals.band ? `Most volume lands in ${arrivals.band}.` : 'Volume is spread too evenly across the clock to name a band.',
    `Per weekday — ${arrivals.byDay}`,
    `Peak single windows: ${arrivals.peaks.join(', ') || 'none'}.`,
    `${arrivals.weekendCount} ticket(s) (${arrivals.weekendPct}%) arrive Sat/Sun.`,
    `${arrivals.offBandCount} ticket(s) (${arrivals.offBandPct}%) arrive outside the busy band.`,
    closures ? `Closures peak ${closures.busiestDay} ${hh(closures.busiestHour)} ${PORTAL_TZ_LABEL}${closures.band ? `, mostly in ${closures.band}` : ''} — compare against the arrival band to spot a coverage gap.` : 'Too few closed tickets to read a closing pattern.',
  ].join('\n') : 'No dated tickets in this range — no arrival pattern to read.';
  const pending = s.oldestPending.map(t => `• ${t.subject} — ${t.stage}, ${t.assignee}, ${t.ageHrs}h old, SLA ${t.sla || 'not set'}, ${t.priority}`).join('\n');
  const breach  = s.worstBreached.map(t => `• ${t.subject} — ${t.stage}, ${t.assignee}, ${t.ageHrs}h old, ${t.priority}`).join('\n');

  // Caveats the model must not mistake for signal.
  const caveats = [
    s.suspectTimestamps
      ? `${s.suspectTimestamps} closed ticket(s) have a close date BEFORE their create date (HubSpot data entry artifact). They are excluded from "avg time to close", so that average is based on ${s.closed - s.suspectTimestamps} tickets, not ${s.closed}. Do not treat this as a performance signal.`
      : null,
    s.truncated ? 'This query hit HubSpot\'s 10,000-record cap, so counts are a floor, not exact.' : null,
    s.slaBreakdown.some(x => x.status === 'Not set' && x.count)
      ? `${s.slaBreakdown.find(x => x.status === 'Not set').count} ticket(s) have no SLA status set at all — they are neither on track nor breached, so the breach rate is calculated over everything, including them.`
      : null,
  ].filter(Boolean);

  return `You are an operations lead at a hospitality-tech company, reviewing the ${s.label} ticket pipeline in HubSpot.

PERIOD: ${range.start.slice(0,10)} → ${range.end.slice(0,10)}

HEADLINE NUMBERS
- Created in period: ${s.created}  (= ${s.closed} closed + ${s.pending} pending${s.invalid ? ` + ${s.invalid} invalid` : ''})
- Close rate: ${s.closeRate}%
- SLA breached: ${s.slaBreached} (${s.breachRate}% of the period) · at risk: ${s.slaAtRisk}
- Avg time to close: ${s.avgCloseFmt}
- Avg age of still-pending tickets: ${s.avgPendingAgeFmt}
- OPEN BACKLOG (all time, any create date): ${s.openBacklog ?? 'unknown'}

STAGE DISTRIBUTION
${stages || 'none'}

WHEN TICKETS ARRIVE (day x hour, ${PORTAL_TZ_LABEL} local time \u2014 the portal timezone, Asia/Dubai)
${patternBlock}

SLA STATUS
${s.slaBreakdown.map(x => `${x.status}: ${x.count}`).join(' · ')}

PRIORITY
${s.priorityBreakdown.map(x => `${x.priority}: ${x.count}`).join(' · ')}

PER OWNER
${assignees || 'none'}

OLDEST PENDING TICKETS
${pending || 'none'}

WORST SLA BREACHES
${breach || 'none'}

${other ? `FOR COMPARISON — the ${other.label} pipeline over the same period: ${other.created} created, ${other.closed} closed, ${other.pending} pending, ${other.slaBreached} breached (${other.breachRate}%), backlog ${other.openBacklog ?? '?'}, avg close ${other.avgCloseFmt}.` : ''}

${caveats.length ? `DATA CAVEATS — read these before drawing conclusions:\n${caveats.map(c => `- ${c}`).join('\n')}` : ''}

Write your analysis in exactly this structure, in markdown:

**SUMMARY**
Three sentences maximum. The single most important thing about these numbers, stated plainly enough for someone who has not seen the dashboard. Lead with the number that matters most.

**1. WHAT THE NUMBERS ACTUALLY SAY**
The real read on volume, throughput and the backlog. Call out where the period-scoped counts and the all-time backlog tell different stories.

**2. WHERE THE PIPELINE IS STUCK**
Which stages are accumulating tickets and what that specific stage means operationally. Name stages and counts.

**3. SLA RISK**
What is driving the breaches. Is it concentrated in a stage, an assignee, or a priority band? Be specific.

**4. WORKLOAD DISTRIBUTION**
Who is carrying what, and whether it is unbalanced. Name people and numbers, including close rate and average close time where the sample supports it. Call out anything sitting under "Unassigned". If a person has many breached tickets, say so, but attribute it to load or stage rather than assuming fault.

**5. COVERAGE VS ARRIVAL PATTERN**
Read the day x hour arrival pattern against the closing pattern. Name the specific windows that are busy and say whether closures happen in the same windows. If a meaningful share arrives at the weekend or outside the busy band, say what that implies for staffing. If the volume is too thin to support a pattern, say so plainly instead of naming a window.

**6. DO THIS WEEK**
Three to five concrete actions, each tied to a number or a named ticket above. No generic advice.

Rules: use the real numbers; never invent a figure that is not above; if the data is too thin to support a claim, say so instead of guessing; be direct and brief; no preamble before SUMMARY.`;
}
