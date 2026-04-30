import {
  getGleapHeaders, getCachedJson, setCachedJson,
  findLastSkip, fetchAllTickets, enrichTickets, processTickets,
} from '../_shared/gleap.js';

export async function onRequestGet({ request, env }) {
  try {
    const url          = new URL(request.url);
    const now          = new Date();
    const start        = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end          = url.searchParams.get('end')   || now.toISOString();
    const agentFilter  = url.searchParams.get('agent')  || '';
    const statusFilter = url.searchParams.get('status') || '';
    const typeFilter   = url.searchParams.get('type')   || '';
    const page         = parseInt(url.searchParams.get('page')  || '1');
    const limit        = parseInt(url.searchParams.get('limit') || '50');

    const gleapHeaders = getGleapHeaders(env);

    let lastSkip = await getCachedJson('lastskip');
    if (!lastSkip) {
      lastSkip = await findLastSkip(gleapHeaders);
      await setCachedJson('lastskip', lastSkip, 600);
    }

    let tickets = await fetchAllTickets(start, end, lastSkip, gleapHeaders);
    if (tickets.length <= 200) tickets = await enrichTickets(tickets, gleapHeaders);
    let rows = processTickets(tickets, env.PROJECT_ID);

    if (agentFilter)  rows = rows.filter(r => r.agent.toLowerCase().includes(agentFilter.toLowerCase()));
    if (statusFilter) rows = rows.filter(r => r.status === statusFilter.toUpperCase());
    if (typeFilter === 'call')       rows = rows.filter(r => r.isCallRequest);
    if (typeFilter === 'escalated')  rows = rows.filter(r => r.isEscalated);
    if (typeFilter === 'open')       rows = rows.filter(r => r.isOpen);
    if (typeFilter === 'archived')   rows = rows.filter(r => r.isArchived);
    if (typeFilter === 'unassigned') rows = rows.filter(r => r.agent === 'Unassigned');
    if (typeFilter === 'sla')        rows = rows.filter(r => r.slaBreached);

    const total = rows.length;
    const paged = rows.slice((page - 1) * limit, page * limit);
    return Response.json({ ok: true, total, page, pages: Math.ceil(total / limit), tickets: paged });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
