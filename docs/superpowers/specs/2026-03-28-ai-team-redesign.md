# AI Team Platform — Complete Redesign Spec

**Date:** 2026-03-28
**Status:** Draft
**Authors:** Christos Ferlachidis, Claude

## Vision

Ett komplett AI-företagsteam som lär sig allt om varje produkt/projekt det tilldelas, jobbar autonomt, samarbetar internt, och levererar resultat — medan de riktiga människorna (Christos & Daniel) behåller kontrollen och stänger deals.

Först byggt för våra egna projekt (Bokvyx, WPilot). Förberett för att säljas som produkt till andra företag.

## Core Principles

1. **Agenterna jobbar ÅT er** — de representerar aldrig sig som människor
2. **Trust levels** — autonomi ökar gradvis baserat på bevisad kvalitet
3. **Alla lär sig** — varje agent lär sig av resultat och delar kunskap med teamet
4. **Rätt agenter pratar** — smart routing, inte alla svarar varje gång
5. **Produktkunskap först** — agenterna måste kunna sin produkt innan de agerar

---

## Team Structure

### Leadership (riktiga människor)

| Person | Roll | Ansvar |
|--------|------|--------|
| Christos | CEO / Tech | Slutgiltiga beslut, tech, arkitektur |
| Daniel | Co-founder | Affärsutveckling, partnerskap |

Agenterna kan boka möten åt er, förbereda underlag, och följa upp efter möten. De stänger INTE deals och lovar INTE priser.

### AI Teams (18 agenter, 7 avdelningar)

#### Executive (strategiskt ledarskap)

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **COO** | Daglig drift | Strukturerad, effektiv, ser helheten. Koordinerar mellan team. Eskalerar till Christos/Daniel när beslut krävs. | Veckorapporter, resursallokering, flaskhalsar |
| **CFO** | Ekonomi | Analytisk, försiktig, datadriven. Räknar på allt. Varnar för kostnader. | Budget-tracking, intäktsrapporter, ROI-analys |
| **CTO** | Tech-strategi | Djupt teknisk, pragmatisk. Vet vad som är möjligt och vad som är overkill. | Tech-audits, arkitekturbeslut, tech debt-bevakning |

#### Sales (hitta och värma leads)

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **Scout** | Research | Nyfiken, grundlig, hittar alltid en till källa. Researchar marknader och konkurrenter. | Lead-research, marknadsanalys, konkurrentbevakning |
| **Outreach** | Kontakt | Personlig, aldrig pushy, anpassar ton efter mottagare. Skriver mail som känns mänskliga. | Intro-mail, follow-ups, sekvenser |
| **Closer** | Avslut-prep | Strategisk, förberedd, tänker på invändningar i förväg. Förbereder allt ÅT Christos/Daniel. | Kundresearch, prisförslag, mötesunderlag, bokar möten |

#### Marketing (bygga varumärke och trafik)

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **Content** | Innehåll | Kreativ, anpassar stil per kanal. Skriver bloggar, nyhetsbrev, sociala inlägg. | Content-drafts, nyhetsbrev, sociala inlägg |
| **SEO** | Sökmotorer | Teknisk och kreativ. Keyword-research, ranking-analys, on-page optimering. | Keyword-rapporter, meta-optimering, content-briefs |
| **Brand** | Varumärke | Konsekvent, medveten om ton och visuell identitet. Vaktar brand guidelines. | Brand audits, ton-guide per produkt, design feedback |
| **Strategist** | Kampanjer | Analytisk, ser mönster, planerar långsiktigt. A/B-tänk i allt. | Kampanjplanering, KPI-analys, A/B-testning |

#### Design (visuellt och UX)

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **UI Designer** | Layout & UX | Användarvänlig, clean, modern. Tänker mobile-first. | Wireframes, UX-review, layout-förslag |
| **Visual** | Grafik | Estetisk, brand-medveten. Skapar grafik, presentationer, social media-bilder. | Grafik-drafts, presentationer |

#### Development (bygga och drifta)

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **Backend** | API & DB | Grundlig, prestandamedveten, säkerhetstänk. | Kodgranskning, arkitekturförslag, performance-analys |
| **Frontend** | UI-kod | Pixel-perfect, accessibility-medveten, komponenttänk. | Komponentförslag, responsive-review |
| **DevOps** | Infra | Automation-fokuserad, monitoring-first. | Deploy-review, monitoring-alerts, infra-optimering |

#### Security

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **SecOps** | Säkerhet | Paranoid (på rätt sätt), GDPR-expert, har veto-rätt. Blockerar osäkra actions. | Säkerhetsaudits, GDPR-check, consent-validering |

#### Customer Success

| Agent | Roll | Personlighet | Autonoma uppgifter |
|-------|------|-------------|-------------------|
| **Support** | Kundservice | Empatisk, tålmodig, lösningsorienterad. Samlar FAQ-data. | Svarsförslag på inkommande mail, FAQ-uppdatering |
| **Keeper** | Retention | Proaktiv, uppmärksam på signaler. Identifierar churn-risk och upsell. | Churn-analys, review-requests, upsell-förslag |

---

## Agent Architecture

### System Prompt Structure

Varje agent har en djup system prompt som byggs dynamiskt:

```
┌─────────────────────────────────────┐
│  1. Identitet & personlighet        │  (statisk per agent)
│     - Namn, roll, team              │
│     - Personlighetsdrag             │
│     - Kommunikationsstil            │
│     - Vad du FÅR göra               │
│     - Vad du INTE får göra          │
├─────────────────────────────────────┤
│  2. Produktkunskap                  │  (dynamisk per produkt)
│     - Beskrivning, features, pris   │
│     - Crawlad webbinnehåll          │
│     - Konkurrentanalys              │
│     - Målgrupp & språk              │
├─────────────────────────────────────┤
│  3. Agent-specifik kunskap          │  (dynamisk)
│     - Learnings från denna agent    │
│     - Feedback från användaren      │
│     - Senaste actions & resultat    │
├─────────────────────────────────────┤
│  4. Team-delad kunskap              │  (dynamisk)
│     - Viktiga learnings från andra  │
│     - Pågående kampanjer/projekt    │
│     - Aktiva sekvenser              │
├─────────────────────────────────────┤
│  5. Aktuell kontext                 │  (per anrop)
│     - Leads (relevanta)             │
│     - Senaste aktivitet             │
│     - Action queue status           │
│     - Uppgift att utföra            │
└─────────────────────────────────────┘
```

### Meeting Room (multi-agent diskussion)

**Ett Claude-anrop** med alla närvarande agenters profiler. Smart routing väljer agenter:

```
Användarmeddelande
       │
       ▼
┌──────────────┐
│ Topic Router  │ — analyserar meddelandet
│ (keyword +    │ — matchar mot team/agent-fokus
│  intent)      │ — väljer 2-5 relevanta agenter
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Single Claude │ — alla valda agenters profiler
│ Call (Sonnet) │ — produktkontext + learnings
│              │ — konversationshistorik
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Response      │ — parsar svar per agent
│ Parser        │ — utför actions
│              │ — sparar till discussions DB
└──────────────┘
```

**Topic Router — regelbaserad + keyword matching:**

```typescript
const TEAM_KEYWORDS = {
  sales:     ['lead', 'kund', 'prospect', 'outreach', 'kontakt', 'deal', 'avslut'],
  marketing: ['content', 'blogg', 'SEO', 'kampanj', 'varumärke', 'social media', 'nyhetsbrev'],
  design:    ['design', 'layout', 'UX', 'wireframe', 'grafik', 'färg', 'font', 'UI'],
  dev:       ['kod', 'API', 'databas', 'deploy', 'bugg', 'performance', 'server'],
  security:  ['säkerhet', 'GDPR', 'audit', 'sårbarhet', 'consent', 'kryptering'],
  customer:  ['support', 'klagomål', 'churn', 'nöjd', 'recension', 'retention'],
  executive: ['budget', 'strategi', 'Q1', 'Q2', 'rapport', 'prioritering', 'roadmap'],
}
```

Om inget team matchar → COO + Strategist (generell routing).
Om frågan berör flera team → 1 agent per relevant team.

### Autonomous Jobs (cron-drivna)

```
┌─────────────────────────────────────────────┐
│              CRON SCHEDULE                   │
├─────────────────────────────────────────────┤
│                                             │
│  Var 6:e timme:                             │
│  ├── Scout: researchar nya leads            │
│  ├── Outreach: kollar sekvenser, skriver    │
│  │   follow-up drafts                       │
│  ├── Support: läser inbox, kategoriserar    │
│  └── SEO: kollar ranking-förändringar       │
│                                             │
│  Var 24:e timme:                            │
│  ├── COO: daglig sammanfattning till er     │
│  ├── Strategist: KPI-update                 │
│  ├── Keeper: churn-analys                   │
│  ├── Content: föreslår nytt content         │
│  └── SecOps: säkerhetscheck                 │
│                                             │
│  Var vecka:                                 │
│  ├── CFO: veckorapport ekonomi              │
│  ├── CTO: tech debt review                  │
│  ├── Brand: brand consistency audit         │
│  └── COO: veckomöte-sammanfattning          │
│                                             │
└─────────────────────────────────────────────┘
```

Varje autonomt jobb:
1. Agent körs med sitt eget system prompt + produktkontext
2. Resultat → Action Queue (trust level 1) eller direkt utförande (trust level 2-3)
3. Learnings sparas automatiskt

---

## Action Queue & Trust Levels

### Action Queue

Allt agenterna vill GÖRA hamnar i en kö:

```typescript
interface QueuedAction {
  id: number
  agent_role: string
  agent_name: string
  product_id: number
  action_type: string        // 'send_email', 'create_lead', 'post_content', 'book_meeting', etc.
  action_data: object        // all details needed to execute
  priority: 'low' | 'medium' | 'high' | 'urgent'
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'
  requires_approval: boolean // based on trust level
  created_at: string
  approved_by: string | null // 'christos', 'daniel', or 'auto'
  executed_at: string | null
  result: object | null
  feedback: string | null    // user feedback on rejection
}
```

### Trust Levels (per agent, per produkt)

```
Level 1 — REVIEW (default)
├── ALLT kräver godkännande
├── Drafts visas i Action Queue
└── Ni godkänner/redigerar/avvisar

Level 2 — SEMI-AUTO
├── Standard-sekvenser körs automatiskt
├── Follow-ups på befintliga leads = auto
├── NYA kontakter kräver godkännande
└── Nya kampanjer kräver godkännande

Level 3 — AUTONOMOUS
├── Full autonomi inom ramar
├── Daglig sammanfattning istället för godkännande
├── Bara stora beslut eskaleras
└── Budget-cap fortfarande aktivt
```

Trust level höjs manuellt av er i dashboarden.

---

## Learning System

### Hur agenterna lär sig

```
┌─────────────────────────────────────────┐
│           LEARNING LOOP                  │
│                                         │
│  1. Agent utför action                  │
│  2. Resultat mäts:                      │
│     - Email: öppnad? klickad? svarad?   │
│     - Lead: konverterad? churnad?       │
│     - Content: trafik? engagement?      │
│  3. Learning sparas:                    │
│     - Vad gjordes                       │
│     - Resultat                          │
│     - Confidence score                  │
│  4. Nästa gång: agenten har tillgång    │
│     till sina learnings i system prompt  │
└─────────────────────────────────────────┘
```

### Feedback-loop (user → agent)

```
Ni avvisar draft i Action Queue
       │
       ▼
System frågar: "Varför?" (valfritt)
       │
       ▼
"Tonen var för formell"
       │
       ▼
Learning sparas: {
  agent: "outreach",
  product: "bokvyx",
  category: "content_style",
  insight: "Bokvyx-mail ska vara personliga och informella, inte formella",
  confidence: 0.7,
  source: "user_feedback"
}
       │
       ▼
Nästa draft: Outreach har detta i sin prompt
```

### Cross-agent learning

```
Scout hittar: "WordPress-byråer i Tyskland svarar bäst på engelska"
       │
       ▼
Learning sparas med product_id + category
       │
       ▼
Outreach ser detta automatiskt nästa gång den skriver
mail till tyska WordPress-byråer
       │
       ▼
Content ser det och skriver blogginlägg på engelska
för WPilot, inte tyska
```

### Learning DB Schema (utökad)

```sql
CREATE TABLE learnings (
  id INTEGER PRIMARY KEY,
  agent_role TEXT,           -- vilken agent lärde sig detta
  product_id INTEGER,        -- för vilken produkt (NULL = universell)
  category TEXT,             -- subject_line, content_style, timing, audience, objection, etc.
  insight TEXT,              -- själva insikten
  evidence TEXT,             -- stödjande data (JSON)
  confidence REAL DEFAULT 0.5, -- 0.0-1.0, ökar med bekräftelse
  source TEXT,               -- 'user_feedback', 'email_tracking', 'conversion', 'agent_observation'
  shared_with TEXT,          -- JSON array av agent_roles som fått denna learning
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Product Onboarding

När en ny produkt läggs till:

```
1. Crawl & Learn
   ├── Crawla hemsida (alla sidor, max 50)
   ├── Extrahera: features, pricing, USP, FAQ
   ├── Spara allt i knowledge base
   │
2. Analys (varje agent analyserar från sin vinkel)
   ├── Scout: konkurrentanalys, marknadsstorlek
   ├── SEO: nuvarande ranking, keyword-gaps
   ├── Brand: ton, visuell identitet, målgrupp
   ├── Strategist: SWOT-analys
   ├── CTO: tech stack-bedömning
   └── SecOps: GDPR-compliance check
   │
3. Onboarding Report
   ├── Sammanfattning till er
   ├── Förslag på första kampanj
   ├── Identifierade quick wins
   └── Rekommenderad prioritering
   │
4. Team Ready
   ├── Alla agenter har produktkunskap
   ├── Templates skapade (mail, content)
   └── Sekvenser föreslagna
```

---

## Intern Kommunikation (agent-till-agent)

### Task System

Agenter kan ge varandra uppgifter:

```sql
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY,
  from_agent TEXT,        -- vem skapade uppgiften
  to_agent TEXT,          -- vem ska utföra
  product_id INTEGER,
  title TEXT,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',  -- pending, in_progress, completed, blocked
  due_at DATETIME,
  completed_at DATETIME,
  result TEXT,            -- vad agenten levererade
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Exempel:
- Support → Content: "Vi får samma fråga om WPilot-pricing 5 gånger/vecka. Skriv FAQ-blogginlägg."
- Scout → Outreach: "12 nya byråer i Berlin. Starta outreach-sekvens."
- SecOps → Backend: "SQL injection risk i lead-import. Fixa."
- COO → Alla: "Q2-fokus: Bokvyx expansion till Norge. Anpassa allt."

### Escalation Chain

```
Agent fastnar / osäker
       │
       ▼
Frågar team-lead (COO för cross-team)
       │
       ▼
COO kan inte lösa
       │
       ▼
Eskalerar till Christos/Daniel
       │
       ▼
Notification i dashboard + valfritt Telegram
```

---

## Database Schema (ny/utökad)

### Nya tabeller

```sql
-- Action Queue
CREATE TABLE action_queue (
  id INTEGER PRIMARY KEY,
  agent_role TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  product_id INTEGER,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL,       -- JSON
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  requires_approval INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_by TEXT,
  approved_at DATETIME,
  executed_at DATETIME,
  result TEXT,                     -- JSON
  feedback TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Agent Tasks (inter-agent)
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  product_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  due_at DATETIME,
  completed_at DATETIME,
  result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Trust Levels (per agent per product)
CREATE TABLE trust_levels (
  id INTEGER PRIMARY KEY,
  agent_role TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  level INTEGER DEFAULT 1,       -- 1, 2, or 3
  changed_by TEXT NOT NULL,      -- 'christos' or 'daniel'
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  UNIQUE(agent_role, product_id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Agent Profiles (utökad från nuvarande agents)
CREATE TABLE agent_profiles (
  id INTEGER PRIMARY KEY,
  role TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  team TEXT NOT NULL,             -- 'executive', 'sales', 'marketing', 'design', 'dev', 'security', 'customer'
  avatar TEXT,
  personality TEXT NOT NULL,      -- kort personlighetsbeskrivning
  system_prompt TEXT NOT NULL,    -- full system prompt template
  capabilities TEXT NOT NULL,     -- JSON array av action_types denna agent kan utföra
  focus_keywords TEXT,            -- JSON array för topic routing
  status TEXT DEFAULT 'active',
  last_action TEXT,
  last_action_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Onboarding Reports
CREATE TABLE onboarding_reports (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL,
  agent_role TEXT NOT NULL,
  report_type TEXT NOT NULL,     -- 'competitor', 'seo', 'brand', 'swot', 'tech', 'security'
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Daily Reports
CREATE TABLE daily_reports (
  id INTEGER PRIMARY KEY,
  product_id INTEGER,            -- NULL = global
  report_type TEXT NOT NULL,     -- 'daily_summary', 'weekly_report', 'kpi_update'
  agent_role TEXT NOT NULL,      -- vem skrev rapporten
  content TEXT NOT NULL,
  period_start DATETIME,
  period_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);
```

### Utökade befintliga tabeller

```sql
-- learnings: lägg till agent_role, source, shared_with
ALTER TABLE learnings ADD COLUMN agent_role TEXT;
ALTER TABLE learnings ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE learnings ADD COLUMN shared_with TEXT; -- JSON

-- discussions: lägg till team-tagg
ALTER TABLE discussions ADD COLUMN team TEXT;

-- products: lägg till onboarding-status
ALTER TABLE products ADD COLUMN onboarding_status TEXT DEFAULT 'pending';
ALTER TABLE products ADD COLUMN target_market TEXT;
ALTER TABLE products ADD COLUMN target_language TEXT DEFAULT 'sv';
ALTER TABLE products ADD COLUMN brand_voice TEXT;
```

---

## API Endpoints (nya)

### Action Queue
```
GET    /api/dashboard/actions                  — lista actions (filter: status, agent, product)
POST   /api/dashboard/actions/:id/approve      — godkänn action
POST   /api/dashboard/actions/:id/reject       — avvisa med feedback
POST   /api/dashboard/actions/:id/execute      — kör godkänd action
```

### Trust Levels
```
GET    /api/dashboard/trust-levels             — alla trust levels
PUT    /api/dashboard/trust-levels/:agent/:product  — ändra trust level
```

### Agent Tasks
```
GET    /api/dashboard/agent-tasks              — alla inter-agent uppgifter
POST   /api/dashboard/agent-tasks              — skapa uppgift (admin eller agent)
PUT    /api/dashboard/agent-tasks/:id          — uppdatera status
```

### Reports
```
GET    /api/dashboard/reports                  — rapporter (filter: type, agent, product, period)
GET    /api/dashboard/reports/latest            — senaste dagliga sammanfattning
```

### Onboarding
```
POST   /api/dashboard/products/:id/onboard     — starta onboarding-process
GET    /api/dashboard/products/:id/onboard      — status på onboarding
```

### Agent Runner (intern)
```
POST   /api/internal/run-agent                 — kör en agent med uppgift
POST   /api/internal/run-meeting               — kör meeting room
```

---

## Dashboard Pages (nya/uppdaterade)

### Uppdaterade
- **Overview** — KPI-kort per produkt, Action Queue-sammanfattning, senaste rapport
- **Meeting Room** — produktväljare, topic-system, smart routing-indikator (visar vilka agenter som kallas in)

### Nya sidor
- **Action Queue** (`/actions`) — alla väntande actions, godkänn/avvisa/redigera, filter per agent/produkt
- **Team** (`/team`) — alla agenter grupperade per team, trust levels, status, senaste action
- **Reports** (`/reports`) — dagliga/veckovisa rapporter, KPI-grafer
- **Product Onboarding** (`/apps/[name]/onboard`) — onboarding-progress, rapporter per agent

### Produktväljare (global)
Toppen av dashboarden: dropdown med alla produkter + "Alla" för global vy. Filtrerar ALLT — leads, actions, reports, meetings.

---

## Agent Runner Architecture

### Autonomous Runner (cron)

```
autonomous-runner.mjs
├── Kör som systemd service
├── Cron-schema i config (per agent, per intervall)
├── Per körning:
│   1. Bygg system prompt (profil + produkt + learnings + kontext)
│   2. Kör claude -p med agentens prompt
│   3. Parsa response → actions
│   4. Actions → Action Queue (respekterar trust level)
│   5. Learnings → sparas automatiskt
│   6. Agent tasks → skapas om agenten ber om det
│   7. Logga allt i activity_log
└── Rate limiting: max X körningar per agent per dag
```

### Meeting Runner (polling)

```
meeting-runner.mjs (ersätter agent-responder.mjs)
├── Pollar discussions var 3s
├── Nytt meddelande:
│   1. Topic Router → väljer agenter
│   2. Bygg prompt med alla valda agenters profiler
│   3. Inkludera: produktdata, learnings, leads, senaste actions
│   4. Kör claude -p (Sonnet)
│   5. Parsa svar per agent
│   6. Actions → Action Queue
│   7. Chat → discussions DB
└── Visar i Meeting Room vilka agenter som "är med"
```

---

## Säkerhet & Regler

### SecOps Veto

SecOps har automatiskt veto på:
- Email utan consent → blockerad
- PII i content-drafts → flaggad
- Actions som bryter mot GDPR → stoppade
- Osäkra URL:er i mail → varning

### Rate Limits

```typescript
const AGENT_LIMITS = {
  emails_per_day: 50,          // per produkt
  api_calls_per_hour: 100,     // per agent
  claude_calls_per_day: 200,   // totalt alla agenter
  leads_created_per_day: 100,  // per produkt
}
```

### Audit Log

Allt loggas i `activity_log` med:
- `agent_role` — vem
- `action_type` — vad
- `product_id` — för vilken produkt
- `details` — full data (JSON)
- `result` — lyckades/misslyckades

---

## Tech Stack

- **Runtime:** Node.js 22 på Pi (claudestation)
- **DB:** SQLite (better-sqlite3) — enkelt, snabbt, backup-vänligt
- **API:** Hono (redan i bruk)
- **Dashboard:** Next.js 14 (redan i bruk)
- **AI:** Claude CLI (`claude -p`) — Sonnet för meetings, Haiku för snabba autonoma jobb
- **Services:** systemd (sales-mcp, sales-dashboard, meeting-runner, autonomous-runner)

---

<!-- Built by Christos Ferlachidis & Daniel Hedenberg -->

## Migration Path (från nuvarande system)

1. **Behåll:** SQLite DB, Hono API, Next.js dashboard, MCP tools, inbox reader
2. **Utöka:** DB med nya tabeller (action_queue, agent_tasks, trust_levels, etc.)
3. **Ersätt:** `agents` tabell → `agent_profiles` med djupare data
4. **Ersätt:** `agent-responder.mjs` → `meeting-runner.mjs` (smartare routing)
5. **Nytt:** `autonomous-runner.mjs` (cron-drivna jobb)
6. **Nytt:** Action Queue API + dashboard-sida
7. **Nytt:** Product onboarding pipeline
8. **Uppdatera:** Dashboard med produktväljare, team-sida, rapporter

---

## Implementation Priority

### Fas 1 — Foundation (denna session)
- Agent profiles med djupa system prompts (alla 18)
- DB-migration (nya tabeller)
- Topic Router
- Ny Meeting Runner
- Action Queue (API + grundläggande dashboard)

### Fas 2 — Autonomi
- Autonomous Runner (cron-jobb)
- Trust Level-system
- Dagliga rapporter (COO)
- Feedback-loop (avvisa → learning)

### Fas 3 — Intelligence
- Product Onboarding pipeline
- Cross-agent learnings
- Inter-agent tasks
- A/B-testning (mail-varianter)

### Fas 4 — Dashboard Polish
- Produktväljare (global)
- Team-sida med trust levels
- Rapportsida med grafer
- Pipeline-vy för leads
- Action Queue med redigering

### Fas 5 — Integrations
- Stripe-koppling (CFO)
- Google Calendar (Closer — mötesbokare)
- SMS (46elks / Twilio)
- Telegram-notifieringar

### Roadmap (framtid)
- Multi-tenant (andra företag)
- White-label
- Pricing-modell
- Onboarding-wizard för nya kunder
