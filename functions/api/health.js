import { getCachedJson } from '../_shared/gleap.js';

export async function onRequestGet({ env }) {
  return Response.json({
    ok: true,
    timestamp: new Date().toISOString(),
    projectId: env.PROJECT_ID,
    hasGleapKey: !!env.GLEAP_API_KEY,
    hasOpenRouterKey: !!env.OPENROUTER_KEY,
    cachedLastSkip: await getCachedJson('lastskip'),
  });
}
