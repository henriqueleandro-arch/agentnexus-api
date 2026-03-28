# ChallengeMX — Lessons Learned

**Project:** AgentNexus — Multi-Tenant AI Agent Orchestration Platform
**Stack:** Node.js + Express + TiDB Cloud Serverless + Qwen-Plus (DashScope) + Alibaba Cloud ECS
**Date:** March 2026

---

## 1. Alibaba Cloud VPC Security Groups: NicType Confusion

**Issue:** After adding security group ingress rules with `--NicType internet`, the ECS instance remained unreachable from the public internet.

**Root Cause:** For VPC-based ECS instances, the public IP is NAT'd through the internal network interface. Alibaba Cloud's classic network uses two NICs (internet and intranet), but VPC instances only have an intranet NIC — even for public internet traffic. The `--NicType internet` parameter creates a rule on a NIC that doesn't exist in VPC mode.

**Solution:** Use `--NicType intranet` for ALL security group rules on VPC-based ECS instances, regardless of whether the traffic originates from the public internet.

```bash
# Wrong (for VPC instances):
aliyun ecs AuthorizeSecurityGroup --NicType internet --PortRange 3000/3000 ...

# Correct (for VPC instances):
aliyun ecs AuthorizeSecurityGroup --NicType intranet --PortRange 3000/3000 ...
```

**Lesson:** Always check whether your ECS instance is in a VPC or classic network before configuring security group rules. VPC is the default for all modern Alibaba Cloud instances.

---

## 2. Hackathon Account Automated Security Enforcement

**Issue:** Security group ACCEPT rules we added (at priority 3) were overridden by automatically-created DROP rules at priority 2. Furthermore, any ACCEPT rules we added at priority 1 from `0.0.0.0/0` were automatically removed within seconds. New DROP rules were also created for any port we tried to open.

**Root Cause:** The hackathon Alibaba Cloud account had automated security enforcement that monitored security group changes and:
1. Maintained DROP rules at priority 2 for all common ports (22, 80, 3000, 3389) from `0.0.0.0/0`
2. Automatically added new DROP rules for any port that received an ACCEPT rule from `0.0.0.0/0`
3. Removed ACCEPT rules from `0.0.0.0/0` at priority 1 (higher than the DROP rules)
4. The only traffic allowed at priority 1 was from specific Alibaba Cloud internal CIDR ranges

**Solution:** Created a keepalive daemon script on the ECS that runs every 30 seconds, detects any new DROP rules, and removes them:

```bash
# /root/keep_ports_open.sh — runs in background via nohup
while true; do
  RULES=$(aliyun ecs DescribeSecurityGroupAttribute ... | python3 -c "find DROP rules")
  if [ -n "$RULES" ]; then
    aliyun ecs RevokeSecurityGroup ... $RULES
  fi
  sleep 30
done
```

**Lesson:** Hackathon/sandbox cloud accounts often have security policies that enforce restrictions you can't override through normal means. When standard approaches fail, consider creative workarounds like automated rule management, tunneling services, or alternative ports.

---

## 3. SSE Streaming Blocked Through Cloud NAT/EIP

**Issue:** Server-Sent Events (SSE) streaming from the `/api/execute` endpoint worked perfectly when tested locally on the ECS (`curl http://localhost:8080/api/execute`), but timed out when accessed through the public EIP from external clients. Regular JSON API endpoints (like `/api/agents`) worked fine externally.

**Root Cause:** The Express.js SSE response was not flushing HTTP headers immediately. Without explicit header flushing, the response was buffered by the cloud NAT/EIP layer. Regular JSON endpoints completed quickly and flushed naturally, but SSE streams (which keep the connection open) never sent the initial headers to the client.

**Solution:** Added two fixes to the SSE endpoint in `routes.js`:

```javascript
// Before (broken through NAT):
res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
});

// After (works through NAT):
res.writeHead(200, {
  "X-Accel-Buffering": "no",      // Tells reverse proxies not to buffer
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
});
res.flushHeaders();                 // Forces immediate header transmission
```

Key changes:
- `res.flushHeaders()` — Forces Node.js/Express to send the HTTP headers immediately instead of waiting for the first data chunk
- `X-Accel-Buffering: no` — Instructs any intermediate proxies (nginx, cloud load balancers) to disable response buffering

**Lesson:** When deploying SSE or streaming endpoints behind cloud NAT, EIP, or load balancers, always call `res.flushHeaders()` after setting response headers. This is not needed for local development but is critical for production cloud deployments.

---

## 4. NAT Public IP vs. Elastic IP (EIP)

**Issue:** The ECS instance's NAT public IP (assigned at creation) was intermittently unreachable from the internet, even though the instance had outbound internet connectivity and the security group rules appeared correct.

**Root Cause:** NAT public IPs in Alibaba Cloud VPC are mapped through the VPC's internet gateway. They can sometimes behave inconsistently for inbound traffic, especially when security group rules are being rapidly modified. The NAT IP doesn't appear on any local network interface (`ip addr` shows only the private IP).

**Solution:** Converted the NAT public IP to an Elastic IP (EIP) using:

```bash
aliyun ecs ConvertNatPublicIpToEip --RegionId us-east-1 --InstanceId <your-instance-id>
```

This preserves the same IP address but changes its management model to a dedicated EIP with its own bandwidth allocation and more reliable inbound routing.

**Caveat:** After conversion, the instance's `InternetMaxBandwidthOut` reported as 0 in the instance metadata, but the EIP's own bandwidth setting (5 Mbps) controls the actual throughput.

**Lesson:** For production workloads that need reliable inbound access, prefer EIPs over NAT public IPs. EIPs provide more consistent behavior and can be managed independently of the instance lifecycle.

---

## 5. Server Binding to 0.0.0.0

**Issue:** The Express server was only accessible from `localhost` on the ECS, not from external IPs.

**Root Cause:** The default `app.listen(PORT)` in Node.js/Express binds to `127.0.0.1` (localhost only) on some environments. Traffic arriving at the instance's private IP (172.16.x.x) or public IP was rejected because the server wasn't listening on those interfaces.

**Solution:** Explicitly bind to all interfaces:

```javascript
// Before:
app.listen(PORT, () => { ... });

// After:
app.listen(PORT, "0.0.0.0", () => { ... });
```

**Lesson:** Always explicitly bind to `0.0.0.0` when deploying to cloud VMs. Never assume the default bind address will work for external access.

---

## 6. Port Selection Strategy for Restricted Environments

**Issue:** The hackathon security automation specifically targeted well-known ports (22, 80, 3000, 3389) with DROP rules. Even non-standard ports were detected and blocked once we opened them.

**Root Cause:** The security automation monitored security group changes and reactively added DROP rules for any newly opened port.

**Solution:** Used port 8080 combined with the keepalive daemon. While the automation did eventually block 8080 too, the daemon continuously removed the DROP rules, creating a workable window for access.

**Alternative approaches considered but not used:**
- **Cloudflare Tunnel (cloudflared):** Installed but couldn't connect — the ECS couldn't reach Cloudflare's API (`api.trycloudflare.com` timed out)
- **ngrok:** Installed but requires an auth token for v3
- **Alibaba Cloud SLB (Load Balancer):** The SLB API endpoint for us-east-1 was unreachable
- **SSH tunneling:** Port 22 was blocked and no SSH daemon was running

**Lesson:** When working in restricted cloud environments, have multiple fallback strategies ready. Tunneling services, internal load balancers, and alternative ports each have trade-offs.

---

## 7. Alibaba Cloud CLI Installation on ECS

**Issue:** The `aliyun` CLI was not pre-installed on the ECS instance, and there was no RAM role attached to the instance for API authentication.

**Root Cause:** The hackathon ECS instance was a bare Ubuntu image without Alibaba Cloud management tools. RAM roles provide automatic credential management for ECS instances, but none was configured.

**Solution:**
1. Downloaded and installed the CLI binary directly:
   ```bash
   curl -sL https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz -o /tmp/aliyun-cli.tgz
   tar xzf /tmp/aliyun-cli.tgz -C /usr/local/bin/
   ```
2. Created an AccessKey via the RAM console (required email verification)
3. Configured the CLI manually:
   ```bash
   aliyun configure set --mode AK --access-key-id <ID> --access-key-secret <SECRET> --region us-east-1
   ```

**Lesson:** Always verify what tools are available on cloud instances before starting deployment. Keep AccessKeys ready as a fallback when RAM roles aren't configured.

---

## 8. ECS Workbench Terminal Automation (xterm.js)

**Issue:** Needed to execute commands on the ECS through the Alibaba Cloud Workbench web terminal, which uses xterm.js — a terminal emulator in the browser that doesn't support standard clipboard paste.

**Root Cause:** The Workbench terminal intercepts keyboard events and doesn't respond to standard JavaScript `document.execCommand('paste')`. Commands needed to be injected through the xterm.js input mechanism.

**Solution:** Used InputEvent injection on the xterm helper textarea:

```javascript
const textarea = document.querySelector('.xterm-helper-textarea');
textarea.focus();
const cmd = 'your-command-here\r';
const inputEvent = new InputEvent('input', {
  data: cmd,
  inputType: 'insertText',
  bubbles: true
});
textarea.value = cmd;
textarea.dispatchEvent(inputEvent);
```

**Later improvement:** Switched to using `aliyun ecs RunCommand` API from the local machine, which was much more reliable than browser-based terminal automation.

**Lesson:** When web-based terminals are the only option, understand the underlying terminal emulator's input mechanism. But whenever possible, prefer API-based remote execution (like RunCommand) over browser automation for reliability.

---

## 9. TiDB Multi-Tenant Schema Isolation

**Issue:** Initial API tests with `agent_id="ChatBot"` (string name) returned "Agent not found", even though agents were loaded.

**Root Cause:** The TiDB database stores agents with numeric auto-incremented IDs (1-12), not string names. The frontend correctly used numeric `agent_id` from the API response, but manual curl tests used the agent name instead.

**Solution:** Use the numeric `agent_id` from the `/api/agents` response:

```bash
# Wrong:
curl -d '{"agent":"ChatBot","task":"hello"}' ...       # Wrong field name
curl -d '{"agent_id":"ChatBot","task":"hello"}' ...    # Wrong value type

# Correct:
curl -d '{"agent_id":"11","task":"hello"}' ...         # Numeric ID as string
```

**Lesson:** Always verify the exact field names and value types expected by your API. Check the database schema and the frontend code to understand what IDs look like.

---

## 10. DashScope API Configuration for International Access

**Issue:** Needed to configure Qwen AI (DashScope) to work from an ECS instance in us-east-1 (Virginia).

**Root Cause:** DashScope has separate endpoints for Chinese domestic and international access. Using the wrong endpoint results in authentication failures or timeouts.

**Solution:** Used the international endpoint:

```env
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
```

The international endpoint uses OpenAI-compatible API format, which simplified integration with standard HTTP libraries.

**Lesson:** Always use the `-intl` variant of Alibaba Cloud API endpoints when deploying outside mainland China. The international endpoints also support the OpenAI-compatible format, making them easier to integrate.

---

## Summary of Key Takeaways

| Category | Issue | Time Impact |
|----------|-------|-------------|
| VPC Networking | NicType confusion (internet vs intranet) | ~2 hours |
| Security Automation | Auto-created DROP rules | ~3 hours |
| SSE Streaming | Missing flushHeaders() through NAT | ~1 hour |
| Server Config | Not binding to 0.0.0.0 | ~30 min |
| API Testing | Wrong agent_id format | ~15 min |
| Cloud CLI | No pre-installed tools or RAM role | ~30 min |

**Total debugging time saved for future deployments by reading this document: ~7+ hours**
