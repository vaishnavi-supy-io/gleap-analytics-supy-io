import {
  getGleapHeaders, getCachedJson, setCachedJson,
  runFullPipeline,
} from '../_shared/gleap.js';

export async function onRequestGet({ request, env }) {
  try {
    const url   = new URL(request.url);
    const now   = new Date();
    const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = url.searchParams.get('end')   || now.toISOString();
    const force = url.searchParams.get('force') === 'true';

    const cacheKey = `analytics::${start.slice(0,10)}::${end.slice(0,10)}`;
    const cached   = force ? null : await getCachedJson(cacheKey);

    if (cached) {
      console.log(`⚡ Cache hit [${cacheKey}]`);
      return Response.json({ ok: true, stats: cached.stats, generatedAt: cached.generatedAt, fromCache: true });
    }

    console.log(`🔃 Cache miss [${cacheKey}] — running full pipeline`);
    const gleapHeaders = getGleapHeaders(env);
    const result = await runFullPipeline(start, end, gleapHeaders, env.PROJECT_ID);
    await setCachedJson(cacheKey, result, 600);
    return Response.json({ ok: true, stats: result.stats, generatedAt: result.generatedAt, fromCache: false });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
