#!/usr/bin/env bash
# ── Gleap Analytics v2 — Cloudflare Pages deploy script ──────────────────────
#
# Usage (local or CI):
#   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<org-id> ./deploy.sh
#
# In GitHub Actions, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as
# repository secrets, then this script runs without modification.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Error: CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?Error: CLOUDFLARE_ACCOUNT_ID is not set}"

PROJECT="gleap-analytics-supy-io"

echo "▶ Deploying ${PROJECT} to Cloudflare Pages (account: ${CLOUDFLARE_ACCOUNT_ID})..."

npx wrangler pages deploy public \
  --project-name "${PROJECT}" \
  --commit-dirty=true

echo "✅ Deploy complete."

# ── Optional: upload/rotate secrets ──────────────────────────────────────────
# Uncomment and fill values to push secrets in CI (one-time setup or rotation):
#
# echo "${GLEAP_API_KEY}"      | npx wrangler pages secret put GLEAP_API_KEY      --project-name "${PROJECT}"
# echo "${PROJECT_ID}"         | npx wrangler pages secret put PROJECT_ID         --project-name "${PROJECT}"
# echo "${OPENROUTER_KEY}"     | npx wrangler pages secret put OPENROUTER_KEY     --project-name "${PROJECT}"
# echo "${SLACK_WEBHOOK_URL}"  | npx wrangler pages secret put SLACK_WEBHOOK_URL  --project-name "${PROJECT}"
