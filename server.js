// server.js — AgentNexus API Backend
// Multi-Tenant AI Agent Orchestration Platform
// TiDB Cloud Starter + Qwen-Plus (DashScope)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const routes = require("./routes");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(require("path").join(__dirname, "public")));

// ─── API Info (moved to /api/info so index.html serves at /) ──
app.get("/api/info", (req, res) => {
  res.json({
    name: "AgentNexus API",
    description: "Multi-Tenant AI Agent Orchestration Platform",
    version: "1.0.0",
    stack: "Node.js + Express + TiDB Cloud Starter + Qwen-Plus",
    endpoints: {
      "GET  /api/health":                "Health check (requires X-Tenant-ID)",
      "GET  /api/agents":                "List agents for a tenant",
      "GET  /api/agents/:id/performance":"Agent performance stats",
      "POST /api/sessions":              "Create new agent session",
      "GET  /api/sessions":              "List recent sessions",
      "POST /api/insights/generate":     "Run Qwen AI analysis (TiDB → Qwen → TiDB)",
      "GET  /api/insights":              "Retrieve stored AI insights",
      "GET  /api/analytics/htap":        "HTAP analytics via TiFlash",
    },
    tenants: [
      "tenant_acme", "tenant_globex", "tenant_initech",
      "tenant_umbrella", "tenant_waynetech", "tenant_nexagen"
    ],
    usage: 'curl -H "X-Tenant-ID: tenant_acme" http://localhost:8080/api/agents',
  });
});

// ─── Routes ──────────────────────────────
app.use("/api", routes);

// ─── Start ───────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 AgentNexus API running on http://localhost:${PORT}`);
  console.log(`   TiDB:  ${process.env.TIDB_HOST}:${process.env.TIDB_PORT}`);
  console.log(`   Qwen:  ${process.env.QWEN_MODEL} via ${process.env.DASHSCOPE_BASE_URL}`);
  console.log(`\nAvailable tenants: tenant_acme, tenant_globex, tenant_initech, tenant_umbrella, tenant_waynetech, tenant_nexagen`);
  console.log(`\nTry these commands:`);
  console.log(`  curl http://localhost:${PORT}/`);
  console.log(`  curl -H "X-Tenant-ID: tenant_acme" http://localhost:${PORT}/api/agents`);
  console.log(`  curl -H "X-Tenant-ID: tenant_acme" http://localhost:${PORT}/api/analytics/htap`);
  console.log(`  curl -X POST -H "X-Tenant-ID: tenant_acme" http://localhost:${PORT}/api/insights/generate`);
  console.log();
});
