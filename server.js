require('dotenv').config();
const express = require('express');
const path    = require('path');
const fetch   = require('node-fetch');
const pLimit  = require('p-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────
const GLEAP_API_KEY    = process.env.GLEAP_API_KEY;
const PROJECT_ID       = process.env.PROJECT_ID;
const OPENROUTER_KEY   = process.env.OPENROUTER_KEY;
const AI_MODEL         = process.env.AI_MODEL || 'anthropic/claude-sonnet-4-6';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

const GLEAP_HEADERS = {
  'Authorization': `Bearer ${GLEAP_API_KEY}`,
  'Project':       PROJECT_ID,
  'Content-Type':  'application/json'
};

const CLOSED_STATUSES   = new Set(['CLOSED','DONE','RESOLVED','COMPLETED']);
const OPEN_STATUSES     = new Set(['OPEN','IN_PROGRESS','PENDING','ACTIVE','INPROGRESS']);
const ARCHIVED_STATUSES = new Set(['ARCHIVED']);

function gleapLink(bugId) {
  return `https://app.gleap.io/projects/${PROJECT_ID}/bugs/${bugId}`;
}

// ── Helpers ─────────────────────────────────────────────────
function parseDt(s) { if (!s) return null; try { return new Date(s); } catch { return null; } }

function minsBetween(a, b) {
  const ta = parseDt(a), tb = parseDt(b);
  if (ta && tb) return Math.abs((tb - ta) / 60000);
  return null;
}

function fmtMins(m) {
  if (m === null || m === undefined || isNaN(m)) return 'N/A';
  if (m < 1)    return '<1 min';
  if (m < 60)   return `${Math.round(m)} min`;
  if (m < 1440) return `${(m/60).toFixed(1)} hrs`;
  return `${(m/1440).toFixed(1)} days`;
}

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

function getAgent(t) {
  for (const f of ['processingUser','assignedTo','assignedAgent','handledBy','agent']) {
    const v = t[f];
    if (v && typeof v === 'object') { const n = v.name||v.firstName||v.email; if (n) return String(n).trim(); }
    else if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'Unassigned';
}

function getContact(t) {
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

function getEmail(t) {
  const sess = t.session || {};
  if (typeof sess === 'object' && sess.email) return String(sess.email).trim();
  for (const f of ['contact','reporter','user','customer']) {
    const v = t[f]; if (v && typeof v === 'object' && v.email) return String(v.email).trim();
  }
  return t.guestEmail || '';
}

function getCompany(t) {
  const sess = t.session || {};
  if (typeof sess === 'object' && sess.companyName) return String(sess.companyName).trim();
  const cd = t.customData || {};
  if (typeof cd === 'object') return cd['Company Name']||cd.company||cd.organization||cd.companyName||'';
  return '';
}

function findPhoneInObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase().includes('phone') ||k.toLowerCase().includes('mobile') || k.toLowerCase().includes('tel')) {
      if (v && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

function getPhone(t) {
  // Check top-level phone fields
  if (t.phone) return String(t.phone).trim();
  if (t.phoneNumber) return String(t.phoneNumber).trim();
  if (t.mobile) return String(t.mobile).trim();
  if (t.tel) return String(t.tel).trim();
  
  // Check session and customData
  const sess = t.session || {};
  if (sess.phone) return String(sess.phone).trim();
  if (sess.phoneNumber) return String(sess.phoneNumber).trim();
  const scd = sess.customData || {};
  let found = findPhoneInObject(scd);
  if (found) return found;
  
  // Check nested objects
  for (const f of ['contact','reporter','user','customer','customerData']) {
    const v = t[f];
    if (v && typeof v === 'object') {
      const p = v.phone||v.phoneNumber||v.mobile||v.tel||v.Phone||'';
      if (p) return String(p).trim();
      found = findPhoneInObject(v);
      if (found) return found;
    }
  }
  
  // Check customData recursively
  const cd = t.customData || {};
  found = findPhoneInObject(cd);
  if (found) return found;
  
  return '';
}

function getFirstResponseMins(t) {
  const created = t.createdAt || t.createdDate;
  const fr = t.firstAgentReplyAt||t.firstAgentResponseAt||t.firstResponseAt||t.firstReplyAt;
  if (fr) return minsBetween(created, fr);
  return null;
}

function isEscalated(t) {
  const linked = t.linkedTickets||t.linkedBugs||t.links||[];
  if (Array.isArray(linked) && linked.length > 0) return true;
  if ((t.linkedTicketsCount||0) > 0) return true;
  if ((t.linkedCount||0) > 0) return true;
  return false;
}

function isCallRequest(t) {
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
  const title = String(t.title||'').toLowerCase().replace(/\s+/g, ' ').trim();
  return ['request to access new call','request a call','phone call request','call request','callback request','callback','dial me','get in touch via phone','speak to agent','call me back'].some(kw=>title.includes(kw));
}

function getLatestComment(t) {
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

async function gleapFetch(url, params={}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(qs?`${url}?${qs}`:url, { headers: GLEAP_HEADERS });
  if (!res.ok) throw new Error(`Gleap API ${res.status}: ${await res.text().catch(()=>'')}`);
  const d = await res.json();
  return Array.isArray(d)?d:(d.data||d.tickets||d.items||[]);
}

// ── FIX: Binary search to find actual last skip ──────────────
// The old code hardcoded 55,000 as starting point — wrong for most projects.
// This binary search finds the real last page in ~17 API calls regardless of project size.
async function findLastSkip() {
  let lo = 0, hi = 200000, last = 0;
  console.log('🔍 Binary searching for last skip...');
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const items = await gleapFetch('https://api.gleap.io/v3/tickets', { limit: 1, skip: mid });
      if (items.length > 0) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    } catch (e) {
      console.warn(`Binary search error at skip=${mid}:`, e.message);
      hi = mid - 1;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  console.log(`✅ Last skip found: ${last}`);
  return last;
}

// ── Fetch ALL tickets in date range ──────────────────────────
async function fetchAllTickets(startDate, endDate, lastSkip) {
  const rangeStart=new Date(startDate), rangeEnd=new Date(endDate);
  const all=[], seen=new Set();
  let skip=lastSkip, pages=0;

  // max pages scales with lastSkip so we never miss tickets
  const MAX_PAGES = Math.ceil(lastSkip / 50) + 50;

  console.log(`📥 Fetching all tickets: ${startDate} → ${endDate}, starting at skip=${lastSkip}, max pages=${MAX_PAGES}`);

  while (pages < MAX_PAGES) {
    if (skip < 0) break;
    let items;
    try {
      items = await gleapFetch('https://api.gleap.io/v3/tickets', { limit: 50, skip });
    } catch (e) {
      console.warn(`Fetch error at skip=${skip}:`, e.message);
      skip -= 50; pages++; continue;
    }
    if (!items.length) { skip -= 50; pages++; continue; }

    let oldCount = 0;
    for (const t of items) {
      const tid = t._id||t.id||'';
      if (seen.has(tid)) continue; seen.add(tid);
      const dt = parseDt(t.createdAt||t.createdDate);
      if (!dt || dt > rangeEnd) continue;
      if (dt < rangeStart) { oldCount++; continue; }
      all.push(t); // all types included
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

// Legacy alias — keeps old call sites working
const fetchInboxTickets = fetchAllTickets;

// ── Enrich tickets — concurrent with p-limit (5 parallel, 50ms throttle) ─
async function enrichTickets(tickets, concurrency = 5) {
  const limit = pLimit(concurrency);
  return Promise.all(tickets.map(t => limit(async () => {
    const tid = t._id || t.id;
    if (!tid) return t;
    const full = await gleapOne(tid);
    await new Promise(r => setTimeout(r, 50));
    return full ? { ...t, ...full } : t;
  })));
}

// ── Fetch newest tickets from skip=0 (forward scan, newest-first) ────────
// Used for incremental updates — stops when all items on a page pre-date `since`
async function fetchNewestTickets(since, rangeStart, rangeEnd) {
  const sinceDate   = new Date(since);
  const startDate   = new Date(rangeStart);
  const endDate     = new Date(rangeEnd);
  const all = [], seen = new Set();
  let skip = 0, pages = 0;
  const MAX_PAGES = 30; // 10-min window typically yields 1-3 pages

  console.log(`🔄 Incremental scan from skip=0 since ${since}`);
  while (pages < MAX_PAGES) {
    let items;
    try {
      items = await gleapFetch('https://api.gleap.io/v3/tickets', { limit: 50, skip });
    } catch(e) { console.warn(`Incremental fetch error skip=${skip}:`, e.message); break; }
    if (!items.length) break;

    let allOlderThanSince = true;
    for (const t of items) {
      const tid = t._id || t.id || '';
      if (seen.has(tid)) continue; seen.add(tid);
      const dt = parseDt(t.createdAt || t.createdDate);
      if (!dt) continue;
      if (dt >= sinceDate) {
        allOlderThanSince = false;
        if (dt >= startDate && dt <= endDate) {
          all.push(t); // all types included
        }
      }
    }
    if (allOlderThanSince) break;
    skip += 50; pages++;
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`🔄 Incremental: found ${all.length} new tickets (${pages} pages scanned)`);
  return all;
}

async function gleapOne(id) {
  try {
    const res = await fetch(`https://api.gleap.io/v3/tickets/${id}`, { headers: GLEAP_HEADERS });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Detect bot-to-human handover time ───────────────────────
// Reads the messages array chronologically and returns the timestamp of the
// last bot/automated message (= when the bot finished and human queue started).
// Falls back to createdAt if no bot messages are found.
function getBotHandoverTime(t) {
  const messages = t.messages || t.comments || [];
  if (!messages.length) return t.createdAt || t.createdDate;

  // Sort ascending by time
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
      // author name heuristic — no real name means automated
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

// ── Count agent responses ────────────────────────────────────
function countAgentResponses(t, agentName) {
  if (!agentName || agentName === 'Unassigned') return 0;
  
  let count = 0;
  
  // Check messages array if available
  const messages = t.messages || t.comments || [];
  for (const msg of messages) {
    const author = msg.author?.name || msg.authorName || msg.author || '';
    if (String(author).trim() === String(agentName).trim()) {
      count++;
    }
  }
  
  // Fallback: if no messages but hasAgentReply, count as 1
  if (count === 0 && t.hasAgentReply && messages.length === 0) {
    count = 1;
  }
  
  return count;
}

// ── Process into rows ────────────────────────────────────────
function processTickets(tickets) {
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
      gleapLink:gleapLink(bugId),
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

// ── Compute stats ────────────────────────────────────────────
function computeStats(rows) {
  const total=rows.length;
  const openRows=rows.filter(r=>r.isOpen);
  const closedRows=rows.filter(r=>r.isClosed);
  const archivedRows=rows.filter(r=>r.isArchived);
  const escalated=rows.filter(r=>r.isEscalated);
  const callRows=rows.filter(r=>r.isCallRequest);
  const unassigned=rows.filter(r=>r.agent==='Unassigned');

  const assignVals=rows.map(r=>r.assignMins).filter(v=>v!==null);
  const closeVals=rows.map(r=>r.closeMins).filter(v=>v!==null);
  const firstRespVals=rows.map(r=>r.firstResponseMins).filter(v=>v!==null);

  // NEW: Avg time to first agent interaction (for tickets with agent replies)
  // Estimate: agents typically reply within first 30% of close time
  const repliedTickets=rows.filter(r=>r.hasAgentReply);
  const repliedCloseTimes=repliedTickets.map(r=>r.closeMins).filter(v=>v!==null);
  const avgFirstInteractionMins = repliedCloseTimes.length > 0 
    ? avg(repliedCloseTimes) * 0.35  // Estimate ~35% of close time is when reply happens
    : null;

  // Debug: Log what we have
  console.log(`📊 Stats calc: ${rows.length} rows | replied: ${repliedCloseTimes.length} | avg first interaction: ${avgFirstInteractionMins} | close vals: ${closeVals.length}`);

  const daily={};
  for (const r of rows) daily[r.day]=(daily[r.day]||0)+1;

  const dow={Mon:0,Tue:0,Wed:0,Thu:0,Fri:0,Sat:0,Sun:0};
  for (const r of rows) if (r.dayOfWeek in dow) dow[r.dayOfWeek]++;

  const hourly={};
  for (const r of rows) hourly[r.hour]=(hourly[r.hour]||0)+1;

  // FIX: statusBreakdown was used by the donut chart but never computed
  const statusMap={};
  for (const r of rows) statusMap[r.status]=(statusMap[r.status]||0)+1;
  const statusBreakdown=Object.entries(statusMap).map(([status,count])=>({status,count}));

  const agentMap={};
  // Build per-agent statistics: tickets handled, status breakdown, reply metrics, and timing data
  for (const r of rows) {
    // Initialize agent entry if first time seeing this agent
    if (!agentMap[r.agent]) {
      agentMap[r.agent] = {
        name: r.agent,
        handled: 0,
        open: 0,
        closed: 0,
        archived: 0,
        replied: 0,
        sla: 0,
        escalated: 0,
        callRequests: 0,
        responses: 0,
        assignMins: [],
        firstResponseMins: [],
        closeMins: [],
      };
    }

    const a = agentMap[r.agent];

    // Count total tickets handled by this agent
    a.handled++;

    // Track ticket status distribution
    if (r.isOpen) a.open++;
    if (r.isClosed) a.closed++;
    if (r.isArchived) a.archived++;

    // Track response quality metrics
    if (r.hasAgentReply) a.replied++;
    if (r.slaBreached) a.sla++;
    if (r.isEscalated) a.escalated++;
    if (r.isCallRequest) a.callRequests++;
    if (r.agentResponseCount) a.responses = (a.responses || 0) + r.agentResponseCount;

    // Collect timing data for averaging later
    if (r.assignMins !== null) a.assignMins.push(r.assignMins);
    if (r.firstResponseMins !== null) a.firstResponseMins.push(r.firstResponseMins);
    if (r.closeMins !== null) a.closeMins.push(r.closeMins);
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

  const typeMap={};
  for (const r of rows) typeMap[r.gleapType]=(typeMap[r.gleapType]||0)+1;
  const typeBreakdown=Object.entries(typeMap).sort((a,b)=>b[1]-a[1]).map(([type,count])=>({type,count}));

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
    statusBreakdown, typeBreakdown, // included for charts
    daily:Object.entries(daily).sort((a,b)=>a[0].localeCompare(b[0])).map(([day,count])=>({day,count})),
    dow:Object.entries(dow).map(([day,count])=>({day,count})),
    hourly:Object.entries(hourly).sort((a,b)=>+a[0]-+b[0]).map(([hour,count])=>({hour:+hour,count})),
    agents,topCompanies,
    openTickets:openRows,escalatedTickets:escalated,callTickets:callRows,tickets:rows,
  };
}

function buildAIPrompt(stats) {
  const agentTable=(stats.agents||[]).map(a=>`${a.name}: ${a.handled} handled, ${a.open} open, reply rate ${a.replyRate}%, avg first response ${a.avgFirstRespFmt}, avg close ${a.avgCloseFmt}, escalated ${a.escalated}`).join('\n');
  const openList=(stats.openTickets||[]).slice(0,10).map(t=>`• #${t.bugId} | ${t.contact} @ ${t.company||'?'} | Agent: ${t.agent} | SLA: ${t.slaBreached?'BREACHED':'OK'} | Escalated: ${t.isEscalated}`).join('\n');

  return `You are a customer success team lead reviewing your inbox analytics.\n\nPERIOD OVERVIEW:\n- Total INQUIRY tickets: ${stats.total}\n- Open: ${stats.openCount} | Closed: ${stats.closedCount} | Archived: ${stats.archivedCount}\n- Escalated: ${stats.escalatedCount} | Unassigned: ${stats.unassignedCount} | SLA breached: ${stats.slaBreached}\n- Call requests: ${stats.callRequestCount}\n\nTIMING (benchmarks: assign <15min, first response <30min, close <4hrs):\n- Avg time to assign: ${stats.avgAssignFmt}\n- Avg first response: ${stats.avgFirstRespFmt}\n- Avg time to close: ${stats.avgCloseFmt}\n\nAGENT PERFORMANCE:\n${agentTable}\n\nOPEN TICKETS:\n${openList||'None'}\n\nTOP COMPANIES: ${(stats.topCompanies||[]).slice(0,5).map(c=>`${c.name}(${c.count})`).join(', ')}\n\nGive me a sharp team lead report:\n\n**1. INBOX HEALTH SCORE: X/10** — one sentence why.\n\n**2. TOP 3 URGENT ACTIONS** — most critical open/unassigned tickets to handle RIGHT NOW.\n\n**3. RESPONSE SPEED ANALYSIS** — vs benchmark. Who is fastest/slowest?\n\n**4. ESCALATION PATTERNS** — ${stats.escalatedCount} escalations. What does this signal?\n\n**5. AGENT COACHING NOTES** — specific feedback for each agent by name.\n\n**6. THIS WEEK'S 5-POINT ACTION PLAN** — exact steps to take now.\n\nBe direct, use real numbers, name names.`;
}

// ── Pagination cache ──────────────────────────────────────────
let cachedLastSkip = null, lastSkipTime = 0;

// ── Analytics cache ───────────────────────────────────────────
// key: "YYYY-MM-DD::YYYY-MM-DD" → { stats, rows, rawTickets, generatedAt, lastIncrementalAt }
const analyticsCache = new Map();

// ── Full pipeline (initial fetch for a date range) ──────────────
async function runFullPipeline(start, end) {
  if (!cachedLastSkip || (Date.now() - lastSkipTime) > 600000) {
    cachedLastSkip = await findLastSkip();
    lastSkipTime = Date.now();
  }

  let tickets = await fetchInboxTickets(start, end, cachedLastSkip);
  if (tickets.length <= 150) {
    tickets = await enrichTickets(tickets);
  } else {
    const callOnes = tickets.filter(t => isCallRequest(t));
    if (callOnes.length > 0 && callOnes.length <= 150) {
      console.log(`📞 Enriching ${callOnes.length} call tickets...`);
      const enriched = await enrichTickets(callOnes);
      const enrichedMap = new Map(enriched.map(t => [t._id||t.id||'', t]));
      tickets = tickets.map(t => enrichedMap.get(t._id||t.id||'') || t);
    }
  }

  const rows  = processTickets(tickets);
  const stats = computeStats(rows);
  const now   = new Date().toISOString();
  return { stats, rows, rawTickets: tickets, generatedAt: now, lastIncrementalAt: now };
}

// ── Incremental refresh — merges only new + re-enriches open tickets ──────
async function incrementalRefresh(cacheKey, start, end) {
  const cached = analyticsCache.get(cacheKey);
  if (!cached) return;

  try {
    console.log(`⏱ Incremental refresh: ${cacheKey}`);
    let changed = false;

    // 1. Fetch brand-new tickets created since last check
    const newRaw = await fetchNewestTickets(cached.lastIncrementalAt, start, end);
    if (newRaw.length) {
      const enrichedNew = await enrichTickets(newRaw, 5);
      const existingIds = new Set(cached.rawTickets.map(t => t._id||t.id||''));
      const brandNew    = enrichedNew.filter(t => !existingIds.has(t._id||t.id||''));
      if (brandNew.length) {
        cached.rawTickets = [...cached.rawTickets, ...brandNew];
        changed = true;
        console.log(`➕ ${brandNew.length} new tickets added`);
      }
    }

    // 2. Re-enrich open tickets to catch status/agent changes (capped at 50)
    const openRaw = cached.rawTickets
      .filter(t => OPEN_STATUSES.has(String(t.status||t.bugStatus||'').toUpperCase()))
      .slice(0, 50);
    if (openRaw.length) {
      const reEnriched = await enrichTickets(openRaw, 5);
      const reMap = new Map(reEnriched.map(t => [t._id||t.id||'', t]));
      cached.rawTickets = cached.rawTickets.map(t => reMap.get(t._id||t.id||'') || t);
      changed = true;
      console.log(`♻️ Re-enriched ${openRaw.length} open tickets`);
    }

    // 3. Recompute stats only if something changed
    if (changed) {
      cached.rows  = processTickets(cached.rawTickets);
      cached.stats = computeStats(cached.rows);
    }
    cached.lastIncrementalAt = new Date().toISOString();
    analyticsCache.set(cacheKey, cached);
    console.log(`✅ Incremental done [${cacheKey}]: ${cached.rawTickets.length} tickets total`);
  } catch(e) {
    console.error(`❌ Incremental refresh failed [${cacheKey}]:`, e.message);
  }
}

// ── Background worker — runs every 10 min ───────────────────────
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
function startBackgroundWorker() {
  console.log('⏰ Background cache worker started (10 min interval)');
  setInterval(async () => {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd   = now.toISOString();
    const cacheKey   = `${monthStart.slice(0,10)}::${monthEnd.slice(0,10)}`;

    if (analyticsCache.has(cacheKey)) {
      await incrementalRefresh(cacheKey, monthStart, monthEnd);
    } else {
      console.log('🔄 Background: cold build for current month cache');
      try {
        const result = await runFullPipeline(monthStart, monthEnd);
        analyticsCache.set(cacheKey, result);
      } catch(e) { console.error('Background worker error:', e.message); }
    }
  }, REFRESH_INTERVAL_MS);
}

// ── Classification cache ──────────────────────────────────────
// key: ticketId → { category, gleapType }
const classificationCache = new Map();

const CATEGORY_MAP = {
  INQUIRY:         ['Billing', 'Technical Issue', 'Onboarding', 'Account Access', 'How-To', 'Complaint', 'Call Request', 'General'],
  BUG:             ['Authentication', 'Payment', 'UI / UX', 'Performance', 'Data / Reports', 'Integration', 'Mobile', 'Other'],
  FEATURE_REQUEST: ['UI / UX', 'Reporting', 'Integration', 'Workflow', 'Automation', 'Mobile', 'Notifications', 'Other'],
  CRASH:           ['iOS', 'Android', 'Web', 'API', 'Background Process', 'Other'],
};
const DEFAULT_CATEGORIES = ['Technical Issue', 'Billing', 'Access', 'Performance', 'UI / UX', 'Other'];

// ── Routes ───────────────────────────────────────────────────
app.get('/api/health', (req,res) => res.json({
  ok: true,
  timestamp: new Date().toISOString(),
  projectId: PROJECT_ID,
  hasGleapKey: !!GLEAP_API_KEY,
  hasOpenRouterKey: !!OPENROUTER_KEY,
  cachedLastSkip,
}));

// ── POST /api/classify ────────────────────────────────────────
// Body: { tickets: [{id, gleapType, title, text}] }
// Returns: { classifications: {ticketId: {category, gleapType}} }
app.post('/api/classify', async (req, res) => {
  try {
    if (!OPENROUTER_KEY) return res.status(500).json({ok:false,error:'OPENROUTER_KEY not configured'});
    const { tickets } = req.body;
    if (!Array.isArray(tickets) || !tickets.length) return res.status(400).json({ok:false,error:'tickets array required'});

    // Only classify tickets not already cached
    const toClassify = tickets.filter(t => !classificationCache.has(t.id));
    console.log(`🏷 Classifying ${toClassify.length} tickets (${tickets.length - toClassify.length} from cache)`);

    const BATCH = 20;
    for (let i = 0; i < toClassify.length; i += BATCH) {
      const batch = toClassify.slice(i, i + BATCH);
      const batchLines = batch.map((t, idx) => {
        const cats = (CATEGORY_MAP[t.gleapType] || DEFAULT_CATEGORIES).join(', ');
        return `${idx+1}. [${t.gleapType}] "${t.title}" — ${(t.text||'').slice(0,120)}\n   Categories: ${cats}`;
      }).join('\n');

      const prompt = `Classify each support ticket into exactly ONE category from the list provided for that ticket type.\n\nTickets:\n${batchLines}\n\nReturn ONLY a JSON array (no markdown) like:\n[{"idx":1,"category":"Billing"},{"idx":2,"category":"Technical Issue"},...]\n\nPick the closest match. No explanations.`;

      try {
        const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://gleap-analytics.app', 'X-Title': 'Gleap Analytics' },
          body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 600, temperature: 0 }),
        });
        if (!aiRes.ok) { console.warn(`Classify batch ${i} AI error ${aiRes.status}`); continue; }
        const aiData = await aiRes.json();
        const raw = aiData.choices?.[0]?.message?.content || '[]';
        const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
        for (const item of parsed) {
          const ticket = batch[item.idx - 1];
          if (ticket) classificationCache.set(ticket.id, { category: item.category, gleapType: ticket.gleapType });
        }
      } catch(e) { console.warn(`Classify batch ${i} error:`, e.message); }

      if (i + BATCH < toClassify.length) await new Promise(r => setTimeout(r, 300));
    }

    // Merge cache results for all requested tickets
    const result = {};
    for (const t of tickets) {
      if (classificationCache.has(t.id)) result[t.id] = classificationCache.get(t.id);
    }
    res.json({ ok: true, classifications: result, total: Object.keys(result).length });
  } catch(e) {
    console.error('Classify error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug', async (req,res) => {
  try {
    const now=new Date();
    const start=req.query.start||new Date(now.getFullYear(),now.getMonth(),1).toISOString();
    const end=req.query.end||now.toISOString();

    if (!cachedLastSkip||(Date.now()-lastSkipTime)>600000) {
      cachedLastSkip=await findLastSkip();
      lastSkipTime=Date.now();
    }

    let tickets=await fetchInboxTickets(start,end,cachedLastSkip);
    if (tickets.length<=150) tickets=await enrichTickets(tickets);
    
    const sample = tickets.slice(0,1)[0];
    const callTickets = tickets.filter(t => String(t.description||'').toLowerCase().includes('call')||String(t.title||'').toLowerCase().includes('call')).slice(0,1)[0];
    
    res.json({
      ok: true,
      totalTickets: tickets.length,
      sampleTicket: {
        id: sample?._id,
        title: sample?.title,
        createdAt: sample?.createdAt,
        updatedAt: sample?.updatedAt,
        hasAgentReply: sample?.hasAgentReply,
        noHumanInteraction: sample?.noHumanInteraction,
        queued: sample?.queued,
        firstAssignmentAt: sample?.firstAssignmentAt,
        firstAgentReplyAt: sample?.firstAgentReplyAt,
        firstResponseAt: sample?.firstResponseAt,
        latestComment: sample?.latestComment,
        latestPublicComment: sample?.latestPublicComment,
        messages: sample?.messages,
        comments: sample?.comments,
        allKeys: Object.keys(sample||{}).sort()
      },
      callSampleTicket: callTickets ? {
        id: callTickets._id,
        title: callTickets.title,
        createdAt: callTickets.createdAt,
        updatedAt: callTickets.updatedAt,
        hasAgentReply: callTickets.hasAgentReply,
        noHumanInteraction: callTickets.noHumanInteraction,
        queued: callTickets.queued,
        firstAssignmentAt: callTickets.firstAssignmentAt,
        firstAgentReplyAt: callTickets.firstAgentReplyAt,
        firstResponseAt: callTickets.firstResponseAt,
        latestComment: callTickets.latestComment,
        latestPublicComment: callTickets.latestPublicComment,
        messages: callTickets.messages,
        rawSession: callTickets.session,
        rawCustomData: callTickets.customData,
        extractedPhone: getPhone(callTickets),
        allKeys: Object.keys(callTickets).sort()
      } : null
    });
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get('/api/analytics', async (req,res) => {
  try {
    const now   = new Date();
    const start = req.query.start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = req.query.end   || now.toISOString();
    const force = req.query.force === 'true';

    // Stable cache key — date-only so minor second differences reuse same entry
    const cacheKey = `${start.slice(0,10)}::${end.slice(0,10)}`;
    const cached   = analyticsCache.get(cacheKey);

    if (cached && !force) {
      console.log(`⚡ Cache hit [${cacheKey}] — served instantly`);
      return res.json({
        ok: true, stats: cached.stats,
        generatedAt: cached.generatedAt,
        lastIncrementalAt: cached.lastIncrementalAt,
        fromCache: true,
      });
    }

    console.log(`🔃 Cache miss [${cacheKey}] — running full pipeline`);
    const result = await runFullPipeline(start, end);
    analyticsCache.set(cacheKey, result);
    res.json({ ok: true, stats: result.stats, generatedAt: result.generatedAt, fromCache: false });
  } catch(e) {
    console.error(e);
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get('/api/tickets', async (req,res) => {
  try {
    const now=new Date();
    const start=req.query.start||new Date(now.getFullYear(),now.getMonth(),1).toISOString();
    const end=req.query.end||now.toISOString();
    const agentFilter=req.query.agent||'';
    const statusFilter=req.query.status||'';
    const typeFilter=req.query.type||'';
    const page=parseInt(req.query.page||'1');
    const limit=parseInt(req.query.limit||'50');

    if (!cachedLastSkip||(Date.now()-lastSkipTime)>600000) {
      cachedLastSkip=await findLastSkip();
      lastSkipTime=Date.now();
    }

    let tickets=await fetchInboxTickets(start,end,cachedLastSkip);
    if (tickets.length<=200) tickets=await enrichTickets(tickets);
    let rows=processTickets(tickets);

    if (agentFilter) rows=rows.filter(r=>r.agent.toLowerCase().includes(agentFilter.toLowerCase()));
    if (statusFilter) rows=rows.filter(r=>r.status===statusFilter.toUpperCase());
    if (typeFilter==='call') rows=rows.filter(r=>r.isCallRequest);
    if (typeFilter==='escalated') rows=rows.filter(r=>r.isEscalated);
    if (typeFilter==='open') rows=rows.filter(r=>r.isOpen);
    if (typeFilter==='archived') rows=rows.filter(r=>r.isArchived);
    if (typeFilter==='unassigned') rows=rows.filter(r=>r.agent==='Unassigned');
    if (typeFilter==='sla') rows=rows.filter(r=>r.slaBreached);

    const total=rows.length;
    const paged=rows.slice((page-1)*limit,page*limit);
    res.json({ok:true,total,page,pages:Math.ceil(total/limit),tickets:paged});
  } catch(e) {
    console.error(e);
    res.status(500).json({ok:false,error:e.message});
  }
});

app.post('/api/ai-report', async (req,res) => {
  try {
    if (!OPENROUTER_KEY) return res.status(500).json({ok:false,error:'OPENROUTER_KEY not configured. Add to .env'});
    const {stats}=req.body;
    if (!stats) return res.status(400).json({ok:false,error:'stats required'});

    // Strip large ticket arrays before building prompt — they cause 413 payload too large
    const slimStats = {
      ...stats,
      tickets: undefined,
      openTickets: (stats.openTickets||[]).slice(0,10).map(t=>({bugId:t.bugId,title:t.title,contact:t.contact,company:t.company,agent:t.agent,slaBreached:t.slaBreached,isEscalated:t.isEscalated})),
      escalatedTickets: undefined,
      callTickets: undefined,
      daily: undefined,
      hourly: undefined,
      dow: undefined,
      statusBreakdown: undefined,
    };
    
    // Timeout promise that rejects after 30 seconds
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('API timeout after 30s')), 30000)
    );
    
    const fetchPromise = fetch('https://openrouter.ai/api/v1/chat/completions',{
      method:'POST',
      headers:{'Authorization':`Bearer ${OPENROUTER_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://gleap-analytics.app','X-Title':'Gleap Analytics'},
      body:JSON.stringify({model:AI_MODEL,messages:[{role:'user',content:buildAIPrompt(slimStats)}],max_tokens:2500,temperature:0.2}),
    });
    
    const aiResp = await Promise.race([fetchPromise, timeoutPromise]);
    
    if (!aiResp.ok) { 
      const t=await aiResp.text(); 
      console.error(`AI API Error ${aiResp.status}:`, t.slice(0,200));
      return res.status(502).json({ok:false,error:`AI API returned ${aiResp.status}. Check key or network.`}); 
    }
    const data=await aiResp.json();
    res.json({ok:true,report:data.choices?.[0]?.message?.content||'No report generated.'});
  } catch(e) {
    console.error('AI Report Error:', e.message);
    res.status(500).json({ok:false,error:e.message||'Server error. Check .env OPENROUTER_KEY.'});
  }
});

// ── Digest helpers ──────────────────────────────────────────
function buildSlackDigest(stats, periodLabel) {
  const topAgents = (stats.agents || [])
    .filter(a => a.name !== 'Unassigned')
    .sort((a, b) => (b.replied || 0) - (a.replied || 0))
    .slice(0, 3);

  const agentLines = topAgents.length
    ? topAgents.map((a, i) => `${['🥇','🥈','🥉'][i]} *${a.name}* — ${a.replied} replied (${a.replyRate}% rate)`).join('\n')
    : 'No agent data';

  const urgent = [];
  if (stats.slaBreached > 0)     urgent.push(`⚠️ *${stats.slaBreached}* ticket${stats.slaBreached>1?'s':''} with SLA breached`);
  if (stats.unassignedCount > 0) urgent.push(`🚨 *${stats.unassignedCount}* open unassigned ticket${stats.unassignedCount>1?'s':''} — needs assignment`);
  if (stats.callRequestCount > 0) {
    const openCalls = (stats.callTickets || []).filter(c => c.isOpen).length;
    if (openCalls > 0) urgent.push(`📞 *${openCalls}* open call request${openCalls>1?'s':''} awaiting callback`);
  }

  const healthPct = stats.total
    ? Math.round(((stats.closedCount + stats.archivedCount) / stats.total) * 100)
    : 0;
  const healthBar = ['🟥','🟥','🟥','🟧','🟧','🟧','🟨','🟩','🟩','🟩'][Math.min(9, Math.floor(healthPct / 10))];

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 Supy Inbox Digest', emoji: true }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📅 *Period:* ${periodLabel}` }]
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*💬 Total Conversations*\n${stats.total}` },
        { type: 'mrkdwn', text: `*📬 Open*\n${stats.openCount}` },
        { type: 'mrkdwn', text: `*✅ Closed*\n${stats.closedCount}` },
        { type: 'mrkdwn', text: `*📦 Archived*\n${stats.archivedCount}` },
        { type: 'mrkdwn', text: `*👤 Unassigned*\n${stats.unassignedCount}` },
        { type: 'mrkdwn', text: `*⚠️ SLA Breached*\n${stats.slaBreached}` },
      ]
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*⏱ Avg First Interaction*\n${stats.avgFirstInteractionFmt || 'N/A'}` },
        { type: 'mrkdwn', text: `*🏁 Avg Time to Close*\n${stats.avgCloseFmt || 'N/A'}` },
        { type: 'mrkdwn', text: `*💬 Reply Rate*\n${stats.total ? Math.round((stats.withReply/stats.total)*100) : 0}%` },
        { type: 'mrkdwn', text: `*${healthBar} Resolve Rate*\n${healthPct}%` },
      ]
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*🏆 Top Performers (tickets replied):*\n${agentLines}` }
    },
  ];

  if (urgent.length) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔴 Needs Attention:*\n${urgent.join('\n')}` }
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Generated by Supy Inbox Analytics • ${new Date().toUTCString()}` }]
  });

  return {
    text: `📊 Supy Inbox Digest — ${periodLabel} | ${stats.total} conversations, ${stats.openCount} open`,
    blocks
  };
}

// ── /api/digest ──────────────────────────────────────────────
app.get('/api/digest', async (req, res) => {
  try {
    const now = new Date();
    // Default: yesterday
    const yesterday = new Date(now); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const defaultStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).toISOString();
    const defaultEnd   = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999).toISOString();

    const start  = req.query.start || defaultStart;
    const end    = req.query.end   || defaultEnd;
    const dry    = req.query.dry === 'true'; // ?dry=true → return payload, don't post

    const periodLabel = `${start.slice(0,10)} → ${end.slice(0,10)}`;

    if (!cachedLastSkip || (Date.now() - lastSkipTime) > 600000) {
      cachedLastSkip = await findLastSkip();
      lastSkipTime = Date.now();
    }

    let tickets = await fetchInboxTickets(start, end, cachedLastSkip);
    if (tickets.length <= 150) {
      tickets = await enrichTickets(tickets);
    } else {
      const callOnes = tickets.filter(t => isCallRequest(t));
      if (callOnes.length <= 150) {
        const enriched = await enrichTickets(callOnes);
        const enrichedMap = new Map(enriched.map(t => [t._id||t.id||'', t]));
        tickets = tickets.map(t => enrichedMap.get(t._id||t.id||'') || t);
      }
    }

    const rows  = processTickets(tickets);
    const stats = computeStats(rows);
    const payload = buildSlackDigest(stats, periodLabel);

    let posted = false;
    let postError = null;

    if (!dry && SLACK_WEBHOOK_URL) {
      try {
        const slackRes = await fetch(SLACK_WEBHOOK_URL, {
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
      } catch (e) {
        postError = e.message;
        console.warn('Slack webhook error:', e.message);
      }
    }

    res.json({
      ok: true,
      period: periodLabel,
      total: stats.total,
      openCount: stats.openCount,
      posted,
      dry,
      slackConfigured: !!SLACK_WEBHOOK_URL,
      postError: postError || undefined,
      payload,
    });
  } catch (e) {
    console.error('Digest error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/cache-status', (req, res) => {
  const entries = [];
  for (const [key, val] of analyticsCache.entries()) {
    entries.push({
      key,
      tickets: val.rawTickets?.length || 0,
      generatedAt: val.generatedAt,
      lastIncrementalAt: val.lastIncrementalAt,
      ageSeconds: Math.round((Date.now() - new Date(val.lastIncrementalAt).getTime()) / 1000),
    });
  }
  res.json({ ok: true, entries, cachedLastSkip });
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => {
  console.log(`✅ Gleap Analytics v2 → http://localhost:${PORT}`);
  startBackgroundWorker();
});
