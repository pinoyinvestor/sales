import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import { sendTelegram } from '../providers/telegram.js'

// ─── Config ──────────────────────────────────────────────────────────────────

const SSH_HOST = 'root@103.177.248.45'
const SSH_PORT = '2222'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const DB_NAME = 'weblease'

// ─── State ───────────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null
let lastUserCount = -1
let lastLicenseCount = -1
let lastPluginCount = -1

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── SSH Query Helper ────────────────────────────────────────────────────────

function sshQuery(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-p', SSH_PORT,
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=no',
      SSH_HOST,
      `mysql -u root ${DB_NAME} -N -e "${query.replace(/"/g, '\\"')}"`,
    ], { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })

    proc.stdin.end()
    let out = '', err = ''
    proc.stdout.on('data', (d: Buffer) => { out += d })
    proc.stderr.on('data', (d: Buffer) => { err += d })
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `SSH exit ${code}`))
    })
    proc.on('error', reject)
  })
}

// ─── Check WPilot ───────────────────────────────────────────────────────────

async function checkWPilot(db: Database.Database): Promise<void> {
  try {
    // Get current counts
    const userCount = parseInt(await sshQuery('SELECT COUNT(*) FROM users'), 10) || 0
    const licenseCount = parseInt(await sshQuery('SELECT COUNT(*) FROM licenses'), 10) || 0
    const pluginCount = parseInt(await sshQuery('SELECT COUNT(*) FROM plugin_activations'), 10) || 0

    // First run — just store baseline
    if (lastUserCount === -1) {
      lastUserCount = userCount
      lastLicenseCount = licenseCount
      lastPluginCount = pluginCount
      console.log(`[wpilot-monitor] Baseline: ${userCount} users, ${licenseCount} licenses, ${pluginCount} activations`)
      return
    }

    // Check for new users
    if (userCount > lastUserCount) {
      const newUsers = await sshQuery(
        `SELECT email, created_at FROM users ORDER BY created_at DESC LIMIT ${userCount - lastUserCount}`
      )
      const lines = newUsers.split('\n').filter(Boolean)
      for (const line of lines) {
        const [email, date] = line.split('\t')
        await sendTelegram(
          `👤 <b>Ny WPilot-användare!</b>\n\n📧 ${escHtml(email)}\n📅 ${escHtml(date || 'just nu')}`
        )
        // Also log in sales-mcp
        db.prepare(
          `INSERT INTO activity_log (product_id, action, details, created_at)
           VALUES ((SELECT id FROM products WHERE name = 'wpilot'), 'wpilot_new_user', ?, datetime('now'))`
        ).run(JSON.stringify({ email, date }))
      }
      console.log(`[wpilot-monitor] ${userCount - lastUserCount} new user(s)`)
    }

    // Check for new licenses
    if (licenseCount > lastLicenseCount) {
      const newLicenses = await sshQuery(
        `SELECT l.plan_type, l.site_url, l.chat_agent, u.email, l.created_at
         FROM licenses l JOIN users u ON u.id = l.user_id
         ORDER BY l.created_at DESC LIMIT ${licenseCount - lastLicenseCount}`
      )
      const lines = newLicenses.split('\n').filter(Boolean)
      for (const line of lines) {
        const [plan, site, chatAgent, email, date] = line.split('\t')
        const planLabel = plan === 'free' ? 'Free' : plan === 'pro' ? 'Pro ($9/mo)' : plan === 'team' ? 'Team ($24/mo)' : plan === 'lifetime' ? 'Lifetime ($149)' : plan
        const chatLabel = chatAgent === '1' ? ' + Chat Agent' : ''
        await sendTelegram(
          `🔑 <b>Ny WPilot-licens!</b>\n\n` +
          `📧 ${escHtml(email)}\n` +
          `📋 Plan: <b>${escHtml(planLabel)}${chatLabel}</b>\n` +
          `🌐 ${escHtml(site || '(ej aktiverad)')}\n` +
          `📅 ${escHtml(date || 'just nu')}`
        )
        db.prepare(
          `INSERT INTO activity_log (product_id, action, details, created_at)
           VALUES ((SELECT id FROM products WHERE name = 'wpilot'), 'wpilot_new_license', ?, datetime('now'))`
        ).run(JSON.stringify({ email, plan, site, chat_agent: chatAgent === '1' }))
      }
      console.log(`[wpilot-monitor] ${licenseCount - lastLicenseCount} new license(s)`)
    }

    // Check for new plugin activations
    if (pluginCount > lastPluginCount) {
      const diff = pluginCount - lastPluginCount
      const newActivations = await sshQuery(
        `SELECT site_url, wp_version, plugin_version, created_at
         FROM plugin_activations ORDER BY created_at DESC LIMIT ${diff}`
      )
      const lines = newActivations.split('\n').filter(Boolean)
      for (const line of lines) {
        const [site, wpVer, plugVer, date] = line.split('\t')
        await sendTelegram(
          `⚡ <b>WPilot aktiverad!</b>\n\n` +
          `🌐 ${escHtml(site || '?')}\n` +
          `📦 WPilot v${escHtml(plugVer || '?')} / WP ${escHtml(wpVer || '?')}\n` +
          `📅 ${escHtml(date || 'just nu')}`
        )
        db.prepare(
          `INSERT INTO activity_log (product_id, action, details, created_at)
           VALUES ((SELECT id FROM products WHERE name = 'wpilot'), 'wpilot_activation', ?, datetime('now'))`
        ).run(JSON.stringify({ site, wp_version: wpVer, plugin_version: plugVer }))
      }
      console.log(`[wpilot-monitor] ${diff} new activation(s)`)
    }

    // Update counts
    lastUserCount = userCount
    lastLicenseCount = licenseCount
    lastPluginCount = pluginCount

  } catch (err) {
    console.error('[wpilot-monitor] Error:', (err as Error).message)
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startWPilotMonitor(db: Database.Database): void {
  if (intervalHandle) return

  console.log('[wpilot-monitor] Starting — checking every 6h')

  // First check after 10 seconds
  setTimeout(() => {
    checkWPilot(db).catch(err => {
      console.error('[wpilot-monitor] Initial check failed:', (err as Error).message)
    })
  }, 10000)

  intervalHandle = setInterval(() => {
    checkWPilot(db).catch(err => {
      console.error('[wpilot-monitor] Check failed:', (err as Error).message)
    })
  }, CHECK_INTERVAL)
}

export function stopWPilotMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log('[wpilot-monitor] Stopped')
  }
}
