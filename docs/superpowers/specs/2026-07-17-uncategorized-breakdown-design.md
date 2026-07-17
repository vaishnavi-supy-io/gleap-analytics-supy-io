# Uncategorized Breakdown — Design

**Date:** 2026-07-17
**Status:** Approved design, pending spec review

## Problem

The overview classifies every ticket via `classifyTicket()` against a keyword
list (`CATEGORIES`). Anything that matches no keyword falls into a single
`Uncategorized` bucket. Today that bucket is surfaced only as a **flat word
cloud** (`uncategorizedKeywords` → `renderUncategorizedSignals`): top recurring
words, ungrouped, that don't sum to anything and don't tell you where a ticket
belongs.

Goal: break the residual down so it's easy to analyze — **discovery** of
emergent themes *and* **coverage** guidance toward existing categories
(the "both, layered" goal), using a **hybrid** method (free deterministic
layer always on, optional AI refinement on demand).

## Approach

Turn the residual into **MECE theme clusters** (each residual ticket in exactly
one cluster; clusters sum to the Uncategorized total), mirroring the
"first/best match wins" discipline of `classifyTicket()`. Then layer a
coverage hint and an optional AI upgrade.

### Layer 1 — Deterministic clustering (always-on, free)

New function `clusterUncategorized(uncategorizedRows)`:

1. For each residual ticket, extract salient terms from
   `title + aiSummary + latestComment`. Prefer **bigrams** ("stock count",
   "cost center") over unigrams; drop `KEYWORD_STOPWORDS` and pure numbers.
2. Count document-frequency per term (count once per ticket, as
   `extractKeywords` already does).
3. **Seed terms** = terms with df ≥ `max(3, ceil(0.02 * residualCount))`.
   This floor avoids noise clusters on small residuals.
4. Greedily assign each ticket to the cluster of its highest-df seed term
   present in that ticket. A ticket with no seed term → `Other (residual)`.
5. Emit `{ label, count, pct, sampleTitles: string[] (≤3), nearestCategory }`
   per cluster, sorted by `count` desc, with `Other (residual)` pinned last.

Deterministic, instant, and the counts reconcile to the Uncategorized total.

### Layer 2 — Nearest-category hint (coverage, free)

For each cluster, compute token-overlap between its members' combined text
tokens and each existing category's keyword tokens; take the argmax as
`nearestCategory` (null if overlap is zero). Surfaced as a chip
("stock count → closest: Item Configuration"). This directly feeds the keyword
feedback loop: it names which keyword to add and to which category.

### Layer 3 — "Refine with AI" (on-demand, costs tokens)

Button POSTs a **small payload** (cluster labels + sample titles only, never
the full ticket array) to a new endpoint that reuses the existing OpenRouter
plumbing (`AI_MODEL`, `OPENROUTER_KEY`, the `/api/ai-report` pattern with 30s
timeout). Claude returns, per cluster: a clean human name, a one-line
description, and a recommendation (`add as new category X` / `fold into
existing Y`). The deterministic clusters render first; AI only upgrades
labels/recommendations when requested.

## Decisions

- **`Other (residual)` stays visible.** Forcing one-off tickets into a nearest
  category manufactures false trend signal. A visible `Other` is honest and
  doubles as a coverage-health metric (low % = good taxonomy).
- **`uncategorizedKeywords` is retired.** Clusters strictly dominate the flat
  word cloud — same term data, grouped/counted/MECE with a coverage hint.
  Remove it from the stats return; delete `renderUncategorizedSignals`.

## Code changes

Classification is duplicated across two backends and must stay in sync:

- `server.js` — add `clusterUncategorized()`; add `uncategorizedClusters` to
  the stats return; remove `uncategorizedKeywords`. Add `POST /api/uncat-refine`
  mirroring `/api/ai-report`.
- `functions/_shared/gleap.js` — same `clusterUncategorized()` + stats change
  (mirror).
- `functions/api/uncat-refine.js` — new endpoint mirroring
  `functions/api/ai-report.js`.
- `public/index.html` — replace `renderUncategorizedSignals` with
  `renderUncategorizedBreakdown` (mini horizontal bar list: label, count, pct,
  nearest-category chip; "Refine with AI" button wired to the new endpoint).
  Reuse the existing category color language.

## Out of scope (v1 / YAGNI)

- Click-a-cluster to filter the Inbox.
- Persisting AI refinement results.
- Auto-updating `CATEGORIES` from AI suggestions (stays a human-in-the-loop
  action).

## Testing

- Unit-check `clusterUncategorized()` on a fixture set: clusters sum to input
  count; `Other (residual)` captures no-seed tickets; seed floor suppresses
  noise on small inputs.
- Verify `server.js` and `functions/_shared/gleap.js` produce identical
  clusters for the same input.
- Drive the overview end-to-end: panel renders, "Refine with AI" round-trips.
