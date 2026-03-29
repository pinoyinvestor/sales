import { spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'

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

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── Topic Router ─────────────────────────────────────────────────────────────

const TEAM_KEYWORDS = {
  sales:        ['lead', 'kund', 'prospect', 'outreach', 'kontakt', 'deal', 'avslut', 'sälja', 'möte', 'customer', 'client', 'försäljning'],
  marketing:    ['content', 'blogg', 'SEO', 'kampanj', 'social media', 'nyhetsbrev', 'annons', 'copy', 'landing page', 'marketing', 'marknadsföring'],
  creative:     ['varumärke', 'brand', 'design', 'layout', 'UX', 'ton', 'färg', 'font', 'UI', 'identitet', 'stil'],
  security:     ['säkerhet', 'GDPR', 'audit', 'sårbarhet', 'consent', 'kryptering', 'compliance', 'dataskydd'],
  customer:     ['support', 'klagomål', 'churn', 'nöjd', 'recension', 'retention', 'kundservice', 'hjälp'],
  executive:    ['budget', 'ekonomi', 'Q1', 'Q2', 'Q3', 'Q4', 'rapport', 'intäkt', 'kostnad', 'ROI', 'arkitektur', 'tech debt'],
  operations:   ['roadmap', 'prioritering', 'deadline', 'plan', 'uppgift', 'projekt', 'leverans', 'sprint'],
  intelligence: ['data', 'trend', 'analys', 'marknad', 'statistik', 'konvertering', 'siffror', 'mätning'],
}

// Built by Christos Ferlachidis & Daniel Hedenberg

const TEAM_AGENTS = {
  sales: ['scout', 'outreach', 'closer'],
  marketing: ['content', 'copywriter', 'seo', 'strategist'],
  creative: ['creative_director'],
  security: ['secops'],
  customer: ['support', 'keeper'],
  executive: ['coo', 'cfo', 'cto'],
  operations: ['pm'],
  intelligence: ['analyst'],
}

function selectAgents(message, allAgents) {
  const lower = message.toLowerCase()
  const teamScores = []

  for (const [team, keywords] of Object.entries(TEAM_KEYWORDS)) {
    let score = 0
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) score++
    }
    if (score > 0) teamScores.push({ team, score })
  }

  teamScores.sort((a, b) => b.score - a.score)

  if (teamScores.length === 0) {
    return allAgents.filter(a => ['coo', 'strategist'].includes(a.role))
  }

  const selected = []
  const usedTeams = new Set()

  for (const { team, score } of teamScores) {
    if (selected.length >= 5) break
    if (usedTeams.has(team)) continue
    usedTeams.add(team)

    const teamAgentRoles = TEAM_AGENTS[team] || []
    const teamAgents = allAgents.filter(a => teamAgentRoles.includes(a.role))

    const scored = teamAgents.map(a => {
      const kws = JSON.parse(a.focus_keywords || '[]')
      const kwScore = kws.filter(kw => lower.includes(kw.toLowerCase())).length
      return { agent: a, score: kwScore }
    }).sort((a, b) => b.score - a.score)

    if (scored.length > 0) {
      selected.push(scored[0].agent)
      if (scored.length > 1 && score >= 3 && selected.length < 5) {
        selected.push(scored[1].agent)
      }
    }
  }

  if (usedTeams.size >= 3 && !selected.find(a => a.role === 'coo')) {
    const coo = allAgents.find(a => a.role === 'coo')
    if (coo && selected.length < 5) selected.push(coo)
  }

  if (selected.length < 2) {
    const defaults = allAgents.filter(a => ['coo', 'strategist'].includes(a.role) && !selected.find(s => s.role === a.role))
    for (const d of defaults) {
      if (selected.length >= 2) break
      selected.push(d)
    }
  }

  return selected.slice(0, 5)
}

// ── Response Parser ─────────────────────────────────────────────────────────

function parseResponse(response, allAgents) {
  const lines = response.split('\n')
  const parsed = []

  // Resolve role from name or raw role string
  function resolveRole(rawRole, name) {
    const role = (rawRole || '').toLowerCase().replace(/\s+/g, '_')
    // If role is a valid agent role, use it
    if (allAgents && allAgents.find(a => a.role === role)) return role
    // Try to find by name
    if (name && allAgents) {
      const byName = allAgents.find(a => a.name.toLowerCase() === name.toLowerCase())
      if (byName) return byName.role
    }
    // Common aliases
    const aliases = { coo: 'coo', cfo: 'cfo', cto: 'cto', role: 'coo', chat: 'coo', error: 'coo' }
    return aliases[role] || 'coo'
  }

  function resolveName(role, rawName) {
    if (rawName && rawName !== 'Chat' && rawName !== 'Error' && rawName !== 'ROLE') return rawName
    if (allAgents) {
      const agent = allAgents.find(a => a.role === role)
      if (agent) return agent.name
    }
    return rawName || 'Sofia'
  }

  const hasFormatted = lines.some(l => /^(ACTION\|)?[a-z_]+\|/i.test(l.trim()))
  const cleanedLines = lines.map(l => l.trim().replace(/^(Chat|Action|Response):\s*/i, '').replace(/^[-*]\s*/, '').trim())
  const hasFormatted2 = cleanedLines.some(l => /^(ACTION\|)?[a-z_]+\|/i.test(l))

  if (!hasFormatted && !hasFormatted2 && response.trim().length > 5) {
    const match = response.match(/\*\*([A-Z_]+)\s*[\|:]\s*([^*]+)\*\*/i) || response.match(/^([A-Z][a-z]+):/m)
    const rawRole = match ? match[1].toLowerCase().replace(/\s+/g, '_') : 'coo'
    const rawName = match ? (match[2] || match[1]).trim() : ''
    const role = resolveRole(rawRole, rawName)
    const name = resolveName(role, rawName)
    const clean = response.replace(/\*\*[^*]+\*\*/g, '').replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    if (clean.length > 5) parsed.push({ type: 'chat', role, name, message: clean.substring(0, 500) })
    return parsed
  }

  // Built by Christos Ferlachidis & Daniel Hedenberg

  for (const line of lines) {
    let trimmed = line.trim()
      .replace(/^(Chat|Action|Response):\s*/i, '')
      .replace(/^[-*]\s*/, '')
      .trim()
    if (!trimmed.includes('|')) continue

    if (trimmed.startsWith('ACTION|')) {
      const parts = trimmed.substring(7).split('|')
      if (parts.length >= 5) {
        const rawRole = parts[0].trim().toLowerCase()
        const rawName = parts[1].trim()
        const role = resolveRole(rawRole, rawName)
        const name = resolveName(role, rawName)
        const actionType = parts[2].trim()
        const remaining = parts.slice(3).join('|')
        let jsonStr = '', message = ''
        const jsonStart = remaining.indexOf('{')
        if (jsonStart !== -1) {
          let depth = 0, jsonEnd = -1
          for (let i = jsonStart; i < remaining.length; i++) {
            if (remaining[i] === '{') depth++
            if (remaining[i] === '}') depth--
            if (depth === 0) { jsonEnd = i; break }
          }
          if (jsonEnd !== -1) {
            jsonStr = remaining.substring(jsonStart, jsonEnd + 1)
            const after = remaining.substring(jsonEnd + 1)
            message = after.startsWith('|') ? after.substring(1).trim() : after.trim()
          }
        }
        let actionData = {}
        try { actionData = JSON.parse(jsonStr) } catch { continue }
        if (role && name && actionType) {
          parsed.push({ type: 'action', role, name, actionType, actionData, message: message || `Utförde ${actionType}` })
        }
      }
    } else {
      const parts = trimmed.split('|')
      if (parts.length >= 3) {
        const rawRole = parts[0].trim().toLowerCase()
        const rawName = parts[1].trim()
        const role = resolveRole(rawRole, rawName)
        const name = resolveName(role, rawName)
        const message = parts.slice(2).join('|').trim()
        if (role && name && message && message.length > 2) {
          parsed.push({ type: 'chat', role, name, message })
        }
      } else if (parts.length === 2) {
        // Handle Name|Message format (no role prefix)
        const rawName = parts[0].trim()
        const message = parts[1].trim()
        const agent = allAgents && allAgents.find(a => a.name.toLowerCase() === rawName.toLowerCase())
        if (agent && message.length > 2) {
          parsed.push({ type: 'chat', role: agent.role, name: agent.name, message })
        }
      }
    }
  }
  return parsed
}

// ── Claude Prompt Runner ────────────────────────────────────────────────────

function claudePrompt(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('/home/christaras9126/.local/bin/claude', [
      '-p', prompt, '--max-turns', '3', '--model', 'sonnet',
    ], {
      env: { ...process.env, HOME: '/home/christaras9126' },
      timeout: 90000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin.end()
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('close', code => {
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error(err || `exit ${code}`))
    })
    proc.on('error', reject)
  })
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function init() {
  const msgs = await apiFetch('/discussions?limit=1')
  if (Array.isArray(msgs) && msgs.length > 0) lastId = msgs[0].id
  console.log(`[meeting-runner] Started. Last ID: ${lastId}. Polling every 3s...`)
  console.log(`[meeting-runner] 16 agents loaded. Smart routing active.`)
}

async function poll() {
  if (processing) return
  try {
    const msgs = await apiFetch('/discussions?limit=5')
    if (!Array.isArray(msgs)) return

    const newMsg = msgs.find(m => m.id > lastId && m.author_role === 'admin')
    if (!newMsg) return

    processing = true
    lastId = newMsg.id
    console.log(`[meeting-runner] New #${newMsg.id}: "${newMsg.message.substring(0, 80)}"`)

    const topic = newMsg.topic || 'general'

    // Detect product from topic prefix (e.g. "bokvyx-strategy" → "bokvyx")
    const allProducts = await apiFetch('/products')
    const productNames = (allProducts || []).map(p => p.name)
    const topicProduct = productNames.find(name => topic.startsWith(name + '-')) || ''
    const prodFilter = topicProduct ? `&product=${encodeURIComponent(topicProduct)}` : ''
    const activeProduct = topicProduct ? (allProducts || []).find(p => p.name === topicProduct) : null

    if (topicProduct) {
      console.log(`[meeting-runner] Product context: ${topicProduct}`)
    }

    const [allAgents, leads, learnings, history, channels, pendingActions, templates, sequences, knowledge, recentAllDiscussions, completedActions] = await Promise.all([
      apiFetch('/agent-profiles'),
      apiFetch('/leads?limit=15' + prodFilter),
      apiFetch('/brain/learnings' + (topicProduct ? `?product=${topicProduct}` : '')),
      apiFetch(`/discussions?topic=${encodeURIComponent(topic)}&limit=15`),
      apiFetch('/channels'),
      apiFetch('/actions?status=pending&limit=20' + (topicProduct ? `&product=${topicProduct}` : '')),
      apiFetch('/templates' + (topicProduct ? `?product=${topicProduct}` : '')),
      apiFetch('/sequences' + (topicProduct ? `?product=${topicProduct}` : '')),
      apiFetch('/brain/knowledge' + (topicProduct ? `?product=${topicProduct}` : '')),
      apiFetch('/discussions?limit=30'),
      apiFetch('/actions?status=executed&limit=10'),
    ])
    const products = allProducts

    if (!Array.isArray(allAgents) || allAgents.length === 0) {
      console.log('[meeting-runner] No agent profiles found. Skipping.')
      processing = false
      return
    }

    const selectedAgents = selectAgents(newMsg.message, allAgents)
    const agentNames = selectedAgents.map(a => `${a.avatar} ${a.name}`).join(', ')
    console.log(`[meeting-runner] Selected: ${agentNames}`)

    const agentSections = selectedAgents.map(a => {
      const promptExcerpt = (a.system_prompt || '').substring(0, 1500)
      return `### ${a.avatar} ${a.name} (${a.role}) — ${a.team}\n${a.personality}\n\n${promptExcerpt}`
    }).join('\n\n---\n\n')

    // Full product info — agents need to know everything
    const productList = (products || []).map(p => {
      let info = `- ${p.display_name} (${p.name}) [id=${p.id}]`
      if (p.description) info += `\n  Beskrivning: ${p.description}`
      if (p.pitch) info += `\n  Pitch: ${p.pitch}`
      if (p.features) info += `\n  Features: ${p.features}`
      if (p.pricing) info += `\n  Priser: ${p.pricing}`
      if (p.url) info += `\n  URL: ${p.url}`
      if (p.language) info += `\n  Språk: ${p.language}`
      return info
    }).join('\n\n')

    const leadList = (leads || []).map(l => {
      let info = `- ${l.email} (${l.status})`
      if (l.name) info += ` ${l.name}`
      if (l.company) info += ` @ ${l.company}`
      if (l.notes) info += ` — ${l.notes.substring(0, 100)}`
      if (l.last_contacted_at) info += ` [kontaktad: ${l.last_contacted_at}]`
      return info
    }).join('\n')

    // Templates, sequences, knowledge summaries
    const templateList = (templates || []).length > 0
      ? (templates || []).map(t => `- ${t.name} (${t.type}, ${t.language}) ${t.product_name || ''}`).join('\n')
      : '(inga templates)'
    const sequenceList = (sequences || []).length > 0
      ? (sequences || []).map(s => `- ${s.name}: ${s.description || 'ingen beskrivning'} ${s.enabled ? '(AKTIV)' : '(PAUSAD)'}`).join('\n')
      : '(inga sekvenser)'
    const knowledgeCount = (knowledge || []).length
    const learningList = (learnings || []).length > 0
      ? (learnings || []).slice(0, 10).map(l => `- [${l.category}] ${l.insight} (confidence: ${l.confidence})`).join('\n')
      : '(inga learnings)'
    const historyText = (history || []).map(m => `${m.author_name}: ${m.message}`).join('\n')

    // Team memory — what's been discussed in OTHER topics + executed actions
    const otherTopicMessages = (recentAllDiscussions || [])
      .filter(m => m.topic !== topic && m.author_role !== 'admin')
      .slice(0, 15)
    const teamMemory = otherTopicMessages.length > 0
      ? otherTopicMessages.map(m => `[${m.topic}] ${m.author_name}: ${m.message.substring(0, 120)}`).join('\n')
      : '(inga tidigare diskussioner)'
    const executedList = (completedActions || []).length > 0
      ? (completedActions || []).map(a => {
          let detail = ''
          try { const d = JSON.parse(a.action_data); detail = d.title || d.description || '' } catch {}
          return `- [${a.agent_name}] ${a.action_type}: ${detail}`.substring(0, 120)
        }).join('\n')
      : '(inga utförda actions)'

    // Channel status — what platforms are connected
    const connectedChannels = (channels || []).filter(c => c.enabled)
    const allChannelTypes = ['email', 'sms', 'facebook', 'instagram', 'linkedin', 'reddit', 'tiktok', 'wordpress_forum', 'google_business', 'webhook']
    const connectedTypes = connectedChannels.map(c => c.type)
    const disconnectedTypes = allChannelTypes.filter(t => !connectedTypes.includes(t))
    const channelInfo = connectedChannels.length > 0
      ? `KOPPLADE: ${connectedChannels.map(c => `${c.name} (${c.type})`).join(', ')}`
      : 'INGA KANALER KOPPLADE'
    const disconnectedInfo = disconnectedTypes.length > 0
      ? `EJ KOPPLADE: ${disconnectedTypes.join(', ')}`
      : '(alla kopplade)'

    // Pending actions
    const pendingList = (pendingActions || [])
    const pendingInfo = pendingList.length > 0
      ? pendingList.map(a => `- [${a.agent_name}] ${a.action_type}: ${(a.action_data || '').substring(0, 80)}`).join('\n')
      : '(inga väntande)'

    const prompt = `Du är ett AI-företagsteam i ett strategimöte. Admin (Christos) har skrivit ett meddelande.
${activeProduct ? `\nAKTIVT PROJEKT: ${activeProduct.display_name} (${activeProduct.name})
${activeProduct.description || ''}
${activeProduct.pitch ? 'Pitch: ' + activeProduct.pitch : ''}
${activeProduct.url ? 'URL: ' + activeProduct.url : ''}
${activeProduct.pricing ? 'Priser: ' + activeProduct.pricing : ''}
VIKTIGT: Allt ni diskuterar och föreslår gäller specifikt ${activeProduct.display_name}. Håll fokus på detta projekt.` : 'INGET SPECIFIKT PROJEKT VALT — generell diskussion.'}

NÄRVARANDE AGENTER (bara dessa svarar):
${agentNames}

AGENTPROFILER:
${agentSections}

PRODUKTER (fullständig info):
${productList}

LEADS (${(leads || []).length} st):
${leadList}

EMAIL-TEMPLATES (${(templates || []).length} st):
${templateList}

OUTREACH-SEKVENSER (${(sequences || []).length} st):
${sequenceList}

KUNSKAPSBAS: ${knowledgeCount} inlägg i knowledge base
LEARNINGS (${(learnings || []).length} st):
${learningList}

KANALER (plattformar teamet kan använda):
${channelInfo}
${disconnectedInfo}
VIKTIGT: Om du föreslår att använda en PLATTFORM som INTE är kopplad, MEDDELA admin att den behöver kopplas först via Channels-sidan i dashboarden. Föreslå ALDRIG att posta på en plattform som inte är kopplad utan att nämna detta.

VÄNTANDE ACTIONS I KÖN (${pendingList.length} st):
${pendingInfo}

TEAM-MINNE (viktigt som sagts/beslutats i ANDRA mötesrum):
${teamMemory}

UTFÖRDA ACTIONS (det som redan gjorts):
${executedList}

KONVERSATION I DETTA MÖTESRUM:
${historyText}

NYTT MEDDELANDE FRÅN ADMIN:
${newMsg.message}

REGLER:
- Svara BARA som närvarande agenter (${selectedAgents.map(a => a.name).join(', ')})
- Kort och konkret, max 3-4 meningar per agent
- Specifika förslag med fakta, inte fluff
- Svenska om inte produkten kräver engelska
- Agenterna hjälps åt och bygger på varandras resonemang
- Var ärlig om begränsningar — om en kanal inte är kopplad, säg det
- VIKTIGT: Referera till tidigare diskussioner och beslut från team-minnet om relevant. Upprepa inte saker som redan gjorts.

ACTIONS DU KAN UTFÖRA (hamnar i godkännande-kö):
- create_lead: {email, name?, company?, product_id, source}
- update_lead: {id, status?, notes?}
- create_draft: {product_id, type, title, content}
- create_recommendation: {product_id, title, description, priority}
- assign_task: {to_agent, title, description, priority?}
- save_learning: {product_id?, category, insight}
- book_meeting: {title, contact_name, contact_email, date, time}
- escalate: {title, description, priority}

FORMAT (FÖLJ EXAKT):
Chat: ROLE|NAME|Meddelande
Action: ACTION|ROLE|NAME|action_type|{"json":"data"}|Förklaring

SVARA NU:`

    // Helper: fix role if Claude writes literal "ROLE" or "role" instead of actual role
    function fixRole(role, name) {
      if (role && role !== 'role' && role !== 'chat') return role
      // Look up by name
      const agent = allAgents.find(a => a.name.toLowerCase() === (name || '').toLowerCase())
      return agent ? agent.role : role
    }

    console.log(`[meeting-runner] Calling Claude (${selectedAgents.length} agents)...`)
    const response = await claudePrompt(prompt)
    console.log(`[meeting-runner] Response (${response.length} chars): ${response.substring(0, 200)}...`)

    const parsed = parseResponse(response, allAgents)
    console.log(`[meeting-runner] Parsed ${parsed.length} entries`)

    // Helper: get correct agent name from role
    function fixName(role, rawName) {
      const agent = allAgents.find(a => a.role === role)
      if (agent) return agent.name
      // If rawName looks like a real name (not a role), keep it
      const roleWords = ['coo','cfo','cto','scout','outreach','closer','content','copywriter','seo','strategist','creative_director','secops','support','keeper','pm','analyst','chat','error','role','admin']
      if (rawName && !roleWords.includes(rawName.toLowerCase())) return rawName
      return agent?.name || rawName || 'Sofia'
    }

    for (const entry of parsed) {
      if (entry.type === 'action') {
        const resolvedRole = fixRole(entry.role, entry.name)
        const resolvedName = fixName(resolvedRole, entry.name)
        const queueResult = await apiPost('/actions', {
          agent_role: resolvedRole,
          agent_name: resolvedName,
          action_type: entry.actionType,
          action_data: JSON.stringify(entry.actionData),
          priority: entry.actionData.priority || 'medium',
          product_id: entry.actionData.product_id || null,
        })
        const icon = queueResult.error ? '✗' : '📋'
        await apiPost('/discussions', {
          author_role: resolvedRole,
          author_name: resolvedName,
          message: `${icon} ${entry.message} (i godkännande-kö)`,
          topic,
        })
      } else {
        const resolvedRole = fixRole(entry.role, entry.name)
        const resolvedName = fixName(resolvedRole, entry.name)
        await apiPost('/discussions', {
          author_role: resolvedRole,
          author_name: resolvedName,
          message: entry.message,
          topic,
        })
      }
      await new Promise(r => setTimeout(r, 500))
    }

    if (parsed.length === 0) {
      console.log('[meeting-runner] No parseable entries, posting raw response')
      await apiPost('/discussions', {
        author_role: 'coo',
        author_name: 'Sofia',
        message: response.substring(0, 500),
        topic,
      })
    }

    // ── Auto-learning: extract insights from the conversation ────────
    try {
      const learnPrompt = `Analysera denna AI-team-diskussion och extrahera 0-3 viktiga learnings (insikter) som teamet borde komma ihåg inför framtida diskussioner.

DISKUSSION:
Admin: ${newMsg.message}
${parsed.map(e => `${e.name}: ${e.message}`).join('\n')}

Returnera BARA learnings i detta format (en per rad), eller INGEN om inget nytt lärdes:
LEARNING|agent_role|category|insight

Kategorier: strategy, market_insight, customer_behavior, content_style, pricing, competitor, process, technical, legal

Exempel:
LEARNING|scout|market_insight|Tyska WordPress-byråer föredrar engelska i affärskommunikation
LEARNING|secops|legal|3 av 5 leads saknar dokumenterat consent för marknadsföring

VIKTIGT: Bara RIKTIGA insikter. Inte uppenbart. Inte fluff. Om diskussionen inte gav nya insikter, skriv INGEN.`

      const learnResponse = await claudePrompt(learnPrompt)
      const learnLines = learnResponse.split('\n').filter(l => l.startsWith('LEARNING|'))

      for (const line of learnLines) {
        const parts = line.split('|')
        if (parts.length >= 4) {
          const agentRole = parts[1].trim().toLowerCase()
          const category = parts[2].trim()
          const insight = parts.slice(3).join('|').trim()
          if (insight.length > 10) {
            await apiPost('/brain/learnings', {
              agent_role: agentRole,
              category,
              insight,
              source: 'meeting_discussion',
              product: topicProduct || null,
            })
            console.log(`[meeting-runner] Learning saved: [${agentRole}/${category}] ${insight.substring(0, 60)}`)
          }
        }
      }
    } catch (learnErr) {
      console.log(`[meeting-runner] Auto-learn skipped: ${learnErr.message}`)
    }

  } catch (e) {
    console.error(`[meeting-runner] Error:`, e.message)
  } finally {
    processing = false
  }
}

await init()
setInterval(poll, 3000)
