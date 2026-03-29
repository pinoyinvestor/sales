// Telegram notification provider for Sales MCP
// Sends important events to a Telegram chat

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

interface TelegramConfig {
  bot_token: string
  chat_id: string
  enabled: boolean
}

// ── Config loader ────────────────────────────────────────────────────

function getConfigPath(): string {
  const basePath = process.env.SALES_MCP_BASE ||
    dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  return join(basePath, 'config.json')
}

function getTelegramConfig(): TelegramConfig {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    const config = JSON.parse(raw)
    return config.telegram || { bot_token: '', chat_id: '', enabled: false }
  } catch {
    return { bot_token: '', chat_id: '', enabled: false }
  }
}

// Built by Christos Ferlachidis & Daniel Hedenberg

// ── Send Message ─────────────────────────────────────────────────────

export async function sendTelegram(
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML'
): Promise<boolean> {
  const cfg = getTelegramConfig()
  if (!cfg.enabled || !cfg.bot_token || !cfg.chat_id) return false

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${cfg.bot_token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.chat_id,
          text,
          parse_mode: parseMode,
        }),
      }
    )
    const data = await res.json() as { ok: boolean; description?: string }
    if (!data.ok) {
      console.error('[telegram] Send failed:', data.description)
      return false
    }
    return true
  } catch (err) {
    console.error('[telegram] Error:', (err as Error).message)
    return false
  }
}

// ── Format Helpers ───────────────────────────────────────────────────

export function formatNewLead(name: string, email: string, product: string): string {
  return `🎯 <b>Ny Lead</b>\n\n<b>${esc(name)}</b> (${esc(email)})\nProdukt: ${esc(product)}`
}

export function formatActionNeeded(agent: string, action: string, product: string): string {
  return `✅ <b>Action behöver godkännas</b>\n\nAgent: ${esc(agent)}\nAction: ${esc(action)}\nProdukt: ${esc(product)}`
}

export function formatAutoReport(agent: string, summary: string): string {
  return `📊 <b>Auto-rapport: ${esc(agent)}</b>\n\n${esc(summary.substring(0, 500))}`
}

export function formatNewEmail(from: string, subject: string): string {
  return `✉️ <b>Nytt mail</b>\n\nFrån: ${esc(from)}\nÄmne: ${esc(subject)}`
}

export function formatActionExecuted(agent: string, actionType: string, result: string): string {
  return `⚡ <b>Action utförd</b>\n\nAgent: ${esc(agent)}\nTyp: ${esc(actionType)}\nResultat: ${esc(result.substring(0, 200))}`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
