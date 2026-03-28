export interface ParsedChat {
  type: 'chat'
  role: string
  name: string
  message: string
}

export interface ParsedAction {
  type: 'action'
  role: string
  name: string
  actionType: string
  actionData: Record<string, unknown>
  message: string
}

export type ParsedEntry = ParsedChat | ParsedAction

const STRUCTURED_LINE_PATTERN = /^(ACTION\|)?[A-Za-z_]+\|[A-Za-z_]+\|/
const AGENT_MARKDOWN_PATTERN = /\*\*([A-Za-z_]+)\s*\|/
const AGENT_COLON_PATTERN = /^([A-Za-z_]+):/

function hasStructuredLines(response: string): boolean {
  const lines = response.split('\n').filter((l) => l.trim().length > 0)
  const matchCount = lines.filter((l) => STRUCTURED_LINE_PATTERN.test(l.trim())).length
  return matchCount >= 1 && matchCount / lines.length > 0.3
}

function extractJsonObject(text: string): { json: Record<string, unknown>; rest: string } | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1)
        try {
          const parsed = JSON.parse(jsonStr)
          const rest = text.slice(i + 1).replace(/^\|/, '').trim()
          return { json: parsed, rest }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// Built by Christos Ferlachidis & Daniel Hedenberg

function parseActionLine(line: string): ParsedAction | null {
  const stripped = line.replace(/^ACTION\|/, '')
  const parts = stripped.split('|')
  if (parts.length < 4) return null

  const role = parts[0].toLowerCase()
  const name = parts[1]
  const actionType = parts[2]

  const remainder = parts.slice(3).join('|')
  const extracted = extractJsonObject(remainder)
  if (!extracted) return null

  return {
    type: 'action',
    role,
    name,
    actionType,
    actionData: extracted.json,
    message: extracted.rest,
  }
}

function parseChatLine(line: string): ParsedChat | null {
  const parts = line.split('|')
  if (parts.length < 3) return null

  const role = parts[0].toLowerCase()
  const name = parts[1]
  const message = parts.slice(2).join('|').trim()

  if (message.length < 3) return null

  return { type: 'chat', role, name, message }
}

function parseStructured(response: string): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  const lines = response.split('\n').filter((l) => l.trim().length > 0)

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line.startsWith('ACTION|')) {
      const action = parseActionLine(line)
      if (action) entries.push(action)
    } else if (line.includes('|')) {
      const chat = parseChatLine(line)
      if (chat) entries.push(chat)
    }
  }

  return entries
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseFreeform(response: string): ParsedEntry[] {
  let role = 'coo'
  let name = 'COO'

  const mdMatch = response.match(AGENT_MARKDOWN_PATTERN)
  if (mdMatch) {
    name = mdMatch[1].trim()
    role = name.toLowerCase()
  } else {
    const colonMatch = response.match(AGENT_COLON_PATTERN)
    if (colonMatch) {
      name = colonMatch[1].trim()
      role = name.toLowerCase()
    }
  }

  let message = cleanMarkdown(response)
  if (message.length > 500) {
    message = message.slice(0, 500)
  }

  return [{ type: 'chat', role, name, message }]
}

export function parseResponse(response: string): ParsedEntry[] {
  if (!response || response.trim().length === 0) return []

  if (hasStructuredLines(response)) {
    const entries = parseStructured(response)
    if (entries.length > 0) return entries
  }

  return parseFreeform(response)
}
