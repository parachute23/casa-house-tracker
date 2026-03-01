import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const fmt = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export default function PaymentsPage() {
  const [payments, setPayments] = useState([])
  const [projects, setProjects] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterProject, setFilterProject] = useState('')
  const [filterPerson, setFilterPerson] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const navigate = useNavigate()

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const [{ data: py }, { data: pr }, { data: pf }] = await Promise.all([
      supabase.from('payments').select('*, paid_by:profiles(id, full_name), project:projects(id, name)').order('payment_date', { ascending: false }),
      supabase.from('projects').select('id, name').order('name'),
      supabase.from('profiles').select('*')
    ])
    setPayments(py || [])
    setProjects(pr || [])
    setProfiles(pf || [])
    setLoading(false)
  }

  const filtered = payments.filter(p => {
    if (filterProject && p.project_id !== filterProject) return false
    if (filterPerson && (p.paid_by?.id || p.paid_by) !== filterPerson) return false
    if (filterFrom && p.payment_date < filterFrom) return false
    if (filterTo && p.payment_date > filterTo) return false
    return true
  })

  const totalFiltered = filtered.reduce((s, p) => s + p.amount, 0)

  const contribMap = {}
  profiles.forEach(p => { contribMap[p.id] = { name: p.full_name, total: 0 } })
  filtered.forEach(p => {
    const id = p.paid_by?.id || p.paid_by
    if (contribMap[id]) contribMap[id].total += p.amount
  })

  if (loading) return <div className="empty-state"><div className="empty-text">Loading…</div></div>

  return (
    <div>
      <div className="page-header">
        <div className="page-title">All Payments</div>
        <div className="page-subtitle">{filtered.length} payments · {fmt(totalFiltered)} total</div>
      </div>

      {/* Contribution summary */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-title">💑 Contributions</div>
        <div style={{ display: 'flex', gap: '2rem' }}>
          {Object.values(contribMap).map((person, i) => {
            const pct = totalFiltered > 0 ? person.total / totalFiltered * 100 : 0
            return (
              <div key={i} style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', marginBottom: '0.3rem' }}>
                  <span>{person.name}</span>
                  <span style={{ color: '#c8a96e' }}>{fmt(person.total)} ({pct.toFixed(0)}%)</span>
                </div>
                <div style={{ height: '4px', background: '#1a1a2c', borderRadius: '4px' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #c8a96e, #e2c48a)', borderRadius: '4px' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="grid-4" style={{ gap: '1rem' }}>
          <div className="form-group">
            <label className="form-label">PROJECT</label>
            <select className="form-select" value={filterProject} onChange={e => setFilterProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">PAID BY</label>
            <select className="form-select" value={filterPerson} onChange={e => setFilterPerson(e.target.value)}>
              <option value="">Everyone</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">FROM</label>
            <input className="form-input" type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">TO</label>
            <input className="form-input" type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} />
          </div>
        </div>
        {(filterProject || filterPerson || filterFrom || filterTo) && (
          <button className="btn btn-ghost" style={{ marginTop: '0.75rem', fontSize: '0.78rem' }} onClick={() => { setFilterProject(''); setFilterPerson(''); setFilterFrom(''); setFilterTo('') }}>
            Clear filters
          </button>
        )}
      </div>

      {/* Payments table */}
      <div className="card">
        {filtered.length === 0 ? (
          <div className="empty-state"><div className="empty-text">No payments match your filters</div></div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Project</th><th>Amount</th><th>Paid By</th><th>Method</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${p.project_id}`)}>
                  <td style={{ color: '#8a8090' }}>{p.payment_date}</td>
                  <td style={{ fontWeight: 500 }}>{p.project?.name || '—'}</td>
                  <td style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.05rem' }}>{fmt(p.amount)}</td>
                  <td style={{ color: '#8a8090' }}>{p.paid_by?.full_name || '—'}</td>
                  <td style={{ color: '#5a5060' }}>{p.payment_method || '—'}</td>
                  <td style={{ color: '#5a5060', fontSize: '0.8rem' }}>{p.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} style={{ fontWeight: 500, paddingTop: '1rem', color: '#8a8090' }}>Total</td>
                <td style={{ color: '#c8a96e', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.1rem', fontWeight: 600, paddingTop: '1rem' }}>{fmt(totalFiltered)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}
