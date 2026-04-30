import {
  getGleapHeaders, getCachedJson, setCachedJson,
  findLastSkip, fetchAllTickets, enrichTickets, getPhone,
} from '../_shared/gleap.js';

export async function onRequestGet({ request, env }) {
  try {
    const url   = new URL(request.url);
    const now   = new Date();
    const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = url.searchParams.get('end')   || now.toISOString();

    const gleapHeaders = getGleapHeaders(env);

    let lastSkip = await getCachedJson('lastskip');
    if (!lastSkip) {
      lastSkip = await findLastSkip(gleapHeaders);
      await setCachedJson('lastskip', lastSkip, 600);
    }

    let tickets = await fetchAllTickets(start, end, lastSkip, gleapHeaders);
    if (tickets.length <= 150) tickets = await enrichTickets(tickets, gleapHeaders);

    const sample     = tickets[0];
    const callTicket = tickets.find(t =>
      String(t.description||'').toLowerCase().includes('call') ||
      String(t.title||'').toLowerCase().includes('call')
    );

    return Response.json({
      ok: true,
      totalTickets: tickets.length,
      sampleTicket: {
        id: sample?._id,
        title: sample?.title,
        createdAt: sample?.createdAt,
        phone: sample?.phone,
        phoneNumber: sample?.phoneNumber,
        contact: sample?.contact,
        hasAgentReply: sample?.hasAgentReply,
        allKeys: Object.keys(sample||{}).sort(),
      },
      callSampleTicket: callTicket ? {
        id: callTicket._id,
        title: callTicket.title,
        rawSession: callTicket.session,
        rawCustomData: callTicket.customData,
        rawContact: callTicket.contact,
        extractedPhone: getPhone(callTicket),
        allKeys: Object.keys(callTicket).sort(),
      } : null,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
