-- Sales MCP Server — Database Schema

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    UNIQUE NOT NULL,
  display_name TEXT    NOT NULL,
  description  TEXT,
  pitch        TEXT,
  features     TEXT,
  pricing      TEXT,
  url          TEXT,
  language     TEXT    DEFAULT 'sv',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sequences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER REFERENCES products(id),
  name        TEXT    NOT NULL,
  description TEXT,
  steps       TEXT    NOT NULL,
  enabled     BOOLEAN DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL,
  name               TEXT,
  company            TEXT,
  phone              TEXT,
  product_id         INTEGER REFERENCES products(id),
  source             TEXT    DEFAULT 'manual',
  status             TEXT    DEFAULT 'new',
  sequence_id        INTEGER REFERENCES sequences(id),
  sequence_step      INTEGER DEFAULT 0,
  sequence_paused    BOOLEAN DEFAULT 0,
  last_contacted_at  DATETIME,
  notes              TEXT,
  tags               TEXT,
  consent_given      BOOLEAN  DEFAULT 0,
  consent_date       DATETIME,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(email, product_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  credentials TEXT,
  config      TEXT    DEFAULT '{}',
  enabled     BOOLEAN DEFAULT 1,
  last_used_at  DATETIME,
  last_error    TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Built by Weblease

CREATE TABLE IF NOT EXISTS channel_products (
  channel_id  INTEGER REFERENCES channels(id)  ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id)  ON DELETE CASCADE,
  PRIMARY KEY (channel_id, product_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER REFERENCES products(id),
  channel_id      INTEGER REFERENCES channels(id),
  type            TEXT    NOT NULL,
  title           TEXT,
  content         TEXT    NOT NULL,
  recipient_email TEXT,
  status          TEXT    DEFAULT 'pending',
  posted_at       DATETIME,
  external_url    TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  subject    TEXT,
  content    TEXT    NOT NULL,
  language   TEXT    DEFAULT 'sv',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, name)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  lead_id    INTEGER,
  channel_id INTEGER,
  draft_id   INTEGER,
  action     TEXT    NOT NULL,
  details    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created_at  ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_product_id  ON activity_log(product_id);

CREATE TABLE IF NOT EXISTS email_tracking (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER  REFERENCES leads(id),
  draft_id     INTEGER  REFERENCES drafts(id),
  tracking_id  TEXT     UNIQUE NOT NULL,
  type         TEXT     NOT NULL,
  url          TEXT,
  triggered_at DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gdpr_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  details    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER  REFERENCES products(id),
  type       TEXT     NOT NULL,
  title      TEXT,
  content    TEXT     NOT NULL,
  source_url TEXT,
  language   TEXT     DEFAULT 'sv',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_product_id ON knowledge(product_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_type       ON knowledge(type);

CREATE TABLE IF NOT EXISTS learnings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER REFERENCES products(id),
  channel_type TEXT,
  category     TEXT    NOT NULL,
  insight      TEXT    NOT NULL,
  evidence     TEXT,
  confidence   REAL    DEFAULT 0.5,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_learnings_product_id ON learnings(product_id);
CREATE INDEX IF NOT EXISTS idx_learnings_category   ON learnings(category);
