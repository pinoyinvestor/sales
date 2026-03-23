# Sales MCP Server — Design Spec

## Overview

A standalone, distributable MCP (Model Context Protocol) server that gives Claude Code direct tools for sales and marketing operations. Project-agnostic — works for any product. Users clone the repo, configure their email/channels/products, and run it.

**Problem:** Current sales agents in Weblease engine.ts require separate Anthropic API calls, can only generate text drafts, and cannot actually execute actions (post, email, interact). Claude Code already IS Claude — no need to pay twice.

**Solution:** An MCP server with tools for email, leads, content, channels, SMS, and analytics. Channels are pluggable — connect Facebook, Instagram, Reddit, SMS, forums, webhooks via config. A dashboard in `/chefen/sales` shows everything that happened.

## Architecture

```
Claude Code ←→ Sales MCP Server (local, Node.js)
                    ↓
              ┌─────┴─────┐
              │  SQLite DB  │  (local, portable)
              └─────┬─────┘
                    ↓
    ┌─────┬─────┬─────┬─────┬─────┬─────┐
    │Email│ SMS │Social│Forum│Webhook│Brain│  ← Channel Providers + Knowledge
    └─────┴─────┴─────┴─────┴─────┴─────┘
```

### Agent Brain — Shared Knowledge System

Agents learn from each other and from the products they sell. The "brain" is a knowledge base that grows over time:

1. **Product Crawler** — `learn_product` tool crawls a product's website/app, extracts features, pricing, USPs, FAQ, testimonials, and stores it as structured knowledge. Agents read this before selling.
2. **Shared Learnings** — when something works (email opened, lead converted, post got engagement), the outcome is logged with context. Agents query `get_learnings` to see what works for each product/channel.
3. **Cross-agent learning** — insights from one product help sell another. E.g., "personliga mail med namn i ämnesrad har 3x högre öppningsfrekvens" applies to all products.
4. **Auto-context** — when Claude uses `get_product_context`, it also gets the latest learnings and best-performing content for that product.

```
Knowledge Flow:
  Website/App → learn_product → knowledge table
  Campaign results → save_learning → learnings table
  Before action → get_product_context → product + knowledge + learnings
```

### Dashboard Architecture

The admin dashboard (`/chefen/sales`) on Weblease reads from the same SQLite database (synced or accessed via API endpoint on the MCP server). Shows:
- Activity timeline — everything that happened, chronologically
- Leads per product — status, sequence step, source
- Content drafts — pending approval, approved, posted
- Channel status — connected, last used, errors
- Email overview — sent, opened, clicked, bounced
- Stats — conversions, costs, performance per product
- GDPR — unsubscribe log, compliance status

## Project Structure

```
sales-mcp/
├── package.json
├── tsconfig.json
├── config.example.json        # Template — user copies to config.json
├── config.json                # User's config (gitignored)
├── src/
│   ├── index.ts               # MCP server entry point
│   ├── tools/
│   │   ├── email.ts           # read_emails, send_email, reply_email
│   │   ├── leads.ts           # get_leads, save_lead, update_lead, import_leads
│   │   ├── content.ts         # save_draft, get_drafts, approve_draft
│   │   ├── channels.ts        # list_channels, post_to_channel, read_channel
│   │   ├── products.ts        # list_products, get_product_context
│   │   ├── brain.ts           # learn_product, save_learning, get_learnings, crawl_url
│   │   ├── templates.ts       # get_templates, save_template, use_template
│   │   ├── sequences.ts       # get_sequences, create_sequence, advance_lead, pause_sequence, remove_from_sequence, get_due_leads
│   │   ├── stats.ts           # get_stats, log_activity
│   │   └── gdpr.ts            # check_consent, unsubscribe, export_data, delete_data
│   ├── providers/
│   │   ├── base.ts            # Base channel provider interface
│   │   ├── email-provider.ts  # IMAP + SMTP (imapflow + nodemailer)
│   │   ├── facebook.ts        # Graph API
│   │   ├── instagram.ts       # Graph API
│   │   ├── reddit.ts          # Reddit API
│   │   ├── sms.ts             # 46elks / Twilio (configurable)
│   │   ├── wordpress-forum.ts # bbPress / WP REST API
│   │   └── webhook.ts         # Generic webhook (POST to any URL)
│   ├── db/
│   │   ├── schema.sql         # SQLite schema
│   │   ├── sqlite.ts          # Database connection + helpers
│   │   └── migrations/        # Schema versioning
│   ├── tracking/
│   │   ├── pixel.ts           # Email open tracking (1x1 pixel server)
│   │   └── clicks.ts          # Link click tracking (redirect server)
│   ├── api/
│   │   └── dashboard.ts       # HTTP API for /chefen dashboard to read data
│   └── utils/
│       ├── crypto.ts          # AES-256-GCM for credentials
│       ├── rate-limiter.ts    # Per-channel rate limiting
│       └── i18n.ts            # Multi-language support
├── data/                      # Runtime data (gitignored)
│   └── sales.db               # SQLite database
└── README.md
```

## Database Schema (SQLite)

### products
```sql
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,          -- 'bokvyx', 'wpilot', etc.
  display_name TEXT NOT NULL,
  description TEXT,
  pitch TEXT,                         -- Short sales pitch
  features TEXT,                      -- JSON array of features
  pricing TEXT,                       -- JSON pricing info
  url TEXT,
  language TEXT DEFAULT 'sv',         -- Primary language
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### leads
```sql
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  company TEXT,
  phone TEXT,
  product_id INTEGER REFERENCES products(id),
  source TEXT DEFAULT 'manual',       -- 'manual', 'import', 'website', 'email', 'social'
  status TEXT DEFAULT 'new',          -- 'new', 'contacted', 'nurturing', 'converted', 'lost', 'unsubscribed'
  sequence_id INTEGER REFERENCES sequences(id),
  sequence_step INTEGER DEFAULT 0,
  last_contacted_at DATETIME,
  notes TEXT,
  tags TEXT,                          -- JSON array
  consent_given BOOLEAN DEFAULT 0,    -- GDPR
  consent_date DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(email, product_id)
);
```

### channels
```sql
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                 -- 'email', 'facebook', 'instagram', 'reddit', 'sms', 'webhook', 'wordpress_forum'
  name TEXT NOT NULL,                 -- Display name: 'Weblease Facebook Page'
  credentials TEXT,                   -- AES-256-GCM encrypted JSON
  config TEXT DEFAULT '{}',           -- JSON: rate limits, targets, etc.
  enabled BOOLEAN DEFAULT 1,
  last_used_at DATETIME,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### channel_products (many-to-many)
```sql
CREATE TABLE channel_products (
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, product_id)
);
```

### drafts
```sql
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  channel_id INTEGER REFERENCES channels(id),
  type TEXT NOT NULL,                 -- 'email', 'blog_post', 'forum_post', 'social_post', 'sms'
  title TEXT,
  content TEXT NOT NULL,
  recipient_email TEXT,
  status TEXT DEFAULT 'pending',      -- 'pending', 'approved', 'rejected', 'posted', 'sent'
  posted_at DATETIME,
  external_url TEXT,                  -- URL where it was posted
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### templates
```sql
CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,                 -- 'intro_email', 'followup_3day', etc.
  type TEXT NOT NULL,                 -- 'email', 'social', 'forum', 'sms'
  subject TEXT,                       -- Email subject template
  content TEXT NOT NULL,              -- Template with {{placeholders}}
  language TEXT DEFAULT 'sv',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, name)
);
```

### sequences
```sql
CREATE TABLE sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,                 -- 'cold_outreach', 'trial_nurture'
  description TEXT,
  steps TEXT NOT NULL,                -- JSON array: [{day: 0, template_id: 1, channel: 'email'}, {day: 3, ...}]
  enabled BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### activity_log
```sql
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  lead_id INTEGER,
  channel_id INTEGER,
  draft_id INTEGER,
  action TEXT NOT NULL,               -- 'email_sent', 'email_opened', 'link_clicked', 'post_published', 'lead_created', 'sms_sent', etc.
  details TEXT,                       -- JSON: extra context
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_activity_created ON activity_log(created_at);
CREATE INDEX idx_activity_product ON activity_log(product_id);
```

### email_tracking
```sql
CREATE TABLE email_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  draft_id INTEGER REFERENCES drafts(id),
  tracking_id TEXT UNIQUE NOT NULL,   -- UUID for pixel/link
  type TEXT NOT NULL,                 -- 'open', 'click'
  url TEXT,                           -- Original URL (for click tracking)
  triggered_at DATETIME,             -- When opened/clicked (NULL = not yet)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### gdpr_log
```sql
CREATE TABLE gdpr_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  action TEXT NOT NULL,               -- 'consent_given', 'unsubscribed', 'data_exported', 'data_deleted'
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### knowledge (Agent Brain)
```sql
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  type TEXT NOT NULL,                 -- 'page_content', 'faq', 'testimonial', 'feature', 'pricing', 'competitor', 'objection_response'
  title TEXT,
  content TEXT NOT NULL,
  source_url TEXT,                    -- Where it was crawled from
  language TEXT DEFAULT 'sv',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_knowledge_product ON knowledge(product_id);
CREATE INDEX idx_knowledge_type ON knowledge(type);
```

### learnings (Cross-Agent Learning)
```sql
CREATE TABLE learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  channel_type TEXT,                  -- 'email', 'facebook', 'sms', etc. NULL = universal
  category TEXT NOT NULL,             -- 'subject_line', 'content_style', 'timing', 'audience', 'objection', 'cta'
  insight TEXT NOT NULL,              -- "Personliga ämnesrader med namn → 3x öppningsfrekvens"
  evidence TEXT,                      -- JSON: {opens: 45, sample_size: 100, draft_ids: [1,2,3]}
  confidence REAL DEFAULT 0.5,        -- 0.0-1.0, increases with more evidence
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_learnings_product ON learnings(product_id);
CREATE INDEX idx_learnings_category ON learnings(category);
```

### Database Initialization
```sql
-- Required pragmas (run on every connection)
PRAGMA journal_mode=WAL;              -- Concurrent reads during writes
PRAGMA foreign_keys=ON;               -- Enforce referential integrity
PRAGMA busy_timeout=5000;             -- Wait 5s on lock instead of failing
```

### Data Retention
```sql
-- Configurable in config.json: retention_days (default: 365)
-- Cleanup runs on MCP server start and daily:
-- DELETE FROM activity_log WHERE created_at < date('now', '-N days');
-- DELETE FROM email_tracking WHERE created_at < date('now', '-N days') AND triggered_at IS NOT NULL;
```

## MCP Tools — Detailed

### Email Tools

**`read_emails`**
- Params: `folder` (inbox/sent), `limit`, `unread_only`, `search_query`
- Returns: array of {id, from, to, subject, body, date, read}
- Provider: IMAP via imapflow (993/SSL)

**`send_email`**
- Params: `to`, `subject`, `body`, `product` (for context), `track_opens`, `track_clicks`, `lead_id`
- Auto-adds unsubscribe header + link (GDPR)
- Auto-inserts tracking pixel if track_opens=true
- Auto-rewrites links for click tracking if track_clicks=true
- Checks rate limit before sending
- Logs to activity_log
- Provider: SMTP via nodemailer (587/STARTTLS)

**`reply_email`**
- Params: `message_id`, `body`, `lead_id`
- Preserves thread (In-Reply-To header)

### Lead Tools

**`get_leads`**
- Params: `product`, `status`, `source`, `limit`, `search`
- Returns: array of leads with sequence info

**`save_lead`**
- Params: `email`, `name`, `company`, `phone`, `product`, `source`, `tags`, `consent`
- Validates GDPR consent flag
- Deduplicates on email+product

**`update_lead`**
- Params: `id` or `email+product`, `status`, `notes`, `tags`

**`delete_lead`**
- Params: `id` or `email+product`
- Removes lead and all associated data (activity_log, email_tracking)
- Logs deletion to gdpr_log

**`import_leads`**
- Params: `csv_path` or `data` (array), `product`, `source`
- Bulk import with deduplication

### Content Tools

**`save_draft`**
- Params: `product`, `channel`, `type`, `title`, `content`, `recipient_email`
- Saves to drafts table with status=pending

**`get_drafts`**
- Params: `product`, `status`, `type`, `limit`

**`approve_draft`**
- Params: `id`, `action` ('approve'|'reject')
- When approved, status changes to 'approved'

**`post_draft`**
- Params: `id`
- Takes an approved draft and posts it via its assigned channel
- Updates status to 'posted', sets posted_at and external_url
- Logs to activity_log
- Records outcome in learnings (for brain to learn from)

### Channel Tools

**`list_channels`**
- Returns: all configured channels with status

**`post_to_channel`**
- Params: `channel_id` or `channel_name`, `content`, `title`, `product`
- Routes to correct provider
- Checks rate limit
- Logs to activity_log

**`read_channel`**
- Params: `channel_id`, `limit`
- Reads recent posts/messages/comments from channel

### Product Tools

**`list_products`**
- Returns: all products with summary

**`get_product_context`**
- Params: `product`
- Returns: full context (description, features, pricing, pitch, URL) + crawled knowledge + top learnings — everything Claude needs to sell it smartly

### Template Tools

**`get_templates`**
- Params: `product`, `type`

**`save_template`**
- Params: `product`, `name`, `type`, `subject`, `content`, `language`

**`use_template`**
- Params: `template_id`, `variables` (object to fill {{placeholders}})
- Returns: rendered content

### Sequence Tools

**`get_sequences`**
- Params: `product`

**`create_sequence`**
- Params: `product`, `name`, `steps` (array of {day, template_name, channel})

**`advance_lead`**
- Params: `lead_id`
- Sends next step in sequence, updates lead.sequence_step
- Checks timing (respects day delays)

**`pause_sequence`**
- Params: `lead_id`, `reason`
- Pauses the sequence for a lead (e.g., they replied, asked to wait)
- Lead stays in current step but won't advance

**`remove_from_sequence`**
- Params: `lead_id`
- Removes lead from sequence entirely (e.g., converted, or said stop)

**`get_due_leads`**
- Params: `product` (optional filter)
- Returns: leads whose next sequence step is due today

### Stats Tools

**`get_stats`**
- Params: `product` (optional), `period` ('today'|'week'|'month'|'all')
- Returns: emails sent, opened, clicked, leads created, converted, posts published, SMS sent

**`log_activity`**
- Params: `product`, `action`, `details`, `lead_id`, `channel_id`

### GDPR Tools

**`check_consent`**
- Params: `email`
- Returns: consent status, can we contact this person

**`unsubscribe`**
- Params: `email`, `reason`
- Marks all leads as unsubscribed, logs to gdpr_log

**`export_data`**
- Params: `email`
- Returns: all data we have on this person (GDPR right of access)

**`delete_data`**
- Params: `email`
- Purges ALL data for this email across all tables (leads, drafts, activity_log, email_tracking)
- Logs the deletion to gdpr_log (which is the only record kept)
- GDPR Article 17 — right to erasure

### Brain Tools (Agent Learning)

**`learn_product`**
- Params: `product`, `url` (website to crawl)
- Crawls the URL (and optionally linked pages: max 10)
- Extracts: features, pricing, FAQ, testimonials, USPs, competitors mentioned
- Stores structured knowledge in the knowledge table
- Should be run once per product + whenever the site changes

**`crawl_url`**
- Params: `url`
- Fetches a single page and returns its content (text extracted from HTML)
- For manual knowledge gathering

**`save_learning`**
- Params: `product`, `channel_type`, `category`, `insight`, `evidence`
- Saves a learning/insight to the learnings table
- Categories: 'subject_line', 'content_style', 'timing', 'audience', 'objection', 'cta', 'general'
- Called automatically after campaigns or manually by Claude

**`get_learnings`**
- Params: `product` (optional), `channel_type` (optional), `category` (optional), `min_confidence` (default 0.3)
- Returns relevant learnings sorted by confidence
- Universal learnings (product=NULL) always included

**`get_knowledge`**
- Params: `product`, `type` (optional: 'faq', 'feature', 'testimonial', 'pricing', etc.)
- Returns crawled knowledge for a product

### GDPR Legal Basis

For B2B cold outreach (e.g., contacting food truck businesses):
- Legal basis: **Legitimate interest** (GDPR Article 6(1)(f))
- Must include unsubscribe in every message
- Must honor opt-outs immediately

For B2C / website signups:
- Legal basis: **Consent** (GDPR Article 6(1)(a))
- `consent_given` must be TRUE before any contact
- Double opt-in recommended for website leads

The `save_lead` tool enforces:
- B2B source ('manual', 'import', 'research'): consent flag optional, legitimate interest applies
- B2C source ('website', 'social'): consent flag REQUIRED, rejected if missing

## Rate Limiting

Per-channel configurable limits stored in `channels.config`:
```json
{
  "rate_limit": {
    "max_per_hour": 20,
    "max_per_day": 100,
    "min_interval_seconds": 30
  }
}
```

Default limits:
- Email: 50/hour, 200/day
- SMS: 10/hour, 50/day
- Social media: 5/hour, 20/day
- Forum: 3/hour, 10/day

## Email Tracking

### Open Tracking
- Each sent email gets a unique tracking_id
- A 1x1 transparent pixel is inserted: `<img src="https://weblease.se/api/sales/track/{tracking_id}/open">`
- When loaded, records the open in email_tracking

### Click Tracking
- Links in emails are rewritten: `https://weblease.se/api/sales/track/{tracking_id}/click?url={original_url}`
- When clicked, records the click and redirects to original URL

### Tracking API & Data Flow
- Tracking endpoints hosted on Weblease server as Next.js API routes
- MCP server generates tracking IDs and stores them in local SQLite
- When a pixel/link is hit on Weblease, the API route calls back to the MCP dashboard API (`http://pi-ip:3200/api/tracking/event`) with the tracking_id and event type
- The MCP server updates its local SQLite with the event
- If MCP server is unreachable, Weblease queues the event and retries (simple retry queue in a `tracking_queue` table on Weblease MySQL)
- This keeps all data in one place (Pi SQLite) while tracking works via Weblease server

## GDPR Compliance

1. **Unsubscribe link** — every outgoing email includes `List-Unsubscribe` header + footer link
2. **Unsubscribe endpoint** — `https://weblease.se/api/sales/unsubscribe/{email_hash}`
3. **Consent tracking** — leads.consent_given + consent_date
4. **Pre-send check** — send_email tool checks consent + unsubscribe status before sending
5. **Data export** — export_data tool returns all stored data for a person
6. **Data deletion** — can purge all data for an email
7. **Audit log** — gdpr_log tracks all consent/unsubscribe/export/delete events

## Dashboard (`/chefen/sales`)

### Tabs

1. **Activity** — real-time feed of everything: emails sent, posts published, leads created, opens, clicks
2. **Leads** — table with filters (product, status, source), bulk actions, import CSV
3. **Drafts** — pending approval queue, approve/reject, preview, post
4. **Channels** — connection manager, add/edit/test channels, OAuth flows
5. **Sequences** — view/edit email sequences per product, pause/resume leads
6. **Templates** — manage reusable templates per product/language
7. **Products** — manage product info (name, pitch, features, pricing, URL)
8. **Brain** — view crawled knowledge per product, learnings/insights with confidence scores, trigger re-crawl, manually add knowledge
9. **Analytics** — charts: emails sent vs opened vs clicked, leads funnel, channel performance, per-product breakdown, learning trends
10. **GDPR** — unsubscribe log, consent overview, data requests, data deletion

### Dashboard Data Source

Option A: MCP server exposes a lightweight HTTP API (`/api/dashboard/*`) that the Weblease frontend fetches.
Option B: SQLite DB is synced/copied to Weblease server periodically.

**Recommendation:** Option A — MCP server runs a small Express/Hono API alongside the MCP protocol. Dashboard pages in `/chefen` fetch from `http://pi-ip:3200/api/dashboard/*`. Secured with admin key.

## Multi-Language

- Products have a `language` field
- Templates have a `language` field
- When Claude uses `get_product_context`, it gets the language and writes in that language
- Default: Swedish (sv)
- Supported: sv, en (extensible)

## Config File

```json
{
  "email": {
    "imap": {
      "host": "mailcluster.loopia.se",
      "port": 993,
      "tls": true
    },
    "smtp": {
      "host": "mailcluster.loopia.se",
      "port": 587,
      "secure": false
    },
    "user": "info@weblease.se",
    "pass": "..."
  },
  "database": {
    "path": "./data/sales.db"
  },
  "tracking": {
    "base_url": "https://weblease.se/api/sales/track",
    "unsubscribe_url": "https://weblease.se/api/sales/unsubscribe"
  },
  "dashboard_api": {
    "port": 3200,
    "admin_key": "..."
  },
  "default_language": "sv",
  "retention_days": 365
}
```

**Note:** `encryption_key` is loaded from the `SALES_MCP_ENCRYPTION_KEY` environment variable (not stored in config.json). Set it in your shell profile or Claude Code env config.
```

## Tech Stack

- **Runtime:** Node.js 22 + TypeScript
- **MCP:** @modelcontextprotocol/sdk
- **Email:** imapflow (IMAP) + nodemailer (SMTP)
- **Database:** better-sqlite3
- **HTTP API:** Hono (lightweight, for dashboard)
- **Crypto:** Node.js crypto (AES-256-GCM)
- **Build:** tsup (fast, simple bundler)

## Security

- Channel credentials encrypted at rest (AES-256-GCM)
- Encryption key in environment variable, NOT in config file
- Dashboard API: HTTPS recommended, CORS restricted to Weblease domain, admin key required
- Config file gitignored (only config.example.json in repo)
- Rate limiting prevents spam/abuse
- GDPR compliance built-in with legal basis enforcement
- No secrets in MCP tool responses (credentials masked)
- SQLite in WAL mode with foreign keys enforced

## Deployment

1. Clone repo to `~/claude/sales-mcp/`
2. `npm install`
3. Copy `config.example.json` → `config.json`, fill in credentials
4. `npm run build`
5. Add to Claude Code MCP config:
   ```json
   {
     "mcpServers": {
       "sales": {
         "command": "node",
         "args": ["/home/user/claude/sales-mcp/dist/index.js"]
       }
     }
   }
   ```
6. Add tracking API routes to Weblease server
7. Add dashboard pages to `/chefen`

## Future (v2+)

- AI auto-scheduling: Claude suggests optimal send times
- A/B testing: test different subject lines/content
- Webhook triggers: auto-run sequences on events
- Multi-user: team access with roles
- GitHub distribution: `npx create-sales-mcp` scaffolding
