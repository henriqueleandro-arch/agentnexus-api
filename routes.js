// routes.js — AgentNexus API endpoints
const express = require("express");
const { tenantQuery } = require("./db");
const { analyzeAgentPerformance, executeAgentTask } = require("./qwen");
const { tenantMiddleware } = require("./middleware");

const router = express.Router();

// All routes require tenant identification
router.use(tenantMiddleware);

// ─────────────────────────────────────────
// GET /agents — List all agents for this tenant
// ─────────────────────────────────────────
router.get("/agents", async (req, res) => {
  try {
    const agents = await tenantQuery(
      req.tenantId,
      "SELECT agent_id, name, type, capabilities, created_at FROM agents ORDER BY created_at DESC"
    );
    res.json({ tenant: req.tenantId, count: agents.length, agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /agents/:id/performance — Agent performance summary
// ─────────────────────────────────────────
router.get("/agents/:id/performance", async (req, res) => {
  try {
    const [agent] = await tenantQuery(
      req.tenantId,
      "SELECT agent_id, name, type FROM agents WHERE agent_id = ?",
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const stats = await tenantQuery(
      req.tenantId,
      `SELECT
         COUNT(*) AS total_sessions,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
       FROM sessions WHERE agent_id = ?`,
      [req.params.id]
    );

    res.json({ tenant: req.tenantId, agent, performance: stats[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /sessions — Create a new agent session
// Demo: POST a session then GET insights
// ─────────────────────────────────────────
router.post("/sessions", async (req, res) => {
  try {
    const { agent_id, task_description } = req.body;
    if (!agent_id) return res.status(400).json({ error: "agent_id is required" });

    // Let AUTO_RANDOM generate the session_id
    const result = await tenantQuery(
      req.tenantId,
      `INSERT INTO sessions (agent_id, task_description, status)
       VALUES (?, ?, 'running')`,
      [agent_id, task_description || "Unnamed task"]
    );

    // Retrieve the inserted session using LAST_INSERT_ID()
    const [session] = await tenantQuery(
      req.tenantId,
      "SELECT * FROM sessions WHERE session_id = LAST_INSERT_ID()"
    );

    res.status(201).json({ tenant: req.tenantId, session: session || { insertId: result.insertId } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /sessions — List recent sessions
// ─────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const sessions = await tenantQuery(
      req.tenantId,
      `SELECT s.session_id, a.name AS agent_name, s.task_description, s.status, s.started_at
       FROM sessions s JOIN agents a ON s.agent_id = a.agent_id
       ORDER BY s.started_at DESC LIMIT ?`,
      [limit]
    );
    res.json({ tenant: req.tenantId, count: sessions.length, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /insights — Get AI-generated insights (from TiDB)
// ─────────────────────────────────────────
router.get("/insights", async (req, res) => {
  try {
    const insights = await tenantQuery(
      req.tenantId,
      `SELECT insight_id, tenant_id, qwen_analysis, recommendations, generated_at
       FROM insights WHERE tenant_id = ?
       ORDER BY generated_at DESC LIMIT 10`,
      [req.tenantId]
    );

    // Parse JSON recommendations
    const parsed = insights.map((row) => ({
      ...row,
      recommendations: typeof row.recommendations === "string" ? JSON.parse(row.recommendations) : row.recommendations,
    }));

    res.json({ tenant: req.tenantId, count: parsed.length, insights: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /insights/generate — Run Qwen AI analysis
// This is the key demo endpoint:
// 1. Query TiDB for structured context
// 2. Send to Qwen-Plus
// 3. Store result back in TiDB
// ─────────────────────────────────────────
router.post("/insights/generate", async (req, res) => {
  try {
    // Step 1: Query TiDB for structured context
    const agentPerformance = await tenantQuery(
      req.tenantId,
      `SELECT a.name AS agent_name, a.type AS agent_type,
              COUNT(s.session_id) AS total_sessions,
              SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM agents a
       LEFT JOIN sessions s ON a.agent_id = s.agent_id
       GROUP BY a.agent_id, a.name, a.type
       ORDER BY total_sessions DESC`
    );

    const toolUsage = await tenantQuery(
      req.tenantId,
      `SELECT tool_name, COUNT(*) AS call_count,
              ROUND(AVG(duration_ms)) AS avg_duration_ms
       FROM tool_calls GROUP BY tool_name
       ORDER BY call_count DESC LIMIT 10`
    );

    // Use TiFlash for the analytics query (HTAP demonstration)
    const sessionTrend = await tenantQuery(
      req.tenantId,
      `SELECT /*+ READ_FROM_STORAGE(TIFLASH[sessions]) */
              DATE(started_at) AS day,
              COUNT(*) AS session_count,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM sessions
       GROUP BY DATE(started_at)
       ORDER BY day DESC LIMIT 7`
    );

    const context = {
      tenant: req.tenantId,
      agent_performance: agentPerformance,
      tool_usage: toolUsage,
      session_trend_7d: sessionTrend,
    };

    // Step 2: Send to Qwen-Plus via DashScope
    console.log(`[Qwen] Generating insights for ${req.tenantId}...`);
    const analysis = await analyzeAgentPerformance(context);
    console.log(`[Qwen] Analysis complete for ${req.tenantId}`);

    // Step 3: Store result back in TiDB
    await tenantQuery(
      req.tenantId,
      `INSERT INTO insights (tenant_id, qwen_analysis, recommendations)
       VALUES (?, ?, ?)`,
      [req.tenantId, analysis.summary, JSON.stringify(analysis.recommendations)]
    );

    res.status(201).json({
      tenant: req.tenantId,
      analysis,
      stored: true,
      note: "Insight stored in TiDB. Retrieve with GET /insights",
    });
  } catch (err) {
    console.error(`[Qwen] Error for ${req.tenantId}:`, err.message);
    res.status(500).json({ error: err.message, hint: "Check DASHSCOPE_API_KEY in .env" });
  }
});

// ─────────────────────────────────────────
// GET /analytics/htap — Demonstrate TiFlash HTAP query
// Forces TiFlash routing with hint
// ─────────────────────────────────────────
router.get("/analytics/htap", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.tenantId,
      `SELECT /*+ READ_FROM_STORAGE(TIFLASH[sessions, tool_calls]) */
              a.name AS agent_name,
              COUNT(DISTINCT s.session_id) AS total_sessions,
              COUNT(tc.call_id) AS total_tool_calls,
              ROUND(AVG(tc.duration_ms)) AS avg_tool_duration_ms
       FROM agents a
       JOIN sessions s ON a.agent_id = s.agent_id
       JOIN tool_calls tc ON s.session_id = tc.session_id
       GROUP BY a.agent_id, a.name
       ORDER BY total_sessions DESC`
    );
    res.json({
      tenant: req.tenantId,
      note: "This query uses TiFlash (HTAP) via READ_FROM_STORAGE hint",
      analytics: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /analytics/htap-compare — TiKV vs TiFlash side-by-side comparison
// Runs the same analytical query on both engines, captures timing + EXPLAIN
// ─────────────────────────────────────────
router.get("/analytics/htap-compare", async (req, res) => {
  try {
    const analyticalQuery = `
      SELECT a.name AS agent_name,
             COUNT(DISTINCT s.session_id) AS total_sessions,
             COUNT(tc.call_id) AS total_tool_calls,
             ROUND(AVG(tc.duration_ms)) AS avg_tool_duration_ms
      FROM agents a
      JOIN sessions s ON a.agent_id = s.agent_id
      JOIN tool_calls tc ON s.session_id = tc.session_id
      GROUP BY a.agent_id, a.name
      ORDER BY total_sessions DESC`;

    // --- Run on TiKV (row store) ---
    const tikvStart = Date.now();
    await tenantQuery(req.tenantId, "SET SESSION tidb_isolation_read_engines = 'tikv'");
    const tikvResult = await tenantQuery(req.tenantId, analyticalQuery);
    const tikvTime = Date.now() - tikvStart;
    const tikvExplain = await tenantQuery(req.tenantId, `EXPLAIN ${analyticalQuery}`);
    // Reset to default
    await tenantQuery(req.tenantId, "SET SESSION tidb_isolation_read_engines = 'tikv,tiflash'");

    // --- Run on TiFlash (columnar store) ---
    const tiflashStart = Date.now();
    const tiflashResult = await tenantQuery(
      req.tenantId,
      `SELECT /*+ READ_FROM_STORAGE(TIFLASH[sessions, tool_calls]) */
              a.name AS agent_name,
              COUNT(DISTINCT s.session_id) AS total_sessions,
              COUNT(tc.call_id) AS total_tool_calls,
              ROUND(AVG(tc.duration_ms)) AS avg_tool_duration_ms
       FROM agents a
       JOIN sessions s ON a.agent_id = s.agent_id
       JOIN tool_calls tc ON s.session_id = tc.session_id
       GROUP BY a.agent_id, a.name
       ORDER BY total_sessions DESC`
    );
    const tiflashTime = Date.now() - tiflashStart;
    const tiflashExplain = await tenantQuery(
      req.tenantId,
      `EXPLAIN SELECT /*+ READ_FROM_STORAGE(TIFLASH[sessions, tool_calls]) */
              a.name AS agent_name,
              COUNT(DISTINCT s.session_id) AS total_sessions,
              COUNT(tc.call_id) AS total_tool_calls,
              ROUND(AVG(tc.duration_ms)) AS avg_tool_duration_ms
       FROM agents a
       JOIN sessions s ON a.agent_id = s.agent_id
       JOIN tool_calls tc ON s.session_id = tc.session_id
       GROUP BY a.agent_id, a.name
       ORDER BY total_sessions DESC`
    );

    res.json({
      tenant: req.tenantId,
      tikv: {
        time_ms: tikvTime,
        row_count: tikvResult.length,
        explain: tikvExplain.map(r => ({
          id: r.id, task: r.task, estRows: r.estRows,
          actRows: r.actRows, execution_info: r.execution_info,
          operator_info: r.operator_info,
        })),
      },
      tiflash: {
        time_ms: tiflashTime,
        row_count: tiflashResult.length,
        explain: tiflashExplain.map(r => ({
          id: r.id, task: r.task, estRows: r.estRows,
          actRows: r.actRows, execution_info: r.execution_info,
          operator_info: r.operator_info,
        })),
      },
      data: tiflashResult,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /execute — Manus-like agent execution with SSE streaming
// The agent EXECUTES the task AND provides ops intelligence
// Each step annotates the TiDB feature being demonstrated
// ─────────────────────────────────────────
router.post("/execute", async (req, res) => {
  const { agent_id, task } = req.body;
  if (!agent_id || !task) return res.status(400).json({ error: "agent_id and task are required" });

  // Set up SSE
  res.writeHead(200, {
    "X-Accel-Buffering": "no",
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    // ── Step 1: Look up the agent ──
    // TiDB Feature: Multi-Tenant Isolation (USE `tenant_id`)
    send("step", { step: 1, title: "Looking up agent", status: "running",
      detail: `Querying TiDB for agent #${agent_id}...`,
      tidb_feature: { name: "Multi-Tenant Isolation", detail: `USE \`${req.tenantId}\` — each tenant has its own database schema. This query is scoped to ${req.tenantId} only; other tenants' agents are invisible.` }
    });
    const [agent] = await tenantQuery(req.tenantId, "SELECT agent_id, name, type, capabilities FROM agents WHERE agent_id = ?", [agent_id]);
    if (!agent) {
      send("step", { step: 1, title: "Looking up agent", status: "failed", detail: "Agent not found" });
      send("done", { success: false });
      return res.end();
    }
    const caps = typeof agent.capabilities === "string" ? JSON.parse(agent.capabilities) : agent.capabilities || [];
    send("step", { step: 1, title: "Looking up agent", status: "completed",
      detail: `Found: ${agent.name} (${agent.type}) — capabilities: ${caps.join(", ")}`,
      tidb_feature: { name: "Multi-Tenant Isolation", detail: `USE \`${req.tenantId}\` ensures this agent belongs to this tenant. Other tenants cannot see or access it.` }
    });
    await wait(300);

    // ── Step 2: Create a session ──
    // TiDB Feature: AUTO_RANDOM distributed primary keys
    send("step", { step: 2, title: "Creating session", status: "running",
      detail: `Recording task in TiDB: "${task}"`,
      tidb_feature: { name: "AUTO_RANDOM", detail: "session_id uses AUTO_RANDOM — distributes writes across TiKV regions to prevent hotspots when many agents write concurrently." }
    });
    await tenantQuery(req.tenantId, "INSERT INTO sessions (agent_id, task_description, status) VALUES (?, ?, 'running')", [agent_id, task]);
    const [session] = await tenantQuery(req.tenantId, "SELECT session_id, started_at FROM sessions WHERE session_id = LAST_INSERT_ID()");
    send("step", { step: 2, title: "Creating session", status: "completed",
      detail: `Session ${session?.session_id || "auto"} created — AUTO_RANDOM ID distributed across TiKV nodes`,
      tidb_feature: { name: "AUTO_RANDOM", detail: `Session ID ${session?.session_id} is randomly distributed, not sequential. With 50 tenants running 50 agents each, this prevents all writes from hitting a single TiKV region.` }
    });
    await wait(300);

    // ── Step 3: Agent executes the task ──
    // TiDB Feature: Agent State Persistence (the database is the agent's long-term memory)
    send("step", { step: 3, title: `${agent.name} executing task`, status: "running",
      detail: `Agent is working on: "${task}"`,
      tidb_feature: { name: "Agent State Persistence", detail: "Like Manus AI, TiDB serves as the agent's long-term memory — task plans, tool calls, and results are all persisted for future reference." }
    });

    const taskResult = await executeAgentTask({ name: agent.name, type: agent.type, capabilities: caps }, task);

    // Save a state snapshot (agent's long-term memory in TiDB)
    if (session?.session_id) {
      await tenantQuery(req.tenantId,
        "INSERT INTO state_snapshots (session_id, step_number, state_data) VALUES (?, 1, ?)",
        [session.session_id, JSON.stringify({ task, response: taskResult.response.substring(0, 500), source: taskResult._source })]
      );
    }

    send("step", { step: 3, title: `${agent.name} executing task`, status: "completed",
      detail: `Task complete (source: ${taskResult._source})`,
      tidb_feature: { name: "Agent State Persistence", detail: "Agent output saved as a state_snapshot in TiDB — this is the agent's memory. Future sessions can retrieve past results for context." }
    });
    // Send the actual task response
    send("task_result", { agent: agent.name, response: taskResult.response, source: taskResult._source });
    await wait(400);

    // ── Step 4: Gather operational context ──
    // TiDB Feature: TiFlash HTAP — analytics without impacting transactions
    send("step", { step: 4, title: "Gathering ops intelligence", status: "running",
      detail: "Running analytical queries via TiFlash (columnar engine) — no impact on agent write operations",
      tidb_feature: { name: "TiFlash HTAP", detail: "Analytical queries (GROUP BY, COUNT, AVG) run on TiFlash's columnar engine while agent writes continue on TiKV. Zero contention between analytics and transactions." }
    });

    const agentPerformance = await tenantQuery(req.tenantId,
      `SELECT a.name AS agent_name, a.type AS agent_type,
              COUNT(s.session_id) AS total_sessions,
              SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM agents a LEFT JOIN sessions s ON a.agent_id = s.agent_id
       GROUP BY a.agent_id, a.name, a.type ORDER BY total_sessions DESC`
    );

    const toolUsage = await tenantQuery(req.tenantId,
      `SELECT tool_name, COUNT(*) AS call_count, ROUND(AVG(duration_ms)) AS avg_duration_ms
       FROM tool_calls GROUP BY tool_name ORDER BY call_count DESC LIMIT 10`
    );

    const htapData = await tenantQuery(req.tenantId,
      `SELECT /*+ READ_FROM_STORAGE(TIFLASH[sessions]) */
              DATE(started_at) AS day, COUNT(*) AS session_count,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM sessions GROUP BY DATE(started_at) ORDER BY day DESC LIMIT 7`
    );

    send("step", { step: 4, title: "Gathering ops intelligence", status: "completed",
      detail: `TiFlash retrieved: ${agentPerformance.length} agents, ${toolUsage.length} tools, ${htapData.length} days of trends`,
      tidb_feature: { name: "TiFlash HTAP", detail: `READ_FROM_STORAGE(TIFLASH[sessions]) routed this aggregation to columnar storage. The agent's session write (Step 2) and this analytics query ran on separate engines — no lock contention.` }
    });
    await wait(300);

    // ── Step 5: AI-powered operations analysis ──
    // TiDB Feature: RAG pattern (TiDB → Qwen → TiDB)
    send("step", { step: 5, title: "AI operations analysis", status: "running",
      detail: "Qwen analyzing agent performance data queried from TiDB...",
      tidb_feature: { name: "RAG Pipeline (TiDB → Qwen → TiDB)", detail: "Structured data queried from TiDB is sent as context to Qwen. The AI response is parsed and stored back in TiDB's insights table. This is the RAG pattern required by the challenge." }
    });

    const context = {
      tenant: req.tenantId,
      task: task,
      assigned_agent: { name: agent.name, type: agent.type, capabilities: caps },
      agent_performance: agentPerformance,
      tool_usage: toolUsage,
      session_trend_7d: htapData,
    };

    const analysis = await analyzeAgentPerformance(context);
    send("step", { step: 5, title: "AI operations analysis", status: "completed",
      detail: `Ops analysis complete (source: ${analysis._source || "qwen"})`,
      tidb_feature: { name: "RAG Pipeline (TiDB → Qwen → TiDB)", detail: "Qwen received structured JSON context from TiDB, generated insights, and the result will be stored back — completing the RAG loop." }
    });
    await wait(300);

    // ── Step 6: Persist everything back to TiDB ──
    // TiDB Feature: Horizontal scalability + online writes
    send("step", { step: 6, title: "Persisting to TiDB", status: "running",
      detail: "Storing AI insight and marking session complete...",
      tidb_feature: { name: "Horizontal Scalability", detail: "TiDB separates compute (TiDB nodes) from storage (TiKV nodes). Adding tenants or agents requires zero architectural changes — just add nodes." }
    });

    await tenantQuery(req.tenantId,
      "INSERT INTO insights (tenant_id, qwen_analysis, recommendations) VALUES (?, ?, ?)",
      [req.tenantId, analysis.summary, JSON.stringify(analysis.recommendations)]
    );

    if (session?.session_id) {
      await tenantQuery(req.tenantId, "UPDATE sessions SET status = 'completed' WHERE session_id = ?", [session.session_id]);
    }

    send("step", { step: 6, title: "Persisting to TiDB", status: "completed",
      detail: "Insight stored. Session marked as completed.",
      tidb_feature: { name: "Horizontal Scalability", detail: "All writes (session, state snapshot, insight) are distributed across TiKV regions. Scaling to 50+ tenants with concurrent agents requires no schema changes — just more TiKV nodes." }
    });

    // ── Final result ──
    send("done", { success: true, taskResult, analysis });
  } catch (err) {
    send("error", { message: err.message });
    send("done", { success: false });
  }

  res.end();
});

// ─────────────────────────────────────────
// GET /health — Health check with TiDB version
// ─────────────────────────────────────────
router.get("/health", async (req, res) => {
  try {
    const [row] = await tenantQuery(req.tenantId, "SELECT VERSION() AS version, NOW() AS server_time");
    res.json({ status: "ok", tidb: row });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

module.exports = router;
