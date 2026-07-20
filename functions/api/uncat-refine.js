import { buildUncatRefinePrompt, parseUncatGroups, getCachedJson, setCachedJson } from '../_shared/gleap.js';

export async function onRequestPost({ request, env }) {
  try {
    if (!env.OPENROUTER_KEY) {
      return Response.json({ ok: false, error: 'OPENROUTER_KEY not configured' }, { status: 500 });
    }
    const { clusters } = await request.json();
    if (!Array.isArray(clusters) || !clusters.length) {
      return Response.json({ ok: false, error: 'clusters required' }, { status: 400 });
    }

    // Cache by cluster signature so repeated overview loads reuse one AI call.
    const sig = clusters.map(c => `${c.label}:${c.count}`).sort().join('|');
    const cacheKey = `uncat-refine::${sig}`;
    const cached = await getCachedJson(cacheKey);
    if (cached && cached.groups) {
      return Response.json({ ok: true, groups: cached.groups, fromCache: true });
    }

    const slim = clusters.slice(0, 20).map(c => ({
      label: c.label, count: c.count, slaBreachPct: c.slaBreachPct,
      nearestCategory: c.nearestCategory, sampleTitles: (c.sampleTitles || []).slice(0, 3),
    }));

    const aiModel = env.AI_MODEL || 'anthropic/claude-sonnet-4-6';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let aiResp;
    try {
      aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://gleap-analytics.app',
          'X-Title': 'Gleap Analytics',
        },
        body: JSON.stringify({
          model: aiModel,
          messages: [{ role: 'user', content: buildUncatRefinePrompt(slim) }],
          max_tokens: 1200,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error(`Uncat Refine API Error ${aiResp.status}:`, t.slice(0, 200));
      return Response.json({ ok: false, error: `AI API returned ${aiResp.status}` }, { status: 502 });
    }
    const data = await aiResp.json();
    const groups = parseUncatGroups(data.choices?.[0]?.message?.content);
    if (!groups) {
      return Response.json({ ok: false, error: 'AI returned unparseable output' }, { status: 502 });
    }
    await setCachedJson(cacheKey, { groups }, 600);
    return Response.json({ ok: true, groups });
  } catch (e) {
    console.error('Uncat Refine Error:', e.message);
    return Response.json({ ok: false, error: e.message || 'Server error' }, { status: 500 });
  }
}
