import type { AgentProfile } from './profiles.js'

// ── Team keyword definitions ────────────────────────────────────────────────

export const TEAM_KEYWORDS: Record<string, string[]> = {
  sales: [
    'lead', 'kund', 'prospect', 'outreach', 'kontakt', 'deal',
    'avslut', 'sälja', 'möte', 'customer', 'client', 'försäljning',
  ],
  marketing: [
    'content', 'blogg', 'seo', 'kampanj', 'social media', 'nyhetsbrev',
    'annons', 'copy', 'landing page', 'marketing', 'marknadsföring',
  ],
  creative: [
    'varumärke', 'brand', 'design', 'layout', 'ux', 'ton',
    'färg', 'font', 'ui', 'identitet', 'stil',
  ],
  security: [
    'säkerhet', 'gdpr', 'audit', 'sårbarhet', 'consent',
    'kryptering', 'compliance', 'dataskydd', 'pii',
  ],
  customer: [
    'support', 'klagomål', 'churn', 'nöjd', 'recension',
    'retention', 'kundservice', 'hjälp',
  ],
  executive: [
    'budget', 'ekonomi', 'q1', 'q2', 'q3', 'q4', 'rapport',
    'intäkt', 'kostnad', 'roi', 'tech debt', 'arkitektur',
  ],
  operations: [
    'roadmap', 'prioritering', 'deadline', 'plan', 'uppgift',
    'projekt', 'leverans', 'sprint',
  ],
  intelligence: [
    'data', 'trend', 'analys', 'marknad', 'statistik',
    'konvertering', 'siffror', 'mätning',
  ],
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Built by Christos Ferlachidis & Daniel Hedenberg

function countKeywordMatches(text: string, keywords: string[]): number {
  let count = 0
  for (const kw of keywords) {
    if (text.includes(kw)) {
      count++
    }
  }
  return count
}

function agentFocusScore(agent: AgentProfile, text: string): number {
  if (!agent.focusKeywords || agent.focusKeywords.length === 0) return 0
  return countKeywordMatches(text, agent.focusKeywords.map(k => k.toLowerCase()))
}

// ── Main router ─────────────────────────────────────────────────────────────

/**
 * Select which agents should respond to a message in the Meeting Room.
 * Uses keyword matching against team definitions and agent focus keywords.
 *
 * Returns 2-5 agents sorted by relevance.
 */
export function routeMessage(message: string, agents: AgentProfile[]): AgentProfile[] {
  const lower = message.toLowerCase()

  // 1. Score each team by keyword matches
  const teamScores: { team: string; score: number }[] = Object.entries(TEAM_KEYWORDS)
    .map(([team, keywords]) => ({
      team,
      score: countKeywordMatches(lower, keywords),
    }))
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score)

  // 2. No matches — default to COO + Strategist
  if (teamScores.length === 0) {
    const coo = agents.find(a => a.role === 'coo')
    const strategist = agents.find(a => a.role === 'strategist')
    const defaults: AgentProfile[] = []
    if (coo) defaults.push(coo)
    if (strategist) defaults.push(strategist)
    if (defaults.length >= 2) return defaults
    // Fallback: just return first 2 agents
    return agents.slice(0, 2)
  }

  // 3. Pick best agent per team, optionally 2 for high-scoring teams
  const selected: AgentProfile[] = []
  const selectedRoles = new Set<string>()

  for (const { team, score } of teamScores) {
    const teamAgents = agents
      .filter(a => a.team === team && !selectedRoles.has(a.role))
      .sort((a, b) => agentFocusScore(b, lower) - agentFocusScore(a, lower))

    if (teamAgents.length === 0) continue

    // Always pick the best agent from this team
    selected.push(teamAgents[0])
    selectedRoles.add(teamAgents[0].role)

    // 5. If a team scores 3+ keyword matches, include 2 agents
    if (score >= 3 && teamAgents.length > 1) {
      selected.push(teamAgents[1])
      selectedRoles.add(teamAgents[1].role)
    }
  }

  // 6. If 3+ teams involved, always add COO
  if (teamScores.length >= 3 && !selectedRoles.has('coo')) {
    const coo = agents.find(a => a.role === 'coo')
    if (coo) {
      selected.push(coo)
      selectedRoles.add(coo.role)
    }
  }

  // 7. Ensure minimum 2 agents
  if (selected.length < 2) {
    for (const agent of agents) {
      if (selectedRoles.has(agent.role)) continue
      selected.push(agent)
      selectedRoles.add(agent.role)
      if (selected.length >= 2) break
    }
  }

  // 7. Cap at maximum 5 agents
  return selected.slice(0, 5)
}
