// Built by Christos Ferlachidis & Daniel Hedenberg

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sales MCP Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>
body{background:#030507;margin:0}
.scrollbar-hide::-webkit-scrollbar{display:none}
.scrollbar-hide{-ms-overflow-style:none;scrollbar-width:none}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useCallback } = React;

const TABS = ['activity','leads','drafts','channels','sequences','templates','products','brain','analytics'];
const LEAD_STATUS_COLORS = {
  new:'bg-blue-500/20 text-blue-300 border-blue-500/30',
  contacted:'bg-amber-500/20 text-amber-300 border-amber-500/30',
  nurturing:'bg-purple-500/20 text-purple-300 border-purple-500/30',
  converted:'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  lost:'bg-red-500/20 text-red-300 border-red-500/30',
  unsubscribed:'bg-gray-500/20 text-gray-400 border-gray-500/30',
};
const DRAFT_STATUS_COLORS = {
  pending:'bg-amber-500/20 text-amber-300 border-amber-500/30',
  approved:'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  rejected:'bg-red-500/20 text-red-300 border-red-500/30',
  posted:'bg-blue-500/20 text-blue-300 border-blue-500/30',
};
const CHANNEL_TYPE_COLORS = {
  email:'bg-blue-500/20 text-blue-300 border-blue-500/30',
  sms:'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  facebook:'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  instagram:'bg-pink-500/20 text-pink-300 border-pink-500/30',
  reddit:'bg-orange-500/20 text-orange-300 border-orange-500/30',
  wordpress_forum:'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  webhook:'bg-gray-500/20 text-gray-300 border-gray-500/30',
};
const ACTION_ICONS = {
  email_sent:'\\u2709\\uFE0F', email_opened:'\\uD83D\\uDCEC', link_clicked:'\\uD83D\\uDD17',
  post_published:'\\uD83D\\uDCDD', lead_created:'\\uD83C\\uDF1F', sms_sent:'\\uD83D\\uDCF1',
  sequence_advanced:'\\u25B6\\uFE0F',
};
const TAB_ICONS = {
  activity:'\\u26A1', leads:'\\uD83C\\uDFAF', drafts:'\\uD83D\\uDCC4', channels:'\\uD83D\\uDCE1',
  sequences:'\\uD83D\\uDD04', templates:'\\uD83D\\uDCC2', products:'\\uD83D\\uDCE6',
  brain:'\\uD83E\\uDDE0', analytics:'\\uD83D\\uDCCA',
};

function App() {
  const [key, setKey] = useState('');
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState('activity');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activity, setActivity] = useState([]);
  const [leads, setLeads] = useState([]);
  const [leadProductFilter, setLeadProductFilter] = useState('');
  const [leadStatusFilter, setLeadStatusFilter] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [draftFilter, setDraftFilter] = useState('pending');
  const [channels, setChannels] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [expandedSeq, setExpandedSeq] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [products, setProducts] = useState([]);
  const [knowledge, setKnowledge] = useState([]);
  const [learnings, setLearnings] = useState([]);
  const [brainProduct, setBrainProduct] = useState('');
  const [stats, setStats] = useState(null);
  const [statsPeriod, setStatsPeriod] = useState('week');
  const [inputKey, setInputKey] = useState('');

  useEffect(() => {
    const stored = sessionStorage.getItem('sales_admin_key');
    if (stored) { setKey(stored); setAuthed(true); }
  }, []);

  const headers = useCallback(() => ({ 'X-Admin-Key': key, 'Content-Type': 'application/json' }), [key]);

  const apiFetch = useCallback(async (path) => {
    const res = await fetch('/api/dashboard' + path, { headers: headers() });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }, [headers]);

  const fmt = (iso) => {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('sv-SE', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  };

  const fetchTabData = useCallback(async () => {
    if (!key) return;
    setLoading(true); setError(null);
    try {
      switch (tab) {
        case 'activity': { const d = await apiFetch('/activity?limit=50'); setActivity(d); break; }
        case 'leads': {
          const p = new URLSearchParams();
          if (leadProductFilter) p.set('product', leadProductFilter);
          if (leadStatusFilter) p.set('status', leadStatusFilter);
          p.set('limit','50');
          setLeads(await apiFetch('/leads?' + p)); break;
        }
        case 'drafts': { setDrafts(await apiFetch('/drafts?status=' + draftFilter)); break; }
        case 'channels': { setChannels(await apiFetch('/channels')); break; }
        case 'sequences': { setSequences(await apiFetch('/sequences')); break; }
        case 'templates': { setTemplates(await apiFetch('/templates')); break; }
        case 'products': { setProducts(await apiFetch('/products')); break; }
        case 'brain': {
          const pp = brainProduct ? '?product=' + brainProduct : '';
          const [k, l] = await Promise.all([apiFetch('/brain/knowledge' + pp), apiFetch('/brain/learnings' + pp)]);
          setKnowledge(k); setLearnings(l); break;
        }
        case 'analytics': { setStats(await apiFetch('/stats?period=' + statsPeriod)); break; }
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [key, tab, apiFetch, leadProductFilter, leadStatusFilter, draftFilter, brainProduct, statsPeriod]);

  useEffect(() => { if (authed) fetchTabData(); }, [authed, tab, fetchTabData]);

  const doLogin = () => {
    if (!inputKey) return;
    sessionStorage.setItem('sales_admin_key', inputKey);
    setKey(inputKey); setAuthed(true);
  };

  if (!authed) return (
    <div className="min-h-screen bg-[#030507] flex items-center justify-center p-4">
      <div className="bg-[#080B12] border border-white/[0.06] rounded-2xl p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white mb-2 text-center"><span className="text-[#4F7EFF]">Sales</span> MCP</h1>
        <p className="text-gray-500 text-sm text-center mb-6">Dashboard</p>
        <input type="password" placeholder="Admin key..." value={inputKey} onChange={e => setInputKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') doLogin(); }}
          className="w-full bg-[#030507] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-600 outline-none focus:border-[#4F7EFF]/50 mb-4 text-sm"/>
        <button onClick={doLogin} className="w-full bg-gradient-to-r from-[#4F7EFF] to-[#6B4FFC] text-white font-semibold py-3 rounded-xl hover:opacity-90 transition">Connect</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#030507] text-white">
      <div className="border-b border-white/[0.06] bg-[#080B12]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold"><span className="text-[#4F7EFF]">Sales</span> MCP</h1>
          <div className="flex items-center gap-3">
            {loading && <span className="text-xs text-[#4F7EFF] animate-pulse">Loading...</span>}
            <button onClick={fetchTabData} className="text-sm text-gray-500 hover:text-white transition">Refresh</button>
            <button onClick={() => { sessionStorage.removeItem('sales_admin_key'); setAuthed(false); setKey(''); }}
              className="text-sm text-gray-600 hover:text-red-400 transition">Disconnect</button>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto scrollbar-hide">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={\`px-3 py-2.5 text-sm font-medium capitalize transition-all border-b-2 whitespace-nowrap flex items-center gap-1.5 \${
                tab === t ? 'border-[#4F7EFF] text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
              }\`}>
              <span className="text-xs">{TAB_ICONS[t]}</span>{t}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-red-400">{error}</div>}

        {/* ACTIVITY */}
        {tab === 'activity' && (
          <div className="space-y-1">
            <h2 className="text-lg font-semibold mb-4">Activity Timeline</h2>
            {activity.length === 0 && !loading ? <p className="text-gray-600 text-center py-12">No recent activity</p> : (
              <div className="space-y-1">{activity.map(a => (
                <div key={a.id} className="flex items-start gap-3 py-3 px-4 rounded-xl hover:bg-white/[0.02] transition">
                  <span className="text-lg mt-0.5 flex-shrink-0 w-7 text-center">{ACTION_ICONS[a.action] || '\\u2022'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200">{a.details || a.action}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-600">{fmt(a.created_at)}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-500">{a.action.replace(/_/g,' ')}</span>
                      {a.product_name && <span className="text-xs text-[#4F7EFF]">{a.product_name}</span>}
                    </div>
                  </div>
                </div>
              ))}</div>
            )}
          </div>
        )}

        {/* LEADS */}
        {tab === 'leads' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h2 className="text-lg font-semibold">Leads</h2>
              <select value={leadProductFilter} onChange={e => setLeadProductFilter(e.target.value)}
                className="bg-[#080B12] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-300 outline-none">
                <option value="">All products</option>
                {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
              <select value={leadStatusFilter} onChange={e => setLeadStatusFilter(e.target.value)}
                className="bg-[#080B12] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-300 outline-none">
                <option value="">All statuses</option>
                {['new','contacted','nurturing','converted','lost','unsubscribed'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={fetchTabData} className="text-xs text-[#4F7EFF] hover:underline">Apply</button>
            </div>
            <div className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-white/[0.06] text-gray-500 text-xs">
                  <th className="text-left p-3">Email</th><th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Company</th><th className="text-left p-3">Product</th>
                  <th className="text-left p-3">Status</th><th className="text-left p-3">Source</th>
                  <th className="text-left p-3">Created</th>
                </tr></thead>
                <tbody>{leads.map(l => (
                  <tr key={l.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="p-3 font-medium text-white">{l.email}</td>
                    <td className="p-3 text-gray-300">{l.name || '-'}</td>
                    <td className="p-3 text-gray-400">{l.company || '-'}</td>
                    <td className="p-3 text-gray-400">{l.product_name || '-'}</td>
                    <td className="p-3"><span className={\`px-2 py-0.5 rounded-full text-xs border \${LEAD_STATUS_COLORS[l.status] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'}\`}>{l.status}</span></td>
                    <td className="p-3 text-gray-500">{l.source || '-'}</td>
                    <td className="p-3 text-gray-500">{fmt(l.created_at)}</td>
                  </tr>
                ))}</tbody>
              </table>
              {leads.length === 0 && !loading && <p className="text-gray-600 text-center py-8">No leads found</p>}
            </div>
          </div>
        )}

        {/* DRAFTS */}
        {tab === 'drafts' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-semibold">Drafts</h2>
              <div className="flex gap-2">{['pending','approved','rejected','posted'].map(s => (
                <button key={s} onClick={() => setDraftFilter(s)}
                  className={\`px-3 py-1.5 rounded-lg text-sm capitalize transition \${draftFilter === s ? 'bg-[#4F7EFF]/20 text-[#4F7EFF] border border-[#4F7EFF]/30' : 'text-gray-500 hover:text-white border border-transparent'}\`}>{s}</button>
              ))}</div>
            </div>
            {drafts.length === 0 && !loading ? <p className="text-gray-600 text-center py-12">No {draftFilter} drafts</p> : (
              <div className="grid gap-4 md:grid-cols-2">{drafts.map(d => (
                <div key={d.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <span className={\`px-2 py-0.5 rounded-full text-xs border \${DRAFT_STATUS_COLORS[d.status] || ''}\`}>{d.status}</span>
                    <span className="px-2 py-0.5 rounded-full text-xs bg-gray-500/20 text-gray-400 border border-gray-500/30">{d.type}</span>
                    {d.product_name && <span className="text-xs text-[#4F7EFF]">{d.product_name}</span>}
                  </div>
                  {d.title && <h3 className="font-semibold text-white mb-2">{d.title}</h3>}
                  <p className="text-sm text-gray-400 line-clamp-4 whitespace-pre-wrap">{d.content}</p>
                  <span className="text-xs text-gray-600 mt-4 block">{fmt(d.created_at)}</span>
                </div>
              ))}</div>
            )}
          </div>
        )}

        {/* CHANNELS */}
        {tab === 'channels' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Channels</h2>
            {channels.length === 0 && !loading ? <p className="text-gray-600 text-center py-12">No channels configured</p> : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{channels.map(c => (
                <div key={c.id} className={\`bg-[#080B12] border border-white/[0.06] rounded-xl p-5 \${!c.enabled ? 'opacity-50' : ''}\`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-white">{c.name}</h3>
                    <span className={\`px-2 py-0.5 rounded-full text-xs border \${c.enabled ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-gray-500/20 text-gray-500 border-gray-500/30'}\`}>
                      {c.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <span className={\`inline-block px-2 py-0.5 rounded-full text-xs border mb-3 \${CHANNEL_TYPE_COLORS[c.type] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'}\`}>{c.type}</span>
                  <div className="text-xs text-gray-500 space-y-1">
                    <p>Last used: {fmt(c.last_used_at)}</p>
                    {c.last_error && <p className="text-red-400 truncate">Error: {c.last_error}</p>}
                  </div>
                </div>
              ))}</div>
            )}
          </div>
        )}

        {/* SEQUENCES */}
        {tab === 'sequences' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Sequences</h2>
            {sequences.length === 0 && !loading ? <p className="text-gray-600 text-center py-12">No sequences configured</p> : (
              <div className="space-y-3">{sequences.map(s => {
                let steps = [];
                try { steps = typeof s.steps === 'string' ? JSON.parse(s.steps) : (s.steps || []); } catch(e) {}
                return (
                  <div key={s.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-hidden">
                    <button onClick={() => setExpandedSeq(expandedSeq === s.id ? null : s.id)}
                      className="w-full px-5 py-4 flex items-center justify-between hover:bg-white/[0.02] transition">
                      <div className="flex items-center gap-3">
                        <span className={\`w-2 h-2 rounded-full \${s.enabled ? 'bg-emerald-400' : 'bg-gray-600'}\`}/>
                        <h3 className="font-semibold text-white text-left">{s.name}</h3>
                        <span className="text-xs text-gray-500">{s.product_name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-500">{steps.length} steps</span>
                        <span className="text-gray-500 text-xs">{expandedSeq === s.id ? '\\u25B2' : '\\u25BC'}</span>
                      </div>
                    </button>
                    {expandedSeq === s.id && steps.length > 0 && (
                      <div className="px-5 pb-4 border-t border-white/[0.04]">
                        <div className="mt-3 space-y-2">{steps.map((step, i) => (
                          <div key={i} className="flex items-center gap-3 text-sm">
                            <span className="text-xs text-gray-600 w-6">{step.order || i+1}.</span>
                            <span className="px-2 py-0.5 rounded text-xs bg-white/[0.04] text-gray-400">{step.type}</span>
                            <span className="text-gray-500">after {step.delay_hours}h</span>
                            <span className="text-gray-400 truncate">{step.template}</span>
                          </div>
                        ))}</div>
                      </div>
                    )}
                  </div>
                );
              })}</div>
            )}
          </div>
        )}

        {/* TEMPLATES */}
        {tab === 'templates' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Templates</h2>
            <div className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-white/[0.06] text-gray-500 text-xs">
                  <th className="text-left p-3">Name</th><th className="text-left p-3">Product</th>
                  <th className="text-left p-3">Type</th><th className="text-left p-3">Language</th>
                  <th className="text-left p-3">Subject</th>
                </tr></thead>
                <tbody>{templates.map(t => (
                  <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="p-3 font-medium text-white">{t.name}</td>
                    <td className="p-3 text-gray-400">{t.product_name || '-'}</td>
                    <td className="p-3"><span className="px-2 py-0.5 rounded-full text-xs bg-white/[0.04] text-gray-400">{t.type}</span></td>
                    <td className="p-3 text-gray-500">{t.language}</td>
                    <td className="p-3 text-gray-400 truncate max-w-xs">{t.subject}</td>
                  </tr>
                ))}</tbody>
              </table>
              {templates.length === 0 && !loading && <p className="text-gray-600 text-center py-8">No templates found</p>}
            </div>
          </div>
        )}

        {/* PRODUCTS */}
        {tab === 'products' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold mb-4">Products</h2>
            {products.length === 0 && !loading ? <p className="text-gray-600 text-center py-12">No products configured</p> : (
              <div className="grid gap-4 md:grid-cols-2">{products.map(p => (
                <div key={p.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-5">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-white">{p.display_name || p.name}</h3>
                    <span className="text-xs text-gray-600">{p.language}</span>
                  </div>
                  <p className="text-sm text-gray-400 mb-3">{p.description}</p>
                  {p.url && <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#4F7EFF] hover:underline mb-3 block truncate">{p.url}</a>}
                  {p.pitch && (
                    <div className="mt-3 pt-3 border-t border-white/[0.04]">
                      <p className="text-xs text-gray-500 mb-1">Pitch</p>
                      <p className="text-sm text-gray-300">{p.pitch}</p>
                    </div>
                  )}
                </div>
              ))}</div>
            )}
          </div>
        )}

        {/* BRAIN */}
        {tab === 'brain' && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Brain</h2>
              <select value={brainProduct} onChange={e => setBrainProduct(e.target.value)}
                className="bg-[#080B12] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-300 outline-none">
                <option value="">All products</option>
                {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
              <button onClick={fetchTabData} className="text-xs text-[#4F7EFF] hover:underline">Apply</button>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Knowledge Base</h3>
              {knowledge.length === 0 && !loading ? <p className="text-gray-600 text-sm">No crawled pages yet</p> : (
                <div className="bg-[#080B12] border border-white/[0.06] rounded-xl overflow-hidden">
                  {knowledge.map(k => (
                    <div key={k.id} className="px-4 py-3 border-b border-white/[0.03] hover:bg-white/[0.02] flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm text-white truncate">{k.title || k.source_url}</p>
                        <p className="text-xs text-gray-600 truncate">{k.source_url}</p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                        <span className="text-xs text-[#4F7EFF]">{k.product_name}</span>
                        <span className="text-xs text-gray-600">{fmt(k.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Learnings</h3>
              {learnings.length === 0 && !loading ? <p className="text-gray-600 text-sm">No learnings recorded yet</p> : (
                <div className="space-y-3">{learnings.map(l => (
                  <div key={l.id} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-[#4F7EFF]">{l.product_name}</span>
                      <span className="text-xs text-gray-600">{fmt(l.created_at)}</span>
                    </div>
                    <p className="text-sm text-gray-300 mb-3">{l.insight}</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                        <div className={\`h-full rounded-full transition-all \${l.confidence >= 0.8 ? 'bg-emerald-500' : l.confidence >= 0.5 ? 'bg-amber-500' : 'bg-red-500'}\`}
                          style={{ width: (l.confidence * 100) + '%' }}/>
                      </div>
                      <span className="text-xs text-gray-500 w-10 text-right">{Math.round(l.confidence * 100)}%</span>
                    </div>
                  </div>
                ))}</div>
              )}
            </div>
          </div>
        )}

        {/* ANALYTICS */}
        {tab === 'analytics' && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Analytics</h2>
              <div className="flex gap-2">{['today','week','month','all'].map(p => (
                <button key={p} onClick={() => setStatsPeriod(p)}
                  className={\`px-3 py-1.5 rounded-lg text-sm capitalize transition \${statsPeriod === p ? 'bg-[#4F7EFF]/20 text-[#4F7EFF] border border-[#4F7EFF]/30' : 'text-gray-500 hover:text-white border border-transparent'}\`}>{p}</button>
              ))}</div>
            </div>
            {stats ? (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {[
                  { label:'Leads', value: stats.leads, color:'text-amber-400' },
                  { label:'Drafts', value: stats.drafts, color:'text-purple-400' },
                  { label:'Activities', value: stats.activities, color:'text-blue-400' },
                  { label:'Email Opens', value: stats.email_opens, color:'text-cyan-400' },
                  { label:'Email Clicks', value: stats.email_clicks, color:'text-indigo-400' },
                ].map((s, i) => (
                  <div key={i} className="bg-[#080B12] border border-white/[0.06] rounded-xl p-4">
                    <p className="text-xs text-gray-500 mb-1">{s.label}</p>
                    <p className={\`text-2xl font-bold \${s.color}\`}>{s.value}</p>
                  </div>
                ))}
              </div>
            ) : !loading ? <p className="text-gray-600 text-center py-12">No analytics data</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body>
</html>`;
}
