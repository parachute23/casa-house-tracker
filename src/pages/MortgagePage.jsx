import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { uploadMortgagePaymentFile, requestDriveAccess, ensureRootStructure } from '../lib/googleDrive'
import toast from 'react-hot-toast'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Plus } from 'lucide-react'
import { format } from 'date-fns'

const fmt = (n) => (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €'

export default function MortgagePage() {
  const { user } = useAuth()
  const [mortgage, setMortgage] = useState(null)
  const [payments, setPayments] = useState([])
  const [profiles, setProfiles] = useState([])
  const [showSetup, setShowSetup] = useState(false)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [setupForm, setSetupForm] = useState({ property_name: 'Our Home', purchase_price: '', loan_amount: '', interest_rate: '', term_months: 360, start_date: '', monthly_payment: '' })
  const [paymentForm, setPaymentForm] = useState({ amount: '', payment_date: format(new Date(), 'yyyy-MM-dd'), notes: '', paid_by: '' })
  const [paymentFile, setPaymentFile] = useState(null)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const [{ data: m }, { data: p }, { data: pr }] = await Promise.all([
      supabase.from('mortgage').select('*').single(),
      supabase.from('mortgage_payments').select('*, paid_by:profiles(id, full_name)'),
      supabase.from('profiles').select('*')
    ])
    setMortgage(m)
    setPayments(p || [])
    setProfiles(pr || [])
    setLoading(false)
    if (m) setPaymentForm(f => ({ ...f, amount: m.monthly_payment, paid_by: user?.id }))
  }

  function buildAmortization(m) {
    if (!m) return []
    const monthlyRate = m.interest_rate / 100 / 12
    let balance = m.loan_amount
    const rows = []
    for (let i = 1; i <= m.term_months; i++) {
      const interest = balance * monthlyRate
      const principal = m.monthly_payment - interest
      balance = Math.max(0, balance - principal)
      rows.push({ month: i, interest: +interest.toFixed(2), principal: +principal.toFixed(2), balance: +balance.toFixed(2) })
      if (balance <= 0) break
    }
    return rows
  }

  const schedule = buildAmortization(mortgage)
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)
  const paymentsCount = payments.length
  const totalInterestPaid = payments.reduce((s, _, i) => s + (schedule[i]?.interest || 0), 0)
  const currentBalance = schedule[paymentsCount]?.balance ?? mortgage?.loan_amount ?? 0

  const balanceChartData = schedule.filter((_, i) => i % 12 === 0).map(r => ({
    year: Math.floor(r.month / 12),
    balance: r.balance
  }))

  const contribMap = {}
  profiles.forEach(p => { contribMap[p.id] = { name: p.full_name, total: 0 } })
  payments.forEach(p => {
    const id = p.paid_by?.id || p.paid_by
    if (contribMap[id]) contribMap[id].total += p.amount
  })

  async function saveMortgage(e) {
    e.preventDefault()
    const payload = { ...setupForm, purchase_price: +setupForm.purchase_price, loan_amount: +setupForm.loan_amount, interest_rate: +setupForm.interest_rate, term_months: +setupForm.term_months, monthly_payment: +setupForm.monthly_payment }
    const { error } = mortgage
      ? await supabase.from('mortgage').update(payload).eq('id', mortgage.id)
      : await supabase.from('mortgage').insert(payload)
    if (error) toast.error(error.message)
    else { toast.success('Mortgage saved'); setShowSetup(false); loadData() }
  }

  async function addPayment(e) {
    e.preventDefault()
    let drive_file_id = null, drive_file_url = null
    if (paymentFile) {
      try {
        await requestDriveAccess()
        await ensureRootStructure()
        const uploaded = await uploadMortgagePaymentFile(paymentFile, paymentForm.payment_date)
        drive_file_id = uploaded.id
        drive_file_url = uploaded.webViewLink
      } catch (err) {
        toast.error('Drive upload failed: ' + err.message)
      }
    }
    const { error } = await supabase.from('mortgage_payments').insert({
      mortgage_id: mortgage.id, paid_by: paymentForm.paid_by,
      amount: +paymentForm.amount, payment_date: paymentForm.payment_date,
      notes: paymentForm.notes, drive_file_id, drive_file_url
    })
    if (error) toast.error(error.message)
    else { toast.success('Payment recorded'); setShowPaymentForm(false); loadData() }
  }

  if (loading) return <div className="empty-state"><div className="empty-text">Loading…</div></div>

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="page-title">Mortgage</div>
          <div className="page-subtitle">{mortgage?.property_name || 'Not set up yet'}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost" onClick={() => setShowSetup(!showSetup)}>{mortgage ? 'Edit' : '+ Setup Mortgage'}</button>
          {mortgage && <button className="btn btn-primary" onClick={() => setShowPaymentForm(!showPaymentForm)}><Plus size={15} /> Log Payment</button>}
        </div>
      </div>

      {showSetup && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-title">🏦 Mortgage Details</div>
          <form onSubmit={saveMortgage}>
            <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
              {[['property_name','Property Name','text'],['purchase_price','Purchase Price (€)','number'],['loan_amount','Loan Amount (€)','number'],['interest_rate','Annual Interest Rate (%)','number'],['term_months','Term (months)','number'],['start_date','Start Date','date'],['monthly_payment','Monthly Payment (€)','number']].map(([key, label, type]) => (
                <div className="form-group" key={key}>
                  <label className="form-label">{label.toUpperCase()}</label>
                  <input className="form-input" type={type} value={setupForm[key]} onChange={e => setSetupForm(f => ({ ...f, [key]: e.target.value }))} required />
                </div>
              ))}
            </div>
            <button className="btn btn-primary" type="submit">Save Mortgage</button>
          </form>
        </div>
      )}

      {showPaymentForm && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-title">+ Log Payment</div>
          <form onSubmit={addPayment}>
            <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
              <div className="form-group">
                <label className="form-label">AMOUNT (€)</label>
                <input className="form-input" type="number" value={paymentForm.amount} onChange={e => setPaymentForm(f => ({ ...f, amount: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">DATE</label>
                <input className="form-input" type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm(f => ({ ...f, payment_date: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">PAID BY</label>
                <select className="form-select" value={paymentForm.paid_by} onChange={e => setPaymentForm(f => ({ ...f, paid_by: e.target.value }))} required>
                  <option value="">Select...</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">NOTES</label>
                <input className="form-input" type="text" value={paymentForm.notes} onChange={e => setPaymentForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">PROOF (optional)</label>
                <input type="file" accept="image/*,application/pdf" onChange={e => setPaymentFile(e.target.files[0])} style={{ fontSize: '0.8rem', color: '#8a8090' }} />
              </div>
            </div>
            <button className="btn btn-primary" type="submit">Record Payment</button>
          </form>
        </div>
      )}

      {!mortgage ? (
        <div className="card"><div className="empty-state"><div className="empty-icon">🏦</div><div className="empty-text">Set up your mortgage details to start tracking</div></div></div>
      ) : (
        <>
          <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
            {[
              { label: 'Remaining Balance', value: fmt(currentBalance) },
              { label: 'Total Paid', value: fmt(totalPaid) },
              { label: 'Interest Paid', value: fmt(totalInterestPaid) },
              { label: 'Payments Made', value: `${paymentsCount} / ${mortgage.term_months}` },
            ].map((s, i) => (
              <div key={i} className="card">
                <div className="stat-label">{s.label}</div>
                <div className="stat-value" style={{ fontSize: '1.4rem' }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div className="grid-2" style={{ marginBottom: '1.5rem' }}>
            <div className="card">
              <div className="card-title">📉 Balance Over Time</div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={balanceChartData}>
                  <XAxis dataKey="year" tick={{ fill: '#5a5060', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `Yr ${v}`} />
                  <YAxis tick={{ fill: '#5a5060', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v/1000).toFixed(0)}k`} />
                  <Tooltip contentStyle={{ background: '#1a1a2c', border: '1px solid rgba(200,169,110,0.2)', borderRadius: 8, color: '#e8dcc8' }} formatter={v => [fmt(v), 'Balance']} labelFormatter={v => `Year ${v}`} />
                  <Line type="monotone" dataKey="balance" stroke="#c8a96e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-title">💑 Contributions</div>
              {Object.values(contribMap).map((person, i) => {
                const allTotal = Object.values(contribMap).reduce((s, p) => s + p.total, 0)
                const pct = allTotal > 0 ? person.total / allTotal * 100 : 0
                return (
                  <div key={i} style={{ marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem', fontSize: '0.88rem' }}>
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

          <div className="card">
            <div className="card-title">📋 Payment History</div>
            {payments.length === 0 ? (
              <div className="empty-state"><div className="empty-text">No payments yet</div></div>
            ) : (
              <table className="table">
                <thead><tr><th>Date</th><th>Amount</th><th>Principal</th><th>Interest</th><th>Paid By</th><th>Notes</th><th>Proof</th></tr></thead>
                <tbody>
                  {[...payments].sort((a, b) => b.payment_date.localeCompare(a.payment_date)).map((p, i) => {
                    const schedRow = schedule[paymentsCount - 1 - i] || {}
                    return (
                      <tr key={p.id}>
                        <td>{p.payment_date}</td>
                        <td style={{ color: '#c8a96e' }}>{fmt(p.amount)}</td>
                        <td className="amount-positive">{fmt(schedRow.principal)}</td>
                        <td style={{ color: '#8a8090' }}>{fmt(schedRow.interest)}</td>
                        <td>{p.paid_by?.full_name || '—'}</td>
                        <td style={{ color: '#8a8090' }}>{p.notes || '—'}</td>
                        <td>{p.drive_file_url ? <a href={p.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.8rem' }}>View</a> : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
