// Shared system-prompt builder for the dashboard's chat assistant — used by
// both functions/api/ai-chat.js (Cloudflare Pages) and server.js (Node, via
// dynamic import), so the two runtimes can never answer from different context.
//
// The dashboard holds two unrelated datasets: Gleap conversations (the inbox)
// and HubSpot tickets (Onboarding / Operations). Either may be absent depending
// on which tab the user has loaded, so each section is emitted only when its
// data is present and the prompt states plainly what is missing — otherwise the
// model invents numbers for the half it cannot see.

const BENCHMARKS = 'assign <15min, first resp <30min, close <4h';

function gleapSection(s) {
  const agents = (s.agents || [])
    .map(a => `  ${a.name}: ${a.handled} handled, ${a.open} open, reply rate ${a.replyRate}%, avg first resp ${a.avgFirstRespFmt}, avg close ${a.avgCloseFmt}, escalated ${a.escalated || 0}`)
    .join('\n');
  const open = (s.openTickets || [])
    .map(t => `  #${t.bugId} | ${t.contact}@${t.company || '?'} | ${t.agent} | SLA:${t.slaBreached ? 'BREACHED' : 'OK'} | esc:${t.isEscalated}`)
    .join('\n');

  return `INBOX (Gleap conversations)
- Total: ${s.total} | Open: ${s.openCount} | Closed: ${s.closedCount} | Archived: ${s.archivedCount}
- Escalated: ${s.escalatedCount} | Unassigned: ${s.unassignedCount} | SLA breached: ${s.slaBreached} | Call requests: ${s.callRequestCount}

TIMING (benchmarks: ${BENCHMARKS})
- Avg assign: ${s.avgAssignFmt} | Avg first resp: ${s.avgFirstRespFmt} | Avg close: ${s.avgCloseFmt}

AGENT PERFORMANCE
${agents || '  (no agent data)'}

OPEN TICKETS (sample)
${open || '  None'}

TOP COMPANIES: ${(s.topCompanies || []).slice(0, 5).map(c => `${c.name}(${c.count})`).join(', ') || 'N/A'}`;
}

function pipelineSection(p) {
  const stages = (p.stageBreakdown || [])
    .filter(x => x.count > 0)
    .map(x => `    ${x.stage}: ${x.count}`)
    .join('\n');
  const oldest = (p.pendingTickets || [])
    .slice(0, 6)
    .map(t => `    • ${t.subject} — ${t.stage}, ${t.assignee}, ${t.ageHrs}h old, ${t.priority}`)
    .join('\n');
  const assignees = (p.assigneeBreakdown || [])
    .slice(0, 10)
    .map(o => `    ${o.name}: ${o.total} assigned, ${o.closed} closed, ${o.pending} pending, ${o.breached} breached (${o.breachRate}%), close rate ${o.closeRate}%, avg close ${o.avgCloseFmt}, oldest pending ${o.oldestPendingFmt || 'n/a'}${o.topPendingStage ? `, mostly in ${o.topPendingStage}` : ''}`)
    .join('\n');

  // Hours are portal-local (Asia/Dubai) — see PORTAL_TZ_LABEL in hubspot.js.
  const hm = p.heatmap?.created;
  const pattern = hm && hm.total
    ? `    Busiest day ${hm.busiestDay}, busiest hour ${String(hm.busiestHour).padStart(2, '0')}:00 Dubai` +
      (hm.busyFrom !== null ? `, busy band ${String(hm.busyFrom).padStart(2, '0')}:00-${String(hm.busyTo).padStart(2, '0')}:00 Dubai` : '')
    : '    (no arrival pattern)';

  return `  ${p.label}: created ${p.created}, closed ${p.closed}, pending ${p.pending}, SLA breached ${p.slaBreached} (${p.breachRate}%)
    Open backlog all-time: ${p.openBacklog ?? 'unknown'} | avg close ${p.avgCloseFmt} | avg pending age ${p.avgPendingAgeFmt}
    Stages:
${stages || '    (none)'}
    Oldest pending:
${oldest || '    (none)'}
    Assignees:
${assignees || '    (none)'}
    Arrival pattern:
${pattern}`;
}

/**
 * System prompt for the chat assistant. `stats` is the Gleap payload, `hubspot`
 * the { onboarding, operations } pipeline map — both optional.
 */
export function buildChatSystemPrompt({ stats, hubspot, range } = {}) {
  const parts = [];
  const loaded = [];

  if (stats) { parts.push(gleapSection(stats)); loaded.push('inbox'); }

  const pipelines = hubspot ? Object.values(hubspot).filter(Boolean) : [];
  if (pipelines.length) {
    parts.push(`HUBSPOT TICKETS (times are Asia/Dubai, the portal timezone)\n${pipelines.map(pipelineSection).join('\n\n')}`);
    loaded.push('HubSpot pipelines');
  }

  const missing = [];
  if (!stats) missing.push('inbox (Gleap) data is NOT loaded');
  if (!pipelines.length) missing.push('HubSpot pipeline data is NOT loaded');

  const header = `You are an AI analyst for a B2B SaaS customer success team, answering questions from the team's own dashboard.

RULES
- Answer only from the data below. Never invent numbers, names, or ticket titles.
- Be concise and specific: cite real figures and name people and tickets as they appear.
- Attribute a person's breach count to load or pipeline stage, not to fault.
- If a question needs data that is not loaded, say which tab the user should load rather than guessing.
- Times are Asia/Dubai (the HubSpot portal timezone). Never relabel them as UTC.
- If asked for a formal report, use: HEALTH SCORE, URGENT ACTIONS, RESPONSE SPEED, ESCALATION PATTERNS, AGENT COACHING, ACTION PLAN.

DATA LOADED: ${loaded.join(' + ') || 'none'}${missing.length ? `\nNOT AVAILABLE: ${missing.join('; ')}` : ''}${range?.start ? `\nPERIOD: ${range.start} to ${range.end}` : ''}`;

  return parts.length ? `${header}\n\n${parts.join('\n\n')}` : header;
}

/** Appended when the user asks for the formal write-up rather than a chat reply. */
export const REPORT_INSTRUCTION = 'Based on our conversation, write a formal team lead report with: **1. HEALTH SCORE: X/10** (one sentence why) **2. TOP 3 URGENT ACTIONS** (what to handle now) **3. RESPONSE SPEED ANALYSIS** (vs benchmarks, fastest/slowest) **4. ESCALATION PATTERNS** (what they signal) **5. COACHING NOTES** (specific, per person) **6. THIS WEEK\'S 5-POINT ACTION PLAN** (exact steps). Be direct, use real numbers, name names.';
