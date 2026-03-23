'use client'

import { useState, useEffect, useCallback } from 'react'

/* ─── Types ─── */
interface ActivityEntry {
  id: string
  action: string
  message: string
  timestamp: string
  metadata?: Record<string, unknown>
}

interface Lead {
  id: string
  email: string
  name: string
  company: string
  product: string
  status: string
  source: string
  last_contacted: string | null
  created: string
}

interface Draft {
  id: string
  title: string
  content: string
  type: string
  channel: string
  product: string
  status: string
  created: string
}

interface Channel {
  id: string
  name: string
  type: string
  enabled: boolean
  last_used: string | null
  last_error: string | null
}

interface Sequence {
  id: string
  name: string
  product: string
  enabled: boolean
  steps: { order: number; type: string; delay_hours: number; template: string }[]
}

interface Template {
  id: string
  name: string
  product: string
  type: string
  language: string
  subject: string
}

interface Product {
  id: string
  name: string
  description: string
  url: string
  language: string
  pitch: string
}

interface KnowledgeEntry {
  id: string
  url: string
  product: string
  title: string
  crawled_at: string
}

interface LearningEntry {
  id: string
  product: string
  insight: string
  confidence: number
  created: string
}

interface Stats {
  emails_sent: number
  emails_opened: number
  emails_clicked: number
  leads_created: number
  leads_converted: number
  posts_published: number
  sms_sent: number
}

/* ─── Constants ─── */
const TABS = ['activity', 'leads', 'drafts', 'channels', 'sequences', 'templates', 'products', 'brain', 'analytics', 'settings'] as const
type Tab = typeof TABS[number]

const LEAD_STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  contacted: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  nurturing: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  converted: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  lost: 'bg-red-500/20 text-red-300 border-red-500/30',
  unsubscribed: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
}

const DRAFT_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  approved: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  rejected: 'bg-red-500/20 text-red-300 border-red-500/30',
  posted: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
}

const CHANNEL_TYPE_COLORS: Record<string, string> = {
  email: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  sms: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  facebook: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  instagram: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  reddit: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  wordpress_forum: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  webhook: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
}

const ACTION_ICONS: Record<string, string> = {
  email_sent: '\u2709\uFE0F',
  email_opened: '\uD83D\uDCEC',
  link_clicked: '\uD83D\uDD17',
  post_published: '\uD83D\uDCDD',
  lead_created: '\uD83C\uDF1F',
  sms_sent: '\uD83D\uDCF1',
  sequence_advanced: '\u25B6\uFE0F',
}

// Built by Weblease

/* ─── Component ─── */
export default function SalesDashboard() {
  const [apiUrl, setApiUrl] = useState('')
  const [key, setKey] = useState('')
  const [authed, setAuthed] = useState(false)
  const [tab, setTab] = useState<Tab>('activity')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Data states
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [leadProductFilter, setLeadProductFilter] = useState('')
  const [leadStatusFilter, setLeadStatusFilter] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [draftFilter, setDraftFilter] = useState('pending')
  const [channels, setChannels] = useState<Channel[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [expandedSeq, setExpandedSeq] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [learnings, setLearnings] = useState<LearningEntry[]>([])
  const [brainProduct, setBrainProduct] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsPeriod, setStatsPeriod] = useState('week')
  const [settingsApiUrl, setSettingsApiUrl] = useState('')
  const [settingsKey, setSettingsKey] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)

  // Load stored config
  useEffect(() => {
    const storedUrl = sessionStorage.getItem('sales_api_url') || ''
    const storedKey = sessionStorage.getItem('sales_admin_key') || ''
    setApiUrl(storedUrl)
    setKey(storedKey)
    setSettingsApiUrl(storedUrl)
    setSettingsKey(storedKey)
    if (storedUrl && storedKey) setAuthed(true)
  }, [])

  const headers = useCallback(() => ({
    'X-Admin-Key': key,
    'Content-Type': 'application/json',
  }), [key])

  const apiFetch = useCallback(async (path: string) => {
    if (!apiUrl) return null
    const res = await fetch(`${apiUrl}${path}`, { headers: headers() })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json()
  }, [apiUrl, headers])

  const fmt = (iso: string | null) => {
    if (!iso) return '-'
    return new Date(iso).toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // Fetch data based on active tab
  const fetchTabData = useCallback(async () => {
    if (!apiUrl || !key) return
    setLoading(true)
    setError(null)
    try {
      switch (tab) {
        case 'activity': {
          const data = await apiFetch('/api/dashboard/activity?limit=50')
          if (data) setActivity(data)
          break
        }
        case 'leads': {
          const params = new URLSearchParams()
          if (leadProductFilter) params.set('product', leadProductFilter)
          if (leadStatusFilter) params.set('status', leadStatusFilter)
          params.set('limit', '50')
          const data = await apiFetch(`/api/dashboard/leads?${params}`)
          if (data) setLeads(data)
          break
        }
        case 'drafts': {
          const data = await apiFetch(`/api/dashboard/drafts?status=${draftFilter}`)
          if (data) setDrafts(data)
          break
        }
        case 'channels': {
          const data = await apiFetch('/api/dashboard/channels')
          if (data) setChannels(data)
          break
        }
        case 'sequences': {
          const data = await apiFetch('/api/dashboard/sequences')
          if (data) setSequences(data)
          break
        }
        case 'templates': {
          const data = await apiFetch('/api/dashboard/templates')
          if (data) setTemplates(data)
          break
        }
        case 'products': {
          const data = await apiFetch('/api/dashboard/products')
          if (data) setProducts(data)
          break
        }
        case 'brain': {
          const prodParam = brainProduct ? `?product=${brainProduct}` : ''
          const [k, l] = await Promise.all([
            apiFetch(`/api/dashboard/brain/knowledge${prodParam}`),
            apiFetch(`/api/dashboard/brain/learnings${prodParam}`),
          ])
          if (k) setKnowledge(k)
          if (l) setLearnings(l)
          break
        }
        case 'analytics': {
          const data = await apiFetch(`/api/dashboard/stats?period=${statsPeriod}`)
          if (data) setStats(data)
          break
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    }
    setLoading(false)
  }, [apiUrl, key, tab, apiFetch, leadProductFilter, leadStatusFilter, draftFilter, brainProduct, statsPeriod])

  useEffect(() => {
    if (authed && tab !== 'settings') fetchTabData()
  }, [authed, tab, fetchTabData])

  const saveSettings = () => {
    sessionStorage.setItem('sales_api_url', settingsApiUrl)
    sessionStorage.setItem('sales_admin_key', settingsKey)
    setApiUrl(settingsApiUrl)
    setKey(settingsKey)
    if (settingsApiUrl && settingsKey) setAuthed(true)
  }

  const testConnection = async () => {
    setTestResult(null)
    try {
      const res = await fetch(`${settingsApiUrl}/api/dashboard/stats?period=today`, {
        headers: { 'X-Admin-Key': settingsKey, 'Content-Type': 'application/json' },
      })
      if (res.ok) {
        setTestResult('Connected successfully')
      } else {
        setTestResult(`Failed: ${res.status} ${res.statusText}`)
      }
    } catch (e) {
      setTestResult(`Error: ${e instanceof Error ? e.message : 'Connection failed'}`)
    }
  }

  // Login screen if not configured
  if (!authed) {
    return (
      <div className="min-h-screen bg-[#030507] flex items-center justify-center p-4">
        <div className="bg-[#080B12] border border-white/[0.06] rounded-2xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-white mb-2 text-center">
            <span className="text-[#4F7EFF]">Sales</span> MCP
          </h1>
          <p className="text-gray-500 text-sm text-center mb-6">Dashboard</p>
          <input
            type="text"
            placeholder="API URL (e.g. http://192.168.1.x:3210)"
            value={settingsApiUrl}
            onChange={e => setSettingsApiUrl(e.target.value)}
            className="w-full bg-[#030507] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-600 outline-none focus:border-[#4F7EFF]/50 mb-3 text-sm"
          />
          <input
            type="password"
            placeholder="Admin key..."
            value={settingsKey}
            onChange={e => setSettingsKey(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') saveSettings()
            }}
            className="w-full bg-[#030507] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-600 outline-none focus:border-[#4F7EFF]/50 mb-4 text-sm"
          />
          <button
            onClick={saveSettings}
            className="w-full bg-gradient-to-r from-[#4F7EFF] to-[#6B4FFC] text-white font-semibold py-3 rounded-xl hover:opacity-90 transition"
          >
            Connect
          </button>
          <a href="/chefen" className="block text-center text-sm text-gray-600 mt-4 hover:text-gray-400 transition">
            Back to Admin
          </a>
        </div>
      </div>
    )
  }

  // Tab icons for the nav
  const tabIcons: Record<Tab, string> = {
    activity: '\u26A1',
    leads: '\uD83C\uDFAF',
    drafts: '\uD83D\uDCC4',
    channels: '\uD83D\uDCE1',
    sequences: '\uD83D\uDD04',
    templates: '\uD83D\uDCC2',
    products: '\uD83D\uDCE6',
    brain: '\uD83E\uDDE0',
    analytics: '\uD83D\uDCCA',
    settings: '\u2699\uFE0F',
  }

  return (
    <div className="min-h-screen bg-[#030507] text-white">
      {/* Header */}
      <div className="border-b border-white/[0.06] bg-[#080B12]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/chefen" className="text-gray-500 hover:text-white transition text-sm">&larr; Admin</a>
            <h1 className="text-xl font-bold">
              <span className="text-[#4F7EFF]">Sales</span> MCP
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {loading && <span className="text-xs text-[#4F7EFF] animate-pulse">Loading...</span>}
            <button onClick={fetchTabData} className="text-sm text-gray-500 hover:text-white transition">
              Refresh
            </button>
            <button
              onClick={() => {
                sessionStorage.removeItem('sales_api_url')
                sessionStorage.removeItem('sales_admin_key')
                setAuthed(false)
                setApiUrl('')
                setKey('')
              }}
              className="text-sm text-gray-600 hover:text-red-400 transition"
            >
              Disconnect
            </button>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto scrollbar-hide">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2.5 text-sm font-medium capitalize transition-all border-b-2 whitespace-nowrap flex items-center gap-1.5 ${
                tab === t
                  ? 'border-[#4F7EFF] text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              <span className="text-xs">{tabIcons[t]}</span>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* ─── ACTIVITY TAB ─── */}
        {tab === 'activity' && (
          <div className="space-y-1">
            <h2 className="text-lg font-semibold mb-4">Activity Timeline</h2>
            {activity.length === 0 && !loading ? (
              <p className="text-gray-600 text-center py-12">No recent activity</p>
            ) : (
              <div className="space-y-1">
                {activity.map(a => (
                  <div key={a.id} className="flex items-start gap-3 py-3 px-4 rounded-xl hover:bg-white/[0.02] transition">
                    <span className="text-lg mt-0.5 flex-shrink-0 w-7 text-center">
                      {ACTION_ICONS[a.action] || '\u2022'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200">{a.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-gray-600">{fmt(a.timestamp)}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-500">{a.action.replace(/_/g, ' ')}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── LEADS TAB ─── */}
        {tab === 'leads' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h2 className="text-lg font-semibold">Leads</h2>
              <select
                value={leadProductFilter}
                onChange={e => setLeadProductFilter(e.target.value)}
                className="bg-[#080B12] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-300 outline-none focus:border-[#4F7EFF]/50"
              >
                <option value="">All products</option>
                {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
              <select
                value={leadStatusFilter}
                onChange={e => setLeadStatusFilter(e.target.value)}
                className="bg-[#080B12] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-300 outline-none focus:border-[#4F7EFF]/50"
              >
                <option value="">All statuses</option>
                {['new', 'contacted', 'nurturing', 'converted', 'lost', 'unsubscribed'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button onClick={fetchTabData} className="text-xs text-[#4F7EFF] hover:underline">Apply</button>
            </div>

            <div className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs">
                    <th className="text-left p-3">Email</th>
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Company</th>
                    <th className="text-left p-3">Product</th>
                    <th className="text-left p-3">Status</th>
                    <th className="text-left p-3">Source</th>
                    <th className="text-left p-3">Last Contact</th>
                    <th className="text-left p-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map(l => (
                    <tr key={l.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="p-3 font-medium text-white">{l.email}</td>
                      <td className="p-3 text-gray-300">{l.name || '-'}</td>
                      <td className="p-3 text-gray-400">{l.company || '-'}</td>
                      <td className="p-3 text-gray-400">{l.product}</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs border ${LEAD_STATUS_COLORS[l.status] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                          {l.status}
                        </span>
                      </td>
                      <td className="p-3 text-gray-500">{l.source || '-'}</td>
                      <td className="p-3 text-gray-500">{fmt(l.last_contacted)}</td>
                      <td className="p-3 text-gray-500">{fmt(l.created)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {leads.length === 0 && !loading && <p className="text-gray-600 text-center py-8">No leads found</p>}
            </div>
          </div>
        )}

        {/* ─── DRAFTS TAB ─── */}
        {tab === 'drafts' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-semibold">Drafts</h2>
              <div className="flex gap-2">
                {['pending', 'approved', 'rejected', 'posted'].map(s => (
                  <button
                    key={s}
                    onClick={() => setDraftFilter(s)}
                    className={`px-3 py-1.5 rounded-lg text-sm capitalize transition ${
                      draftFilter === s
                        ? 'bg-[#4F7EFF]/20 text-[#4F7EFF] border border-[#4F7EFF]/30'
                        : 'text-gray-500 hover:text-white border border-transparent'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {drafts.length === 0 && !loading ? (
              <p className="text-gray-600 text-center py-12">No {draftFilter} drafts</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {drafts.map(d => (
                  <div key={d.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs border ${DRAFT_STATUS_COLORS[d.status] || ''}`}>{d.status}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs bg-gray-500/20 text-gray-400 border border-gray-500/30">{d.type}</span>
                      {d.channel && <span className="text-xs text-gray-600">{d.channel}</span>}
                      {d.product && <span className="text-xs text-[#4F7EFF]">{d.product}</span>}
                    </div>
                    {d.title && <h3 className="font-semibold text-white mb-2">{d.title}</h3>}
                    <p className="text-sm text-gray-400 line-clamp-4 whitespace-pre-wrap">{d.content}</p>
                    <div className="flex items-center justify-between mt-4">
                      <span className="text-xs text-gray-600">{fmt(d.created)}</span>
                      {d.status === 'pending' && (
                        <div className="flex gap-2">
                          <button className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs hover:bg-emerald-500/20 transition">
                            Approve
                          </button>
                          <button className="px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-xs hover:bg-red-500/20 transition">
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── CHANNELS TAB ─── */}
        {tab === 'channels' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Channels</h2>
            {channels.length === 0 && !loading ? (
              <p className="text-gray-600 text-center py-12">No channels configured</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {channels.map(c => (
                  <div key={c.id} className={`bg-[#080B12] border border-white/[0.06] rounded-xl p-5 ${!c.enabled ? 'opacity-50' : ''}`}>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-white">{c.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs border ${c.enabled ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-gray-500/20 text-gray-500 border-gray-500/30'}`}>
                        {c.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs border mb-3 ${CHANNEL_TYPE_COLORS[c.type] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                      {c.type}
                    </span>
                    <div className="text-xs text-gray-500 space-y-1">
                      <p>Last used: {fmt(c.last_used)}</p>
                      {c.last_error && <p className="text-red-400 truncate">Error: {c.last_error}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── SEQUENCES TAB ─── */}
        {tab === 'sequences' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Sequences</h2>
            {sequences.length === 0 && !loading ? (
              <p className="text-gray-600 text-center py-12">No sequences configured</p>
            ) : (
              <div className="space-y-3">
                {sequences.map(s => (
                  <div key={s.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedSeq(expandedSeq === s.id ? null : s.id)}
                      className="w-full px-5 py-4 flex items-center justify-between hover:bg-white/[0.02] transition"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${s.enabled ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                        <h3 className="font-semibold text-white text-left">{s.name}</h3>
                        <span className="text-xs text-gray-500">{s.product}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-500">{s.steps?.length || 0} steps</span>
                        <span className="text-gray-500 text-xs">{expandedSeq === s.id ? '\u25B2' : '\u25BC'}</span>
                      </div>
                    </button>
                    {expandedSeq === s.id && s.steps && (
                      <div className="px-5 pb-4 border-t border-white/[0.04]">
                        <div className="mt-3 space-y-2">
                          {s.steps.map((step, i) => (
                            <div key={i} className="flex items-center gap-3 text-sm">
                              <span className="text-xs text-gray-600 w-6">{step.order || i + 1}.</span>
                              <span className="px-2 py-0.5 rounded text-xs bg-white/[0.04] text-gray-400">{step.type}</span>
                              <span className="text-gray-500">after {step.delay_hours}h</span>
                              <span className="text-gray-400 truncate">{step.template}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── TEMPLATES TAB ─── */}
        {tab === 'templates' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Templates</h2>
            <div className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs">
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Product</th>
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Language</th>
                    <th className="text-left p-3">Subject</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map(t => (
                    <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="p-3 font-medium text-white">{t.name}</td>
                      <td className="p-3 text-gray-400">{t.product}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded-full text-xs bg-white/[0.04] text-gray-400">{t.type}</span>
                      </td>
                      <td className="p-3 text-gray-500">{t.language}</td>
                      <td className="p-3 text-gray-400 truncate max-w-xs">{t.subject}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {templates.length === 0 && !loading && <p className="text-gray-600 text-center py-8">No templates found</p>}
            </div>
          </div>
        )}

        {/* ─── PRODUCTS TAB ─── */}
        {tab === 'products' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Products</h2>
            {products.length === 0 && !loading ? (
              <p className="text-gray-600 text-center py-12">No products configured</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {products.map(p => (
                  <div key={p.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-5">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="font-semibold text-white">{p.name}</h3>
                      <span className="text-xs text-gray-600">{p.language}</span>
                    </div>
                    <p className="text-sm text-gray-400 mb-3">{p.description}</p>
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#4F7EFF] hover:underline mb-3 block truncate">
                        {p.url}
                      </a>
                    )}
                    {p.pitch && (
                      <div className="mt-3 pt-3 border-t border-white/[0.04]">
                        <p className="text-xs text-gray-500 mb-1">Pitch</p>
                        <p className="text-sm text-gray-300 line-clamp-3">{p.pitch}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── BRAIN TAB ─── */}
        {tab === 'brain' && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Brain</h2>
              <select
                value={brainProduct}
                onChange={e => setBrainProduct(e.target.value)}
                className="bg-[#080B12] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-300 outline-none focus:border-[#4F7EFF]/50"
              >
                <option value="">All products</option>
                {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
              <button onClick={fetchTabData} className="text-xs text-[#4F7EFF] hover:underline">Apply</button>
            </div>

            {/* Knowledge */}
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Knowledge Base</h3>
              {knowledge.length === 0 && !loading ? (
                <p className="text-gray-600 text-sm">No crawled pages yet</p>
              ) : (
                <div className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-hidden">
                  {knowledge.map(k => (
                    <div key={k.id} className="px-4 py-3 border-b border-white/[0.03] hover:bg-white/[0.02] flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm text-white truncate">{k.title || k.url}</p>
                        <p className="text-xs text-gray-600 truncate">{k.url}</p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                        <span className="text-xs text-[#4F7EFF]">{k.product}</span>
                        <span className="text-xs text-gray-600">{fmt(k.crawled_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Learnings */}
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Learnings</h3>
              {learnings.length === 0 && !loading ? (
                <p className="text-gray-600 text-sm">No learnings recorded yet</p>
              ) : (
                <div className="space-y-3">
                  {learnings.map(l => (
                    <div key={l.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-[#4F7EFF]">{l.product}</span>
                        <span className="text-xs text-gray-600">{fmt(l.created)}</span>
                      </div>
                      <p className="text-sm text-gray-300 mb-3">{l.insight}</p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              l.confidence >= 80 ? 'bg-emerald-500' : l.confidence >= 50 ? 'bg-amber-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${l.confidence}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-10 text-right">{l.confidence}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── ANALYTICS TAB ─── */}
        {tab === 'analytics' && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Analytics</h2>
              <div className="flex gap-2">
                {['today', 'week', 'month', 'all'].map(p => (
                  <button
                    key={p}
                    onClick={() => setStatsPeriod(p)}
                    className={`px-3 py-1.5 rounded-lg text-sm capitalize transition ${
                      statsPeriod === p
                        ? 'bg-[#4F7EFF]/20 text-[#4F7EFF] border border-[#4F7EFF]/30'
                        : 'text-gray-500 hover:text-white border border-transparent'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {stats ? (
              <>
                {/* Stat cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
                  {[
                    { label: 'Emails Sent', value: stats.emails_sent, color: 'text-blue-400' },
                    { label: 'Opened', value: `${stats.emails_opened}${stats.emails_sent > 0 ? ` (${Math.round(stats.emails_opened / stats.emails_sent * 100)}%)` : ''}`, color: 'text-cyan-400' },
                    { label: 'Clicked', value: stats.emails_clicked, color: 'text-indigo-400' },
                    { label: 'Leads Created', value: stats.leads_created, color: 'text-amber-400' },
                    { label: 'Converted', value: stats.leads_converted, color: 'text-emerald-400' },
                    { label: 'Posts', value: stats.posts_published, color: 'text-purple-400' },
                    { label: 'SMS Sent', value: stats.sms_sent, color: 'text-pink-400' },
                  ].map((s, i) => (
                    <div key={i} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-4">
                      <p className="text-xs text-gray-500 mb-1">{s.label}</p>
                      <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                    </div>
                  ))}
                </div>

                {/* Bar chart */}
                <div className="bg-[#080B12] border border-white/[0.06] rounded-xl p-6">
                  <h3 className="text-sm font-semibold text-gray-400 mb-4">Distribution</h3>
                  {(() => {
                    const bars = [
                      { label: 'Emails', value: stats.emails_sent, color: 'bg-blue-500' },
                      { label: 'Opened', value: stats.emails_opened, color: 'bg-cyan-500' },
                      { label: 'Clicked', value: stats.emails_clicked, color: 'bg-indigo-500' },
                      { label: 'Leads', value: stats.leads_created, color: 'bg-amber-500' },
                      { label: 'Converted', value: stats.leads_converted, color: 'bg-emerald-500' },
                      { label: 'Posts', value: stats.posts_published, color: 'bg-purple-500' },
                      { label: 'SMS', value: stats.sms_sent, color: 'bg-pink-500' },
                    ]
                    const max = Math.max(...bars.map(b => b.value), 1)
                    return (
                      <div className="space-y-3">
                        {bars.map((b, i) => (
                          <div key={i} className="flex items-center gap-3">
                            <span className="text-xs text-gray-500 w-20 text-right">{b.label}</span>
                            <div className="flex-1 h-6 bg-white/[0.03] rounded overflow-hidden">
                              <div
                                className={`h-full ${b.color} rounded transition-all`}
                                style={{ width: `${(b.value / max) * 100}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-400 w-10">{b.value}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              </>
            ) : !loading ? (
              <p className="text-gray-600 text-center py-12">No analytics data</p>
            ) : null}
          </div>
        )}

        {/* ─── SETTINGS TAB ─── */}
        {tab === 'settings' && (
          <div className="max-w-lg space-y-6">
            <h2 className="text-lg font-semibold">Settings</h2>

            <div className="bg-[#080B12] border border-white/[0.06] rounded-xl p-6 space-y-4">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">API URL</label>
                <input
                  type="text"
                  placeholder="http://192.168.1.x:3210"
                  value={settingsApiUrl}
                  onChange={e => setSettingsApiUrl(e.target.value)}
                  className="w-full bg-[#030507] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-600 outline-none focus:border-[#4F7EFF]/50 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Admin Key</label>
                <input
                  type="password"
                  placeholder="Your admin key"
                  value={settingsKey}
                  onChange={e => setSettingsKey(e.target.value)}
                  className="w-full bg-[#030507] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-600 outline-none focus:border-[#4F7EFF]/50 text-sm"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={saveSettings}
                  className="px-4 py-2.5 bg-gradient-to-r from-[#4F7EFF] to-[#6B4FFC] text-white font-semibold rounded-xl hover:opacity-90 transition text-sm"
                >
                  Save
                </button>
                <button
                  onClick={testConnection}
                  className="px-4 py-2.5 bg-[#4F7EFF]/10 text-[#4F7EFF] border border-[#4F7EFF]/20 rounded-xl hover:bg-[#4F7EFF]/20 transition text-sm"
                >
                  Test Connection
                </button>
              </div>
              {testResult && (
                <p className={`text-sm ${testResult.startsWith('Connected') ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResult}
                </p>
              )}
            </div>

            <div className="bg-[#080B12] border border-white/[0.06] rounded-xl p-6">
              <h3 className="font-semibold text-white mb-2">Connection Info</h3>
              <div className="text-sm text-gray-500 space-y-1">
                <p>API: {apiUrl || 'Not configured'}</p>
                <p>Key: {key ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : 'Not set'}</p>
                <p>Status: {authed ? <span className="text-emerald-400">Connected</span> : <span className="text-gray-600">Disconnected</span>}</p>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
