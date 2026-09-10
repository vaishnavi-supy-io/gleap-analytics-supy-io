// AI analysis of one HubSpot pipeline's numbers.
//
// Takes the already-computed stats from /api/hubspot-pipelines rather than
// re-querying HubSpot — the numbers on screen are exactly the numbers analysed,
// so the write-up can never disagree with the cards above it.
//
// _middleware.js enforces session auth; the X-User-Email check mirrors the
// secondary guard the other HubSpot routes use.

import { buildHubspotInsightPrompt } from '../_shared/hubspot.js';

export async function onRequestPost({ request, env }) {
  try {
    if (!request.headers.get('X-User-Email')) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (!env.OPENROUTER_KEY) {
      return Response.json({ ok: false, error: 'OPENROUTER_KEY not configured' }, { status: 500 });
    }

    const { pipeline, other, range } = await request.json();
    if (!pipeline) return Response.json({ ok: false, error: 'pipeline stats required' }, { status: 400 });

    const prompt   = buildHubspotInsightPrompt(pipeline, other, range || { start: '', end: '' });
    const aiModel  = env.AI_MODEL || 'openai/gpt-5.6-luna';
    const controller = new AbortController();
    const timeout  = setTimeout(() => controller.abort(), 30000);

    let aiResp;
    try {
      aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://gleap-analytics.app',
          'X-Title':       'Gleap Analytics',
        },
        body: JSON.stringify({
          model: aiModel,
          messages: [{ role: 'user', content: prompt }],
          // Reasoning models bill thinking against this same budget, so the old
          // 2600 could be spent before any prose was emitted. Low effort keeps
          // the round trip inside the 30s abort below.
          max_tokens: 8000,
          reasoning: { effort: 'low' },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error(`AI API Error ${aiResp.status}:`, t.slice(0, 200));
      return Response.json({ ok: false, error: `AI API returned ${aiResp.status}` }, { status: 502 });
    }

    const data = await aiResp.json();
    const choice   = data.choices?.[0];
    const analysis = choice?.message?.content?.trim();

    // An empty body with finish_reason 'length' means the token budget went to
    // reasoning. Surfacing that beats the old silent 'No analysis generated.',
    // which read like a content problem rather than a budget one.
    if (!analysis) {
      const reason = choice?.finish_reason || 'unknown';
      console.error('AI returned no content; finish_reason:', reason);
      return Response.json({
        ok: false,
        error: reason === 'length'
          ? `AI hit the token budget before answering (finish_reason: length) on ${aiModel}`
          : `AI returned no content (finish_reason: ${reason}) on ${aiModel}`,
      }, { status: 502 });
    }

    return Response.json({ ok: true, analysis, model: aiModel });
  } catch (e) {
    console.error('HubSpot insights error:', e.message);
    return Response.json({ ok: false, error: e.message || 'Server error' }, { status: 500 });
  }
}
