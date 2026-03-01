import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { uploadBillFile, uploadContractFile, requestDriveAccess, uploadPaymentFile } from '../lib/googleDrive'
import { extractBillData, generateCostEstimate, extractContractLineItems } from '../lib/ai'
import toast from 'react-hot-toast'
import { useDropzone } from 'react-dropzone'
import { format } from 'date-fns'
import { Sparkles, ArrowLeft, Plus, Trash2 } from 'lucide-react'

const fmt = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY

async function extractPixData(file) {
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: file.type, data: base64 }
          },
          {
            type: 'text',
            text: `This is a Brazilian PIX payment confirmation screen. Extract the payment details and return ONLY valid JSON, no markdown:
{
  "amount": number (the value in BRL, no currency symbol),
  "payment_date": "YYYY-MM-DD",
  "recipient_name": "string (favorecido/destinatário)",
  "notes": "string (e.g. PIX para [recipient] - [transaction id if visible])"
}`
          }
        ]
      }]
    })
  })

  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  const text = data.content[0].text
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

export default function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [project, setProject] = useState(null)
  const [bills, setBills] = useState([])
  const [payments, setPayments] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('payments')
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [billFile, setBillFile] = useState(null)
  const [contractFile, setContractFile] = useState(null)
  const [paymentFile, setPaymentFile] = useState(null)
  const [uploadingContract, setUploadingContract] = useState(false)
  const [processingBill, setProcessingBill] = useState(false)
  const [processingReceipt, setProcessingReceipt] = useState(false)
  const [estimate, setEstimate] = useState(null)
  const [loadingEstimate, setLoadingEstimate] = useState(false)
  const [paymentForm, setPaymentForm] = useState({
    amount: '', payment_date: format(new Date(), 'yyyy-MM-dd'),
    notes: '', paid_by: '', payment_method: 'PIX'
  })
  const [expenseForm, setExpenseForm] = useState({
    bill_number: '', contractor_name: '', issue_date: '',
    total_amount: '', notes: '', status: 'pending'
  })

  useEffect(() => { loadData() }, [id])

  async function loadData() {
    const [{ data: p }, { data: b }, { data: bli }, { data: py }, { data: pr }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('bills').select('*').eq('project_id', id).order('issue_date', { ascending: false }),
      supabase.from('bill_line_items').select('*'),
      supabase.from('payments').select('*, paid_by:profiles(id, full_name)').eq('project_id', id).order('payment_date', { ascending: false }),
      supabase.from('profiles').select('*')
    ])
    setProject(p)
    setBills((b || []).map(bill => ({ ...bill, bill_line_items: (bli || []).filter(i => i.bill_id === bill.id) })))
    setPayments(py || [])
    setProfiles(pr || [])
    setLoading(false)
    setPaymentForm(f => ({ ...f, paid_by: user?.id || '' }))
  }

  const budget = project?.contract_amount || 0
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)
  const totalExpenses = bills.reduce((s, b) => s + b.total_amount, 0)
  const remaining = budget - totalPaid
  const pctComplete = budget > 0 ? Math.min(totalPaid / budget * 100, 100) : 0

  const billDropzone = useDropzone({
    accept: { 'application/pdf': [], 'image/*': [] },
    maxFiles: 1,
    onDrop: files => setBillFile(files[0])
  })

  const contractDropzone = useDropzone({
    accept: { 'application/pdf': [], 'image/*': [] },
    maxFiles: 1,
    onDrop: files => setContractFile(files[0])
  })

  const receiptDropzone = useDropzone({
    accept: { 'image/*': [] },
    maxFiles: 1,
    onDrop: async (files) => {
      const file = files[0]
      setPaymentFile(file)
      setProcessingReceipt(true)
      toast('AI is reading your PIX receipt…', { icon: '🤖' })
      try {
        const extracted = await extractPixData(file)
        setPaymentForm(f => ({
          ...f,
          amount: extracted.amount || f.amount,
          payment_date: extracted.payment_date || f.payment_date,
          notes: extracted.notes || f.notes,
          payment_method: 'PIX'
        }))
        toast.success('Receipt read — review and confirm')
      } catch (err) {
        toast.error('Could not read receipt: ' + err.message)
      } finally {
        setProcessingReceipt(false)
      }
    }
  })

  async function uploadContract() {
    if (!contractFile) return
    setUploadingContract(true)
    try {
      if (project.drive_folder_id) {
        await requestDriveAccess()
        await uploadContractFile(contractFile, project.name, project.drive_folder_id)
      }
      toast('AI is reading your contract…', { icon: '🤖' })
      const extracted = await extractContractLineItems(contractFile)
      const updates = {}
      if (!project.contract_amount && extracted.total_amount) updates.contract_amount = extracted.total_amount
      if (!project.contractor_name && extracted.contractor_name) updates.contractor_name = extracted.contractor_name
      if (!project.contract_date && extracted.contract_date) updates.contract_date = extracted.contract_date
      if (Object.keys(updates).length) await supabase.from('projects').update(updates).eq('id', id)
      toast.success('Contract uploaded!')
      setContractFile(null)
      loadData()
    } catch (err) {
      toast.error('Contract processing failed: ' + err.message)
    } finally {
      setUploadingContract(false)
    }
  }

  async function savePayment(e) {
    e.preventDefault()
    let drive_file_id = null, drive_file_url = null
    if (paymentFile && project.drive_folder_id) {
      try {
        await requestDriveAccess()
        const uploaded = await uploadPaymentFile(paymentFile, project.drive_folder_id, `PIX-${paymentForm.payment_date}-${paymentForm.amount}`)
        drive_file_id = uploaded.id
        drive_file_url = uploaded.webViewLink
      } catch (err) {
        toast.error('Drive upload failed — payment will be saved without receipt')
      }
    }
    const { error } = await supabase.from('payments').insert({
      project_id: id,
      paid_by: paymentForm.paid_by,
      amount: +paymentForm.amount,
      payment_date: paymentForm.payment_date,
      notes: paymentForm.notes,
      payment_method: paymentForm.payment_method,
      drive_file_id,
      drive_file_url
    })
    if (error) toast.error(error.message)
    else {
      toast.success('Payment recorded')
      setShowPaymentForm(false)
      setPaymentFile(null)
      setPaymentForm({ amount: '', payment_date: format(new Date(), 'yyyy-MM-dd'), notes: '', paid_by: user?.id || '', payment_method: 'PIX' })
      loadData()
    }
  }

  async function processBillWithAI() {
    if (!billFile) return
    setProcessingBill(true)
    toast('AI is reading your invoice…', { icon: '🤖' })
    try {
      const extracted = await extractBillData(billFile, [])
      setExpenseForm({
        bill_number: extracted.bill_number || '',
        contractor_name: extracted.contractor_name || '',
        issue_date: extracted.issue_date || '',
        total_amount: extracted.total_amount || '',
        notes: extracted.notes || '',
        status: 'pending'
      })
      toast.success('Invoice details extracted — review and save')
      window._extractedBillLineItems = extracted.line_items
    } catch (err) {
      toast.error('AI extraction failed: ' + err.message)
    } finally {
      setProcessingBill(false)
    }
  }

  async function saveExpense(e) {
    e.preventDefault()
    let drive_file_id = null, drive_file_url = null
    if (billFile && project.drive_folder_id) {
      try {
        await requestDriveAccess()
        const uploaded = await uploadBillFile(billFile, project.drive_folder_id, `Invoice-${expenseForm.bill_number || expenseForm.issue_date}`)
        drive_file_id = uploaded.id
        drive_file_url = uploaded.webViewLink
      } catch {}
    }
    const { data: bill, error } = await supabase.from('bills').insert({
      project_id: id,
      ...expenseForm,
      total_amount: +expenseForm.total_amount,
      drive_file_id,
      drive_file_url
    }).select().single()
    if (error) { toast.error(error.message); return }
    const aiLineItems = window._extractedBillLineItems
    if (aiLineItems?.length) {
      await supabase.from('bill_line_items').insert(
        aiLineItems.map(item => ({
          bill_id: bill.id,
          description: item.description,
          amount: item.amount,
          is_deviation: false
        }))
      )
      window._extractedBillLineItems = null
    }
    toast.success('Expense saved')
    setShowExpenseForm(false)
    setBillFile(null)
    setExpenseForm({ bill_number: '', contractor_name: '', issue_date: '', total_amount: '', notes: '', status: 'pending' })
    loadData()
  }

  async function deletePayment(paymentId) {
    await supabase.from('payments').delete().eq('id', paymentId)
    loadData()
  }

  async function getEstimate() {
    setLoadingEstimate(true)
    try {
      const est = await generateCostEstimate(project, [], bills, payments)
      setEstimate(est)
    } catch (err) {
      toast.error('Estimation failed: ' + err.message)
    } finally {
      setLoadingEstimate(false)
    }
  }

  if (loading) return <div className="empty-state"><div className="empty-text">Loading…</div></div>
  if (!project) return <div className="empty-state"><div className="empty-text">Project not found</div></div>

  const contribMap = {}
  profiles.forEach(p => { contribMap[p.id] = { name: p.full_name, total: 0 } })
  payments.forEach(p => {
    const pid = p.paid_by?.id || p.paid_by
    if (contribMap[pid]) contribMap[pid].total += p.amount
  })

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <button onClick={() => navigate('/projects')} style={{ background: 'none', border: 'none', color: '#8a8090', cursor: 'pointer', fontSize: '0.8rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <ArrowLeft size={14} /> Projects
          </button>
          <div className="page-title">{project.name}</div>
          <div className="page-subtitle">{project.contractor_name || 'No contractor set'}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost" onClick={() => { setShowExpenseForm(!showExpenseForm); setShowPaymentForm(false) }}>
            <Plus size={15} /> Add Expense
          </button>
          <button className="btn btn-primary" onClick={() => { setShowPaymentForm(!showPaymentForm); setShowExpenseForm(false) }}>
            <Plus size={15} /> Log Payment
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
        {[
          { label: 'Contract Value', value: fmt(budget) },
          { label: 'Total Paid', value: fmt(totalPaid), color: '#4caf88' },
          { label: 'Expenses / Invoices', value: fmt(totalExpenses), color: totalExpenses > 0 ? '#e8a84c' : undefined },
          { label: 'Remaining', value: fmt(remaining), color: remaining < 0 ? '#e05c6a' : undefined }
        ].map((s, i) => (
          <div key={i} className="card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value" style={{ fontSize: '1.4rem', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Progress Bar */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
          <span style={{ color: '#8a8090' }}>Payment progress</span>
          <span style={{ color: '#c8a96e' }}>{pctComplete.toFixed(0)}% paid</span>
        </div>
        <div style={{ height: '8px', background: '#1a1a2c', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pctComplete}%`, background: 'linear-gradient(90deg, #c8a96e, #4caf88)', borderRadius: '8px', transition: 'width 0.3s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem', fontSize: '0.75rem', color: '#5a5060' }}>
          <span>{fmt(totalPaid)} paid</span>
          <span>{fmt(remaining)} remaining</span>
        </div>
      </div>

      {/* Contributions */}
      {payments.length > 0 && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-title">💑 Contributions</div>
          {Object.values(contribMap).filter(p => p.total > 0).map((person, i) => {
            const pct = totalPaid > 0 ? person.total / totalPaid * 100 : 0
            return (
              <div key={i} style={{ marginBottom: '0.75rem' }}>
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
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(200,169,110,0.1)' }}>
        {['payments', 'expenses', 'contract', 'estimate'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem 1rem',
            fontSize: '0.82rem', fontFamily: "'DM Sans', sans-serif",
            color: activeTab === tab ? '#c8a96e' : '#8a8090',
            borderBottom: activeTab === tab ? '2px solid #c8a96e' : '2px solid transparent',
            marginBottom: '-1px', transition: 'color 0.15s',
            fontWeight: activeTab === tab ? 500 : 400, letterSpacing: '0.04em'
          }}>
            {tab === 'estimate' ? '🤖 AI Estimate' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Log Payment Form */}
      {showPaymentForm && (
        <div className="card" style={{ marginBottom: '1.5rem', border: '1px solid rgba(76,175,136,0.3)' }}>
          <div className="card-title">💳 Log Payment</div>

          {/* Receipt upload */}
          <div {...receiptDropzone.getRootProps()} style={{
            border: `2px dashed ${receiptDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`,
            borderRadius: '10px', padding: '1.25rem', textAlign: 'center',
            cursor: 'pointer', marginBottom: '1rem', background: paymentFile ? 'rgba(76,175,136,0.05)' : 'transparent'
          }}>
            <input {...receiptDropzone.getInputProps()} />
            {processingReceipt ? (
              <div style={{ color: '#c8a96e', fontSize: '0.85rem' }}>🤖 Reading PIX receipt…</div>
            ) : paymentFile ? (
              <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>✅ {paymentFile.name} — form filled automatically</div>
            ) : (
              <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>
                📱 Drop your PIX confirmation screenshot here — AI will fill the form automatically
              </div>
            )}
          </div>

          <form onSubmit={savePayment}>
            <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
              <div className="form-group">
                <label className="form-label">AMOUNT (R$)</label>
                <input className="form-input" type="number" value={paymentForm.amount} onChange={e => setPaymentForm(f => ({ ...f, amount: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">DATE</label>
                <input className="form-input" type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm(f => ({ ...f, payment_date: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">PAID BY</label>
                <select className="form-select" value={paymentForm.paid_by} onChange={e => setPaymentForm(f => ({ ...f, paid_by: e.target.value }))} required>
                  <option value="">Select…</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">METHOD</label>
                <input className="form-input" value={paymentForm.payment_method} onChange={e => setPaymentForm(f => ({ ...f, payment_method: e.target.value }))} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">NOTES</label>
                <input className="form-input" placeholder="e.g. Parcela 2/6, Medição março…" value={paymentForm.notes} onChange={e => setPaymentForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary" type="submit">Record Payment</button>
              <button className="btn btn-ghost" type="button" onClick={() => { setShowPaymentForm(false); setPaymentFile(null) }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Add Expense Form */}
      {showExpenseForm && (
        <div className="card" style={{ marginBottom: '1.5rem', border: '1px solid rgba(232,168,76,0.3)' }}>
          <div className="card-title">🧾 Add Expense / Invoice</div>
          <div {...billDropzone.getRootProps()} style={{ border: `2px dashed ${billDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`, borderRadius: '10px', padding: '1.5rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem' }}>
            <input {...billDropzone.getInputProps()} />
            {billFile ? (
              <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>
                📄 {billFile.name} —{' '}
                <button type="button" className="btn btn-ghost" style={{ fontSize: '0.78rem', padding: '0.25rem 0.75rem' }} onClick={e => { e.stopPropagation(); processBillWithAI() }} disabled={processingBill}>
                  {processingBill ? '⏳ Processing…' : '🤖 Extract with AI'}
                </button>
              </div>
            ) : (
              <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>📄 Drop invoice here (PDF or photo) — AI will fill the form</div>
            )}
          </div>
          <form onSubmit={saveExpense}>
            <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
              {[['bill_number','Invoice #','text'],['contractor_name','Supplier','text'],['issue_date','Date','date'],['total_amount','Amount (R$)','number']].map(([key, label, type]) => (
                <div className="form-group" key={key}>
                  <label className="form-label">{label.toUpperCase()}</label>
                  <input className="form-input" type={type} value={expenseForm[key]} onChange={e => setExpenseForm(f => ({ ...f, [key]: e.target.value }))} required={key === 'total_amount'} />
                </div>
              ))}
              <div className="form-group">
                <label className="form-label">STATUS</label>
                <select className="form-select" value={expenseForm.status} onChange={e => setExpenseForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="pending">Pending</option>
                  <option value="paid">Paid</option>
                  <option value="disputed">Disputed</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">NOTES</label>
                <input className="form-input" value={expenseForm.notes} onChange={e => setExpenseForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary" type="submit">Save Expense</button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowExpenseForm(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* PAYMENTS TAB */}
      {activeTab === 'payments' && (
        <div className="card">
          <div className="card-title">💳 Payment History</div>
          {payments.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">💳</div><div className="empty-text">No payments yet — click "Log Payment" above</div></div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Amount</th><th>Paid By</th><th>Method</th><th>Notes</th><th>Receipt</th><th></th></tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td>{p.payment_date}</td>
                    <td style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif", fontSize: '1.05rem' }}>{fmt(p.amount)}</td>
                    <td>{p.paid_by?.full_name || '—'}</td>
                    <td style={{ color: '#8a8090' }}>{p.payment_method || '—'}</td>
                    <td style={{ color: '#8a8090' }}>{p.notes || '—'}</td>
                    <td>{p.drive_file_url ? <a href={p.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>📱 View</a> : '—'}</td>
                    <td>
                      <button onClick={() => deletePayment(p.id)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer', padding: '0.2rem' }} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* EXPENSES TAB */}
      {activeTab === 'expenses' && (
        <div>
          {bills.length === 0 ? (
            <div className="card"><div className="empty-state"><div className="empty-icon">🧾</div><div className="empty-text">No expenses yet — click "Add Expense" above</div></div></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {bills.map(bill => (
                <div key={bill.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{bill.contractor_name || 'Unknown'}{bill.bill_number ? ` — #${bill.bill_number}` : ''}</div>
                      <div style={{ fontSize: '0.78rem', color: '#8a8090' }}>{bill.issue_date}</div>
                      {bill.notes && <div style={{ fontSize: '0.78rem', color: '#5a5060', marginTop: '0.2rem' }}>{bill.notes}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.2rem', color: '#e8a84c' }}>{fmt(bill.total_amount)}</span>
                      <span className={`badge ${bill.status === 'paid' ? 'badge-green' : bill.status === 'disputed' ? 'badge-red' : 'badge-amber'}`}>{bill.status}</span>
                      {bill.drive_file_url && <a href={bill.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>📁 View</a>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CONTRACT TAB */}
      {activeTab === 'contract' && (
        <div className="card">
          <div className="card-title">📄 Contract Document</div>
          <div style={{ marginBottom: '1rem' }}>
            <div className="stat-label">CONTRACT VALUE</div>
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.8rem', color: '#c8a96e' }}>{fmt(budget)}</div>
            {project.contractor_name && <div style={{ color: '#8a8090', fontSize: '0.85rem', marginTop: '0.25rem' }}>{project.contractor_name}</div>}
            {project.contract_date && <div style={{ color: '#5a5060', fontSize: '0.8rem' }}>Signed {project.contract_date}</div>}
          </div>
          <hr className="divider" />
          <div style={{ color: '#8a8090', fontSize: '0.85rem', marginBottom: '1rem' }}>Upload the contract document to store it in Google Drive.</div>
          <div {...contractDropzone.getRootProps()} style={{ border: `2px dashed ${contractDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`, borderRadius: '10px', padding: '1.5rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem' }}>
            <input {...contractDropzone.getInputProps()} />
            {contractFile ? (
              <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>📄 {contractFile.name}</div>
            ) : (
              <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>Drop contract here (PDF or photo)</div>
            )}
          </div>
          {contractFile && (
            <button className="btn btn-primary" onClick={uploadContract} disabled={uploadingContract}>
              {uploadingContract ? '⏳ Uploading…' : '📤 Upload to Drive'}
            </button>
          )}
        </div>
      )}

      {/* AI ESTIMATE TAB */}
      {activeTab === 'estimate' && (
        <div>
          {!estimate ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🤖</div>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>AI Cost Estimation</div>
              <div style={{ color: '#8a8090', fontSize: '0.85rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                Claude will analyze your payments and expenses to estimate the final project cost.
              </div>
              <button className="btn btn-primary" onClick={getEstimate} disabled={loadingEstimate} style={{ fontSize: '0.9rem', padding: '0.75rem 1.5rem' }}>
                {loadingEstimate ? '⏳ Analyzing…' : <><Sparkles size={16} /> Generate Estimate</>}
              </button>
            </div>
          ) : (
            <div>
              <div className="grid-3" style={{ marginBottom: '1.5rem' }}>
                {[
                  { label: 'Estimated Final Cost', value: fmt(estimate.estimated_final_cost), color: estimate.estimated_final_cost > budget ? '#e05c6a' : '#4caf88' },
                  { label: 'Range', value: `${fmt(estimate.confidence_low)} – ${fmt(estimate.confidence_high)}` },
                  { label: 'Risk Level', value: estimate.risk_level?.toUpperCase(), color: estimate.risk_level === 'high' ? '#e05c6a' : estimate.risk_level === 'medium' ? '#e8a84c' : '#4caf88' }
                ].map((s, i) => (
                  <div key={i} className="card">
                    <div className="stat-label">{s.label}</div>
                    <div className="stat-value" style={{ fontSize: '1.4rem', color: s.color }}>{s.value}</div>
                  </div>
                ))}
              </div>
              <div className="card" style={{ marginBottom: '1rem' }}>
                <div className="card-title">📊 Summary</div>
                <p style={{ color: '#c8c0b8', lineHeight: 1.6, fontSize: '0.9rem' }}>{estimate.summary}</p>
              </div>
              <div className="grid-2">
                <div className="card">
                  <div className="card-title">🔍 Key Observations</div>
                  <ul style={{ paddingLeft: '1.25rem', color: '#8a8090', fontSize: '0.85rem', lineHeight: 1.8 }}>
                    {estimate.key_observations?.map((obs, i) => <li key={i}>{obs}</li>)}
                  </ul>
                </div>
                <div className="card">
                  <div className="card-title">💡 Recommendations</div>
                  <ul style={{ paddingLeft: '1.25rem', color: '#8a8090', fontSize: '0.85rem', lineHeight: 1.8 }}>
                    {estimate.recommendations?.map((rec, i) => <li key={i}>{rec}</li>)}
                  </ul>
                </div>
              </div>
              <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                <button className="btn btn-ghost" onClick={() => { setEstimate(null); getEstimate() }}>🔄 Refresh Estimate</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
