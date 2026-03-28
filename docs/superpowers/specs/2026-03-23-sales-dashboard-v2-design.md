# Sales Dashboard v2 — Full Sales App

## Overview
Upgrade the Sales MCP dashboard from a read-only single-page React embed to a full Next.js admin app. Each product (Bokvyx, WPilot, etc.) is treated as an independent app with its own channels, leads, emails, and AI agent recommendations.

## Architecture

```
Pi (~/claude/sales-dashboard/)     Weblease Server
├── Next.js 15 app (port 3200)  ←→  nginx proxy (/chefen/sales)
├── Reads from same SQLite DB
│   as MCP tools write to
└── Calls Hono API (port 3210)
    for all data operations
```

- **Frontend**: Next.js 15 + Tailwind CSS, dark theme (#030507/#080B12, accent #4F7EFF)
- **Backend**: Existing Hono API on port 3210 (extended with write endpoints)
- **DB**: Same SQLite at ~/claude/sales-mcp/data/sales.db
- **Auth**: Admin key only (single user)
- **Proxy**: nginx on weblease.se proxies /chefen/sales → Pi:3200

## Pages

### 1. Overview (`/`)
- KPI cards: total leads, emails sent, open rate, conversions, active sequences
- Period toggle: today / week / month / all
- Recent activity timeline (last 20)
- **Agent Recommendations** panel: AI-generated action items from `recommendations` table
  - Each card: agent role icon, priority badge, title, description, action button
  - Actions: "Send follow-up", "Push upgrade", "Review draft"
  - Dismiss or accept (updates status in DB)

### 2. Apps (`/apps`)
- Grid of product cards (Bokvyx, WPilot, etc.)
- Click → per-app detail page (`/apps/[name]`)
- Per-app page shows: connected channels, leads pipeline, recent emails, stats
- Add new app button (creates product)

### 3. Emails (`/emails`)
- Table: date, from/to, subject, product, status (sent/opened/clicked/replied)
- Filter by product, status, date range
- Click row → expand to see full email body
- Compose button → send email modal (pick product, template, recipient)

### 4. Leads (`/leads`)
- Pipeline view: columns for new → contacted → nurturing → converted → lost
- Drag & drop to change status (nice-to-have, start with table view)
- Filters: product, status, source, search
- Click lead → detail panel: notes, email history, sequence status

### 5. Content (`/content`)
- Tabs: Drafts | Templates | Sequences
- Drafts: card grid, approve/reject buttons, edit content
- Templates: table with edit modal, {{variable}} preview
- Sequences: expandable list with step visualization

### 6. Brain (`/brain`)
- Knowledge base: crawled pages per product
- Learnings: confidence bars, category tags
- Filter by product
- "Crawl URL" button (calls crawl_url API)

### 7. Channels (`/channels`)
- **The key new feature**: connect platforms per product
- Grid of connected channels with status indicators
- **"Add Channel" flow**:
  1. Pick type (Email, SMS, Facebook, Instagram, Reddit, WordPress Forum, Webhook)
  2. Dynamic form based on type:
     - **Email**: IMAP host, port, SMTP host, port, user, pass
     - **SMS (46elks)**: API key, API secret, from number
     - **SMS (Twilio)**: Account SID, Auth token, from number
     - **Facebook**: Page ID, Access token
     - **Instagram**: IG User ID, Access token
     - **Reddit**: Client ID, Client secret, Refresh token, Username, Subreddit
     - **WordPress Forum**: Site URL, Username, App password, Forum ID
     - **Webhook**: URL, custom headers
  3. Pick which products to connect it to
  4. Test connection button
  5. Save (credentials encrypted via API)
- Edit / disable / delete existing channels

## New Database Table

```sql
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  agent_role TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  action_type TEXT,
  action_data TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
```

## New Hono API Endpoints (write operations)

```
POST /api/dashboard/channels          — Create channel (with encrypted creds)
PUT  /api/dashboard/channels/:id      — Update channel
DELETE /api/dashboard/channels/:id    — Delete channel
POST /api/dashboard/channels/:id/test — Test channel connection

POST /api/dashboard/products          — Create product
PUT  /api/dashboard/products/:id      — Update product

POST /api/dashboard/leads             — Create lead
PUT  /api/dashboard/leads/:id         — Update lead status/notes

POST /api/dashboard/drafts/:id/approve — Approve draft
POST /api/dashboard/drafts/:id/reject  — Reject draft

POST /api/dashboard/emails/send       — Send email via channel
GET  /api/dashboard/emails            — List sent/received emails

GET  /api/dashboard/recommendations   — Get pending recommendations
POST /api/dashboard/recommendations/:id/accept  — Accept
POST /api/dashboard/recommendations/:id/dismiss — Dismiss

POST /api/dashboard/brain/crawl       — Crawl a URL
```

## Tech Stack
- Next.js 15 (App Router)
- Tailwind CSS 4
- No additional UI library (pure Tailwind components)
- fetch() to Hono API (same-machine, port 3210)

## File Structure
```
~/claude/sales-dashboard/
├── package.json
├── next.config.ts
├── tailwind.config.ts
├── src/
│   ├── app/
│   │   ├── layout.tsx          (dark theme, nav sidebar)
│   │   ├── page.tsx            (overview/dashboard)
│   │   ├── apps/
│   │   │   ├── page.tsx        (product grid)
│   │   │   └── [name]/page.tsx (per-app detail)
│   │   ├── emails/page.tsx
│   │   ├── leads/page.tsx
│   │   ├── content/page.tsx
│   │   ├── brain/page.tsx
│   │   └── channels/page.tsx
│   ├── components/
│   │   ├── nav.tsx             (sidebar navigation)
│   │   ├── kpi-card.tsx
│   │   ├── activity-feed.tsx
│   │   ├── recommendations.tsx
│   │   ├── channel-form.tsx    (dynamic form per channel type)
│   │   ├── lead-table.tsx
│   │   ├── email-table.tsx
│   │   ├── draft-card.tsx
│   │   └── modal.tsx
│   └── lib/
│       ├── api.ts              (fetch wrapper with admin key)
│       └── types.ts            (shared TypeScript types)
```

## Deployment
1. Build Next.js app on Pi
2. Run via systemd service (port 3200)
3. nginx proxy on Weblease: /chefen/sales → Pi:3200 via Tailscale
4. Admin key stored in sessionStorage (same as current)
