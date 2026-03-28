import { readFileSync } from 'fs';
import { join } from 'path';

export interface EmailImapConfig {
  host: string;
  port: number;
  tls: boolean;
}

export interface EmailSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
}

export interface EmailConfig {
  imap: EmailImapConfig;
  smtp: EmailSmtpConfig;
  user: string;
  pass: string;
}

export interface DatabaseConfig {
  path: string;
}

export interface TrackingConfig {
  base_url: string;
  unsubscribe_url: string;
}

// Built by Christos Ferlachidis & Daniel Hedenberg

export interface DashboardApiConfig {
  port: number;
  admin_key: string;
}

export interface SalesConfig {
  email: EmailConfig;
  database: DatabaseConfig;
  tracking: TrackingConfig;
  dashboard_api: DashboardApiConfig;
  default_language: string;
  retention_days: number;
}

let cached: SalesConfig | null = null;

export function loadConfig(basePath: string): SalesConfig {
  const configPath = join(basePath, 'config.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(
      `Config file not found at ${configPath}. ` +
      `Copy config.example.json to config.json and fill in your values.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config.json: ${(err as Error).message}`);
  }

  cached = parsed as SalesConfig;
  return cached;
}

export function getConfig(): SalesConfig {
  if (!cached) {
    throw new Error(
      'Config has not been loaded. Call loadConfig(basePath) before getConfig().'
    );
  }
  return cached;
}
