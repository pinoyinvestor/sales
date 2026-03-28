import type Database from 'better-sqlite3';
import type { AgentProfile } from './profiles.js';

// ── DB row interfaces ───────────────────────────────────────────────────────

interface ProductRow {
  id: number;
  name: string;
  display_name: string;
  description: string | null;
  pitch: string | null;
  features: string | null;
  pricing: string | null;
  url: string | null;
  language: string | null;
  target_market: string | null;
  brand_voice: string | null;
}

interface KnowledgeRow {
  id: number;
  product_id: number;
  type: string;
  title: string | null;
  content: string;
}

interface LearningRow {
  id: number;
  agent_role: string | null;
  product_id: number | null;
  category: string;
  insight: string;
  confidence: number;
}

interface LeadRow {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  status: string;
  notes: string | null;
}

interface CountRow {
  count: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function buildProductContext(db: Database.Database, productId: number): string {
  const product = db.prepare(
    `SELECT id, name, display_name, description, pitch, features, pricing, url, language, target_market, brand_voice
     FROM products WHERE id = ?`
  ).get(productId) as ProductRow | undefined;

  if (!product) return '(Produkt hittades ej)';

  const lines: string[] = [
    `Produkt: ${product.display_name} (${product.name})`,
  ];
  if (product.description) lines.push(`Beskrivning: ${product.description}`);
  if (product.pitch)       lines.push(`Pitch: ${product.pitch}`);
  if (product.features)    lines.push(`Features: ${product.features}`);
  if (product.pricing)     lines.push(`Pris: ${product.pricing}`);
  if (product.url)         lines.push(`URL: ${product.url}`);
  if (product.language)    lines.push(`Sprak: ${product.language}`);
  if (product.target_market) lines.push(`Marknad: ${product.target_market}`);
  if (product.brand_voice) lines.push(`Brand voice: ${product.brand_voice}`);

  // Knowledge base summary
  const knowledgeRows = db.prepare(
    `SELECT id, product_id, type, title, content FROM knowledge WHERE product_id = ? LIMIT 10`
  ).all(productId) as KnowledgeRow[];

  if (knowledgeRows.length > 0) {
    lines.push('');
    lines.push('Kunskapsbas:');
    let totalChars = 0;
    for (const k of knowledgeRows) {
      if (totalChars >= 3000) break;
      const entry = `- [${k.type}] ${k.title ?? 'Utan titel'}: ${truncate(k.content, 200)}`;
      lines.push(entry);
      totalChars += entry.length;
    }
  }

  return lines.join('\n');
}

function buildLearnings(db: Database.Database, agentRole: string, productId: number | null): string {
  const params: (string | number | null)[] = [];
  let sql = `SELECT id, agent_role, product_id, category, insight, confidence
     FROM learnings
     WHERE (agent_role = ? OR agent_role IS NULL)`;
  params.push(agentRole);

  if (productId !== null) {
    sql += ' AND (product_id = ? OR product_id IS NULL)';
    params.push(productId);
  }

  sql += ' AND confidence >= 0.3 ORDER BY confidence DESC LIMIT 15';

  const rows = db.prepare(sql).all(...params) as LearningRow[];

  if (rows.length === 0) return '(Inga learnings an)';

  return rows
    .map(r => `- [${r.category}] ${r.insight} (confidence: ${r.confidence.toFixed(1)})`)
    .join('\n');
}

function buildTeamKnowledge(db: Database.Database, currentRole: string, productId: number | null): string {
  const params: (string | number | null)[] = [currentRole];
  let sql = `SELECT id, agent_role, product_id, category, insight, confidence
     FROM learnings
     WHERE agent_role != ? AND agent_role IS NOT NULL AND confidence >= 0.6`;

  if (productId !== null) {
    sql += ' AND (product_id = ? OR product_id IS NULL)';
    params.push(productId);
  }

  sql += ' ORDER BY confidence DESC LIMIT 10';

  const rows = db.prepare(sql).all(...params) as LearningRow[];

  if (rows.length === 0) return '(Inget delat an)';

  return rows
    .map(r => `- ${r.agent_role}: ${r.insight}`)
    .join('\n');
}

function buildCurrentContext(db: Database.Database, productId: number | null): string {
  const lines: string[] = [];

  // Built by Christos Ferlachidis & Daniel Hedenberg
  if (productId !== null) {
    const leads = db.prepare(
      `SELECT id, email, name, company, status, notes
       FROM leads WHERE product_id = ? ORDER BY updated_at DESC LIMIT 10`
    ).all(productId) as LeadRow[];

    if (leads.length > 0) {
      lines.push('Senaste leads:');
      for (const l of leads) {
        const parts = [l.email];
        if (l.name)    parts.push(l.name);
        if (l.company) parts.push(l.company);
        parts.push(`status: ${l.status}`);
        if (l.notes)   parts.push(`anteckning: ${truncate(l.notes, 80)}`);
        lines.push(`  - ${parts.join(' | ')}`);
      }
    } else {
      lines.push('Inga leads an for denna produkt.');
    }
  }

  const pending = db.prepare(
    `SELECT COUNT(*) as count FROM action_queue WHERE status = 'pending'`
  ).get() as CountRow;

  lines.push(`Vantande actions i ko: ${pending.count}`);

  return lines.join('\n');
}

// ── Exported functions ──────────────────────────────────────────────────────

export function buildAgentPrompt(
  agent: AgentProfile,
  db: Database.Database,
  productId: number | null
): string {
  let prompt = agent.systemPrompt;

  const productContext = productId !== null
    ? buildProductContext(db, productId)
    : '(Ingen specifik produkt vald)';

  const learnings = buildLearnings(db, agent.role, productId);
  const teamKnowledge = buildTeamKnowledge(db, agent.role, productId);
  const currentContext = buildCurrentContext(db, productId);

  prompt = prompt.replace(/\{\{PRODUCT_CONTEXT\}\}/g, productContext);
  prompt = prompt.replace(/\{\{LEARNINGS\}\}/g, learnings);
  prompt = prompt.replace(/\{\{TEAM_KNOWLEDGE\}\}/g, teamKnowledge);
  prompt = prompt.replace(/\{\{CURRENT_CONTEXT\}\}/g, currentContext);

  return prompt;
}

export function buildMeetingPrompt(
  agents: AgentProfile[],
  message: string,
  history: string,
  db: Database.Database,
  productId: number | null
): string {
  const sections: string[] = [];

  // Attending agents
  const attendeeList = agents
    .map(a => `${a.avatar ?? '🤖'} ${a.name} (${a.role})`)
    .join('\n');
  sections.push(`== Deltagare ==\n${attendeeList}`);

  // Agent profiles with abbreviated prompts
  for (const agent of agents) {
    const fullPrompt = buildAgentPrompt(agent, db, productId);
    const abbreviated = truncate(fullPrompt, 1500);
    sections.push(
      `== ${agent.avatar ?? '🤖'} ${agent.name} ==\nPersonlighet: ${agent.personality}\nSystemprompt:\n${abbreviated}`
    );
  }

  // Product list
  if (productId !== null) {
    const product = db.prepare(
      `SELECT display_name, name FROM products WHERE id = ?`
    ).get(productId) as { display_name: string; name: string } | undefined;

    if (product) {
      sections.push(`== Produkt ==\n${product.display_name} (${product.name})`);
    }
  } else {
    const products = db.prepare(
      `SELECT display_name, name FROM products`
    ).all() as { display_name: string; name: string }[];

    if (products.length > 0) {
      sections.push(
        `== Produkter ==\n${products.map(p => `- ${p.display_name} (${p.name})`).join('\n')}`
      );
    }
  }

  // Lead list
  if (productId !== null) {
    const leads = db.prepare(
      `SELECT email, name, company, status FROM leads WHERE product_id = ? ORDER BY updated_at DESC LIMIT 15`
    ).all(productId) as LeadRow[];

    if (leads.length > 0) {
      sections.push(
        `== Leads ==\n${leads.map(l => `- ${l.email}${l.name ? ` (${l.name})` : ''}${l.company ? ` @ ${l.company}` : ''} [${l.status}]`).join('\n')}`
      );
    }
  }

  // Conversation history
  if (history.trim()) {
    sections.push(`== Konversationshistorik ==\n${history}`);
  }

  // New message
  sections.push(`== Nytt meddelande ==\n${message}`);

  // Rules
  sections.push(`== Regler ==
- Bara deltagande agenter svarar (${agents.map(a => a.name).join(', ')})
- Korta, konkreta svar — inga floskler
- Svenska som standard om inget annat anges
- Specifika fakta, inte fluff
- Varje agent svarar i sin roll och expertis`);

  // Action format
  sections.push(`== Svarsformat ==
Chat-svar:
ROLE|NAME|Meddelande

Actions (en per rad):
ACTION|ROLE|NAME|action_type|{json_data}|Meddelande

Tillgangliga action_types:
- create_lead       — {email, name?, company?, source?}
- update_lead       — {lead_id, status?, notes?, tags?}
- create_draft      — {type, title?, content, recipient_email?, channel_id?}
- create_recommendation — {title, description, priority?, action_type?, action_data?}
- assign_task       — {to_agent, title, description?, priority?, due_at?}
- save_learning     — {category, insight, confidence?, evidence?}
- book_meeting      — {contact_name, contact_email, date, time, duration_minutes?, title?, description?}
- escalate          — {reason, priority, details?}`);

  return sections.join('\n\n');
}
