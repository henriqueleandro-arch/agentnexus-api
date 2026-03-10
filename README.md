# AgentNexus API

Multi-Tenant AI Agent Orchestration Platform — built on **TiDB Cloud Starter** + **Qwen-Plus**.

## Quick Start (macOS)

```bash
cd agentnexus-api
chmod +x setup.sh
./setup.sh
```

That's it. The script installs Node.js (via Homebrew if needed), installs dependencies, and starts the server.

If you prefer to do it manually:

```bash
# Install Node.js (if not installed)
brew install node

# Install dependencies
npm install

# Start the server
npm start
```

## Test it

```bash
# API info
curl http://localhost:3000/

# List agents (tenant_acme)
curl -H "X-Tenant-ID: tenant_acme" http://localhost:3000/api/agents

# Agent performance
curl -H "X-Tenant-ID: tenant_acme" http://localhost:3000/api/agents/1/performance

# Create a session
curl -X POST -H "X-Tenant-ID: tenant_acme" -H "Content-Type: application/json" \
  -d '{"agent_id": 1, "task_description": "Research TiDB benchmarks"}' \
  http://localhost:3000/api/sessions

# HTAP analytics (uses TiFlash)
curl -H "X-Tenant-ID: tenant_acme" http://localhost:3000/api/analytics/htap

# Generate AI insights (TiDB → Qwen → TiDB)
curl -X POST -H "X-Tenant-ID: tenant_acme" http://localhost:3000/api/insights/generate

# Retrieve stored insights
curl -H "X-Tenant-ID: tenant_acme" http://localhost:3000/api/insights
```

## Available Tenants

`tenant_acme`, `tenant_globex`, `tenant_initech`, `tenant_umbrella`, `tenant_waynetech`, `tenant_nexagen`

## Architecture

```
Browser/curl → Express API (localhost:3000) → TiDB Cloud Starter (Singapore)
                    ↓                              ↑
              Qwen-Plus (DashScope) ───────────────┘
              (optional — mock fallback)
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express server + API docs |
| `db.js` | TiDB connection pool, tenant-scoped queries |
| `routes.js` | All API endpoints |
| `qwen.js` | Qwen AI integration with mock fallback |
| `middleware.js` | Tenant isolation + input validation |
| `.env` | Connection credentials (edit if needed) |
| `setup.sh` | One-click macOS setup |
