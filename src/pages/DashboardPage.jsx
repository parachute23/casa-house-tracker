import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { TrendingUp, AlertTriangle } from 'lucide-react'

const fmt = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export default function DashboardPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const [
      { data: mortgage },
      { data: mortgagePayments },
      { data: projects },
      { data: bills },
      { data: payments },
      { data: profiles }
    ] = await Promise.all([
      supabase.from('mortgage').select('*').single(),
      supabase.from('mortgage_payments').select('*, paid_by:profiles(full_name)'),
      supabase.from('projects').select('*'),
      supabase.from('bills').select('*'),
      supabase.from('payments').select('*, paid_by:profiles(full_name, id)'),
      supabase.from('profiles').select('*')
    ])

    const totalMortgagePaid = (mortgagePayments || []).reduce((s, p) => s + p.amount, 0)
    const totalBudget = (projects || []).reduce((s, p) => s + (p.contract_amount || 0), 0)
    const totalBilled = (bills || []).reduce((s, b) => s + b.total_amount, 0)
    const totalPaid = (payments || []).reduce((s, p) => s + p.amount, 0)

    const contribMap = {}
    ;(profiles || []).forEach(p => { contribMap[p.id] = { name: p.full_name, renovation: 0, mortgage: 0 } })
    ;(payments || []).forEach(p => {
      const id = p.paid_by?.id || p.paid_by
      if (contribMap[id]) contribMap[id].renovation += p.amount
    })
    ;(mortgagePayments || []).forEach(p => {
      const id = p.paid_by?.id || p.paid_by
      if (contribMap[id]) contribMap[id].mortgage += p.amount
    })

    const monthlyMap = {}
    ;(payments || []).forEach(p => {
      const m = p.payment_date?.slice(0, 7)
      if (m) monthlyMap[m] = (monthlyMap[m] || 0) + p.amount
    })
    const chartData = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, amount]) => ({ month: month.slice(5), amount }))

    const deviationProjects = (projects || []).map(proj => {
      const billed = (bills || []).filter(b => b.project_id === proj.id).reduce((s, b) => s + b.total_amount, 0)
      const deviation = proj.contract_amount ? ((billed - proj.contract_amount) / proj.contract_amount * 100) : 0
      return { ...proj, billed, deviation }
    })

    setData({
      mortgage, totalMortgagePaid,
      totalBudget, totalBilled, totalPaid,
      contribs: Object.values(contribMap),
      chartData,
      projects: deviationProjects,
      payments
    })
    setLoading(false)
  }

  if (loading) return <div className="empty-state"><div className="empty-icon">⏳</div><div className="empty-text">Loading…</div></div>
  if (!data) return null

  const totalSpend = data.totalPaid + data.totalMortgagePaid

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Dashboard</div>
        <div className="page-subtitle">Overview of all house expenses</div>
      </div>

      <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
        {[
          { label: 'Total House Spend', value: fmt(totalSpend), sub: 'all-time', icon: '🏠' },
          { label: 'Renovation Budget', value: fmt(data.totalBudget), sub: `${fmt(data.totalBilled)} billed`, icon: '🔨' },
          { label: 'Renovation Paid', value: fmt(data.totalPaid), sub: `${fmt(data.totalBudget - data.totalPaid)} remaining`, icon: '✅' },
          { label: 'Mortgage Paid', value: fmt(data.totalMortgagePaid), sub: data.mortgage ? `${fmt(data.mortgage.monthly_payment)}/mo` : 'Not set up', icon: '🏦' },
        ].map((stat, i) => (
          <div key={i} className="card">
            <div style={{ fontSize: '1.3rem', marginBottom: '0.5rem' }}>{stat.icon}</div>
            <div className="stat-label">{stat.label}</div>
            <div className="stat-value" style={{ fontSize: '1.4rem' }}>{stat.value}</div>
            <div className="stat-sub">{stat.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid-2" style={{ marginBottom: '1.5rem' }}>
        <div className="card">
          <div className="card-title">💑 Who Paid What</div>
          {data.contribs.length === 0 ? (
            <div className="empty-state"><div className="empty-text">No payments recorded yet</div></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {data.contribs.map((person, i) => {
                const total = person.renovation + person.mortgage
                const allTotal = data.contribs.reduce((s, p) => s + p.renovation + p.mortgage, 0)
                const pct = allTotal > 0 ? (total / allTotal * 100) : 0
                return (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(200,169,110,0.15)', border: '1px solid rgba(200,169,110,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: '#c8a96e' }}>{person.name?.[0]}</div>
                        <span style={{ fontSize: '0.88rem' }}>{person.name}</span>
                      </div>
                      <span style={{ fontSize: '0.88rem', color: '#c8a96e' }}>{fmt(total)} ({pct.toFixed(0)}%)</span>
                    </div>
                    <div style={{ height: '4px', background: '#1a1a2c', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #c8a96e, #e2c48a)', borderRadius: '4px' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '1rem', marginTop: '0.35rem', fontSize: '0.72rem', color: '#5a5060' }}>
                      <span>🔨 {fmt(person.renovation)} renovation</span>
                      <span>🏦 {fmt(person.mortgage)} mortgage</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title"><TrendingUp size={16} /> Monthly Renovation Payments</div>
          {data.chartData.length === 0 ? (
            <div className="empty-state"><div className="empty-text">No payment data yet</div></div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={data.chartData}>
                <defs>
                  <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#c8a96e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#c8a96e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" tick={{ fill: '#5a5060', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#5a5060', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${v/1000}k`} />
                <Tooltip contentStyle={{ background: '#1a1a2c', border: '1px solid rgba(200,169,110,0.2)', borderRadius: 8, color: '#e8dcc8' }} formatter={v => [fmt(v), 'Paid']} />
                <Area type="monotone" dataKey="amount" stroke="#c8a96e" strokeWidth={2} fill="url(#goldGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title"><AlertTriangle size={16} /> Renovation Projects — Budget vs. Billed</div>
        {data.projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔨</div>
            <div className="empty-text">No projects yet — <span style={{ color: '#c8a96e', cursor: 'pointer' }} onClick={() => navigate('/projects/new')}>create your first one</span></div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Project</th><th>Status</th><th>Budget</th><th>Billed</th><th>Deviation</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map(proj => {
                const paid = (data.payments || []).filter(p => p.project_id === proj.id).reduce((s, p) => s + p.amount, 0)
                const devPct = proj.deviation
                return (
                  <tr key={proj.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${proj.id}`)}>
                    <td style={{ fontWeight: 500 }}>{proj.name}</td>
                    <td><span className={`badge ${proj.status === 'active' ? 'badge-green' : proj.status === 'completed' ? 'badge-muted' : 'badge-amber'}`}>{proj.status}</span></td>
                    <td>{fmt(proj.contract_amount || 0)}</td>
                    <td>{fmt(proj.billed)}</td>
                    <td><span className={devPct > 10 ? 'amount-negative' : devPct > 0 ? 'amount-warning' : 'amount-positive'}>{devPct > 0 ? '+' : ''}{devPct.toFixed(1)}%</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
