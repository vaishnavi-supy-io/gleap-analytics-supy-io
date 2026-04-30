// Classification cache — persists for the lifetime of this edge worker instance
const classificationCache = new Map();

const CATEGORY_MAP = {
  INQUIRY:         ['Billing', 'Technical Issue', 'Onboarding', 'Account Access', 'How-To', 'Complaint', 'Call Request', 'General'],
  BUG:             ['Authentication', 'Payment', 'UI / UX', 'Performance', 'Data / Reports', 'Integration', 'Mobile', 'Other'],
  FEATURE_REQUEST: ['UI / UX', 'Reporting', 'Integration', 'Workflow', 'Automation', 'Mobile', 'Notifications', 'Other'],
  CRASH:           ['iOS', 'Android', 'Web', 'API', 'Background Process', 'Other'],
};
const DEFAULT_CATEGORIES = ['Technical Issue', 'Billing', 'Access', 'Performance', 'UI / UX', 'Other'];

export async function onRequestPost({ request, env }) {
  try {
    if (!env.OPENROUTER_KEY) {
      return Response.json({ ok: false, error: 'OPENROUTER_KEY not configured' }, { status: 500 });
    }

    const body = await request.json();
    const { tickets } = body;
    if (!Array.isArray(tickets) || !tickets.length) {
      return Response.json({ ok: false, error: 'tickets array required' }, { status: 400 });
    }

    const toClassify = tickets.filter(t => !classificationCache.has(t.id));
    console.log(`🏷 Classifying ${toClassify.length} tickets (${tickets.length - toClassify.length} from cache)`);

    const aiModel = env.AI_MODEL || 'anthropic/claude-sonnet-4-6';
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
          headers: {
            'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://gleap-analytics.app',
            'X-Title': 'Gleap Analytics',
          },
          body: JSON.stringify({ model: aiModel, messages: [{ role: 'user', content: prompt }], max_tokens: 600, temperature: 0 }),
        });
        if (!aiRes.ok) { console.warn(`Classify batch ${i} AI error ${aiRes.status}`); continue; }
        const aiData = await aiRes.json();
        const raw = aiData.choices?.[0]?.message?.content || '[]';
        const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
        for (const item of parsed) {
          const ticket = batch[item.idx - 1];
          if (ticket) classificationCache.set(ticket.id, { category: item.category, gleapType: ticket.gleapType });
        }
      } catch (e) { console.warn(`Classify batch ${i} error:`, e.message); }

      if (i + BATCH < toClassify.length) await new Promise(r => setTimeout(r, 300));
    }

    const result = {};
    for (const t of tickets) {
      if (classificationCache.has(t.id)) result[t.id] = classificationCache.get(t.id);
    }
    return Response.json({ ok: true, classifications: result, total: Object.keys(result).length });
  } catch (e) {
    console.error('Classify error:', e.message);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
