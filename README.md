# Supy — Inbox Intelligence Dashboard

A full-featured, self-hosted analytics dashboard for [Gleap](https://gleap.io) inbox data. Built for support team leads at Supy who need deep visibility into ticket volume, agent performance, call requests, SLA compliance, and operational health — all in one place.

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Project Structure](#project-structure)
5. [Environment Variables](#environment-variables)
6. [Installation & Local Development](#installation--local-development)
7. [Deployment](#deployment)
8. [API Reference](#api-reference)
9. [Dashboard Sections](#dashboard-sections)
10. [Data Pipeline](#data-pipeline)
11. [Call Request Detection](#call-request-detection)
12. [Agent Performance Metrics](#agent-performance-metrics)
13. [Slack Digest](#slack-digest)
14. [AI Report](#ai-report)
15. [Tech Stack](#tech-stack)

---

## Overview

The dashboard connects to the Gleap REST API, fetches all `INQUIRY` type tickets within a user-selected date range, processes them into structured metrics, and renders a rich multi-section UI. It is designed to answer the most critical support ops questions:

- How many tickets came in today / this week / this month?
- Who are the top-performing agents?
- Which tickets have been sitting unassigned for hours?
- Are any SLA timers breached?
- What is the trend over time?
- What are customers calling about?

---

## Features

| Feature | Description |
|---|---|
| 📊 **Overview Dashboard** | KPI cards, leaderboard, aging buckets, resolution rates, and mini-charts |
| ⏳ **Open Ticket Aging** | Buckets: <1hr / 1–4hr / 4–24hr / 1–3 days / 3+ days with color coding |
| 🚨 **Unassigned Queue** | Dedicated view sorted oldest-first, color-coded age badges, summary stats |
| 📥 **Inbox View** | Full paginated ticket list with search, filters (open/closed/SLA/call/unassigned/archived) |
| 👥 **Agent Performance** | Per-agent: tickets handled, replied, reply rate, avg first response, avg close time, SLA breaches |
| 🏆 **Performance Leaderboard** | Top 3 agents by tickets replied (gold/silver/bronze) |
| 📞 **Call Requests** | All `call_flow=true` tickets with phone, email, agent, timing, and reply status |
| 📈 **Trends & Charts** | Daily volume, day-of-week, hourly pattern, top companies (Chart.js) |
| 🤖 **AI Team Lead Report** | AI-powered coaching and action plan via OpenRouter (Claude Sonnet) |
| 📤 **Slack Digest** | Post a formatted daily/custom-period summary to any Slack channel via webhook |
| 🔗 **Direct Gleap Links** | Every ticket opens directly in Gleap (`/bugs/:id`) |
| 🗂 **Ticket Detail Modal** | Click any ticket to see full details in an overlay without leaving the dashboard |
| ⚠️ **SLA Breach Alerts** | Badges and alert banners for breached SLA tickets |

---

## Architecture

```
Browser (Vanilla JS + Chart.js)
        │
        │  HTTP (GET/POST)
        ▼
Express.js Server (Node.js)
        │
        ├── GET /api/analytics   ← main data endpoint
        ├── GET /api/digest       ← Slack digest generator + poster
        ├── POST /api/ai-report   ← forwards stats to OpenRouter AI
        ├── GET /api/tickets      ← paginated ticket endpoint
        ├── GET /api/debug        ← raw ticket inspection
        └── GET /api/health       ← server health check
        │
        ▼
Gleap REST API (v3)
https://api.gleap.io/v3/tickets

        + OpenRouter AI API (optional)
        https://openrouter.ai/api/v1/chat/completions

        + Slack Incoming Webhook (optional)
        https://hooks.slack.com/services/...
```

---

## Project Structure

```
gleap-analytics-supy-io/
├── server.js          # Express backend — all API logic
├── package.json       # Dependencies and scripts
├── Procfile           # Heroku process definition
├── .env               # Environment variables (NOT committed)
├── .env.example       # Template for required variables
└── public/
    └── index.html     # Entire frontend (single-file SPA, vanilla JS)
```

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Required
GLEAP_API_KEY=your_gleap_api_key_here
PROJECT_ID=your_gleap_project_id_here

# Optional — AI Report
OPENROUTER_KEY=your_openrouter_key_here
AI_MODEL=anthropic/claude-sonnet-4-6   # default

# Optional — Slack Digest
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Optional — Server port (default: 3000)
PORT=3000
```

### Where to get each value

| Variable | Where to find it |
|---|---|
| `GLEAP_API_KEY` | Gleap Dashboard → Settings → API Keys |
| `PROJECT_ID` | Gleap Dashboard → Settings → General (Project ID field) |
| `OPENROUTER_KEY` | [openrouter.ai](https://openrouter.ai) → Keys |
| `SLACK_WEBHOOK_URL` | Slack workspace → Apps → Incoming Webhooks → Add to channel |

---

## Installation & Local Development

**Prerequisites:** Node.js ≥ 18

```bash
# 1. Clone the repo
git clone https://github.com/vaishnavi-supy-io/gleap-analytics-supy-io.git
cd gleap-analytics-supy-io

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your credentials

# 4. Start the server
npm start

# 5. Open in browser
open http://localhost:3000
```

The first load may take 30–90 seconds — the server runs a binary search across Gleap's API to find the correct starting pagination offset before fetching tickets.

---

## Deployment

### Railway / Render / Fly.io

1. Connect your GitHub repo
2. Set environment variables in the platform dashboard
3. Deploy — the `npm start` command (`node server.js`) is auto-detected

### Heroku

```bash
heroku create
heroku config:set GLEAP_API_KEY=... PROJECT_ID=... OPENROUTER_KEY=...
git push heroku main
```

The `Procfile` (`web: node server.js`) handles process configuration automatically.

---

## API Reference

All endpoints are served by the Express backend.

### `GET /api/analytics`

Fetches and processes all INQUIRY tickets for the given date range.

**Query params:**

| Param | Format | Default |
|---|---|---|
| `start` | ISO 8601 | First day of current month |
| `end` | ISO 8601 | Current timestamp |

**Example:**
```
GET /api/analytics?start=2026-04-01T00:00:00.000Z&end=2026-04-15T23:59:59.999Z
```

**Response:**
```json
{
  "ok": true,
  "generatedAt": "2026-04-15T10:00:00.000Z",
  "stats": {
    "total": 142,
    "openCount": 18,
    "closedCount": 110,
    "archivedCount": 14,
    "unassignedCount": 3,
    "slaBreached": 5,
    "callRequestCount": 9,
    "withReply": 130,
    "avgFirstInteractionFmt": "1.2 hrs",
    "avgCloseFmt": "4.5 hrs",
    "agents": [...],
    "topCompanies": [...],
    "tickets": [...],
    "openTickets": [...],
    "callTickets": [...],
    "statusBreakdown": [...],
    "daily": [...],
    "dow": [...],
    "hourly": [...]
  }
}
```

---

### `GET /api/digest`

Generates a Slack Block Kit digest for the date range and optionally posts it to the configured webhook.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `start` | ISO 8601 | Yesterday 00:00 UTC | Period start |
| `end` | ISO 8601 | Yesterday 23:59 UTC | Period end |
| `dry` | `true`/`false` | `false` | Preview payload without posting to Slack |

**Example:**
```
GET /api/digest?start=2026-04-14T00:00:00.000Z&end=2026-04-14T23:59:59.999Z
GET /api/digest?dry=true
```

**Response:**
```json
{
  "ok": true,
  "period": "2026-04-14 → 2026-04-14",
  "total": 28,
  "openCount": 4,
  "posted": true,
  "dry": false,
  "slackConfigured": true,
  "payload": { "text": "...", "blocks": [...] }
}
```

---

### `POST /api/ai-report`

Sends summarised stats to the OpenRouter AI and returns a formatted coaching report.

**Body:**
```json
{ "stats": { ...summary stats (no large arrays)... } }
```

**Response:**
```json
{ "ok": true, "report": "**1. INBOX HEALTH SCORE: 7/10**..." }
```

---

### `GET /api/tickets`

Paginated ticket list with filtering.

**Query params:** `start`, `end`, `agent`, `status`, `type` (`call`/`escalated`/`open`/`archived`/`unassigned`/`sla`), `page`, `limit`

---

### `GET /api/health`

Returns server status, project ID, and whether API keys are configured.

---

### `GET /api/debug`

Returns raw ticket data for inspection — useful for diagnosing field mapping issues (phone numbers, agent names, etc.).

---

## Dashboard Sections

### 🏠 Overview

The landing page after data loads. Contains:

- **Alert banners** — SLA breached count, unassigned warning, all-clear message
- **Top Performers Leaderboard** — top 3 agents ranked by tickets replied (not just assigned), with gold/silver/bronze medals
- **⏳ Open Ticket Aging Panel** — 5 buckets showing how long open tickets have been waiting, color-coded from green to red
- **KPI Cards** — total conversations, open/closed, SLA breached, unassigned, call requests, company/phone/email coverage
- **Response Timings** — avg time to first agent interaction, avg time to close with progress bars vs benchmarks
- **Resolution Rates** — resolve rate, reply rate, assignment rate
- **Top Companies** — top 8 companies by ticket volume
- **Status Donut** — breakdown of all ticket statuses
- **Volume by Day of Week** — which days are busiest

---

### 🚨 Unassigned Queue

All open tickets with no assigned agent, sorted **oldest first** (longest waiting at top).

- Summary cards: total unassigned, waiting >4hrs, waiting >24hrs 🔥
- Color-coded age badge per row: green (<1hr) → indigo (1–4hr) → amber (4–24hr) → red (days)
- Columns: Age, Ticket ID, Subject + preview, Customer + company, Created date, Flags (📞 / SLA ⚠)
- Direct "Open ↗" link to ticket detail modal

---

### 📥 Inbox

Full paginated list of all tickets in the date range.

- **Search** by name, company, email, subject, or ticket ID
- **Filters:** All / Open / Closed / Unassigned / 📞 Call / ⚠ SLA / Archived
- **Per-row info:** ticket ID, date, subject, contact, company, email, phone, agent, status badge, timing chips (assign time, first response, close time)
- **Ticket detail modal** on click

---

### 👥 Agent Performance

Table of all agents (excluding Unassigned) with:

| Column | Description |
|---|---|
| Agent | Name |
| Handled | Total tickets assigned |
| Open | Currently open tickets |
| Closed | Closed tickets |
| Replied | Tickets with at least one agent response |
| Responses | Total message count sent by agent |
| Reply Rate | `replied / handled × 100` |
| Avg First Response | Mean time from ticket creation to first reply |
| Avg Close Time | Mean time from creation to close |
| SLA Breached | Count of SLA-breached tickets |

---

### 📞 Call Requests

All tickets where `formData.call_flow = true` (or detected via title keywords).

- Summary KPIs: total, open, closed, missing phone, no agent reply
- Cards with: contact, company, email, phone, agent, created date, assign time, close time, reply/SLA badge
- Ticket detail modal on each card

---

### 📈 Trends & Charts

Four Chart.js charts:

1. **Daily Volume** — bar chart of tickets per day
2. **Day of Week** — which weekday gets most tickets
3. **Hour of Day (UTC)** — peak hours for ticket creation
4. **Top Companies** — horizontal bar chart (up to 15 companies)

---

### 🤖 AI Report

Click "Generate Report" to send summarised stats to Claude Sonnet via OpenRouter. The AI returns a structured coaching report with:

1. Inbox Health Score (X/10)
2. Top 3 Urgent Actions (specific open tickets to handle now)
3. Response Speed Analysis (vs benchmarks)
4. Escalation Patterns
5. Agent Coaching Notes (per-agent by name)
6. 5-Point Action Plan

Requires `OPENROUTER_KEY` in `.env`.

---

## Data Pipeline

The server runs this pipeline on every `/api/analytics` request:

```
1. findLastSkip()
   └─ Binary search (~17 API calls) to find real pagination endpoint
      Cached for 10 minutes to avoid repeat searches

2. fetchInboxTickets(start, end, lastSkip)
   └─ Pages backwards through Gleap API (50 per page)
   └─ Filters: type=INQUIRY, createdAt within range
   └─ Stops when all items on a page are older than range start

3. enrichTickets(tickets)   [only if ≤ 150 total, or for call tickets]
   └─ Fetches full ticket object for each ticket
   └─ Required to get session.phone, messages, latestComment

4. processTickets(tickets)
   └─ Normalises fields: agent, contact, email, company, phone
   └─ Computes: assignMins, firstResponseMins, closeMins
   └─ Detects: isCallRequest, isEscalated, slaBreached, hasAgentReply

5. computeStats(rows)
   └─ Aggregates: totals, status counts, per-agent maps, daily/hourly/dow
   └─ Builds: topCompanies, statusBreakdown, agents array
   └─ Returns complete stats object to frontend
```

**Enrichment threshold:** When the date range returns >150 tickets, full enrichment is skipped for performance. However, call-request tickets are always individually enriched (up to 150) to ensure phone numbers are available.

---

## Call Request Detection

A ticket is treated as a call request if **any** of the following are true:

1. `formData.call_flow === true`
2. `customData.call_flow === true` (or `callFlow`, `phone_call_flow`, `Phone Call Flow`)
3. Title contains any of these keywords:
   - `request to access new call`
   - `request a call`
   - `phone call request`
   - `call request`
   - `callback request`
   - `callback`
   - `dial me`
   - `get in touch via phone`
   - `speak to agent`
   - `call me back`

---

## Agent Performance Metrics

### Reply Rate
```
replyRate = (tickets where hasAgentReply === true / total tickets handled) × 100
```

### Average First Response Time
Mean of `firstAgentReplyAt - createdAt` across all tickets where `firstAgentReplyAt` is available. Falls back to estimating from resolved close times when direct timestamps are absent.

### Average Close Time
Mean of `updatedAt - createdAt` for closed/resolved tickets.

### Leaderboard Ranking
Top 3 agents ranked by `replied` (tickets with at least one agent response), not total assigned. This rewards real engagement over passive assignment.

---

## Slack Digest

The digest posts a rich Slack Block Kit message containing:

- Period label
- 6-field grid: total, open, closed, archived, unassigned, SLA breached
- 4-field grid: avg first interaction, avg close time, reply rate, resolve rate (with health emoji)
- Top 3 performers by tickets replied (🥇🥈🥉)
- 🔴 "Needs Attention" section if any of: SLA breached, unassigned tickets, open call requests

**Trigger options:**

| Method | How |
|---|---|
| Dashboard button | Click "📤 Slack Digest" in the topbar — uses current date range |
| Direct API call | `GET /api/digest` — defaults to yesterday |
| Cron job / scheduler | Call `GET /api/digest` on a schedule (e.g. cron-job.org, Railway cron) |
| Dry run / preview | `GET /api/digest?dry=true` — returns payload without posting |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| HTTP Server | Express 4 |
| Gleap API Client | `node-fetch` v2 |
| Frontend Framework | Vanilla JS (no framework) |
| Charts | Chart.js 4 |
| Fonts | Montserrat (Google Fonts) |
| AI | OpenRouter → Anthropic Claude Sonnet 4.6 |
| Notifications | Slack Incoming Webhooks (Block Kit) |
| Config | `dotenv` |
| Deployment | Heroku / Railway / Render / Fly.io |

---

## Performance Notes

- The binary search for `lastSkip` makes ~17 Gleap API calls and is cached for 10 minutes. Subsequent requests within that window skip it entirely.
- Ticket fetching is sequential (not parallel) to avoid Gleap rate limits — 150ms delay between pages.
- Enrichment adds ~150ms per ticket. For ranges exceeding 150 tickets, only call-request tickets are enriched.
- The AI endpoint has a 30-second timeout and strips all large arrays before sending to stay under payload limits.
- Express body limit is set to `10mb` to handle large stat payloads from the frontend.
