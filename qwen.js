// qwen.js — Qwen AI integration via Alibaba Cloud Model Studio (DashScope)
const OpenAI = require("openai");

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.DASHSCOPE_API_KEY || "sk-placeholder",
      baseURL:
        process.env.DASHSCOPE_BASE_URL ||
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  }
  return client;
}

/**
 * Analyze agent performance data using local Qwen via Ollama.
 *
 * Pipeline:
 * 1. Receive structured context (already queried from TiDB)
 * 2. Send to local Qwen model
 * 3. Parse the JSON response
 *
 * Falls back to mock analysis if Ollama is unavailable.
 */
async function analyzeAgentPerformance(context) {
  const systemPrompt = `You are an AI operations analyst for AgentNexus, a multi-tenant AI agent orchestration platform running on TiDB Cloud.
You are analyzing data for a specific agent that has been assigned a task.
Focus your analysis on the assigned agent and how it relates to the task given.
Use the actual data provided — reference real agent names, real numbers, real tool names.
Respond ONLY with valid JSON in this exact format:
{
  "summary": "Brief assessment focused on the assigned agent and task (1-2 sentences)",
  "top_issues": ["issue1", "issue2", "issue3"],
  "recommendations": [
    {"agent": "agent_name", "action": "specific recommendation", "priority": "high|medium|low"}
  ],
  "tool_optimization": [
    {"tool": "tool_name", "suggestion": "optimization suggestion"}
  ]
}
Do NOT include any text outside the JSON object. Do NOT use markdown code fences. Do NOT include any thinking or reasoning.`;

  const userPrompt = `Agent "${context.assigned_agent?.name || "unknown"}" (type: ${context.assigned_agent?.type || "unknown"}, capabilities: ${(context.assigned_agent?.capabilities || []).join(", ")}) has been assigned this task: "${context.task || "general analysis"}"

Tenant: ${context.tenant}

Agent Performance Data:
${JSON.stringify(context.agent_performance, null, 2)}

Tool Usage Data:
${JSON.stringify(context.tool_usage, null, 2)}

Session Trends (7 days):
${JSON.stringify(context.session_trend_7d, null, 2)}

Respond with JSON only. No thinking, no explanation, just the JSON object.`;

  try {
    const response = await getClient().chat.completions.create({
      model: process.env.QWEN_MODEL || "qwen-plus",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
    });

    let raw = response.choices[0].message.content.trim();

    // Strip <think>...</think> blocks that Qwen3 may produce
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    // Strip markdown fences
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    // Find the JSON object in the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");

    const result = JSON.parse(jsonMatch[0]);
    result._source = "qwen-plus";
    return result;
  } catch (err) {
    console.warn(`[Qwen] DashScope API call failed (${err.message.substring(0, 100)}), using mock analysis`);
    const mock = generateMockAnalysis(context);
    mock._source = "mock (DashScope unavailable)";
    return mock;
  }
}

/**
 * Fallback mock analysis when Ollama is unavailable.
 */
function generateMockAnalysis(context) {
  const agents = context.agent_performance || [];
  const tools = context.tool_usage || [];
  const assignedAgent = context.assigned_agent || {};
  const agentName = assignedAgent.name || "Agent";
  const agentType = assignedAgent.type || "general";

  const selfStats = agents.find(a => a.agent_name === agentName) || {};
  const selfSessions = Number(selfStats.total_sessions) || 0;
  const selfCompleted = Number(selfStats.completed) || 0;
  const selfFailed = Number(selfStats.failed) || 0;
  const selfRate = selfSessions > 0 ? ((selfCompleted / selfSessions) * 100).toFixed(0) : 0;

  const worstAgent = agents.reduce(
    (worst, a) => {
      const failRate = a.total_sessions > 0 ? a.failed / a.total_sessions : 0;
      return failRate > worst.rate ? { name: a.agent_name, rate: failRate, type: a.agent_type } : worst;
    },
    { name: "unknown", rate: 0, type: "unknown" }
  );

  const slowestTool = tools.reduce(
    (s, t) => (t.avg_duration_ms > s.dur ? { name: t.tool_name, dur: t.avg_duration_ms } : s),
    { name: "unknown", dur: 0 }
  );
  const busiestTool = tools.reduce(
    (b, t) => (t.call_count > b.count ? { name: t.tool_name, count: t.call_count } : b),
    { name: "unknown", count: 0 }
  );

  return {
    summary: `${agentName} (${agentType}) has ${selfSessions} sessions with ${selfRate}% success rate. ${worstAgent.name} has the highest failure rate at ${(worstAgent.rate * 100).toFixed(0)}%, while ${slowestTool.name} is the slowest tool at ${slowestTool.dur}ms avg.`,
    top_issues: [
      `${worstAgent.name} failure rate is ${(worstAgent.rate * 100).toFixed(0)}% — investigate error logs`,
      `${slowestTool.name} averages ${slowestTool.dur}ms per call — consider caching or batching`,
      `${busiestTool.name} is the most-called tool (${busiestTool.count} calls) — ensure it scales`,
    ],
    recommendations: [
      { agent: worstAgent.name, action: `Review failed session logs and add retry logic for ${worstAgent.type} tasks`, priority: "high" },
      { agent: agentName, action: selfFailed > 0 ? "Add error handling and retry mechanisms" : "Performance is strong — use as template for other agents", priority: selfFailed > 0 ? "high" : "low" },
    ],
    tool_optimization: [
      { tool: slowestTool.name, suggestion: `At ${slowestTool.dur}ms avg, consider adding result caching` },
      { tool: busiestTool.name, suggestion: `High call volume (${busiestTool.count}) — add batch mode support` },
    ],
  };
}

/**
 * Execute a task as the agent — the agent actually responds to the user's request.
 * This is the Manus-like behavior: the agent uses its capabilities to perform the task.
 */
async function executeAgentTask(agent, task) {
  const caps = agent.capabilities || [];
  const systemPrompt = `You are "${agent.name}", an AI agent of type "${agent.type}" on the AgentNexus platform.
Your capabilities: ${caps.join(", ")}.
You are executing a task assigned by a user. Respond naturally and helpfully, using your capabilities.
Be concise but thorough. If the task involves generating content, generate it. If it involves analysis, analyze it.
Do NOT mention that you are an AI model. Act as the specialized agent you are.`;

  try {
    const response = await getClient().chat.completions.create({
      model: process.env.QWEN_MODEL || "qwen-plus",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task },
      ],
      temperature: 0.7,
    });

    let content = response.choices[0].message.content.trim();
    // Strip <think> blocks
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return { success: true, response: content, _source: "qwen-plus" };
  } catch (err) {
    console.warn(`[Qwen] Agent task execution failed (${err.message.substring(0, 100)})`);
    return {
      success: false,
      response: `[${agent.name} could not complete this task — DashScope API unavailable]`,
      _source: "fallback",
    };
  }
}

module.exports = { analyzeAgentPerformance, executeAgentTask };
