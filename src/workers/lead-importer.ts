import type Database from 'better-sqlite3'
import { sendTelegram } from '../providers/telegram.js'
import { decrypt } from '../utils/crypto.js'

// ─── Config ──────────────────────────────────────────────────────────────────

const SEARCH_QUERIES = [
  { query: 'WordPress agency', language: 'en', region: 'DE' },
  { query: 'WordPress byrå', language: 'sv', region: 'SE' },
  { query: 'WordPress agency', language: 'en', region: 'GB' },
  { query: 'WordPress developer freelance', language: 'en', region: 'US' },
  { query: 'Webbbyrå WordPress', language: 'sv', region: 'SE' },
]

const CHECK_INTERVAL = 24 * 60 * 60 * 1000 // Daily
let intervalHandle: ReturnType<typeof setInterval> | null = null

// Built by Christos Ferlachidis & Daniel Hedenberg

// ─── Google Places Search ────────────────────────────────────────────────────

interface PlaceResult {
  name: string
  website?: string
  formatted_address?: string
  rating?: number
  user_ratings_total?: number
}

async function searchPlaces(query: string, apiKey: string): Promise<PlaceResult[]> {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const data = await res.json() as { results?: PlaceResult[]; status: string }
    if (data.status !== 'OK') return []
    return data.results || []
  } catch {
    return []
  }
}

async function getPlaceDetails(placeId: string, apiKey: string): Promise<{ website?: string; email?: string }> {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=website,formatted_phone_number&key=${apiKey}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const data = await res.json() as { result?: { website?: string } }
    return { website: data.result?.website }
  } catch {
    return {}
  }
}

// ─── Website Email Scraper ───────────────────────────────────────────────────

async function findEmailOnWebsite(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SalesMCP-Scout/1.0' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()

    // Find email addresses
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    const emails = html.match(emailRegex) || []

    // Filter out common non-contact emails
    const filtered = emails.filter(e =>
      !e.includes('example.com') &&
      !e.includes('wixpress') &&
      !e.includes('sentry') &&
      !e.includes('gravatar') &&
      !e.includes('@2x') &&
      !e.includes('.png') &&
      !e.includes('.jpg') &&
      e.length < 60
    )

    // Prefer info@, contact@, hello@ etc
    const preferred = filtered.find(e => /^(info|contact|hello|hi|sales|team)@/i.test(e))
    return preferred || filtered[0] || null
  } catch {
    return null
  }
}

// ─── Detect WordPress ────────────────────────────────────────────────────────

async function isWordPressSite(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SalesMCP-Scout/1.0' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    })
    if (!res.ok) return false
    const html = await res.text()
    return html.includes('wp-content') || html.includes('wordpress') || html.includes('wp-json')
  } catch {
    return false
  }
}

// ─── Import Process ──────────────────────────────────────────────────────────

async function runImport(db: Database.Database): Promise<void> {
  // Get API key from channels (google_places type)
  const channel = db.prepare(
    "SELECT credentials FROM channels WHERE type = 'google_places' AND enabled = 1 LIMIT 1"
  ).get() as { credentials: string } | undefined

  if (!channel) {
    console.log('[lead-importer] No Google Places channel configured — skipping')
    return
  }

  let apiKey: string
  try {
    // Credentials are encrypted — decrypt first, then parse JSON
    const decrypted = decrypt(channel.credentials)
    const parsed = JSON.parse(decrypted)
    apiKey = parsed.api_key
  } catch {
    try {
      // Maybe plain JSON (not encrypted)
      const parsed = JSON.parse(channel.credentials)
      apiKey = parsed.api_key
    } catch {
      apiKey = channel.credentials
    }
  }

  if (!apiKey || apiKey === '***') {
    console.log('[lead-importer] Google Places API key not set — skipping')
    return
  }

  const wpilotId = (db.prepare("SELECT id FROM products WHERE name = 'wpilot'").get() as { id: number })?.id
  const sequenceId = (db.prepare("SELECT id FROM sequences WHERE name = 'WPilot Outreach' AND enabled = 1").get() as { id: number } | undefined)?.id

  let imported = 0

  for (const search of SEARCH_QUERIES) {
    const places = await searchPlaces(`${search.query} ${search.region}`, apiKey)

    for (const place of places.slice(0, 10)) {
      if (!place.website) continue

      // Check if we already have this lead (by website domain)
      const domain = new URL(place.website).hostname
      const existing = db.prepare(
        "SELECT id FROM leads WHERE email LIKE ? OR notes LIKE ?"
      ).get(`%${domain}%`, `%${domain}%`)
      if (existing) continue

      // Find email on their website
      const email = await findEmailOnWebsite(place.website)
      if (!email) continue

      // Check duplicate by email
      const dupEmail = db.prepare(
        "SELECT id FROM leads WHERE email = ? AND product_id = ?"
      ).get(email, wpilotId)
      if (dupEmail) continue

      // Check if they use WordPress (bonus info)
      const usesWP = await isWordPressSite(place.website)

      // Import lead
      const notes = [
        `[Auto-import] ${place.name}`,
        `Website: ${place.website}`,
        `Address: ${place.formatted_address || '?'}`,
        `Rating: ${place.rating || '?'} (${place.user_ratings_total || 0} reviews)`,
        `WordPress: ${usesWP ? 'JA' : 'nej'}`,
      ].join('\n')

      db.prepare(
        `INSERT INTO leads (email, name, company, product_id, source, status, sequence_id, consent_given, consent_date, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'google_places', 'new', ?, 0, NULL, ?, datetime('now'), datetime('now'))`
      ).run(email, place.name, place.name, wpilotId, sequenceId || null, notes)

      imported++

      // Log
      db.prepare(
        `INSERT INTO activity_log (product_id, action, details, created_at)
         VALUES (?, 'lead_imported', ?, datetime('now'))`
      ).run(wpilotId, JSON.stringify({ email, company: place.name, source: 'google_places', wordpress: usesWP }))

      console.log(`[lead-importer] Imported: ${email} (${place.name}) — WP: ${usesWP}`)

      // Rate limit
      await new Promise(r => setTimeout(r, 2000))
    }

    // Rate limit between queries
    await new Promise(r => setTimeout(r, 3000))
  }

  if (imported > 0) {
    console.log(`[lead-importer] Imported ${imported} new leads`)
    sendTelegram(
      `📥 <b>Lead Import klar</b>\n\n${imported} nya leads importerade via Google Places`
    ).catch(() => {})
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startLeadImporter(db: Database.Database): void {
  if (intervalHandle) return

  console.log('[lead-importer] Starting — runs daily (needs Google Places channel)')

  // First run after 5 minutes
  setTimeout(() => {
    runImport(db).catch(err => {
      console.error('[lead-importer] Import failed:', (err as Error).message)
    })
  }, 5 * 60 * 1000)

  intervalHandle = setInterval(() => {
    runImport(db).catch(err => {
      console.error('[lead-importer] Import failed:', (err as Error).message)
    })
  }, CHECK_INTERVAL)
}

export function stopLeadImporter(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log('[lead-importer] Stopped')
  }
}
