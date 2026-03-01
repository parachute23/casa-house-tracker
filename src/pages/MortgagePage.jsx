import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { uploadPaymentFile, requestDriveAccess } from '../lib/googleDrive'
import toast from 'react-hot-toast'
import { useDropzone } from 'react-dropzone'
import { format } from 'date-fns'
import { Plus, Edit2, Check, X } from 'lucide-react'

const fmt = (n) => n != null ? 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—'
const fmtFull = (n) => n != null ? 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

const HOUSE_PRICE = 3800000
const FINANCED = 3040000
const DOWN_PAYMENT = 760000
const CONTRACT_DATE = '2025-06-26'
const FIRST_PAYMENT = '2025-07-26'
const TOTAL_MONTHS = 400

export default function MortgagePage() {
  const [payments, setPayments] = useState([])
  const [state, setState] = useState({ itau: null, beacon: null })
  const [loading, setLoading] = useState(true)
  const [purchaseCosts, setPurchaseCosts] = useState([])
  const [activeTab, setActiveTab] = useState('overview')
  const [showForm, setShowForm] = useState(null) // 'itau' | 'beacon'
  const [paymentFile, setPaymentFile] = useState(null)
  const [editingBalance, setEditingBalance] = useState(null) // 'itau' | 'beacon'
  const [editingMonthly, setEditingMonthly] = useState(null)
  const [balanceInput, setBalanceInput] = useState('')
  const [monthlyInput, setMonthlyInput] = useState('')
  const [form, setForm] = useState({
    loan_type: 'itau',
    payment_date: format(new Date(), 'yyyy-MM-dd'),
    amount: '',
    payment_type: 'regular',
    notes: ''
  })

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const [{ data: p }, { data: s }, { data: c }] = await Promise.all([
  supabase.from('mortgage_payments').select('*').order('payment_date', { ascending: false }),
  supabase.from('mortgage_state').select('*'),
  supabase.from('purchase_costs').select('*').order('payment_date', { ascending: true })
])
setPayments(p || [])
setPurchaseCosts(c || [])
const stateMap = {}
;(s || []).forEach(row => { stateMap[row.loan_type] = row })
setState(stateMap)
setLoading(false)
  }

  const itauPayments = payments.filter(p => p.loan_type === 'itau')
  const beaconPayments = payments.filter(p => p.loan_type === 'beacon')
  const itauTotal = itauPayments.reduce((s, p) => s + p.amount, 0)
  const beaconTotal = beaconPayments.reduce((s, p) => s + p.amount, 0)
  const itauExtraordinary = itauPayments.filter(p => p.payment_type === 'extraordinary').reduce((s, p) => s + p.amount, 0)

  // Months elapsed since first payment
  const firstPayment = new Date(FIRST_PAYMENT)
  const now = new Date()
  const monthsElapsed = Math.max(0, (now.getFullYear() - firstPayment.getFullYear()) * 12 + (now.getMonth() - firstPayment.getMonth()))
  const monthsRemaining = TOTAL_MONTHS - monthsElapsed

  const receiptDropzone = useDropzone({
    accept: { 'image/*': [], 'application/pdf': [] },
    maxFiles: 1,
    onDrop: files => setPaymentFile(files[0])
  })

  async function savePayment(e) {
    e.preventDefault()
    let drive_file_id = null, drive_file_url = null
    if (paymentFile) {
      try {
        await requestDriveAccess()
        const uploaded = await uploadPaymentFile(paymentFile, null, `Mortgage-${form.loan_type}-${form.payment_date}`)
        drive_file_id = uploaded.id
        drive_file_url = uploaded.webViewLink
      } catch {}
    }
    const { error } = await supabase.from('mortgage_payments').insert({
      ...form,
      amount: +form.amount,
      drive_file_id,
      drive_file_url
    })
    if (error) { toast.error(error.message); return }
    toast.success('Payment recorded')
    setShowForm(null)
    setPaymentFile(null)
    setForm({ loan_type: 'itau', payment_date: format(new Date(), 'yyyy-MM-dd'), amount: '', payment_type: 'regular', notes: '' })
    loadData()
  }

  async function updateBalance(loanType) {
    const val = parseFloat(balanceInput.replace(/\./g, '').replace(',', '.'))
    if (isNaN(val)) { toast.error('Invalid value'); return }
    await supabase.from('mortgage_state')
      .update({ outstanding_balance: val, updated_at: new Date().toISOString() })
      .eq('loan_type', loanType)
    toast.success('Balance updated')
    setEditingBalance(null)
    loadData()
  }

  async function updateMonthly(loanType) {
    const val = parseFloat(monthlyInput.replace(/\./g, '').replace(',', '.'))
    if (isNaN(val)) { toast.error('Invalid value'); return }
    await supabase.from('mortgage_state')
      .update({ monthly_amount: val, updated_at: new Date().toISOString() })
      .eq('loan_type', loanType)
    toast.success('Monthly amount updated')
    setEditingMonthly(null)
    loadData()
  }

  async function deletePayment(id) {
    await supabase.from('mortgage_payments').delete().eq('id', id)
    loadData()
  }

  if (loading) return <div className="empty-state"><div className="empty-text">Loading…</div></div>

  const itauState = state.itau
  const beaconState = state.beacon
  const totalPaidToBank = itauTotal + beaconTotal
  const purchaseCosts = DOWN_PAYMENT // minimum — will add ITBI etc later

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="page-title">🏠 Mortgage</div>
          <div className="page-subtitle">Rua Prof. Nova Gomes 321 — Vila Madalena</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost" onClick={() => { setShowForm('beacon'); setForm(f => ({ ...f, loan_type: 'beacon' })) }}>
            <Plus size={15} /> Beacon
          </button>
          <button className="btn btn-primary" onClick={() => { setShowForm('itau'); setForm(f => ({ ...f, loan_type: 'itau' })) }}>
            <Plus size={15} /> Itaú
          </button>
        </div>
      </div>

      {/* Log Payment Form */}
      {showForm && (
        <div className="card" style={{ marginBottom: '1.5rem', border: `1px solid ${showForm === 'itau' ? 'rgba(76,175,136,0.3)' : 'rgba(200,169,110,0.3)'}` }}>
          <div className="card-title">💳 Log {showForm === 'itau' ? 'Itaú' : 'Beacon'} Payment</div>
          <div {...receiptDropzone.getRootProps()} style={{
            border: `2px dashed ${receiptDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`,
            borderRadius: '10px', padding: '1rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem'
          }}>
            <input {...receiptDropzone.getInputProps()} />
            {paymentFile
              ? <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>✅ {paymentFile.name}</div>
              : <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>📱 Drop receipt (optional)</div>}
          </div>
          <form onSubmit={savePayment}>
            <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
              <div className="form-group">
                <label className="form-label">AMOUNT (R$)</label>
                <input className="form-input" type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">DATE</label>
                <input className="form-input" type="date" value={form.payment_date} onChange={e => setForm(f => ({ ...f, payment_date: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">TYPE</label>
                <select className="form-select" value={form.payment_type} onChange={e => setForm(f => ({ ...f, payment_type: e.target.value }))}>
                  <option value="regular">Regular</option>
                  <option value="extraordinary">Extraordinary (principal reduction)</option>
                </select>
              </div>
              <div className="form-group" style={{ gridColumn: 'span 3' }}>
                <label className="form-label">NOTES</label>
                <input className="form-input" placeholder="e.g. Parcela 3/400, amortização extra…" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary" type="submit">Save</button>
              <button className="btn btn-ghost" type="button" onClick={() => { setShowForm(null); setPaymentFile(null) }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(200,169,110,0.1)' }}>
        {['overview', 'purchase', 'itaú', 'beacon', 'history'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem 1rem',
            fontSize: '0.82rem', fontFamily: "'DM Sans', sans-serif",
            color: activeTab === tab ? '#c8a96e' : '#8a8090',
            borderBottom: activeTab === tab ? '2px solid #c8a96e' : '2px solid transparent',
            marginBottom: '-1px', fontWeight: activeTab === tab ? 500 : 400, letterSpacing: '0.04em'
          }}>
            {tab === 'purchase' ? '🏡 Purchase' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div>
          {/* House purchase */}
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-title">🏡 House Purchase</div>
            <div className="grid-4">
              {[
                { label: 'Purchase Price', value: fmt(HOUSE_PRICE) },
                { label: 'Down Payment', value: fmt(DOWN_PAYMENT), color: '#c8a96e' },
                { label: 'Financed (Itaú)', value: fmt(FINANCED), color: '#e8a84c' },
                { label: 'Signed', value: '26/06/2025' }
              ].map((s, i) => (
                <div key={i}>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value" style={{ fontSize: '1.2rem', color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Two loan cards */}
          <div className="grid-2" style={{ marginBottom: '1.5rem' }}>
            {/* Itaú */}
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div className="card-title" style={{ marginBottom: 0 }}>🏦 Itaú — Pati</div>
                <span className="badge badge-green">Active</span>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <div className="stat-label">OUTSTANDING BALANCE (bank's number)</div>
                {editingBalance === 'itau' ? (
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
                    <input className="form-input" style={{ width: '160px' }} placeholder="e.g. 3.040.000" value={balanceInput} onChange={e => setBalanceInput(e.target.value)} autoFocus />
                    <button onClick={() => updateBalance('itau')} style={{ background: 'none', border: 'none', color: '#4caf88', cursor: 'pointer' }}><Check size={16} /></button>
                    <button onClick={() => setEditingBalance(null)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}><X size={16} /></button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div className="stat-value" style={{ fontSize: '1.4rem', color: '#e05c6a' }}>{fmt(itauState?.outstanding_balance)}</div>
                    <button onClick={() => { setEditingBalance('itau'); setBalanceInput('') }} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}><Edit2 size={13} /></button>
                  </div>
                )}
                {itauState?.updated_at && <div style={{ fontSize: '0.72rem', color: '#5a5060', marginTop: '0.2rem' }}>Updated {new Date(itauState.updated_at).toLocaleDateString('pt-BR')}</div>}
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <div className="stat-label">CURRENT MONTHLY AMOUNT</div>
                {editingMonthly === 'itau' ? (
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
                    <input className="form-input" style={{ width: '160px' }} placeholder="e.g. 38559" value={monthlyInput} onChange={e => setMonthlyInput(e.target.value)} autoFocus />
                    <button onClick={() => updateMonthly('itau')} style={{ background: 'none', border: 'none', color: '#4caf88', cursor: 'pointer' }}><Check size={16} /></button>
                    <button onClick={() => setEditingMonthly(null)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}><X size={16} /></button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div className="stat-value" style={{ fontSize: '1.2rem' }}>{fmtFull(itauState?.monthly_amount)}</div>
                    <button onClick={() => { setEditingMonthly('itau'); setMonthlyInput('') }} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}><Edit2 size={13} /></button>
                  </div>
                )}
              </div>

              <div className="grid-2" style={{ fontSize: '0.82rem' }}>
                <div>
                  <div className="stat-label">TOTAL PAID</div>
                  <div style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.1rem' }}>{fmt(itauTotal)}</div>
                </div>
                <div>
                  <div className="stat-label">OF WHICH EXTRAORDINARY</div>
                  <div style={{ color: '#c8a96e', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.1rem' }}>{fmt(itauExtraordinary)}</div>
                </div>
                <div>
                  <div className="stat-label">MONTHS ELAPSED</div>
                  <div style={{ color: '#8a8090' }}>{monthsElapsed} / {TOTAL_MONTHS}</div>
                </div>
                <div>
                  <div className="stat-label">MONTHS REMAINING</div>
                  <div style={{ color: '#8a8090' }}>{monthsRemaining}</div>
                </div>
              </div>

              {/* Progress bar */}
              <div style={{ marginTop: '1rem' }}>
                <div style={{ height: '6px', background: '#1a1a2c', borderRadius: '6px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(monthsElapsed / TOTAL_MONTHS * 100, 100)}%`, background: 'linear-gradient(90deg, #c8a96e, #4caf88)', borderRadius: '6px' }} />
                </div>
                <div style={{ fontSize: '0.72rem', color: '#5a5060', marginTop: '0.3rem', textAlign: 'right' }}>
                  Last payment: 26/10/2058
                </div>
              </div>
            </div>

            {/* Beacon */}
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div className="card-title" style={{ marginBottom: 0 }}>🏫 Beacon — Jorge</div>
                <span className="badge badge-amber">Active</span>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <div className="stat-label">CURRENT MONTHLY AMOUNT</div>
                {editingMonthly === 'beacon' ? (
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
                    <input className="form-input" style={{ width: '160px' }} placeholder="e.g. 11000" value={monthlyInput} onChange={e => setMonthlyInput(e.target.value)} autoFocus />
                    <button onClick={() => updateMonthly('beacon')} style={{ background: 'none', border: 'none', color: '#4caf88', cursor: 'pointer' }}><Check size={16} /></button>
                    <button onClick={() => setEditingMonthly(null)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}><X size={16} /></button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div className="stat-value" style={{ fontSize: '1.2rem' }}>{beaconState?.monthly_amount ? fmtFull(beaconState.monthly_amount) : <span style={{ color: '#5a5060', fontSize: '0.85rem' }}>Not set — click to edit</span>}</div>
                    <button onClick={() => { setEditingMonthly('beacon'); setMonthlyInput('') }} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}><Edit2 size={13} /></button>
                  </div>
                )}
              </div>

              <div className="grid-2" style={{ fontSize: '0.82rem' }}>
                <div>
                  <div className="stat-label">TOTAL PAID</div>
                  <div style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.1rem' }}>{fmt(beaconTotal)}</div>
                </div>
                <div>
                  <div className="stat-label">PAYMENTS LOGGED</div>
                  <div style={{ color: '#8a8090' }}>{beaconPayments.length}</div>
                </div>
              </div>

              <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(200,169,110,0.05)', borderRadius: '8px', fontSize: '0.78rem', color: '#8a8090' }}>
                Jorge's contribution toward the house via Beacon school fees. Update monthly amount each January when the school sends the new table.
              </div>
            </div>
          </div>

          {/* Total house cost */}
          <div className="card">
            <div className="card-title">📊 Total House Cost To Date</div>
            <div className="grid-4">
              {[
                { label: 'Purchase Costs', value: fmt(purchaseCosts.reduce((s, c) => s + c.amount, 0)), color: '#c8a96e' },
{ label: 'Itaú Payments', value: fmt(itauTotal), color: '#4caf88' },
{ label: 'Beacon Payments', value: fmt(beaconTotal), color: '#4caf88' },
{ label: 'Total Invested', value: fmt(purchaseCosts.reduce((s, c) => s + c.amount, 0) + itauTotal + beaconTotal), color: '#c8a96e' }
              ].map((s, i) => (
                <div key={i}>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value" style={{ fontSize: '1.2rem', color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

{/* PURCHASE COSTS TAB */}
{activeTab === 'purchase' && (
  <div>
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div className="card-title">🏡 One-Time Purchase Costs</div>
      <table className="table">
        <thead>
          <tr><th>Date</th><th>Description</th><th>Paid By</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {purchaseCosts.map(c => (
            <tr key={c.id}>
              <td>{c.payment_date}</td>
              <td>{c.description}</td>
              <td style={{ color: '#8a8090' }}>{c.paid_by}</td>
              <td style={{ color: '#c8a96e', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.05rem' }}>{fmt(c.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid rgba(200,169,110,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.85rem', color: '#8a8090' }}>Total purchase costs</span>
        <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.3rem', color: '#c8a96e' }}>{fmt(purchaseCosts.reduce((s, c) => s + c.amount, 0))}</span>
      </div>
    </div>
  </div>
)}
      
      {/* ITAÚ TAB */}
      {activeTab === 'itaú' && (
        <div className="card">
          <div className="card-title">🏦 Itaú Payment History</div>
          {itauPayments.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">🏦</div><div className="empty-text">No payments logged yet</div></div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Amount</th><th>Type</th><th>Notes</th><th>Receipt</th><th></th></tr>
              </thead>
              <tbody>
                {itauPayments.map(p => (
                  <tr key={p.id}>
                    <td>{p.payment_date}</td>
                    <td style={{ color: p.payment_type === 'extraordinary' ? '#c8a96e' : '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.05rem' }}>{fmtFull(p.amount)}</td>
                    <td><span className={`badge ${p.payment_type === 'extraordinary' ? 'badge-amber' : 'badge-green'}`}>{p.payment_type === 'extraordinary' ? '⚡ Extra' : 'Regular'}</span></td>
                    <td style={{ color: '#8a8090', fontSize: '0.8rem' }}>{p.notes || '—'}</td>
                    <td>{p.drive_file_url ? <a href={p.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>📄 View</a> : '—'}</td>
                    <td><button onClick={() => deletePayment(p.id)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer', fontSize: '0.75rem' }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* BEACON TAB */}
      {activeTab === 'beacon' && (
        <div className="card">
          <div className="card-title">🏫 Beacon Payment History</div>
          {beaconPayments.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">🏫</div><div className="empty-text">No payments logged yet</div></div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Amount</th><th>Notes</th><th>Receipt</th><th></th></tr>
              </thead>
              <tbody>
                {beaconPayments.map(p => (
                  <tr key={p.id}>
                    <td>{p.payment_date}</td>
                    <td style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.05rem' }}>{fmtFull(p.amount)}</td>
                    <td style={{ color: '#8a8090', fontSize: '0.8rem' }}>{p.notes || '—'}</td>
                    <td>{p.drive_file_url ? <a href={p.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>📄 View</a> : '—'}</td>
                    <td><button onClick={() => deletePayment(p.id)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer', fontSize: '0.75rem' }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* HISTORY TAB - combined */}
      {activeTab === 'history' && (
        <div className="card">
          <div className="card-title">📋 All Mortgage Payments</div>
          {payments.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">📋</div><div className="empty-text">No payments logged yet</div></div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Loan</th><th>Amount</th><th>Type</th><th>Notes</th><th></th></tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td>{p.payment_date}</td>
                    <td><span className={`badge ${p.loan_type === 'itau' ? 'badge-green' : 'badge-amber'}`}>{p.loan_type === 'itau' ? '🏦 Itaú' : '🏫 Beacon'}</span></td>
                    <td style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.05rem' }}>{fmtFull(p.amount)}</td>
                    <td style={{ color: '#8a8090', fontSize: '0.8rem' }}>{p.payment_type === 'extraordinary' ? '⚡ Extra' : 'Regular'}</td>
                    <td style={{ color: '#8a8090', fontSize: '0.8rem' }}>{p.notes || '—'}</td>
                    <td><button onClick={() => deletePayment(p.id)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer', fontSize: '0.75rem' }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
