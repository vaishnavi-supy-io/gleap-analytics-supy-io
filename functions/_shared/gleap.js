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

export function gleapLink(ticketType, id, bugId, projectId) {
  const type = String(ticketType || '').toUpperCase();
  if (type === 'INQUIRY') return `https://app.gleap.io/projects/${projectId}/inquiries/${id}`;
  if (type === 'FEATURE_REQUEST') return `https://app.gleap.io/projects/${projectId}/feature-requests/${id}`;
  if (type === 'CRASH') return `https://app.gleap.io/projects/${projectId}/crashes/${id}`;
  return `https://app.gleap.io/projects/${projectId}/bugs/${bugId || id}`;
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
  // Check explicit call_flow flags in formData / customData
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
  // Search ALL text content — most tickets have no title; user message is in formData.description
  const texts = [
    t.title||'',
    (typeof fd==='object'?fd.description:'') || '',
    (t.form?.description?.value) || '',
    t.plainContent||'',
  ].map(s=>String(s).toLowerCase().replace(/\s+/g,' ').trim()).join(' ');

  return [
    'request to access new call','request a call','phone call request',
    'call request','callback request','call me back','call back',
    'give me a call','schedule a call','arrange a call',
    'please call me','can you call me','can someone call',
    'reach me by phone','contact me by phone','speak over the phone',
    'call me at','dial me','speak to agent',
  ].some(kw=>texts.includes(kw));
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

// ── Recurring-word extraction (Uncategorized keyword feedback loop) ────
const KEYWORD_STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','to','of','in','on',
  'at','for','with','this','that','it','its','i','we','you','they','my','our','your','their',
  'not','no','do','does','did','can','could','would','should','have','has','had','will',
  'just','get','got','please','need','how','what','when','where','why','which','who',
  'issue','ticket','help','app','item','also','from','as','by','if','so','me','us','them',
  'all','any','some','one','two','there','here','been','being','than','then','now','still',
  'about','into','over','out','up','down','only','same','more','most','via','per',
]);
export function extractKeywords(rows, limit=20) {
  const counts = {};
  for (const r of rows) {
    const text = `${r.title||''} ${r.aiSummary||''} ${r.latestComment||''}`.toLowerCase();
    const words = text.replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
      .filter(w => w.length>2 && !KEYWORD_STOPWORDS.has(w) && isNaN(w));
    const seenInTicket = new Set(); // count once per ticket so one verbose ticket can't dominate
    for (const w of words) {
      if (seenInTicket.has(w)) continue;
      seenInTicket.add(w);
      counts[w] = (counts[w]||0) + 1;
    }
  }
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([word,count])=>({word,count}));
}

// ── Uncategorized sub-clustering ──────────────────────────────────────────
// Turns the residual "Uncategorized" bucket into MECE emergent theme clusters
// (each ticket in exactly one cluster; clusters sum to the residual total),
// mirroring classifyTicket's "first/best match wins" discipline. Bigrams are
// preferred as labels; tickets matching no recurring seed fall into
// "Other (residual)" — kept visible on purpose so we never fabricate a trend.
const UNCAT_MAX_CLUSTERS = 12;
// Agent-boilerplate / greeting tokens that pollute clustering (they describe
// how a ticket was answered, not what it was about). Clustering uses only
// title + aiSummary — never latestComment, which is usually the agent's reply.
const UNCAT_BOILERPLATE = new Set([
  'thank','thanks','thanking','trusting','trust','feel','free','reach','reaching',
  'regards','kindly','welcome','glad','happy','assist','assistance','hello','dear',
  'team','support','further','queries','query','hesitate','anytime','pleasure',
  'greetings','warm','sincerely','cheers','noted','acknowledged','request','inquiry',
]);
function uncatTerms(r) {
  const title = (r.title && r.title !== '(No title)') ? r.title : ''; // drop the sentinel
  const text = `${title} ${r.aiSummary||''}`.toLowerCase();
  const words = text.replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
    .filter(w => w.length>2 && !KEYWORD_STOPWORDS.has(w) && !UNCAT_BOILERPLATE.has(w) && isNaN(w));
  const terms = new Set();
  for (let i=0;i<words.length-1;i++) terms.add(`${words[i]} ${words[i+1]}`); // bigrams first
  for (const w of words) terms.add(w);
  return { terms, words };
}
// Closest existing category by keyword-token overlap. Only returned when the
// overlap is strong enough to be a real tuning hint — a misleading chip is
// worse than none, and these tickets matched no keyword by definition.
function nearestCategory(catRows) {
  const tokenDf = {};
  for (const r of catRows) {
    const seen = new Set();
    for (const w of uncatTerms(r).words) {
      if (seen.has(w)) continue; seen.add(w);
      tokenDf[w] = (tokenDf[w]||0) + 1;
    }
  }
  let best=null, bestScore=0;
  for (const cat of CATEGORIES) {
    let score=0;
    for (const kw of cat.keywords) for (const kt of kw.split(' ')) if (tokenDf[kt]) score += tokenDf[kt];
    if (score>bestScore) { bestScore=score; best=cat.name; }
  }
  const threshold = Math.max(3, Math.ceil(0.3 * catRows.length));
  return bestScore>=threshold ? best : null;
}
export function clusterUncategorized(rows) {
  const N = rows.length;
  if (!N) return [];
  const ticketTerms = [];
  const df = {};
  for (const r of rows) {
    const { terms } = uncatTerms(r);
    ticketTerms.push(terms);
    for (const t of terms) df[t] = (df[t]||0) + 1;
  }
  const EMPTY = '(no title / summary)'; // honest bucket for content-less tickets
  const floor = Math.max(3, Math.ceil(0.02 * N));
  // Seed candidates: bigrams before unigrams, each group by df desc.
  const seeds = Object.entries(df)
    .filter(([,c]) => c >= floor)
    .sort((a,b) => (b[0].includes(' ')?1:0)-(a[0].includes(' ')?1:0) || b[1]-a[1])
    .map(([t]) => t);
  const assign = idx => { for (const s of seeds) if (ticketTerms[idx].has(s)) return s; return null; };
  // Pass 1 — tentative assignment; drop seeds whose cluster falls below floor.
  const counts = {};
  for (let i=0;i<N;i++) { const s=assign(i); if (s) counts[s]=(counts[s]||0)+1; }
  const validSeeds = seeds.filter(s => (counts[s]||0) >= floor).slice(0, UNCAT_MAX_CLUSTERS);
  const validSet = new Set(validSeeds);
  // Pass 2 — content-less → EMPTY; first *valid* seed present → its cluster;
  // else Other (residual).
  const buckets = {};
  for (let i=0;i<N;i++) {
    let label = ticketTerms[i].size===0 ? EMPTY : 'Other (residual)';
    if (label!==EMPTY) for (const s of seeds) if (validSet.has(s) && ticketTerms[i].has(s)) { label=s; break; }
    (buckets[label] = buckets[label] || []).push(rows[i]);
  }
  const residualLabels = new Set([EMPTY, 'Other (residual)']);
  const clusters = Object.entries(buckets).map(([label,catRows]) => ({
    label,
    count: catRows.length,
    pct: Math.round((catRows.length/N)*100),
    sampleTitles: catRows.slice(0,3).map(r => (r.title||'').slice(0,80)).filter(t=>t && t!=='(No title)'),
    nearestCategory: residualLabels.has(label) ? null : nearestCategory(catRows),
  }));
  // Sort by count desc, but pin the residual buckets last.
  return clusters.sort((a,b) =>
    (residualLabels.has(a.label)?1:0)-(residualLabels.has(b.label)?1:0) || b.count-a.count);
}

// Prompt for the on-demand "Refine with AI" upgrade of the deterministic clusters.
export function buildUncatRefinePrompt(clusters) {
  const existing = CATEGORIES.map(c=>c.name).join(', ');
  const list = clusters.map((c,i) =>
    `${i+1}. "${c.label}" — ${c.count} tickets${c.nearestCategory?`, nearest existing: ${c.nearestCategory}`:''}\n   Examples: ${(c.sampleTitles||[]).map(t=>`"${t}"`).join('; ')||'n/a'}`
  ).join('\n');
  return `You are a support-analytics expert tuning a ticket taxonomy. The clusters below were auto-extracted from tickets that matched NO existing category keyword.\n\nExisting categories: ${existing}\n\nResidual clusters:\n${list}\n\nFor EACH cluster give exactly:\n- **Theme name** — a clean human-readable name\n- What it's about — one sentence\n- Recommendation — either "Add as new category: <name>" OR "Fold into existing: <category>", naming the specific keyword(s) to add\n\nBe concise, use markdown. End with a one-line summary of the single highest-impact taxonomy change to make.`;
}

// ── Get first real human agent response time ─────────────────
// Gleap does not return a messages array — only latestComment.
// Checks: firstAgentReplyAt (when Gleap provides it) → latestComment.createdAt
// when bot===false and it's not a Kai AI-chat message (human agent message).
//
// Verified against live tickets (2026-07-14): real human replies never carry
// a `kaiChat` key at all — it's only ever present (and `true`) on Kai AI
// messages. The previous `lc.kaiChat === false` check required the key to be
// explicitly false, which never happens, so `undefined === false` silently
// failed every time and this function always returned null. Use `!== true`
// so an absent key (the normal case) doesn't get excluded.
export function getAgentResponseTime(t) {
  const fr = t.firstAgentReplyAt||t.firstAgentResponseAt||t.firstResponseAt||t.firstReplyAt;
  if (fr) return fr;
  const lc = t.latestComment;
  if (lc && typeof lc === 'object' && lc.bot === false && lc.kaiChat !== true && lc.user && lc.createdAt) {
    return lc.createdAt;
  }
  return null;
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
  if (Array.isArray(t.emailRefs) && t.emailRefs.length > 0) return t.emailRefs.length;
  return t.hasAgentReply ? 1 : 0;
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
// Gleap API is sorted newest-first (skip=0 = most recent). We start at skip=0
// and increment until every ticket on a page pre-dates rangeStart.
// MAX_PAGES is a safety cap — 1000 pages × 50 = 50,000 tickets max.
export async function fetchAllTickets(startDate, endDate, _lastSkip, gleapHeaders) {
  const rangeStart=new Date(startDate), rangeEnd=new Date(endDate);
  const all=[], seen=new Set();
  let skip=0, pages=0;
  const MAX_PAGES = 1000;
  console.log(`📥 Fetching all tickets: ${startDate} → ${endDate}, max pages=${MAX_PAGES}`);

  while (pages < MAX_PAGES) {
    let items;
    try {
      items = await gleapFetch('https://api.gleap.io/v3/tickets', { limit: 50, skip }, gleapHeaders);
    } catch (e) { console.warn(`Fetch error at skip=${skip}:`, e.message); skip += 50; pages++; continue; }
    if (!items.length) break;

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
    skip += 50; pages++;
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

// Lightweight lexicon check on actual ticket language — used as a stronger
// signal than the operational-only fallback below (SLA breach, closed+replied).
// Returns null (no clear signal) when neither word list hits, or on a tie,
// so callers fall through to the existing heuristic rather than guessing.
const SENTIMENT_POS_WORDS = [
  'thank you', 'thanks', 'great', 'awesome', 'appreciate', 'excellent', 'perfect',
  'happy', 'love', 'helpful', 'resolved', 'amazing', 'wonderful', 'fantastic', 'pleased',
];
const SENTIMENT_NEG_WORDS = [
  'frustrated', 'frustrating', 'disappointed', 'disappointing', 'terrible', 'awful',
  'worst', 'unacceptable', 'angry', 'upset', 'annoyed', 'broken', 'useless', 'horrible',
  'ridiculous', 'complain', 'complaint', 'refund', 'cancel', 'still not working',
  'still broken', 'waste of time', 'fed up', 'unhappy', 'not happy', 'very poor',
];
function textSentimentScore(text) {
  const t = (text || '').toLowerCase();
  let pos = 0, neg = 0;
  for (const w of SENTIMENT_POS_WORDS) if (t.includes(w)) pos++;
  for (const w of SENTIMENT_NEG_WORDS) if (t.includes(w)) neg++;
  if (pos === 0 && neg === 0) return null;
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return null;
}

// Gleap sets `sentiment` (positive/negative/neutral) via AI only on individual ticket fetches,
// not on bulk list responses. Use it when present; otherwise derive from objective signals.
export function resolveSentiment(t, isClosed) {
  const raw = String(t.sentiment || '').toLowerCase().trim();
  if (raw === 'positive' || raw === 'negative' || raw === 'neutral') return raw;

  const cmtStr = typeof t.latestComment === 'string' ? t.latestComment : getLatestComment(t);
  const textSignal = textSentimentScore(`${t.title||''} ${t.description||''} ${t.aiSummary||''} ${cmtStr||''}`);
  if (textSignal) return textSignal;

  // Derive from signals available in the bulk list response
  if (t.slaBreached) return 'negative';
  if (isClosed && t.hasAgentReply && !t.slaBreached) return 'positive';
  return 'neutral';
}

// ── Ticket categorization ────────────────────────────────────
// Order matters: first match wins. Put narrow/specific categories before broad ones.
// Use 'vat ' and 'tax ' (trailing space) to avoid matching inside 'activation'/'deactivate'.
const CATEGORIES = [
  { name: 'GRN/Invoices', keywords: [
    'grn', 'goods receipt', 'goods received note', 'credit note', 'create invoice',
    'purchase invoice', 'invoice creation', 'grn invoice', 'invoice', 'unpost',
    'delivery note', 'accounts payable', 'lpo', 'vendor invoice', 'bulk post',
    'resolve dispute', 'payment link', 'purchase order', 'po item', 'po entry',
    'payment due date', 'outlet purchase', 'receive purchase',
    'receiving error', 'received stock', 'deliverynote',
    'purchase action', 'po layout', 'cannot post',
  ]},
  { name: 'Recipe', keywords: [
    'recipe', 'ingredient', 'semi-finished', 'publish recipe', 'recipe breakdown',
    'sub-recipe', 'recipe cost', 'recipe report', 'recipe item', 'yield', 'allergen',
  ]},
  { name: 'Central Kitchen Module', keywords: [
    'central kitchen', 'price list', 'ordering module', 'kitchen module', 'create catalog', 'catalog',
    'requisition', 'order template', 'order sheet', 'standing order', 'delivery order',
    'order from', 'place order', 'placing order', 'order confirmation', 'order submission',
    'confirm order', 'ship order', 'incoming order', 'approve order', 'supy connect',
    'fill to par', 'internal order', 'warehouse order', 'procurement', 'ck order',
    'order error', 'cannot order', 'unable to order', 'change delivery', 'delivery date',
    'order date', 'draft order', 'drafted order', 'deleted order', 'recover order',
    'confirmed order', 'duplicate order', 'order placement', 'order link', 'po consolidat',
    'order missing', 'order reject', 'order sequence', 'template not loading', 'ordering app',
    'shipping', 'shipment', 'ship date', 'order not', 'order placed', 'placed order', 'order item',
    'disable product ordering', 'missing menu items', 'templates displaying',
    'approve request', 'place request', 'warehouse list',
    'kitchen management', 'order cancellation', 'order popup', 'closed order',
  ]},
  { name: 'Integration', keywords: [
    'integration', 'pos integration', 'accounting integration', 'pos setup', 'accounting setup',
    'posting invoice', 'simphony', 'symphony', 'redcat', 'oracle', 'micros', 'lightspeed',
    'xero', 'quickbooks', 'quadranet', 'revel',
    'sales data', 'sales import', 'sales discrepancy', 'incorrect sales', 'missing sales',
    'api credentials', 'api key', 'webhook', 'sync error', 'sales submission',
    'manual sales', 'pos sync', 'product linking', 'product connection', 'linking status',
    'sales record', 'accounting', 'po link', 'void mapping', 'canceled mapping',
    'unmapped', 'mapping lost', 'mappings lost',
  ]},
  { name: 'Item Costing', keywords: [
    'item cost', 'costing', 'cost price', 'item price', 'costing module',
    'cost calculat', 'negative stock', 'stock value', 'cost change', 'high cost',
    'cost inconsisten', 'vat ', 'cogs', 'cost of goods', 'freight', 'closing stock',
    'cost issue', 'variance value', 'rounding', 'wrong cost', 'incorrect cost',
    'abnormal cost', 'stock valuation', 'zero cost', 'price discrepan', 'pricing discrepan',
    'price anomal', 'pricing anomal', 'pricing anomol', 'unit price', 'price missing',
    'margin', 'incorrect price', 'wrong price', 'price issue', 'tax ', 'unexpected price',
    'unexpected cost', 'price information', 'event cost',
    '$0', 'pricing calculation', 'change price', 'changing price',
    'cost not calculated', 'price not updating',
  ]},
  { name: 'Wastages', keywords: [
    'wastage', 'waste', 'wastage template', 'shrinkage', 'spoilage', 'spoilt',
  ]},
  { name: 'Production', keywords: [
    'production', 'manufacturing', 'auto production', 'production order', 'batch production',
  ]},
  { name: 'Transfers', keywords: [
    'transfer', 'stock transfer', 'inventory transfer', 'stock count', 'stocktake',
    'stock take', 'sub-count', 'sub count', 'count sheet', 'inventory count',
    'inventory adjustment', 'inventory date', 'inventory filter', 'daily count', 'monthly count',
    'count filter', 'stock adjustment', 'inventory input', 'inventory update',
    'inventory correction', 'variance', 'submit inventory', 'inventory submission',
    'stock reconcil', 'inventory record', 'open inventory', 'close inventory',
    'inventory period', 'inventory deletion', 'monthly inventory', 'inventory discrepan',
    'counted stock', 'count submission', 'inventory opening', 'stock discrep',
    'item count', 'wrong item count', 'inventory item', 'stock template', 'merged item',
    'inventory download',
    'stock correction', 'modify submitted', 'reopen inventory', 'inventory closing',
    'inventory not displaying',
  ]},
  { name: 'Roles and Permissions', keywords: [
    'role', 'permission', 'user role', 'access control', 'assign role', 'user permission',
    'deactivate user', 'branch manager', 'cannot log in', 'unable to log',
    'cannot access', 'unable to access', 'user access', 'branch access', 'wrong access',
    'deactivate', 'add user', 'remove user', 'onboarding', 'switch user',
    'approve bar order', 'policy update', 'otp', 'password', 'account creation',
    'new employee', 'employee login', 'unknown user approving',
    'consumption store', 'store access', 'inventory access', 'login',
    'add branch', 'adding branch', 'mobile number', 'language', 'legal name',
    'business name', 'application language',
    'close account', 'location change', 'change location',
  ]},
  { name: 'Supplier Configuration', keywords: [
    'supplier', 'vendor', 'supplier config', 'supplier detail', 'vendor setup',
    'supplier list', 'supplier item', 'supplier stock',
  ]},
  { name: 'Item Configuration', keywords: [
    'item configur', 'item setup', 'configure item', 'base unit', 'change unit', 'change uom',
    'archive product', 'deactivate item', 'item name', 'item update', 'uom', 'item unit',
    'non-stockable', 'stockable', 'sub group', 'sub-group', 'menu category', 'item code', 'sku',
    'base item', 'pack size', 'packaging unit', 'unit conversion', 'weight conversion',
    'archive item', 'archiving item', 'archiving product', 'bulk upload', 'bulk item', 'item upload',
    'items not appear', 'not appearing', 'not visible', 'item not visible', 'items not visible',
    'item not found', 'cannot find item', 'duplicate item', 'merge item', 'merge product',
    'cannot merge', 'merge operation', 'merging',
    'item location', 'create item', 'item category', 'item group', 'category name',
    'item template', 'staff meal template', 'vending machine', 'item branch',
    'unlock item', 'unlock base', 'drafted item', 'cost center', 'cost centre', 'repository',
    'add item to', 'add items to', 'rename item', 'barcode', 'item sort', 'item list',
    'item display', 'reorganize categor', 'parent category', 'display name', 'multi-select',
    'default unit', 'staff meal', 'missing item', 'menu categories not reflecting', 'unable to merge',
  ]},
  { name: 'Reports and Analysis', keywords: [
    'report', 'analysis', 'analytics', 'reporting', 'download report',
    'excel export', 'export to excel', 'export excel', 'download excel',
    'export base item', 'activity history', 'data export',
    'purchase report', 'sales report', 'consumption report', 'subcategory column',
    'mismatch', 'discrepancy report', 'missing data in excel', 'amount display',
    'consumption in portal', 'allergen matrix', 'allergen sheet',
    'order history', 'currency display',
  ]},
  { name: 'Dashboard', keywords: [
    'dashboard', 'kpi', 'dashboard setup', 'dashboard config', 'kpi setup',
  ]},
  // Catch-all for generic technical/bug complaints not tied to a specific module.
  // Kept last so business-domain keywords above always get first match.
  { name: 'Tech', keywords: [
    'crash', 'crashing', 'bug', 'glitch', 'not loading', "won't load", 'blank screen',
    'white screen', 'blank page', 'freeze', 'freezing', 'frozen', 'timeout', 'timed out',
    '500 error', 'internal server error', 'network error', 'session expired',
    'not responding', 'app not working', 'browser issue', 'technical issue',
    'technical error', 'sync issue', 'stuck loading', 'system error', 'app freeze',
    'not saving', 'button not working', 'page error', 'loading forever', 'infinite loading',
    'app crash', 'keeps logging out', 'keeps crashing', 'refresh issue',
    'inaccessible', 'system restart', 'error message', 'recurring error',
  ]},
];

export function classifyTicket(t) {
  const norm    = s => (s || '').toLowerCase().replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  const title   = norm(t.title);
  const desc    = norm(t.description);
  const summary = norm(t.aiSummary);
  const rawCmt  = t.latestComment;
  const cmtStr  = typeof rawCmt === 'string' ? rawCmt : getLatestComment(t);
  const comment = norm(cmtStr);
  const text    = `${title} ${desc} ${summary} ${comment}`;

  for (const cat of CATEGORIES) {
    for (const kw of cat.keywords) {
      if (text.includes(kw)) return cat.name;
    }
  }
  return 'Uncategorized';
}

export function processTickets(tickets, projectId) {
  return tickets.map(t => {
    const created=t.createdAt||t.createdDate;
    const updated=t.updatedAt;
    const firstAssign=t.firstAssignmentAt||getAgentResponseTime(t);
    const statusRaw=String(t.status||t.bugStatus||'UNKNOWN').toUpperCase();
    const isClosed=CLOSED_STATUSES.has(statusRaw);
    const isArchived=ARCHIVED_STATUSES.has(statusRaw)||t.isArchived===true;
    const closeTime=isClosed?updated:null;
    const createdDt=parseDt(created);
    const bugId=t.bugId||t._id||'';
    const rawId=t._id||t.id||'';
    const ticketType=String(t.type||t.ticketType||'UNKNOWN').toUpperCase();
    const linked=t.linkedTickets||t.linkedBugs||t.links||[];
    return {
      id:rawId, bugId,
      gleapLink:gleapLink(ticketType, rawId, bugId, projectId),
      title:t.title||'(No title)',
      gleapType:ticketType,
      contact:getContact(t), email:getEmail(t), company:getCompany(t), phone:getPhone(t),
      agent:getAgent(t),
      status:statusRaw,
      isOpen:OPEN_STATUSES.has(statusRaw), isClosed, isArchived,
      isEscalated:isEscalated(t),
      linkedCount:Array.isArray(linked)?linked.length:(t.linkedTicketsCount||0),
      priority:String(t.priority||'MEDIUM').toUpperCase(),
      sentiment:resolveSentiment(t, isClosed),
      isCallRequest:isCallRequest(t),
      category:classifyTicket(t),
      createdAt:created, updatedAt:updated, firstAssignAt:firstAssign, closeAt:closeTime,
      assignMins:minsBetween(getBotHandoverTime(t), firstAssign),
      firstResponseMins:minsBetween(created, getAgentResponseTime(t)),
      closeMins:minsBetween(created,closeTime),
      hasAgentReply:Boolean(t.hasAgentReply),
      slaBreached:Boolean(t.slaBreached),
      agentResponseCount:countAgentResponses(t,getAgent(t)),
      aiSummary:t.aiSummary||'',
      latestComment:getLatestComment(t),
      latestCommentIsBot:(()=>{const lc=t.latestComment;return !!(lc&&typeof lc==='object'&&(lc.bot===true||lc.kaiChat===true));})(),
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

  const assignVals=rows.map(r=>r.assignMins).filter(v=>v!==null);
  const closeVals=rows.map(r=>r.closeMins).filter(v=>v!==null);
  const firstRespVals=rows.map(r=>r.firstResponseMins).filter(v=>v!==null);

  // Real avg first interaction — from latestComment.createdAt (when bot===false)
  // or firstAgentReplyAt when Gleap provides it. No estimation.
  const avgFirstInteractionMins = firstRespVals.length > 0 ? avg(firstRespVals) : null;

  console.log(`📊 Stats calc: ${rows.length} rows | firstResp samples: ${firstRespVals.length} | avg first interaction: ${avgFirstInteractionMins} | close vals: ${closeVals.length}`);

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

  // Category cross-tab: count + resolve/SLA rates + top company/agent per
  // category, instead of just a raw count — answers "which category has the
  // worst SLA breach rate" without a separate manual drill-down per category.
  const catBuckets={};
  for (const r of rows) {
    const cat = r.category || 'Uncategorized';
    (catBuckets[cat] = catBuckets[cat] || []).push(r);
  }
  const categoryBreakdown = Object.entries(catBuckets).map(([category,catRows])=>{
    const cnt = catRows.length;
    const closedC = catRows.filter(r=>r.isClosed).length;
    const slaC = catRows.filter(r=>r.slaBreached).length;
    const closeValsC = catRows.map(r=>r.closeMins).filter(v=>v!==null);
    const companyCountsC={};
    for (const r of catRows) if (r.company) companyCountsC[r.company]=(companyCountsC[r.company]||0)+1;
    const topCompany = Object.entries(companyCountsC).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    const agentCountsC={};
    for (const r of catRows) if (r.agent && r.agent!=='Unassigned') agentCountsC[r.agent]=(agentCountsC[r.agent]||0)+1;
    const topAgent = Object.entries(agentCountsC).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    return {
      category, count:cnt,
      pct: total ? Math.round((cnt/total)*100) : 0,
      resolveRate: cnt ? Math.round((closedC/cnt)*100) : 0,
      slaBreachRate: cnt ? Math.round((slaC/cnt)*100) : 0,
      avgCloseFmt: fmtMins(avg(closeValsC)),
      topCompany, topAgent,
    };
  }).sort((a,b)=>b.count-a.count);

  // Category trend over time — one row per day, spread with a count per
  // category present that day — powers a "is this category climbing" chart.
  const catTrendMap={};
  for (const r of rows) {
    const cat = r.category || 'Uncategorized';
    (catTrendMap[r.day] = catTrendMap[r.day] || {})[cat] = (catTrendMap[r.day]?.[cat]||0) + 1;
  }
  const categoryTrend = Object.entries(catTrendMap)
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([day,cats])=>({day,...cats}));

  // Sub-cluster the Uncategorized residual into emergent themes + nearest
  // existing category — a feedback loop for tuning CATEGORIES systematically.
  const uncategorizedRows = catBuckets['Uncategorized'] || [];
  const uncategorizedClusters = clusterUncategorized(uncategorizedRows);

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
    statusBreakdown, typeBreakdown, categoryBreakdown,categoryTrend,uncategorizedClusters,
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

const PIPELINE_EXCLUDED = new Set(['BOT', 'UNKNOWN', 'INQUIRY']);

export function computePipelineStats(tickets, projectId) {
  const rows   = processTickets(tickets, projectId);
  const groups = {};
  const now    = Date.now();

  for (const r of rows) {
    if (PIPELINE_EXCLUDED.has(r.gleapType)) continue;

    if (!groups[r.gleapType]) groups[r.gleapType] = { total:0, open:0, resolved:0, daysArr:[], tickets:[] };
    const g = groups[r.gleapType];
    g.total++;
    g.tickets.push({
      id:                 r.id,
      bugId:              r.bugId,
      gleapLink:          r.gleapLink,
      title:              r.title,
      status:             r.status,
      agent:              r.agent,
      priority:           r.priority,
      contact:            r.contact,
      company:            r.company,
      agentResponseCount: r.agentResponseCount,
      createdAt:          r.createdAt,
      updatedAt:          r.updatedAt,
      closeAt:            r.closeAt,
      isOpen:             r.isOpen,
      isClosed:           r.isClosed,
      daysOpen:           r.isOpen && r.createdAt ? Math.round((now - new Date(r.createdAt)) / 86400000) : null,
    });

    if (r.isClosed) {
      g.resolved++;
    } else {
      g.open++;
      if (r.createdAt) g.daysArr.push(Math.round((now - new Date(r.createdAt)) / 86400000));
    }
  }

  return Object.entries(groups).map(([type, g]) => ({
    type,
    total:       g.total,
    open:        g.open,
    resolved:    g.resolved,
    avgDaysOpen: g.daysArr.length ? Math.round(g.daysArr.reduce((a,b)=>a+b,0)/g.daysArr.length) : null,
    maxDaysOpen: g.daysArr.length ? Math.max(...g.daysArr) : null,
    tickets:     g.tickets.sort((a,b) => (b.daysOpen||0) - (a.daysOpen||0)),
  })).sort((a, b) => b.total - a.total);
}

export async function runFullPipeline(start, end, gleapHeaders, projectId) {
  let tickets = await fetchAllTickets(start, end, null, gleapHeaders);
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
