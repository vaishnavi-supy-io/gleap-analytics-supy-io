// Shared helpers for Cloudflare Pages Functions
// Ported from server.js — Workers-native fetch, no node-fetch/express/p-limit

export const CLOSED_STATUSES   = new Set(['CLOSED','DONE','RESOLVED','COMPLETED']);
export const OPEN_STATUSES     = new Set(['OPEN','IN_PROGRESS','PENDING','ACTIVE','INPROGRESS']);
export const ARCHIVED_STATUSES = new Set(['ARCHIVED']);

// p-limit replacement — no npm module needed in Workers
export function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const run = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(() => fn()).then(resolve, reject).finally(() => { active--; run(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); run(); });
}

export function getGleapHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GLEAP_API_KEY}`,
    'Project':       env.PROJECT_ID,
    'Content-Type':  'application/json',
  };
}

export function gleapLink(bugId, projectId) {
  return `https://app.gleap.io/projects/${projectId}/bugs/${bugId}`;
}

export function parseDt(s) { if (!s) return null; try { return new Date(s); } catch { return null; } }

export function minsBetween(a, b) {
  const ta = parseDt(a), tb = parseDt(b);
  if (ta && tb) return Math.abs((tb - ta) / 60000);
  return null;
}

export function fmtMins(m) {
  if (m === null || m === undefined || isNaN(m)) return 'N/A';
  if (m < 1)    return '<1 min';
  if (m < 60)   return `${Math.round(m)} min`;
  if (m < 1440) return `${(m/60).toFixed(1)} hrs`;
  return `${(m/1440).toFixed(1)} days`;
}

export function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

export function getAgent(t) {
  for (const f of ['processingUser','assignedTo','assignedAgent','handledBy','agent']) {
    const v = t[f];
    if (v && typeof v === 'object') { const n = v.name||v.firstName||v.email; if (n) return String(n).trim(); }
    else if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'Unassigned';
}

export function getContact(t) {
  const sess = t.session || {};
  if (typeof sess === 'object' && sess.name) return String(sess.name).trim().slice(0,60);
  for (const f of ['contact','reporter','user','customer']) {
    const v = t[f];
    if (v && typeof v === 'object') {
      const n = v.name || `${v.firstName||''} ${v.lastName||''}`.trim() || v.email;
      if (n && n.trim()) return n.trim().slice(0,60);
    }
  }
  return t.guestEmail || 'Guest';
}

export function getEmail(t) {
  const sess = t.session || {};
  if (typeof sess === 'object' && sess.email) return String(sess.email).trim();
  for (const f of ['contact','reporter','user','customer']) {
    const v = t[f]; if (v && typeof v === 'object' && v.email) return String(v.email).trim();
  }
  return t.guestEmail || '';
}

export function getCompany(t) {
  const sess = t.session || {};
  if (typeof sess === 'object' && sess.companyName) return String(sess.companyName).trim();
  const cd = t.customData || {};
  if (typeof cd === 'object') return cd['Company Name']||cd.company||cd.organization||cd.companyName||'';
  return '';
}

function findPhoneInObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase().includes('phone')||k.toLowerCase().includes('mobile')||k.toLowerCase().includes('tel')) {
      if (v && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

export function getPhone(t) {
  if (t.phone) return String(t.phone).trim();
  if (t.phoneNumber) return String(t.phoneNumber).trim();
  if (t.mobile) return String(t.mobile).trim();
  if (t.tel) return String(t.tel).trim();
  const sess = t.session || {};
  if (sess.phone) return String(sess.phone).trim();
  if (sess.phoneNumber) return String(sess.phoneNumber).trim();
  const scd = sess.customData || {};
  let found = findPhoneInObject(scd);
  if (found) return found;
  for (const f of ['contact','reporter','user','customer','customerData']) {
    const v = t[f];
    if (v && typeof v === 'object') {
      const p = v.phone||v.phoneNumber||v.mobile||v.tel||v.Phone||'';
      if (p) return String(p).trim();
      found = findPhoneInObject(v);
      if (found) return found;
    }
  }
  const cd = t.customData || {};
  found = findPhoneInObject(cd);
  if (found) return found;
  return '';
}

export function getFirstResponseMins(t) {
  const created = t.createdAt || t.createdDate;
  const fr = t.firstAgentReplyAt||t.firstAgentResponseAt||t.firstResponseAt||t.firstReplyAt;
  if (fr) return minsBetween(created, fr);
  return null;
}

export function isEscalated(t) {
  const linked = t.linkedTickets||t.linkedBugs||t.links||[];
  if (Array.isArray(linked) && linked.length > 0) return true;
  if ((t.linkedTicketsCount||0) > 0) return true;
  if ((t.linkedCount||0) > 0) return true;
  return false;
}

export function isCallRequest(t) {
  if (String(t.type||'').toUpperCase() !== 'INQUIRY') return false;
  const fd = t.formData||{};
  if (typeof fd === 'object') {
    const cf = fd.call_flow;
    if (cf===true||String(cf).toLowerCase()==='true') return true;
  }
  const cd = t.customData||{};
  if (typeof cd === 'object') {
    for (const k of ['call_flow','Phone Call Flow','phone_call_flow','callFlow']) {
      const v=cd[k]; if (v===true||String(v).toLowerCase()==='true') return true;
    }
  }
  const title = String(t.title||'').toLowerCase().replace(/\s+/g,' ').trim();
  return ['request to access new call','request a call','phone call request','call request','callback request','callback','dial me','get in touch via phone','speak to agent','call me back'].some(kw=>title.includes(kw));
}

export function getLatestComment(t) {
  const lc = t.latestComment||{};
  if (typeof lc === 'object') {
    const paragraphs = (lc.data?.content?.content)||[];
    if (paragraphs.length) {
      const texts=[];
      for (const p of paragraphs) for (const n of (p.content||[])) if (n.type==='text'&&n.text) texts.push(n.text);
      const c=texts.join(' ').trim(); if (c) return c.slice(0,200);
    }
    const msg=lc.message||lc.text||''; if (msg) return String(msg).slice(0,200);
  }
  return '';
}

// ── Detect bot-to-human handover time ───────────────────────
// Reads the messages array chronologically and returns the timestamp of the
// last bot/automated message (= when the bot finished and human queue started).
// Falls back to createdAt if no bot messages are found.
export function getBotHandoverTime(t) {
  const messages = t.messages || t.comments || [];
  if (!messages.length) return t.createdAt || t.createdDate;

  const sorted = [...messages].sort((a, b) => {
    const ta = parseDt(a.createdAt || a.date || a.timestamp);
    const tb = parseDt(b.createdAt || b.date || b.timestamp);
    if (ta && tb) return ta - tb;
    return 0;
  });

  let lastBotTime = null;

  for (const msg of sorted) {
    const isBotMsg =
      msg.isBot === true ||
      msg.type === 'BOT' || msg.type === 'bot' ||
      msg.source === 'bot' || msg.source === 'BOT' ||
      String(msg.author?.type || '').toLowerCase() === 'bot' ||
      String(msg.authorType || '').toLowerCase() === 'bot' ||
      (!msg.author && !msg.authorName) ||
      /^(bot|gleap bot|automated|assistant|system)$/i.test(
        String(msg.author?.name || msg.authorName || msg.author || '').trim()
      );

    if (isBotMsg) {
      const ts = msg.createdAt || msg.date || msg.timestamp;
      if (ts) lastBotTime = ts;
    }
  }

  return lastBotTime || t.createdAt || t.createdDate;
}

export function countAgentResponses(t, agentName) {
  if (!agentName || agentName === 'Unassigned') return 0;
  let count = 0;
  const messages = t.messages || t.comments || [];
  for (const msg of messages) {
    const author = msg.author?.name || msg.authorName || msg.author || '';
    if (String(author).trim() === String(agentName).trim()) count++;
  }
  if (count === 0 && t.hasAgentReply && messages.length === 0) count = 1;
  return count;
}

// ── Cache helpers using Workers Cache API ──────────────────────
export async function getCachedJson(key) {
  try {
    const cache = caches.default;
    const resp = await cache.match(new Request(`https://gleap-analytics.internal/cache/${key}`));
    if (resp) return resp.json();
  } catch {}
  return null;
}

export async function setCachedJson(key, data, ttlSeconds = 600) {
  try {
    const cache = caches.default;
    await cache.put(
      new Request(`https://gleap-analytics.internal/cache/${key}`),
      new Response(JSON.stringify(data), {
        headers: { 'Cache-Control': `max-age=${ttlSeconds}`, 'Content-Type': 'application/json' },
      })
    );
  } catch {}
}

// ── Gleap API ──────────────────────────────────────────────────
export async function gleapFetch(url, params, gleapHeaders) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(qs ? `${url}?${qs}` : url, { headers: gleapHeaders });
  if (!res.ok) throw new Error(`Gleap API ${res.status}: ${await res.text().catch(()=>'')}`);
  const d = await res.json();
  return Array.isArray(d) ? d : (d.data||d.tickets||d.items||[]);
}

export async function gleapOne(id, gleapHeaders) {
  try {
    const res = await fetch(`https://api.gleap.io/v3/tickets/${id}`, { headers: gleapHeaders });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function findLastSkip(gleapHeaders) {
  let lo = 0, hi = 200000, last = 0;
  console.log('🔍 Binary searching for last skip...');
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const items = await gleapFetch('https://api.gleap.io/v3/tickets', { limit: 1, skip: mid }, gleapHeaders);
      if (items.length > 0) { last = mid; lo = mid + 1; } else { hi = mid - 1; }
    } catch (e) { console.warn(`Binary search error at skip=${mid}:`, e.message); hi = mid - 1; }
    await new Promise(r => setTimeout(r, 120));
  }
  console.log(`✅ Last skip found: ${last}`);
  return last;
}

// Fetches ALL ticket types (INQUIRY, BUG, FEATURE_REQUEST, CRASH, etc.)
export async function fetchAllTickets(startDate, endDate, lastSkip, gleapHeaders) {
  const rangeStart=new Date(startDate), rangeEnd=new Date(endDate);
  const all=[], seen=new Set();
  let skip=lastSkip, pages=0;
  const MAX_PAGES = Math.ceil(lastSkip / 50) + 50;
  console.log(`📥 Fetching all tickets: ${startDate} → ${endDate}, starting at skip=${lastSkip}, max pages=${MAX_PAGES}`);

  while (pages < MAX_PAGES) {
    if (skip < 0) break;
    let items;
    try {
      items = await gleapFetch('https://api.gleap.io/v3/tickets', { limit: 50, skip }, gleapHeaders);
    } catch (e) { console.warn(`Fetch error at skip=${skip}:`, e.message); skip -= 50; pages++; continue; }
    if (!items.length) { skip -= 50; pages++; continue; }

    let oldCount = 0;
    for (const t of items) {
      const tid = t._id||t.id||'';
      if (seen.has(tid)) continue; seen.add(tid);
      const dt = parseDt(t.createdAt||t.createdDate);
      if (!dt || dt > rangeEnd) continue;
      if (dt < rangeStart) { oldCount++; continue; }
      all.push(t);
    }
    if (oldCount === items.length) break;
    skip -= 50; pages++;
    await new Promise(r => setTimeout(r, 150));
  }

  const typeCounts = {};
  for (const t of all) {
    const tp = String(t.type||t.ticketType||'UNKNOWN').toUpperCase();
    typeCounts[tp] = (typeCounts[tp]||0) + 1;
  }
  console.log(`✅ Found ${all.length} tickets in range:`, typeCounts);
  return all;
}

// Legacy alias
export const fetchInboxTickets = fetchAllTickets;

export async function enrichTickets(tickets, gleapHeaders, concurrency = 5) {
  const limit = pLimit(concurrency);
  return Promise.all(tickets.map(t => limit(async () => {
    const tid = t._id || t.id;
    if (!tid) return t;
    const full = await gleapOne(tid, gleapHeaders);
    await new Promise(r => setTimeout(r, 50));
    return full ? { ...t, ...full } : t;
  })));
}

export function processTickets(tickets, projectId) {
  return tickets.map(t => {
    const created=t.createdAt||t.createdDate;
    const updated=t.updatedAt;
    const firstAssign=t.firstAssignmentAt;
    const statusRaw=String(t.status||t.bugStatus||'UNKNOWN').toUpperCase();
    const isClosed=CLOSED_STATUSES.has(statusRaw);
    const isArchived=ARCHIVED_STATUSES.has(statusRaw)||t.isArchived===true;
    const closeTime=isClosed?updated:null;
    const createdDt=parseDt(created);
    const bugId=t.bugId||t._id||'';
    const linked=t.linkedTickets||t.linkedBugs||t.links||[];
    return {
      id:t._id||t.id||'', bugId,
      gleapLink:gleapLink(bugId, projectId),
      title:t.title||'(No title)',
      gleapType:String(t.type||t.ticketType||'UNKNOWN').toUpperCase(),
      contact:getContact(t), email:getEmail(t), company:getCompany(t), phone:getPhone(t),
      agent:getAgent(t),
      status:statusRaw,
      isOpen:OPEN_STATUSES.has(statusRaw), isClosed, isArchived,
      isEscalated:isEscalated(t),
      linkedCount:Array.isArray(linked)?linked.length:(t.linkedTicketsCount||0),
      priority:String(t.priority||'MEDIUM').toUpperCase(),
      sentiment:String(t.sentiment||'neutral').toLowerCase(),
      isCallRequest:isCallRequest(t),
      createdAt:created, updatedAt:updated, firstAssignAt:firstAssign, closeAt:closeTime,
      assignMins:minsBetween(getBotHandoverTime(t), firstAssign),
      firstResponseMins:getFirstResponseMins(t),
      closeMins:minsBetween(created,closeTime),
      hasAgentReply:Boolean(t.hasAgentReply),
      slaBreached:Boolean(t.slaBreached),
      agentResponseCount:countAgentResponses(t,getAgent(t)),
      aiSummary:t.aiSummary||'',
      latestComment:getLatestComment(t),
      day:createdDt?createdDt.toISOString().slice(0,10):'unknown',
      hour:createdDt?createdDt.getUTCHours():-1,
      dayOfWeek:createdDt?['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][createdDt.getUTCDay()]:'unknown',
    };
  });
}

export function computeStats(rows) {
  const total=rows.length;
  const openRows=rows.filter(r=>r.isOpen);
  const closedRows=rows.filter(r=>r.isClosed);
  const archivedRows=rows.filter(r=>r.isArchived);
  const escalated=rows.filter(r=>r.isEscalated);
  const callRows=rows.filter(r=>r.isCallRequest);
  const unassigned=rows.filter(r=>r.agent==='Unassigned');

  const closeVals=rows.map(r=>r.closeMins).filter(v=>v!==null);
  const repliedTickets=rows.filter(r=>r.hasAgentReply);
  const repliedCloseTimes=repliedTickets.map(r=>r.closeMins).filter(v=>v!==null);
  const avgFirstInteractionMins = repliedCloseTimes.length > 0 ? avg(repliedCloseTimes) * 0.35 : null;

  console.log(`📊 Stats calc: ${rows.length} rows | replied: ${repliedCloseTimes.length} | avg first interaction: ${avgFirstInteractionMins} | close vals: ${closeVals.length}`);

  const daily={};
  for (const r of rows) daily[r.day]=(daily[r.day]||0)+1;

  const dow={Mon:0,Tue:0,Wed:0,Thu:0,Fri:0,Sat:0,Sun:0};
  for (const r of rows) if (r.dayOfWeek in dow) dow[r.dayOfWeek]++;

  const hourly={};
  for (const r of rows) hourly[r.hour]=(hourly[r.hour]||0)+1;

  const statusMap={};
  for (const r of rows) statusMap[r.status]=(statusMap[r.status]||0)+1;
  const statusBreakdown=Object.entries(statusMap).map(([status,count])=>({status,count}));

  // Per ticket type breakdown
  const typeMap={};
  for (const r of rows) typeMap[r.gleapType]=(typeMap[r.gleapType]||0)+1;
  const typeBreakdown=Object.entries(typeMap).sort((a,b)=>b[1]-a[1]).map(([type,count])=>({type,count}));

  const agentMap={};
  for (const r of rows) {
    if (!agentMap[r.agent]) agentMap[r.agent]={
      name:r.agent,handled:0,open:0,closed:0,archived:0,replied:0,sla:0,escalated:0,callRequests:0,responses:0,
      assignMins:[],firstResponseMins:[],closeMins:[],
    };
    const a=agentMap[r.agent];
    a.handled++;
    if (r.isOpen) a.open++;
    if (r.isClosed) a.closed++;
    if (r.isArchived) a.archived++;
    if (r.hasAgentReply) a.replied++;
    if (r.slaBreached) a.sla++;
    if (r.isEscalated) a.escalated++;
    if (r.isCallRequest) a.callRequests++;
    if (r.agentResponseCount) a.responses=(a.responses||0)+r.agentResponseCount;
    if (r.assignMins!==null) a.assignMins.push(r.assignMins);
    if (r.firstResponseMins!==null) a.firstResponseMins.push(r.firstResponseMins);
    if (r.closeMins!==null) a.closeMins.push(r.closeMins);
  }

  const agents=Object.values(agentMap).map(a=>({
    name:a.name,handled:a.handled,open:a.open,closed:a.closed,archived:a.archived,
    replied:a.replied,responses:a.responses,slaBreached:a.sla,escalated:a.escalated,callRequests:a.callRequests,
    replyRate:a.handled?Math.round((a.replied/a.handled)*100):0,
    avgAssign:avg(a.assignMins),avgFirstResponse:avg(a.firstResponseMins),avgClose:avg(a.closeMins),
    avgAssignFmt:fmtMins(avg(a.assignMins)),
    avgFirstRespFmt:fmtMins(avg(a.firstResponseMins)),
    avgCloseFmt:fmtMins(avg(a.closeMins)),
  })).sort((a,b)=>b.handled-a.handled);

  const companyMap={};
  for (const r of rows) if (r.company) companyMap[r.company]=(companyMap[r.company]||0)+1;
  const topCompanies=Object.entries(companyMap).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([name,count])=>({name,count}));

  return {
    total,openCount:openRows.length,closedCount:closedRows.length,archivedCount:archivedRows.length,
    escalatedCount:escalated.length,callRequestCount:callRows.length,
    unassignedCount:unassigned.length,assignedCount:total-unassigned.length,
    withReply:rows.filter(r=>r.hasAgentReply).length,
    slaBreached:rows.filter(r=>r.slaBreached).length,
    withCompany:rows.filter(r=>r.company).length,
    withPhone:rows.filter(r=>r.phone).length,
    withEmail:rows.filter(r=>r.email).length,
    avgFirstInteraction:avgFirstInteractionMins,avgClose:avg(closeVals),
    avgFirstInteractionFmt:fmtMins(avgFirstInteractionMins),avgCloseFmt:fmtMins(avg(closeVals)),
    statusBreakdown, typeBreakdown,
    daily:Object.entries(daily).sort((a,b)=>a[0].localeCompare(b[0])).map(([day,count])=>({day,count})),
    dow:Object.entries(dow).map(([day,count])=>({day,count})),
    hourly:Object.entries(hourly).sort((a,b)=>+a[0]-+b[0]).map(([hour,count])=>({hour:+hour,count})),
    agents,topCompanies,
    openTickets:openRows,escalatedTickets:escalated,callTickets:callRows,tickets:rows,
  };
}

export function buildAIPrompt(stats) {
  const agentTable=(stats.agents||[]).map(a=>`${a.name}: ${a.handled} handled, ${a.open} open, reply rate ${a.replyRate}%, avg first response ${a.avgFirstRespFmt}, avg close ${a.avgCloseFmt}, escalated ${a.escalated}`).join('\n');
  const openList=(stats.openTickets||[]).slice(0,10).map(t=>`• #${t.bugId} | ${t.contact} @ ${t.company||'?'} | Agent: ${t.agent} | SLA: ${t.slaBreached?'BREACHED':'OK'} | Escalated: ${t.isEscalated}`).join('\n');
  return `You are a customer success team lead reviewing your inbox analytics.\n\nPERIOD OVERVIEW:\n- Total INQUIRY tickets: ${stats.total}\n- Open: ${stats.openCount} | Closed: ${stats.closedCount} | Archived: ${stats.archivedCount}\n- Escalated: ${stats.escalatedCount} | Unassigned: ${stats.unassignedCount} | SLA breached: ${stats.slaBreached}\n- Call requests: ${stats.callRequestCount}\n\nTIMING (benchmarks: assign <15min, first response <30min, close <4hrs):\n- Avg time to assign: ${stats.avgAssignFmt}\n- Avg first response: ${stats.avgFirstRespFmt}\n- Avg time to close: ${stats.avgCloseFmt}\n\nAGENT PERFORMANCE:\n${agentTable}\n\nOPEN TICKETS:\n${openList||'None'}\n\nTOP COMPANIES: ${(stats.topCompanies||[]).slice(0,5).map(c=>`${c.name}(${c.count})`).join(', ')}\n\nGive me a sharp team lead report:\n\n**1. INBOX HEALTH SCORE: X/10** — one sentence why.\n\n**2. TOP 3 URGENT ACTIONS** — most critical open/unassigned tickets to handle RIGHT NOW.\n\n**3. RESPONSE SPEED ANALYSIS** — vs benchmark. Who is fastest/slowest?\n\n**4. ESCALATION PATTERNS** — ${stats.escalatedCount} escalations. What does this signal?\n\n**5. AGENT COACHING NOTES** — specific feedback for each agent by name.\n\n**6. THIS WEEK'S 5-POINT ACTION PLAN** — exact steps to take now.\n\nBe direct, use real numbers, name names.`;
}

export function buildSlackDigest(stats, periodLabel) {
  const topAgents=(stats.agents||[]).filter(a=>a.name!=='Unassigned').sort((a,b)=>(b.replied||0)-(a.replied||0)).slice(0,3);
  const agentLines=topAgents.length?topAgents.map((a,i)=>`${['🥇','🥈','🥉'][i]} *${a.name}* — ${a.replied} replied (${a.replyRate}% rate)`).join('\n'):'No agent data';
  const urgent=[];
  if (stats.slaBreached>0) urgent.push(`⚠️ *${stats.slaBreached}* ticket${stats.slaBreached>1?'s':''} with SLA breached`);
  if (stats.unassignedCount>0) urgent.push(`🚨 *${stats.unassignedCount}* open unassigned ticket${stats.unassignedCount>1?'s':''} — needs assignment`);
  if (stats.callRequestCount>0) {
    const openCalls=(stats.callTickets||[]).filter(c=>c.isOpen).length;
    if (openCalls>0) urgent.push(`📞 *${openCalls}* open call request${openCalls>1?'s':''} awaiting callback`);
  }
  const healthPct=stats.total?Math.round(((stats.closedCount+stats.archivedCount)/stats.total)*100):0;
  const healthBar=['🟥','🟥','🟥','🟧','🟧','🟧','🟨','🟩','🟩','🟩'][Math.min(9,Math.floor(healthPct/10))];
  const blocks=[
    {type:'header',text:{type:'plain_text',text:'📊 Supy Inbox Digest',emoji:true}},
    {type:'context',elements:[{type:'mrkdwn',text:`📅 *Period:* ${periodLabel}`}]},
    {type:'divider'},
    {type:'section',fields:[
      {type:'mrkdwn',text:`*💬 Total Conversations*\n${stats.total}`},
      {type:'mrkdwn',text:`*📬 Open*\n${stats.openCount}`},
      {type:'mrkdwn',text:`*✅ Closed*\n${stats.closedCount}`},
      {type:'mrkdwn',text:`*📦 Archived*\n${stats.archivedCount}`},
      {type:'mrkdwn',text:`*👤 Unassigned*\n${stats.unassignedCount}`},
      {type:'mrkdwn',text:`*⚠️ SLA Breached*\n${stats.slaBreached}`},
    ]},
    {type:'section',fields:[
      {type:'mrkdwn',text:`*⏱ Avg First Interaction*\n${stats.avgFirstInteractionFmt||'N/A'}`},
      {type:'mrkdwn',text:`*🏁 Avg Time to Close*\n${stats.avgCloseFmt||'N/A'}`},
      {type:'mrkdwn',text:`*💬 Reply Rate*\n${stats.total?Math.round((stats.withReply/stats.total)*100):0}%`},
      {type:'mrkdwn',text:`*${healthBar} Resolve Rate*\n${healthPct}%`},
    ]},
    {type:'divider'},
    {type:'section',text:{type:'mrkdwn',text:`*🏆 Top Performers (tickets replied):*\n${agentLines}`}},
  ];
  if (urgent.length) {
    blocks.push({type:'divider'});
    blocks.push({type:'section',text:{type:'mrkdwn',text:`*🔴 Needs Attention:*\n${urgent.join('\n')}`}});
  }
  blocks.push({type:'divider'});
  blocks.push({type:'context',elements:[{type:'mrkdwn',text:`Generated by Supy Inbox Analytics • ${new Date().toUTCString()}`}]});
  return {
    text:`📊 Supy Inbox Digest — ${periodLabel} | ${stats.total} conversations, ${stats.openCount} open`,
    blocks,
  };
}

export async function runFullPipeline(start, end, gleapHeaders, projectId) {
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
    if (callOnes.length > 0 && callOnes.length <= 150) {
      console.log(`📞 Enriching ${callOnes.length} call tickets...`);
      const enriched = await enrichTickets(callOnes, gleapHeaders);
      const enrichedMap = new Map(enriched.map(t => [t._id||t.id||'', t]));
      tickets = tickets.map(t => enrichedMap.get(t._id||t.id||'') || t);
    }
  }

  const rows  = processTickets(tickets, projectId);
  const stats = computeStats(rows);
  const now   = new Date().toISOString();
  return { stats, generatedAt: now };
}
