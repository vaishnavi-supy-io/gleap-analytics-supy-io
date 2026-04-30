import { getCachedJson } from '../_shared/gleap.js';

export async function onRequestGet() {
  const lastSkip = await getCachedJson('lastskip');
  return Response.json({
    ok: true,
    note: 'Cloudflare Pages uses Cache API — entries are per-edge-node and not enumerable.',
    cachedLastSkip: lastSkip,
  });
}
