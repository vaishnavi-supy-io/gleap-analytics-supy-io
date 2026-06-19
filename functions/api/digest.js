import {
  getGleapHeaders, getCachedJson, setCachedJson,
  findLastSkip, fetchAllTickets, enrichTickets, isCallRequest,
  processTickets, computeStats, buildSlackDigest,
} from '../_shared/gleap.js';

export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const now  = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const defaultStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString();
    const defaultEnd   = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999).toISOString();

    const start = url.searchParams.get('start') || defaultStart;
    const end   = url.searchParams.get('end')   || defaultEnd;
    const dry   = url.searchParams.get('dry') === 'true';

    const periodLabel = `${start.slice(0,10)} → ${end.slice(0,10)}`;
    const gleapHeaders = getGleapHeaders(env);

    let lastSkip = await getCachedJson('lastskip');
    if (!lastSkip) {
      lastSkip = await findLastSkip(gleapHeaders);
      await setCachedJson('lastskip', lastSkip, 600);
    }

    let tickets = await fetchAllTickets(start, end, lastSkip, gleapHeaders);
    if (tickets.length <= 150) {
      tickets = await enrichTickets(tickets, gleapHeaders);
    } else {
      const callOnes = tickets.filter(t => isCallRequest(t));
      if (callOnes.length <= 150) {
        const enriched = await enrichTickets(callOnes, gleapHeaders);
        const enrichedMap = new Map(enriched.map(t => [t._id||t.id||'', t]));
        tickets = tickets.map(t => enrichedMap.get(t._id||t.id||'') || t);
      }
    }

    const rows    = processTickets(tickets, env.PROJECT_ID);
    const stats   = computeStats(rows);
    const payload = buildSlackDigest(stats, periodLabel);

    let posted = false, postError = null;

    if (!dry && env.SLACK_WEBHOOK_URL) {
      try {
        const slackRes = await fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (slackRes.ok) {
          posted = true;
          console.log(`✅ Slack digest posted for ${periodLabel}`);
        } else {
          postError = `Slack responded with HTTP ${slackRes.status}`;
          console.warn('Slack webhook failed:', postError);
        }
      } catch (e) { postError = e.message; console.warn('Slack webhook error:', e.message); }
    }

    return Response.json({
      ok: true, period: periodLabel, total: stats.total, openCount: stats.openCount,
      posted, dry, slackConfigured: !!env.SLACK_WEBHOOK_URL,
      postError: postError || undefined, payload,
    });
  } catch (e) {
    console.error('Digest error:', e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
