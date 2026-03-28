import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

let instance: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, description TEXT, pitch TEXT, features TEXT, pricing TEXT, url TEXT, language TEXT DEFAULT 'sv', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), name TEXT NOT NULL, description TEXT, steps TEXT NOT NULL, enabled BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT, company TEXT, phone TEXT, product_id INTEGER REFERENCES products(id), source TEXT DEFAULT 'manual', status TEXT DEFAULT 'new', sequence_id INTEGER REFERENCES sequences(id), sequence_step INTEGER DEFAULT 0, sequence_paused BOOLEAN DEFAULT 0, last_contacted_at DATETIME, notes TEXT, tags TEXT, consent_given BOOLEAN DEFAULT 0, consent_date DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(email, product_id));
CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT NOT NULL, credentials TEXT, config TEXT DEFAULT '{}', enabled BOOLEAN DEFAULT 1, last_used_at DATETIME, last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS channel_products (channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE CASCADE, PRIMARY KEY (channel_id, product_id));
CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), channel_id INTEGER REFERENCES channels(id), type TEXT NOT NULL, title TEXT, content TEXT NOT NULL, recipient_email TEXT, status TEXT DEFAULT 'pending', posted_at DATETIME, external_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), name TEXT NOT NULL, type TEXT NOT NULL, subject TEXT, content TEXT NOT NULL, language TEXT DEFAULT 'sv', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, name));
CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, lead_id INTEGER, channel_id INTEGER, draft_id INTEGER, action TEXT NOT NULL, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_product_id ON activity_log(product_id);
CREATE TABLE IF NOT EXISTS email_tracking (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER REFERENCES leads(id), draft_id INTEGER REFERENCES drafts(id), tracking_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, url TEXT, triggered_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS gdpr_log (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, action TEXT NOT NULL, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), type TEXT NOT NULL, title TEXT, content TEXT NOT NULL, source_url TEXT, language TEXT DEFAULT 'sv', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_knowledge_product_id ON knowledge(product_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
CREATE TABLE IF NOT EXISTS learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), channel_type TEXT, category TEXT NOT NULL, insight TEXT NOT NULL, evidence TEXT, confidence REAL DEFAULT 0.5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_learnings_product_id ON learnings(product_id);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE TABLE IF NOT EXISTS recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), agent_role TEXT NOT NULL, priority TEXT DEFAULT 'medium', title TEXT NOT NULL, description TEXT NOT NULL, action_type TEXT, action_data TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE TABLE IF NOT EXISTS agent_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_role TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_level TEXT DEFAULT 'intermediate',
  description TEXT,
  last_practiced DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_role, skill_name)
);
-- Built by Christos Ferlachidis & Daniel Hedenberg
CREATE TABLE IF NOT EXISTS agent_research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_role TEXT NOT NULL,
  topic TEXT NOT NULL,
  findings TEXT NOT NULL,
  source_url TEXT,
  shared_with TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_research_role ON agent_research(agent_role);
CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, product_id INTEGER REFERENCES products(id), lead_id INTEGER REFERENCES leads(id), contact_name TEXT, contact_email TEXT, contact_phone TEXT, meeting_type TEXT DEFAULT 'video', location TEXT, meeting_url TEXT, date TEXT NOT NULL, time TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, status TEXT DEFAULT 'proposed', notes TEXT, reminder_sent BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE TABLE IF NOT EXISTS agent_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT UNIQUE NOT NULL, name TEXT NOT NULL, team TEXT NOT NULL, avatar TEXT, personality TEXT NOT NULL, system_prompt TEXT NOT NULL, capabilities TEXT NOT NULL, focus_keywords TEXT, status TEXT DEFAULT 'active', last_action TEXT, last_action_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS action_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_role TEXT NOT NULL, agent_name TEXT NOT NULL, product_id INTEGER REFERENCES products(id), action_type TEXT NOT NULL, action_data TEXT NOT NULL, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'pending', requires_approval INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, approved_by TEXT, approved_at DATETIME, executed_at DATETIME, result TEXT, feedback TEXT);
CREATE INDEX IF NOT EXISTS idx_action_queue_status ON action_queue(status);
CREATE INDEX IF NOT EXISTS idx_action_queue_agent ON action_queue(agent_role);
CREATE TABLE IF NOT EXISTS trust_levels (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_role TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id), level INTEGER DEFAULT 1, changed_by TEXT NOT NULL, changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT, UNIQUE(agent_role, product_id));
CREATE TABLE IF NOT EXISTS agent_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, product_id INTEGER REFERENCES products(id), title TEXT NOT NULL, description TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'pending', due_at DATETIME, completed_at DATETIME, result TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_to ON agent_tasks(to_agent);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE TABLE IF NOT EXISTS daily_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id), report_type TEXT NOT NULL, agent_role TEXT NOT NULL, content TEXT NOT NULL, period_start DATETIME, period_end DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS onboarding_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), agent_role TEXT NOT NULL, report_type TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`;

export function getDb(dbPath: string): Database.Database {
  if (instance) return instance;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA);

  // Extend existing tables — safe to re-run
  const alterations = [
    'ALTER TABLE learnings ADD COLUMN agent_role TEXT',
    "ALTER TABLE learnings ADD COLUMN source TEXT DEFAULT 'manual'",
    'ALTER TABLE learnings ADD COLUMN shared_with TEXT',
    'ALTER TABLE discussions ADD COLUMN team TEXT',
    "ALTER TABLE products ADD COLUMN onboarding_status TEXT DEFAULT 'pending'",
    'ALTER TABLE products ADD COLUMN target_market TEXT',
    "ALTER TABLE products ADD COLUMN target_language TEXT DEFAULT 'sv'",
    'ALTER TABLE products ADD COLUMN brand_voice TEXT',
  ]
  // Built by Christos Ferlachidis & Daniel Hedenberg
  for (const sql of alterations) {
    try { db.prepare(sql).run() } catch { /* column already exists */ }
  }

  instance = db;
  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
