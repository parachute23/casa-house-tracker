import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Plus, Trash2 } from 'lucide-react'

const fmt = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export default function ProjectsPage() {
  const [projects, setProjects] = useState([])
  const [bills, setBills] = useState([])
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: b }, { data: py }] = await Promise.all([
        supabase.from('projects').select('*').order('created_at'),
        supabase.from('bills').select('*'),
        supabase.from('payments').select('*')
      ])
      setProjects(p || [])
      setBills(b || [])
      setPayments(py || [])
      setLoading(false)
    }
    load()
  }, [])

  async function deleteProject(project) {
    // Delete all related data first
    await supabase.from('payments').delete().eq('project_id', project.id)
    await supabase.from('bill_line_items').delete().in('bill_id',
      (bills.filter(b => b.project_id === project.id)).map(b => b.id)
    )
    await supabase.from('bills').delete().eq('project_id', project.id)
    await supabase.from('contract_line_items').delete().eq('project_id', project.id)
    await supabase.from('projects').delete().eq('id', project.id)
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setConfirmDelete(null)
  }

  if (loading) return <div className="empty-state"><div className="empty-text">Loading…</div></div>

  const totalBudget = projects.reduce((s, p) => s + (p.contract_amount || 0), 0)
  const totalBilled = bills.reduce((s, b) => s + b.total_amount, 0)
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)

  return (
    <div>
      {confirmDelete && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div className="card" style={{ maxWidth: '400px', width: '90%', textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>🗑️</div>
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.2rem', marginBottom: '0.5rem' }}>
              Delete "{confirmDelete.name}"?
            </div>
            <div style={{ color: '#8a8090', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
              This will permanently delete the project and all its bills, payments, and line items. This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button className="btn btn-danger" onClick={() => deleteProject(confirmDelete)}>Yes, delete</button>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="page-title">Renovation Projects</div>
          <div className="page-subtitle">{projects.length} project{projects.length !== 1 ? 's' : ''}</div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/projects/new')}>
          <Plus size={15} /> New Project
        </button>
      </div>

      {projects.length > 0 && (
        <div className="grid-3" style={{ marginBottom: '1.5rem' }}>
          {[
            { label: 'Total Budget', value: fmt(totalBudget) },
            { label: 'Total Billed', value: fmt(totalBilled), deviation: totalBilled > totalBudget },
            { label: 'Total Paid', value: fmt(totalPaid) }
          ].map((s, i) => (
            <div key={i} className="card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{ fontSize: '1.5rem', color: s.deviation ? '#e05c6a' : undefined }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🔨</div>
            <div className="empty-text" style={{ marginBottom: '1rem' }}>No renovation projects yet</div>
            <button className="btn btn-primary" onClick={() => navigate('/projects/new')}>Create your first project</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {projects.map(project => {
            const billed = bills.filter(b => b.project_id === project.id).reduce((s, b) => s + b.total_amount, 0)
            const paid = payments.filter(p => p.project_id === project.id).reduce((s, p) => s + p.amount, 0)
            const budget = project.contract_amount || 0
            const billedPct = budget > 0 ? Math.min(billed / budget * 100, 100) : 0
            const paidPct = budget > 0 ? Math.min(paid / budget * 100, 100) : 0
            const deviation = budget > 0 ? ((billed - budget) / budget * 100) : 0

            return (
              <div key={project.id} className="card" style={{ cursor: 'pointer', position: 'relative' }}
                onClick={() => navigate(`/projects/${project.id}`)}>

                <button
                  className="btn btn-danger"
                  style={{ position: 'absolute', top: '1rem', right: '1rem', padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                  onClick={e => { e.stopPropagation(); setConfirmDelete(project) }}
                >
                  <Trash2 size={13} /> Delete
                </button>

                <div style={{ marginBottom: '1rem', paddingRight: '6rem' }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 500, marginBottom: '0.25rem' }}>{project.name}</div>
                  <div style={{ color: '#8a8090', fontSize: '0.8rem' }}>{project.contractor_name || 'No contractor set'}</div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                  {deviation > 10 && <span className="badge badge-red">+{deviation.toFixed(0)}% over</span>}
                  {deviation > 0 && deviation <= 10 && <span className="badge badge-amber">+{deviation.toFixed(0)}% over</span>}
                  {deviation <= 0 && budget > 0 && <span className="badge badge-green">On budget</span>}
                  <span className={`badge ${
                    project.status === 'active' ? 'badge-green' :
                    project.status === 'completed' ? 'badge-muted' :
                    project.status === 'planning' ? 'badge-amber' : 'badge-muted'
                  }`}>{project.status}</span>
                </div>

                <div className="grid-3" style={{ marginBottom: '1rem' }}>
                  <div>
                    <div className="stat-label">Budget</div>
                    <div style={{ fontSize: '1.1rem', fontFamily: "'Cormorant Garamond', serif" }}>{fmt(budget)}</div>
                  </div>
                  <div>
                    <div className="stat-label">Billed</div>
                    <div style={{ fontSize: '1.1rem', fontFamily: "'Cormorant Garamond', serif", color: deviation > 10 ? '#e05c6a' : deviation > 0 ? '#e8a84c' : '#e8dcc8' }}>{fmt(billed)}</div>
                  </div>
                  <div>
                    <div className="stat-label">Paid</div>
                    <div style={{ fontSize: '1.1rem', fontFamily: "'Cormorant Garamond', serif", color: '#4caf88' }}>{fmt(paid)}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#5a5060' }}>
                    <span>Billed {billedPct.toFixed(0)}%</span>
                    <span>Paid {paidPct.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: '6px', background: '#1a1a2c', borderRadius: '6px', overflow: 'hidden', position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${billedPct}%`, background: deviation > 10 ? '#e05c6a44' : '#c8a96e44', borderRadius: '6px' }} />
                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${paidPct}%`, background: '#4caf88', borderRadius: '6px' }} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
