import { buildAIPrompt } from '../_shared/gleap.js';

export async function onRequestPost({ request, env }) {
  try {
    if (!env.OPENROUTER_KEY) {
      return Response.json({ ok: false, error: 'OPENROUTER_KEY not configured' }, { status: 500 });
    }
    const { stats } = await request.json();
    if (!stats) return Response.json({ ok: false, error: 'stats required' }, { status: 400 });

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
          messages: [{ role: 'user', content: buildAIPrompt(slimStats) }],
          max_tokens: 2500,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error(`AI API Error ${aiResp.status}:`, t.slice(0,200));
      return Response.json({ ok: false, error: `AI API returned ${aiResp.status}` }, { status: 502 });
    }
    const data = await aiResp.json();
    return Response.json({ ok: true, report: data.choices?.[0]?.message?.content || 'No report generated.' });
  } catch (e) {
    console.error('AI Report Error:', e.message);
    return Response.json({ ok: false, error: e.message || 'Server error' }, { status: 500 });
  }
}
