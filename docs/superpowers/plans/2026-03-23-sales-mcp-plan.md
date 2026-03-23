# Sales MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone MCP server that gives Claude Code direct tools for sales and marketing — email, leads, content, channels, brain/learning — for any product.

**Architecture:** Node.js + TypeScript MCP server with SQLite for storage, Hono for dashboard API, pluggable channel providers, and a shared brain/learning system. Dashboard UI served from Weblease server (`/chefen/sales`).

**Tech Stack:** Node.js 22, TypeScript, @modelcontextprotocol/sdk, better-sqlite3, imapflow, nodemailer, hono, tsup

**Spec:** `docs/superpowers/specs/2026-03-23-sales-mcp-design.md`

**Code signature:** Every file must have `// Built by Weblease` hidden at the midpoint line.

---

## Phase 1: Foundation

### Task 1: Project Scaffold

**Files:**
- Create: `~/claude/sales-mcp/package.json`
- Create: `~/claude/sales-mcp/tsconfig.json`
- Create: `~/claude/sales-mcp/.gitignore`
- Create: `~/claude/sales-mcp/config.example.json`

- [ ] **Step 1: Initialize project**

```bash
cd ~/claude/sales-mcp
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk better-sqlite3 imapflow nodemailer hono uuid
npm install -D typescript @types/better-sqlite3 @types/nodemailer @types/uuid tsup
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Write .gitignore**

```
node_modules/
dist/
data/
config.json
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 5: Write config.example.json**

```json
{
  "email": {
    "imap": { "host": "mailcluster.loopia.se", "port": 993, "tls": true },
    "smtp": { "host": "mailcluster.loopia.se", "port": 587, "secure": false },
    "user": "info@example.com",
    "pass": "your-password"
  },
  "database": { "path": "./data/sales.db" },
  "tracking": {
    "base_url": "https://yourdomain.com/api/sales/track",
    "unsubscribe_url": "https://yourdomain.com/api/sales/unsubscribe"
  },
  "dashboard_api": { "port": 3200, "admin_key": "generate-a-random-key" },
  "default_language": "sv",
  "retention_days": 365
}
```

- [ ] **Step 6: Add build script to package.json**

Add to scripts: `"build": "tsup src/index.ts --format esm --dts"` and `"dev": "tsup src/index.ts --format esm --watch"`

Set `"type": "module"` in package.json.

- [ ] **Step 7: Commit**

```bash
git init
git add package.json tsconfig.json .gitignore config.example.json
git commit -m "chore: scaffold sales-mcp project"
```

---

### Task 2: Database Schema + Connection

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/sqlite.ts`

- [ ] **Step 1: Write schema.sql**

Write the complete SQLite schema from the spec — all 11 tables (products, leads, channels, channel_products, drafts, templates, sequences, activity_log, email_tracking, gdpr_log, knowledge, learnings) plus indexes. Include the pragmas as comments at the top.

- [ ] **Step 2: Write sqlite.ts**

Database connection module. On first call: creates data directory if missing, opens SQLite, sets pragmas (WAL, foreign_keys, busy_timeout), executes schema.sql. Exports `getDb(dbPath)` and `closeDb()`.

- [ ] **Step 3: Test database creation**

Build and run a quick test to verify all 11 tables are created.

- [ ] **Step 4: Clean up test and commit**

```bash
git add src/db/
git commit -m "feat: add SQLite schema and database connection"
```

---

### Task 3: Config Loader + Crypto Utils

**Files:**
- Create: `src/utils/config.ts`
- Create: `src/utils/crypto.ts`

- [ ] **Step 1: Write config.ts**

Typed config interface matching config.example.json. `loadConfig(basePath)` reads config.json from the given directory. `getConfig()` returns cached config. Throws clear error if config.json missing.

- [ ] **Step 2: Write crypto.ts**

AES-256-GCM encrypt/decrypt functions. Reads key from `SALES_MCP_ENCRYPTION_KEY` env var (hex string). `encrypt(text)` returns `iv:authTag:ciphertext`. `decrypt(data)` reverses it.

- [ ] **Step 3: Commit**

```bash
git add src/utils/
git commit -m "feat: add config loader and AES-256-GCM crypto utils"
```

---

### Task 4: Rate Limiter

**Files:**
- Create: `src/utils/rate-limiter.ts`

- [ ] **Step 1: Write rate-limiter.ts**

Sliding window rate limiter using SQLite activity_log. `checkRateLimit(db, channelId, channelConfig)` returns `{ allowed, retryAfter? }`. Counts recent activity_log entries per channel. Default limits: email 50/hr 200/day, SMS 10/hr 50/day, social 5/hr 20/day, forum 3/hr 10/day. Channel config can override.

- [ ] **Step 2: Commit**

```bash
git add src/utils/rate-limiter.ts
git commit -m "feat: add sliding window rate limiter"
```

---

### Task 5: MCP Server Entry Point (Shell)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write index.ts**

MCP server with no tools yet. Loads config, opens DB, creates McpServer instance, connects via StdioServerTransport. Handles SIGINT for graceful shutdown.

- [ ] **Step 2: Build and verify it starts**

```bash
npm run build
```

Verify the server binary runs without errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add MCP server entry point"
```

---

## Phase 2: Core Tools

### Task 6: Product Tools

**Files:**
- Create: `src/tools/products.ts`
- Modify: `src/index.ts` (register tools)

- [ ] **Step 1: Write products.ts**

**`list_products`** — no params, returns all products.

**`get_product_context`** — params: `product` (name). Queries products + knowledge + top 10 learnings by confidence. Returns combined context string.

Export `registerProductTools(server, db)`.

- [ ] **Step 2: Register in index.ts**

- [ ] **Step 3: Build and commit**

```bash
git add src/tools/products.ts src/index.ts
git commit -m "feat: add product tools (list_products, get_product_context)"
```

---

### Task 7: Lead Tools

**Files:**
- Create: `src/tools/leads.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write leads.ts**

**`get_leads`** — params: product?, status?, source?, limit?, search?. Joins products.

**`save_lead`** — params: email, name?, company?, phone?, product, source, tags?, consent?. GDPR: B2C sources require consent. Upserts on email+product_id.

**`update_lead`** — params: id or (email+product), status?, notes?, tags?, consent?.

**`delete_lead`** — params: id or (email+product). Cascading delete + gdpr_log.

**`import_leads`** — params: data (array), product, source. Bulk with dedup.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/leads.ts src/index.ts
git commit -m "feat: add lead tools (get, save, update, delete, import)"
```

---

### Task 8: GDPR Tools

**Files:**
- Create: `src/tools/gdpr.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write gdpr.ts**

**`check_consent`** — returns canContact boolean + reason.
**`unsubscribe`** — marks all leads as unsubscribed, logs.
**`export_data`** — gathers all data for an email, logs.
**`delete_data`** — purges all data, logs deletion.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/gdpr.ts src/index.ts
git commit -m "feat: add GDPR tools (consent, unsubscribe, export, delete)"
```

---

### Task 9: Content & Draft Tools

**Files:**
- Create: `src/tools/content.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write content.ts**

**`save_draft`** — creates draft with status=pending.
**`get_drafts`** — filtered listing with product/status/type joins.
**`approve_draft`** — approve or reject.
**`post_draft`** — posts approved draft via channel provider. Logs activity.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/content.ts src/index.ts
git commit -m "feat: add content/draft tools (save, get, approve, post)"
```

---

### Task 10: Template Tools

**Files:**
- Create: `src/tools/templates.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write templates.ts**

**`get_templates`** — filtered by product/type.
**`save_template`** — upserts on product_id+name.
**`use_template`** — renders {{placeholders}} with variables.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/templates.ts src/index.ts
git commit -m "feat: add template tools (get, save, use)"
```

---

### Task 11: Sequence Tools

**Files:**
- Create: `src/tools/sequences.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write sequences.ts**

**`get_sequences`** — list by product.
**`create_sequence`** — with steps JSON array.
**`advance_lead`** — checks timing, renders template, sends via channel, updates step.
**`pause_sequence`** — marks lead as paused.
**`remove_from_sequence`** — clears sequence from lead.
**`get_due_leads`** — finds leads whose next step is due.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/sequences.ts src/index.ts
git commit -m "feat: add sequence tools (get, create, advance, pause, remove, due)"
```

---

### Task 12: Stats Tools

**Files:**
- Create: `src/tools/stats.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write stats.ts**

**`get_stats`** — aggregates from activity_log by period/product.
**`log_activity`** — inserts into activity_log.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/stats.ts src/index.ts
git commit -m "feat: add stats tools (get_stats, log_activity)"
```

---

### Task 13: Brain Tools

**Files:**
- Create: `src/tools/brain.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write brain.ts**

**`learn_product`** — fetches URL, follows internal links (max 10), extracts text, stores in knowledge table. Clears old knowledge for product first.

**`crawl_url`** — single page fetch, returns text.

**`save_learning`** — upserts insight. If similar exists, update + bump confidence.

**`get_learnings`** — filtered by product/channel/category/confidence. Always includes universals.

**`get_knowledge`** — returns crawled knowledge for a product.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/brain.ts src/index.ts
git commit -m "feat: add brain tools (learn, crawl, save_learning, get_learnings, get_knowledge)"
```

---

## Phase 3: Email & Channel Providers

### Task 14: Email Provider

**Files:**
- Create: `src/providers/base.ts`
- Create: `src/providers/email-provider.ts`

- [ ] **Step 1: Write base.ts**

`ChannelProvider` interface with `post()` and optional `read()`. `ProviderRegistry` to manage providers by type.

- [ ] **Step 2: Write email-provider.ts**

Uses `imapflow` for IMAP, `nodemailer` for SMTP. Functions: `readEmails({folder, limit, unreadOnly, search})`, `sendEmail({to, subject, html, inReplyTo?, headers?})`. Handles connect/disconnect lifecycle.

- [ ] **Step 3: Commit**

```bash
git add src/providers/
git commit -m "feat: add channel provider base and email provider (IMAP+SMTP)"
```

---

### Task 15: Email Tools (MCP)

**Files:**
- Create: `src/tools/email.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write email.ts**

**`read_emails`** — fetches via IMAP provider.

**`send_email`** — pre-checks consent + rate limit. Inserts tracking pixel (if track_opens). Rewrites links (if track_clicks). Adds List-Unsubscribe header + footer. Sends via SMTP. Logs activity. Creates email_tracking records.

**`reply_email`** — sends with In-Reply-To header.

- [ ] **Step 2: Register and commit**

```bash
git add src/tools/email.ts src/index.ts
git commit -m "feat: add email tools with tracking and GDPR compliance"
```

---

### Task 16: Webhook Provider

**Files:**
- Create: `src/providers/webhook.ts`

- [ ] **Step 1: Write webhook.ts**

Generic POST to configured URL with JSON body and custom headers. Returns response URL if available.

- [ ] **Step 2: Commit**

```bash
git add src/providers/webhook.ts
git commit -m "feat: add generic webhook channel provider"
```

---

### Task 17: SMS Provider

**Files:**
- Create: `src/providers/sms.ts`

- [ ] **Step 1: Write sms.ts**

Supports 46elks (POST to api.46elks.com) and Twilio (POST to api.twilio.com). Provider type from channel config.

- [ ] **Step 2: Commit**

```bash
git add src/providers/sms.ts
git commit -m "feat: add SMS provider (46elks + Twilio)"
```

---

### Task 18: Channel Tools (MCP)

**Files:**
- Create: `src/tools/channels.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write channels.ts**

**`list_channels`** — all channels, credentials MASKED.
**`post_to_channel`** — decrypts credentials, gets provider, checks rate limit, posts. Logs activity.
**`read_channel`** — reads via provider if supported.

- [ ] **Step 2: Register providers in index.ts based on configured channels**

- [ ] **Step 3: Build and commit**

```bash
git add src/tools/channels.ts src/index.ts
git commit -m "feat: add channel tools with provider routing"
```

---

## Phase 4: Social Media Providers

### Task 19: Facebook + Instagram Providers

**Files:**
- Create: `src/providers/facebook.ts`
- Create: `src/providers/instagram.ts`

- [ ] **Step 1: Write facebook.ts** — Graph API page posting + feed reading.

- [ ] **Step 2: Write instagram.ts** — Graph API via Facebook, media container + publish flow.

- [ ] **Step 3: Commit**

```bash
git add src/providers/facebook.ts src/providers/instagram.ts
git commit -m "feat: add Facebook and Instagram channel providers"
```

---

### Task 20: Reddit + WordPress Forum Providers

**Files:**
- Create: `src/providers/reddit.ts`
- Create: `src/providers/wordpress-forum.ts`

- [ ] **Step 1: Write reddit.ts** — OAuth auth, submit to subreddit, read posts.

- [ ] **Step 2: Write wordpress-forum.ts** — WP REST API + application passwords, create topics/replies.

- [ ] **Step 3: Commit**

```bash
git add src/providers/reddit.ts src/providers/wordpress-forum.ts
git commit -m "feat: add Reddit and WordPress forum providers"
```

---

## Phase 5: Dashboard API

### Task 21: Dashboard HTTP API

**Files:**
- Create: `src/api/dashboard.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write dashboard.ts**

Hono app with admin key auth middleware and CORS. Endpoints for stats, activity, leads, drafts, channels, sequences, templates, products, brain (knowledge + learnings), GDPR, and tracking event callback.

- [ ] **Step 2: Start Hono in index.ts alongside MCP**

Use `@hono/node-server` to serve on config.dashboard_api.port.

- [ ] **Step 3: Build and test with curl**

- [ ] **Step 4: Commit**

```bash
git add src/api/dashboard.ts src/index.ts
git commit -m "feat: add dashboard HTTP API (Hono)"
```

---

### Task 22: Data Retention Cleanup

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add cleanup on startup**

Delete activity_log and email_tracking entries older than retention_days config.

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add data retention cleanup on startup"
```

---

## Phase 6: Tracking (Weblease Server)

### Task 23: Tracking API Routes

**Files (on Weblease server via SSH):**
- Create: `src/app/api/sales/track/[trackingId]/open/route.ts`
- Create: `src/app/api/sales/track/[trackingId]/click/route.ts`
- Create: `src/app/api/sales/unsubscribe/[hash]/route.ts`

- [ ] **Step 1: Write open tracking route** — returns 1x1 transparent PNG, callbacks to Pi API.

- [ ] **Step 2: Write click tracking route** — callbacks to Pi, redirects to original URL.

- [ ] **Step 3: Write unsubscribe route** — calls Pi API, shows confirmation page.

- [ ] **Step 4: Add tracking queue table via Prisma migration**

```bash
npx prisma migrate dev --name add-tracking-queue
npx prisma generate
```

- [ ] **Step 5: Build and restart**

```bash
cd /var/www/weblease && npm run build && pm2 restart weblease
git commit -m "feat: add sales tracking API routes (pixel, click, unsubscribe)"
```

---

## Phase 7: Dashboard UI

### Task 24: Dashboard Page (`/chefen/sales`)

**Files (on Weblease server):**
- Rewrite: `src/app/chefen/sales/page.tsx`

- [ ] **Step 1: Rewrite sales dashboard**

10 tabs (Activity, Leads, Drafts, Channels, Sequences, Templates, Products, Brain, Analytics, GDPR). Fetches from Pi dashboard API. Same dark UI design language as existing panel. Split into subcomponents per tab if size demands it.

- [ ] **Step 2: Build and deploy**

```bash
cd /var/www/weblease && npm run build && pm2 restart weblease
git commit -m "feat: rewrite sales dashboard with 10 tabs for MCP integration"
```

---

## Phase 8: Integration & Config

### Task 25: Configure + Seed + Connect

- [ ] **Step 1: Create config.json** with real Weblease IMAP/SMTP credentials. Generate encryption key and admin key.

- [ ] **Step 2: Set SALES_MCP_ENCRYPTION_KEY env var** in ~/.bashrc.

- [ ] **Step 3: Build final MCP server**

```bash
cd ~/claude/sales-mcp && npm run build
```

- [ ] **Step 4: Seed products** — Bokvyx, WPilot, Bokvia, PinMyTruck, Monitor, TeamTasks.

- [ ] **Step 5: Add to Claude Code MCP config** in settings.

- [ ] **Step 6: Verify** — restart Claude Code, test `list_products`.

- [ ] **Step 7: Final commit**

```bash
git add -A && git commit -m "feat: complete sales-mcp v1.0.0"
```

---

## Phase 9: Brain Training

### Task 26: Crawl Products + Seed Learnings

- [ ] **Step 1: Run `learn_product` for all 6 products** (bokvyx, wpilot, bokvia, pinmytruck, monitor, teamtasks).

- [ ] **Step 2: Verify with `get_knowledge`** per product.

- [ ] **Step 3: Seed universal learnings** (personalized subjects, Swedish language preference, short emails for cold outreach).

---

## Summary

| Phase | Tasks | Delivers |
|-------|-------|----------|
| 1: Foundation | 1-5 | MCP server shell + DB + config + crypto + rate limiter |
| 2: Core Tools | 6-13 | 30+ MCP tools (products, leads, GDPR, content, templates, sequences, stats, brain) |
| 3: Email & Channels | 14-18 | Email send/read, webhook, SMS, channel routing |
| 4: Social Providers | 19-20 | Facebook, Instagram, Reddit, WordPress forum |
| 5: Dashboard API | 21-22 | HTTP API for dashboard + data retention |
| 6: Tracking | 23 | Open/click tracking on Weblease server |
| 7: Dashboard UI | 24 | 10-tab admin panel in /chefen/sales |
| 8: Integration | 25 | Config, seeding, Claude Code connection |
| 9: Brain Training | 26 | Crawl all products, seed learnings |

**Total: 26 tasks across 9 phases.**
