// Chat assistant for the dashboard. This route existed in server.js but had no
// Pages equivalent, so asking a question on the deployed site hit the static
// asset fallback and the caller parsed HTML as JSON.
//
// Two response shapes on one route, because the UI needs both: `stream: true`
// forwards OpenRouter's SSE body straight to the browser so tokens appear as
// they are produced, and anything else returns one JSON object, which is what
// the "generate report" button expects.
//
// _middleware.js enforces the session; the X-User-Email check mirrors the
// secondary guard the other AI routes use.

import { buildChatSystemPrompt, REPORT_INSTRUCTION } from '../_shared/chat.js';

const MAX_TURNS = 20; // keep the tail of the conversation, not all of it

export async function onRequestPost({ request, env }) {
  try {
    if (!request.headers.get('X-User-Email')) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (!env.OPENROUTER_KEY) {
      return Response.json({ ok: false, error: 'OPENROUTER_KEY not configured' }, { status: 500 });
    }

    const { messages, stats, hubspot, range, makeReport, stream } = await request.json();
    if (!Array.isArray(messages) || !messages.length) {
      return Response.json({ ok: false, error: 'messages array required' }, { status: 400 });
    }

    const history = messages.slice(-MAX_TURNS);
    if (makeReport) history.push({ role: 'user', content: REPORT_INSTRUCTION });

    const aiModel = env.AI_MODEL || 'openai/gpt-5.6-luna';
    const body = {
      model: aiModel,
      messages: [{ role: 'system', content: buildChatSystemPrompt({ stats, hubspot, range }) }, ...history],
      // Reasoning models bill thinking against this budget, so a chat-sized
      // 800 would often be spent before any prose appeared.
      max_tokens: makeReport ? 8000 : 3000,
      reasoning: { effort: 'low' },
      ...(stream ? { stream: true } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

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
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }

    if (!aiResp.ok) {
      clearTimeout(timeout);
      const t = await aiResp.text();
      console.error(`AI chat error ${aiResp.status}:`, t.slice(0, 200));
      return Response.json({ ok: false, error: `AI API returned ${aiResp.status}` }, { status: 502 });
    }

    if (stream) {
      // Hand the upstream body to the client untouched: no buffering here, and
      // one SSE parser (the browser's) rather than two that could disagree.
      // The timeout is cleared now that headers have arrived — leaving it armed
      // would abort the response mid-answer, and consuming the body here to
      // detect the end would lock the very stream we are returning.
      clearTimeout(timeout);
      return new Response(aiResp.body, {
        headers: {
          'Content-Type':      'text/event-stream; charset=utf-8',
          'Cache-Control':     'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    clearTimeout(timeout);
    const data   = await aiResp.json();
    const choice = data.choices?.[0];
    const reply  = choice?.message?.content?.trim();
    if (!reply) {
      const reason = choice?.finish_reason || 'unknown';
      console.error('AI chat returned no content; finish_reason:', reason);
      return Response.json({
        ok: false,
        error: reason === 'length'
          ? `AI hit the token budget before answering (finish_reason: length) on ${aiModel}`
          : `AI returned no content (finish_reason: ${reason}) on ${aiModel}`,
      }, { status: 502 });
    }
    return Response.json({ ok: true, reply, model: aiModel });
  } catch (e) {
    console.error('AI chat error:', e.message);
    return Response.json({ ok: false, error: e.message || 'Server error' }, { status: 500 });
  }
}
