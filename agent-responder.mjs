import { spawn } from 'child_process'

const API = 'http://localhost:3210/api/dashboard'
const KEY = 'ccc8b8f3cf0e7e788c98fab7463fe0ca004d65a39f7ad8509e58a40c90c6f611'
let lastId = 0
let processing = false

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
  })
  return res.json()
}

// Built by Christos Ferlachidis & Daniel Hedenberg

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function apiPut(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── HTML email wrapper ───────────────────────────────────────────────────────

function wrapEmailHtml(bodyText, productName = 'weblease') {
  const brandColors = {
    wpilot:   { primary: '#6C5CE7', accent: '#A29BFE' },
    bokvyx:   { primary: '#00B894', accent: '#55EFC4' },
    bokvia:   { primary: '#E17055', accent: '#FAB1A0' },
    weblease: { primary: '#0984E3', accent: '#74B9FF' },
  }
  const colors = brandColors[productName.toLowerCase()] || brandColors.weblease
  // Built by Christos Ferlachidis & Daniel Hedenberg
  return `<!DOCTYPE html>
<html lang="sv">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
  <tr><td style="background:${colors.primary};padding:28px 40px;">
    <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;">${productName.charAt(0).toUpperCase() + productName.slice(1)}</h1>
  </td></tr>
  <tr><td style="padding:32px 40px;color:#333;font-size:15px;line-height:1.7;">
    ${bodyText}
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #eee;color:#999;font-size:12px;">
    <p style="margin:0;">Med vänliga hälsningar,<br><strong>${productName.charAt(0).toUpperCase() + productName.slice(1)}-teamet</strong> — Weblease</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

// ── Action executor ──────────────────────────────────────────────────────────

async function executeAction(actionType, data, agentRole) {
  console.log(`[agent-responder] ⚡ Executing action: ${actionType}`, JSON.stringify(data).substring(0, 200))

  try {
    switch (actionType) {
      case 'create_template': {
        if (data.content && !data.content.includes('<!DOCTYPE') && !data.content.includes('<table')) {
          data.content = wrapEmailHtml(data.content, data.product || 'weblease')
        }
        const result = await apiPost('/templates', {
          product: data.product,
          name: data.name,
          type: data.type || 'email',
          subject: data.subject || null,
          content: data.content,
          language: data.language || 'sv',
        })
        console.log(`[agent-responder] ✓ Template created:`, result.name || result.error)
        return result
      }

      case 'update_lead': {
        if (!data.id) throw new Error('update_lead requires id')
        const { id, ...fields } = data
        const result = await apiPut(`/leads/${id}`, fields)
        console.log(`[agent-responder] ✓ Lead ${id} updated:`, result.status || result.error)
        return result
      }

      // Built by Christos Ferlachidis & Daniel Hedenberg

      case 'create_lead': {
        if (!data.email) throw new Error('create_lead requires email')
        const result = await apiPost('/leads', {
          email: data.email,
          name: data.name || null,
          company: data.company || null,
          phone: data.phone || null,
          product_id: data.product_id || null,
          source: data.source || 'agent',
          status: data.status || 'new',
          notes: data.notes || null,
        })
        console.log(`[agent-responder] ✓ Lead created:`, result.email || result.error)
        return result
      }

      case 'create_recommendation': {
        const result = await apiPost('/recommendations', {
          product_id: data.product_id || null,
          agent_role: agentRole,
          priority: data.priority || 'medium',
          title: data.title,
          description: data.description,
          action_type: data.action_type || null,
          action_data: data.action_data ? JSON.stringify(data.action_data) : null,
        })
        console.log(`[agent-responder] ✓ Recommendation created:`, result.title || result.error)
        return result
      }

      case 'log_activity': {
        const result = await apiPost('/tracking/event', {
          trackingId: data.tracking_id || `agent_${Date.now()}`,
          type: data.type || 'open',
        })
        console.log(`[agent-responder] ✓ Activity logged`)
        return result
      }

      default:
        console.log(`[agent-responder] ⚠ Unknown action type: ${actionType}`)
        return { error: `Unknown action: ${actionType}` }
    }
  } catch (err) {
    console.error(`[agent-responder] ✗ Action failed: ${actionType}:`, err.message)
    return { error: err.message }
  }
}

// ── Claude prompt runner ─────────────────────────────────────────────────────

function claudePrompt(prompt) {
  return new Promise((resolve, reject) => {
    const { writeFileSync, unlinkSync } = require('fs')
    const tmpFile = '/tmp/agent-prompt-' + Date.now() + '.txt'
    writeFileSync(tmpFile, prompt)

    const proc = spawn('/home/christaras9126/.local/bin/claude', [
      '-p', `Read and follow instructions in ${tmpFile}`, '--max-turns', '1', '--model', 'sonnet',
    ], {
      env: { ...process.env, HOME: '/home/christaras9126' },
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Close stdin immediately
    proc.stdin.end()

    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('close', code => {
      try { unlinkSync(tmpFile) } catch {}
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error(err || `exit ${code}`))
    })
    proc.on('error', e => {
      try { unlinkSync(tmpFile) } catch {}
      reject(e)
    })
  })
}

// ── Response parser ──────────────────────────────────────────────────────────
// Built by Christos Ferlachidis & Daniel Hedenberg

function parseResponseLines(response) {
  const lines = response.split('\n')
  const parsed = []

  // If no properly formatted lines found, try to extract agent name and post whole response
  const hasFormattedLines = lines.some(l => /^(ACTION\|)?[a-z_]+\|/i.test(l.trim()))

  if (!hasFormattedLines && response.trim().length > 5) {
    // Try to detect agent from markdown like **SCOUT | Name** or **Scout:**
    const agentMatch = response.match(/\*\*([A-Z_]+)\s*[\|:]\s*([^*]+)\*\*/i) ||
                       response.match(/^([A-Z][a-z]+):/m)
    const role = agentMatch ? agentMatch[1].toLowerCase().replace(/\s+/g, '_') : 'support'
    const name = agentMatch ? (agentMatch[2] || agentMatch[1]).trim() : 'Support'
    // Clean markdown
    const clean = response.replace(/\*\*[^*]+\*\*/g, '').replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    if (clean.length > 5) {
      parsed.push({ type: 'chat', role, name, message: clean.substring(0, 500) })
    }
    return parsed
  }

  const filteredLines = lines.filter(l => l.includes('|'))

  for (const line of filteredLines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('ACTION|')) {
      // ACTION|ROLE|NAME|action_type|{json}|Message
      // Parse carefully: split on first 5 pipes, rest is message
      const withoutPrefix = trimmed.substring(7) // remove "ACTION|"
      const parts = withoutPrefix.split('|')

      if (parts.length >= 5) {
        const role = parts[0].trim().toLowerCase()
        const name = parts[1].trim()
        const actionType = parts[2].trim()

        // Find the JSON part — it starts at parts[3]
        // JSON might contain | so we need to find where it ends
        const remaining = parts.slice(3).join('|')
        let jsonStr = ''
        let message = ''

        // Try to extract JSON object from remaining
        const jsonStart = remaining.indexOf('{')
        if (jsonStart !== -1) {
          let depth = 0
          let jsonEnd = -1
          for (let i = jsonStart; i < remaining.length; i++) {
            if (remaining[i] === '{') depth++
            if (remaining[i] === '}') depth--
            if (depth === 0) { jsonEnd = i; break }
          }
          if (jsonEnd !== -1) {
            jsonStr = remaining.substring(jsonStart, jsonEnd + 1)
            // Message is everything after the JSON + pipe separator
            const afterJson = remaining.substring(jsonEnd + 1)
            message = afterJson.startsWith('|') ? afterJson.substring(1).trim() : afterJson.trim()
          }
        }

        let actionData = {}
        try {
          actionData = JSON.parse(jsonStr)
        } catch {
          console.log(`[agent-responder] ⚠ Failed to parse action JSON: ${jsonStr.substring(0, 100)}`)
        }

        if (role && name && actionType) {
          parsed.push({
            type: 'action',
            role,
            name,
            actionType,
            actionData,
            message: message || `Executed ${actionType}`,
          })
        }
      }
    } else {
      // Regular chat: ROLE|NAME|Message
      const parts = trimmed.split('|')
      if (parts.length >= 3) {
        const role = parts[0].trim().toLowerCase()
        const name = parts[1].trim()
        const message = parts.slice(2).join('|').trim()

        if (role && name && message && message.length > 2) {
          parsed.push({ type: 'chat', role, name, message })
        }
      }
    }
  }

  return parsed
}

// ── Init & polling ───────────────────────────────────────────────────────────

async function init() {
  const msgs = await apiFetch('/discussions?limit=1')
  if (Array.isArray(msgs) && msgs.length > 0) {
    lastId = msgs[0].id
  }
  console.log(`[agent-responder] Started (v2 with actions). Last ID: ${lastId}. Polling every 3s...`)
}

// Built by Christos Ferlachidis & Daniel Hedenberg

async function poll() {
  if (processing) return
  try {
    const msgs = await apiFetch('/discussions?limit=5')
    if (!Array.isArray(msgs)) return

    const newUserMsg = msgs.find(m => m.id > lastId && m.author_role === 'admin')
    if (!newUserMsg) return

    processing = true
    lastId = newUserMsg.id
    console.log(`[agent-responder] New #${newUserMsg.id}: "${newUserMsg.message}"`)

    const topic = newUserMsg.topic || 'general'

    const [history, agents, products, leads, templates, channels] = await Promise.all([
      apiFetch(`/discussions?topic=${encodeURIComponent(topic)}&limit=15`),
      apiFetch('/agents'),
      apiFetch('/products'),
      apiFetch('/leads?limit=10'),
      apiFetch('/templates'),
      apiFetch('/channels'),
    ])

    const agentList = agents.map(a => `- ${a.name} (${a.role}): ${a.description}`).join('\n')
    const productList = products.map(p => `- ${p.name} (${p.display_name}): ${p.description || ''} [id=${p.id}]`).join('\n')
    const leadList = leads.map(l => `- id=${l.id} ${l.email} (${l.status}) product_id=${l.product_id || '?'} ${l.notes || ''}`).join('\n')
    const templateList = templates.length > 0
      ? templates.map(t => `- ${t.name} (${t.type}, ${t.language}) product=${t.product_name || '?'}`).join('\n')
      : '(inga templates ännu)'
    const channelList = channels.length > 0
      ? channels.map(c => `- ${c.name} (${c.type}) ${c.enabled ? 'AKTIV' : 'INAKTIV'}`).join('\n')
      : '(inga kanaler kopplade)'
    const missingChannels = ['linkedin', 'facebook', 'instagram', 'tiktok', 'sms', 'reddit']
      .filter(t => !channels.some(c => c.type === t))
    const missingList = missingChannels.length > 0
      ? missingChannels.join(', ')
      : '(alla kopplade)'
    const historyText = history.map(m => `${m.author_name}: ${m.message}`).join('\n')

    const prompt = `Du är ett säljteam med AI-agenter. Admin (Christos) skrev i mötesrummet.

AGENTER:
${agentList}

PRODUKTER:
${productList}

LEADS:
${leadList}

BEFINTLIGA TEMPLATES:
${templateList}

KOPPLADE KANALER:
${channelList}

EJ KOPPLADE PLATTFORMAR: ${missingList}
OBS: Om du föreslår att posta på en plattform som INTE är kopplad, MEDDELA admin att den behöver kopplas först via Channels-sidan. Ge kort instruktion.

KONVERSATION:
${historyText}

NYTT MEDDELANDE:
${newUserMsg.message}

REGLER:
- Svara som 1-3 relevanta agenter (INTE alla)
- Kort och konkret, max 2-3 meningar per agent
- Specifika förslag, inte fluff
- Svenska

DU KAN UTFÖRA ACTIONS — inte bara prata. Om admin ber dig göra något, GÖR det.

Actions du kan utföra (lägg till ACTION| prefix):
- create_template: Skapa email-mall (JSON: name, product, subject, content som HTML, language, type)
- update_lead: Uppdatera lead (JSON: id, status?, notes?, name?, company?, phone?)
- create_lead: Skapa lead (JSON: email, name?, company?, product_id, source)
- create_recommendation: Skapa rekommendation (JSON: product_id, title, description, priority, action_type)

FORMAT:
Chat-svar: ROLE|NAME|Meddelande
Action-svar: ACTION|ROLE|NAME|action_type|{"json":"data"}|Förklaringsmeddelande

Du kan blanda chat och actions i samma svar.
Alla email-templates ska vara HTML med professionell design, anpassat efter produkt och språk.
Anpassa språk efter produkten och mottagaren.
Använd rätt product name (t.ex. wpilot, bokvyx) och product_id i actions.

SVARA NU:`

    console.log(`[agent-responder] Calling Claude...`)
    const response = await claudePrompt(prompt)
    console.log(`[agent-responder] Response: ${response.substring(0, 200)}...`)

    const parsed = parseResponseLines(response)

    for (const entry of parsed) {
      if (entry.type === 'action') {
        // Execute the action first
        const result = await executeAction(entry.actionType, entry.actionData, entry.role)

        // Build status message
        const statusPrefix = result && !result.error ? '✓' : '✗'
        const fullMessage = `${statusPrefix} ${entry.message}`

        // Post the explanation to discussions
        console.log(`[agent-responder] Posting action result as ${entry.name}`)
        await apiPost('/discussions', {
          author_role: entry.role,
          author_name: entry.name,
          message: fullMessage,
          topic,
        })
        await new Promise(r => setTimeout(r, 500))

      } else {
        // Regular chat message
        console.log(`[agent-responder] Posting as ${entry.name}`)
        await apiPost('/discussions', {
          author_role: entry.role,
          author_name: entry.name,
          message: entry.message,
          topic,
        })
        await new Promise(r => setTimeout(r, 500))
      }
    }
  } catch (e) {
    console.error(`[agent-responder] Error:`, e.message)
  } finally {
    processing = false
  }
}

// Built by Christos Ferlachidis & Daniel Hedenberg

await init()
setInterval(poll, 3000)
