import {
  getGleapHeaders, getCachedJson, setCachedJson,
  runFullPipeline, computeStats,
} from '../_shared/gleap.js';

export async function onRequestGet({ request, env }) {
  try {
    const url   = new URL(request.url);
    const now   = new Date();
    const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = url.searchParams.get('end')   || now.toISOString();
    const force = url.searchParams.get('force') === 'true';
    const cat   = (url.searchParams.get('category') || '').trim();

    const cacheKey = `analytics::${start.slice(0,10)}::${end.slice(0,10)}${cat ? '::'+cat : ''}`;
    const cached   = force ? null : await getCachedJson(cacheKey);

    if (cached) {
      console.log(`⚡ Cache hit [${cacheKey}]`);
      return Response.json({ ok: true, stats: cached.stats, generatedAt: cached.generatedAt, fromCache: true });
    }

    console.log(`🔃 Cache miss [${cacheKey}] — running full pipeline`);

    // A category filter is just a subset of the full ticket set — reuse the
    // already-cached rows for this date range instead of re-fetching Gleap,
    // so filtering is near-instant after the overview has loaded once.
    if (cat) {
      const baseKey = `analytics::${start.slice(0,10)}::${end.slice(0,10)}`;
      let base = force ? null : await getCachedJson(baseKey);
      if (!base || !base.rows) {
        base = await runFullPipeline(start, end, getGleapHeaders(env), env.PROJECT_ID);
        await setCachedJson(baseKey, base, 600);
      }
      const filtered = base.rows.filter(r => (r.category||'').toLowerCase() === cat.toLowerCase());
      const catStats = computeStats(filtered);
      await setCachedJson(cacheKey, { stats: catStats, generatedAt: base.generatedAt }, 600);
      return Response.json({ ok: true, stats: catStats, generatedAt: base.generatedAt, fromCache: false });
    }

    const result = await runFullPipeline(start, end, getGleapHeaders(env), env.PROJECT_ID);
    await setCachedJson(cacheKey, result, 600);
    return Response.json({ ok: true, stats: result.stats, generatedAt: result.generatedAt, fromCache: false });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
