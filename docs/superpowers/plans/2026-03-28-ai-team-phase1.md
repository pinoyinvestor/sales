# AI Team Platform — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Sales MCP from a basic chat-and-tools system into a fully profiled 16-agent AI team with smart meeting routing, action queue, and trust levels.

**Architecture:** Extend existing Hono API + SQLite DB + Next.js dashboard. Add new DB tables for agent_profiles, action_queue, trust_levels, agent_tasks, daily_reports. Replace agent-responder.mjs with a smarter meeting-runner.mjs that uses topic routing. Each agent has a deep system prompt built dynamically from profile + product knowledge + learnings.

**Tech Stack:** Node.js 22, TypeScript, Hono, better-sqlite3, Next.js 14, Claude CLI (`claude -p`)

---

## File Structure

### New files to create:
- `src/agents/profiles.ts` — All 16 agent profile definitions (identity, personality, system prompt templates, capabilities, keywords)
- `src/agents/topic-router.ts` — Keyword + intent matching to select relevant agents for a message
- `src/agents/prompt-builder.ts` — Builds dynamic system prompts by combining profile + product + learnings + context
- `src/agents/response-parser.ts` — Parses Claude responses into per-agent chat messages and actions (extracted from agent-responder.mjs)
- `src/api/actions.ts` — Action Queue API endpoints (list, create, approve, reject, execute)
- `src/api/trust-levels.ts` — Trust level API endpoints
- `src/api/agent-tasks.ts` — Inter-agent task API endpoints
- `meeting-runner.mjs` — New meeting room poller (replaces agent-responder.mjs)

### Files to modify:
- `src/db/sqlite.ts` — Add new tables and alter existing ones
- `src/api/dashboard.ts` — Mount new route modules, add agent profiles endpoint
- `src/index.ts` — Import and call seedAgentProfiles on startup

### Files to keep unchanged:
- All `src/tools/*.ts`, `src/providers/*.ts`, `src/workers/inbox-reader.ts`, `src/utils/*`

---

### Task 1: Database Migration — New Tables

**Files:**
- Modify: `src/db/sqlite.ts`

- [ ] **Step 1: Add new table definitions to SCHEMA string**

Add after the existing meetings table block in the SCHEMA constant:

```sql
CREATE TABLE IF NOT EXISTS agent_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  avatar TEXT,
  personality TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  focus_keywords TEXT,
  status TEXT DEFAULT 'active',
  last_action TEXT,
  last_action_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS action_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_role TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  requires_approval INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_by TEXT,
  approved_at DATETIME,
  executed_at DATETIME,
  result TEXT,
  feedback TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_queue_status ON action_queue(status);
CREATE INDEX IF NOT EXISTS idx_action_queue_agent ON action_queue(agent_role);

CREATE TABLE IF NOT EXISTS trust_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_role TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  level INTEGER DEFAULT 1,
  changed_by TEXT NOT NULL,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  UNIQUE(agent_role, product_id)
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  due_at DATETIME,
  completed_at DATETIME,
  result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_to ON agent_tasks(to_agent);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  report_type TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  content TEXT NOT NULL,
  period_start DATETIME,
  period_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS onboarding_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  agent_role TEXT NOT NULL,
  report_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: Add ALTER TABLE statements for existing tables**

After `db.exec(SCHEMA)` in the `getDb` function, add safe ALTER TABLE calls:

```typescript
const alterations = [
  `ALTER TABLE learnings ADD COLUMN agent_role TEXT`,
  `ALTER TABLE learnings ADD COLUMN source TEXT DEFAULT 'manual'`,
  `ALTER TABLE learnings ADD COLUMN shared_with TEXT`,
  `ALTER TABLE discussions ADD COLUMN team TEXT`,
  `ALTER TABLE products ADD COLUMN onboarding_status TEXT DEFAULT 'pending'`,
  `ALTER TABLE products ADD COLUMN target_market TEXT`,
  `ALTER TABLE products ADD COLUMN target_language TEXT DEFAULT 'sv'`,
  `ALTER TABLE products ADD COLUMN brand_voice TEXT`,
]
for (const sql of alterations) {
  try { db.exec(sql) } catch { /* column already exists */ }
}
```

- [ ] **Step 3: Build and verify**

Run: `cd ~/claude/sales-mcp && npm run build`
Expected: No TypeScript errors.

- [ ] **Step 4: Restart and verify**

Run: `sudo systemctl restart sales-mcp && sleep 2 && curl -s -H "X-Admin-Key: ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611" http://localhost:3210/api/dashboard/products | head -c 100`
Expected: JSON array (service running, DB intact).

- [ ] **Step 5: Commit**

```bash
cd ~/claude/sales-mcp && git add src/db/sqlite.ts && git commit -m "Add DB tables: agent_profiles, action_queue, trust_levels, agent_tasks, reports"
```

---

### Task 2: Agent Profiles — All 16 Agents

**Files:**
- Create: `src/agents/profiles.ts`

- [ ] **Step 1: Create the agent profiles module**

Create `src/agents/profiles.ts` with all 16 agent definitions. Each agent has role, name, team, avatar, personality, capabilities (action types array), focusKeywords (for routing), and a full systemPrompt template with `{{PRODUCT_CONTEXT}}`, `{{LEARNINGS}}`, `{{TEAM_KNOWLEDGE}}`, `{{CURRENT_CONTEXT}}` placeholders.

The 16 agents are:
- **Executive:** COO, CFO, CTO
- **Sales:** Scout, Outreach, Closer
- **Marketing:** Content, Copywriter, SEO, Strategist
- **Creative:** Creative Director
- **Security:** SecOps (with VETO rights)
- **Customer:** Support, Keeper
- **Operations:** PM
- **Intelligence:** Analyst

Each system prompt includes:
- Identity and personality section
- Responsibilities (what they DO)
- Permissions (what they CAN and CANNOT do)
- Research and regulatory awareness section (all agents must stay updated on laws/regulations relevant to their domain)
- Dynamic placeholders for product context, learnings, team knowledge, and current data

Include a `seedAgentProfiles(db)` function that uses INSERT OR REPLACE to populate the agent_profiles table.

See the full spec at `docs/superpowers/specs/2026-03-28-ai-team-redesign.md` for complete agent details.

- [ ] **Step 2: Build**

Run: `cd ~/claude/sales-mcp && npm run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd ~/claude/sales-mcp && git add src/agents/profiles.ts && git commit -m "Add 16 agent profiles with deep system prompts and capabilities"
```

---

### Task 3: Seed Agents on Startup

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import and call seedAgentProfiles**

After `const db = getDb(dbPath)` and the retention cleanup, add:

```typescript
import { seedAgentProfiles } from './agents/profiles.js'
// ... after retention cleanup ...
seedAgentProfiles(db)
```

- [ ] **Step 2: Build and restart**

Run: `cd ~/claude/sales-mcp && npm run build && sudo systemctl restart sales-mcp && sleep 2`

- [ ] **Step 3: Commit**

```bash
cd ~/claude/sales-mcp && git add src/index.ts && git commit -m "Seed 16 agent profiles into DB on startup"
```

---

### Task 4: Topic Router

**Files:**
- Create: `src/agents/topic-router.ts`

- [ ] **Step 1: Create topic router**

Implements keyword + intent matching. Given a message and list of agents, returns 2-5 relevant agents. Logic:
1. Score each team by counting keyword matches in the message
2. Sort teams by score (descending)
3. From each matching team, pick the agent with most focus_keyword matches
4. If 3+ teams match, always include COO (cross-team coordinator)
5. Ensure minimum 2 agents, maximum 5
6. Default to COO + Strategist if no keywords match

Team keywords map (8 teams): sales, marketing, creative, security, customer, executive, operations, intelligence.

- [ ] **Step 2: Build**

Run: `cd ~/claude/sales-mcp && npm run build`

- [ ] **Step 3: Commit**

```bash
cd ~/claude/sales-mcp && git add src/agents/topic-router.ts && git commit -m "Add topic router for smart agent selection in meetings"
```

---

### Task 5: Prompt Builder

**Files:**
- Create: `src/agents/prompt-builder.ts`

- [ ] **Step 1: Create prompt builder**

Two main functions:
- `buildAgentPrompt(agent, db, productId)` — builds a single agent's full prompt by replacing placeholders with: product info + knowledge base (max 3000 chars), agent learnings (confidence >= 0.3, limit 15), cross-agent learnings (confidence >= 0.6, limit 10), current leads (limit 10), pending action count.
- `buildMeetingPrompt(agents, message, history, db, productId)` — builds a multi-agent meeting prompt with all selected agents' profiles, product context, leads, history, and action format instructions.

- [ ] **Step 2: Build**

Run: `cd ~/claude/sales-mcp && npm run build`

- [ ] **Step 3: Commit**

```bash
cd ~/claude/sales-mcp && git add src/agents/prompt-builder.ts && git commit -m "Add dynamic prompt builder with product context and learnings"
```

---

### Task 6: Response Parser

**Files:**
- Create: `src/agents/response-parser.ts`

- [ ] **Step 1: Extract parser from agent-responder.mjs**

Create a TypeScript module with `parseResponse(response: string): ParsedEntry[]`. Handles:
- Structured format: `ROLE|NAME|Message` for chat, `ACTION|ROLE|NAME|action_type|{json}|Message` for actions
- Freeform fallback: extracts agent name from markdown patterns, assigns to COO as default
- JSON parsing with depth-tracking for nested braces
- Returns array of `ParsedChat | ParsedAction` entries

- [ ] **Step 2: Build**

Run: `cd ~/claude/sales-mcp && npm run build`

- [ ] **Step 3: Commit**

```bash
cd ~/claude/sales-mcp && git add src/agents/response-parser.ts && git commit -m "Extract response parser into shared TypeScript module"
```

---

### Task 7: Action Queue, Trust Levels, Agent Tasks API

**Files:**
- Create: `src/api/actions.ts`
- Create: `src/api/trust-levels.ts`
- Create: `src/api/agent-tasks.ts`
- Modify: `src/api/dashboard.ts`

- [ ] **Step 1: Create action queue routes**

`src/api/actions.ts` — Hono router with:
- `GET /` — list actions (filter: status, agent, product, limit)
- `POST /` — queue new action (used by meeting runner)
- `POST /:id/approve` — approve with approved_by
- `POST /:id/reject` — reject with feedback (saves feedback as learning)
- `POST /:id/execute` — mark approved action as executed

- [ ] **Step 2: Create trust level routes**

`src/api/trust-levels.ts` — Hono router with:
- `GET /` — list all trust levels with product names
- `PUT /:agent/:productId` — set trust level (1-3) with changed_by and reason

- [ ] **Step 3: Create agent task routes**

`src/api/agent-tasks.ts` — Hono router with:
- `GET /` — list tasks (filter: status, agent, limit)
- `POST /` — create task (from_agent, to_agent, title, description, priority)
- `PUT /:id` — update task status and result

- [ ] **Step 4: Mount routes in dashboard.ts**

Import and mount all three routers. Also add `GET /api/dashboard/agent-profiles` endpoint.

- [ ] **Step 5: Build and restart**

Run: `cd ~/claude/sales-mcp && npm run build && sudo systemctl restart sales-mcp && sleep 2`

- [ ] **Step 6: Verify endpoints**

```bash
KEY="ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611"
curl -s -H "X-Admin-Key: $KEY" http://localhost:3210/api/dashboard/agent-profiles | python3 -c "import sys,json; print(f'{len(json.load(sys.stdin))} agents')"
curl -s -H "X-Admin-Key: $KEY" http://localhost:3210/api/dashboard/actions | python3 -c "import sys,json; print(json.load(sys.stdin))"
curl -s -H "X-Admin-Key: $KEY" http://localhost:3210/api/dashboard/trust-levels | python3 -c "import sys,json; print(json.load(sys.stdin))"
curl -s -H "X-Admin-Key: $KEY" http://localhost:3210/api/dashboard/agent-tasks | python3 -c "import sys,json; print(json.load(sys.stdin))"
```
Expected: 16 agents, empty arrays for the rest.

- [ ] **Step 7: Commit**

```bash
cd ~/claude/sales-mcp && git add src/api/actions.ts src/api/trust-levels.ts src/api/agent-tasks.ts src/api/dashboard.ts && git commit -m "Add Action Queue, Trust Levels, and Agent Tasks API endpoints"
```

---

### Task 8: Meeting Runner

**Files:**
- Create: `meeting-runner.mjs`

- [ ] **Step 1: Create meeting-runner.mjs**

Replaces agent-responder.mjs. Key differences from old version:
- Uses `/api/dashboard/agent-profiles` instead of `/api/dashboard/agents`
- Implements topic routing (mirrors `src/agents/topic-router.ts` logic in plain JS)
- Actions go to Action Queue via `POST /api/dashboard/actions` instead of executing directly
- Builds richer prompts with agent system_prompt excerpts
- Uses `claude -p` with Sonnet model, 90s timeout
- Logs which agents were selected for each message

Poll loop: every 3s, check for new admin messages in discussions, route to agents, call Claude, parse response, post chat messages and queue actions.

- [ ] **Step 2: Create systemd service**

Create `/etc/systemd/system/meeting-runner.service`:
- Type: simple
- User: christaras9126
- WorkingDirectory: /home/christaras9126/claude/sales-mcp
- ExecStart: /usr/bin/node meeting-runner.mjs
- After: sales-mcp.service
- Restart: on-failure, RestartSec=10

- [ ] **Step 3: Deploy and start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable meeting-runner
sudo systemctl start meeting-runner
sudo systemctl stop agent-responder 2>/dev/null; sudo systemctl disable agent-responder 2>/dev/null
sleep 3
sudo systemctl status meeting-runner --no-pager
```

- [ ] **Step 4: Test with a message**

```bash
KEY="ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611"
curl -s -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"author_role":"admin","author_name":"Christos","message":"Vi behover hitta fler WordPress-byraer i Tyskland som kan anvanda WPilot. Vad foreslar ni?","topic":"wpilot-germany"}' \
  http://localhost:3210/api/dashboard/discussions
```

Wait 15 seconds, then verify:
```bash
curl -s -H "X-Admin-Key: $KEY" "http://localhost:3210/api/dashboard/discussions?topic=wpilot-germany&limit=10" | python3 -c "
import sys, json
for m in json.load(sys.stdin):
    print(f'{m[\"author_name\"]}: {m[\"message\"][:80]}')
"
```
Expected: Responses from Sales team agents (Scout, Outreach).

- [ ] **Step 5: Commit**

```bash
cd ~/claude/sales-mcp && git add meeting-runner.mjs && git commit -m "Add meeting runner with smart topic routing and action queue"
```

---

### Task 9: Full System Verification

- [ ] **Step 1: Check all services**

```bash
sudo systemctl status sales-mcp sales-dashboard meeting-runner --no-pager | grep -E '(●|Active:)'
```
Expected: All 3 active (running).

- [ ] **Step 2: Verify 16 agents across 8 teams**

```bash
KEY="ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611"
curl -s -H "X-Admin-Key: $KEY" http://localhost:3210/api/dashboard/agent-profiles | python3 -c "
import sys, json
agents = json.load(sys.stdin)
print(f'Total: {len(agents)} agents')
teams = {}
for a in agents:
    teams.setdefault(a['team'], []).append(a['name'])
for team, members in sorted(teams.items()):
    print(f'  {team}: {\", \".join(members)}')
"
```
Expected: 16 agents, 8 teams.

- [ ] **Step 3: Test action queue flow**

```bash
# Queue action
curl -s -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"agent_role":"scout","agent_name":"Scout","action_type":"create_lead","action_data":"{\"email\":\"test@example.com\"}","priority":"medium"}' \
  http://localhost:3210/api/dashboard/actions | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Action #{d[\"id\"]} queued ({d[\"status\"]})')"

# Approve it
curl -s -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"approved_by":"christos"}' \
  "http://localhost:3210/api/dashboard/actions/1/approve" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Action #{d.get(\"id\",\"?\")} now {d.get(\"status\",\"?\")}')"
```

- [ ] **Step 4: Verify meeting responses arrived**

```bash
curl -s -H "X-Admin-Key: $KEY" "http://localhost:3210/api/dashboard/discussions?limit=5" | python3 -c "
import sys, json
for m in json.load(sys.stdin):
    print(f'{m[\"author_name\"]}: {m[\"message\"][:80]}')
"
```

- [ ] **Step 5: Backup memory to NAS**

```bash
cp -r ~/.claude/projects/-home-christaras9126/memory/ /mnt/nas/claude/memory/
```

- [ ] **Step 6: Final commit if needed**

```bash
cd ~/claude/sales-mcp && git status && git diff --quiet || (git add -A && git commit -m "Phase 1 complete: 16 agents, topic router, action queue, meeting runner")
```

---

<!-- Built by Christos Ferlachidis & Daniel Hedenberg -->
