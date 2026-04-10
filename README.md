# Supy Inbox Intelligence Dashboard v2

A comprehensive Gleap inbox analytics dashboard for team leads.

## Features
- 📥 **Full Inbox Analytics** — all INQUIRY type tickets with detailed metrics
- 👥 **Agent Performance** — first response time, close time, reply rate, per agent
- 📞 **Call Requests** — tracks call_flow=true tickets with contact details
- 🚨 **Escalations** — tickets with linked tickets automatically detected
- 📊 **Charts & Trends** — daily volume, day of week, hourly patterns, top companies
- 🤖 **AI Report** — AI-powered team lead coaching via OpenRouter
- 🔗 **Direct Gleap Links** — every ticket links directly to Gleap conversation
- 🗄 **Archived Count** — tracks archived conversation volume
- ⚡ **Smart Filters** — filter by open/closed/unassigned/escalated/call/SLA/archived

## Setup
1. Copy `.env.example` to `.env`
2. Fill in your Gleap API key and Project ID
3. Optionally add OpenRouter key for AI reports
4. `npm install`
5. `npm start`
6. Open http://localhost:3000

## Deployment
- **Railway / Render / Fly.io**: Set env vars, `npm start`
- **Heroku**: Uses Procfile, set config vars
