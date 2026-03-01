import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { uploadBillFile, uploadPaymentFile, uploadContractFile, requestDriveAccess } from '../lib/googleDrive'
import { extractBillData, generateCostEstimate, extractContractLineItems } from '../lib/ai'
import toast from 'react-hot-toast'
import { useDropzone } from 'react-dropzone'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { format } from 'date-fns'
import { Sparkles, ArrowLeft, Plus } from 'lucide-react'

const fmt = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export default function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [project, setProject] = useState(null)
  const [lineItems, setLineItems] = useState([])
  const [bills, setBills] = useState([])
  const [payments, setPayments] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [showBillForm, setShowBillForm] = useState(false)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [billFile, setBillFile] = useState(null)
  const [paymentFile, setPaymentFile] = useState(null)
  const [contractFile, setContractFile] = useState(null)
  const [uploadingContract, setUploadingContract] = useState(false)
  const [billForm, setBillForm] = useState({ bill_number: '', contractor_name: '', issue_date: '', due_date: '', total_amount: '', notes: '', status: 'pending' })
  const [paymentForm, setPaymentForm] = useState({ amount: '', payment_date: format(new Date(), 'yyyy-MM-dd'), notes: '', paid_by: '', bill_id: '', payment_method: '' })
  const [estimate, setEstimate] = useState(null)
  const [loadingEstimate, setLoadingEstimate] = useState(false)
  const [processingBill, setProcessingBill] = useState(false)

  useEffect(() => { loadData() }, [id])

  async function loadData() {
    const [{ data: p }, { data: li }, { data: b }, { data: bli }, { data: py }, { data: pr }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('contract_line_items').select('*').eq('project_id', id).order('sort_order'),
      supabase.from('bills').select('*').eq('project_id', id).order('issue_date', { ascending: false }),
      supabase.from('bill_line_items').select('*'),
      supabase.from('payments').select('*, paid_by:profiles(id, full_name)').eq('project_id', id).order('payment_date', { ascending: false }),
      supabase.from('profiles').select('*')
    ])
    setProject(p)
    setLineItems(li || [])
    setBills((b || []).map(bill => ({ ...bill, bill_line_items: (bli || []).filter(i => i.bill_id === bill.id) })))
    setPayments(py || [])
    setProfiles(pr || [])
    setLoading(false)
    setPaymentForm(f => ({ ...f, paid_by: user?.id || '' }))
  }

  const totalBudget = lineItems.reduce((s, i) => s + i.budgeted_amount, 0) || project?.contract_amount || 0
  const totalBilled = bills.reduce((s, b) => s + b.total_amount, 0)
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)
  const totalDeviation = totalBilled - totalBudget
  const deviationPct = totalBudget > 0 ? (totalDeviation / totalBudget * 100) : 0

  const lineItemAnalysis = lineItems.map(item => {
    const billed = bills.flatMap(b => b.bill_line_items || [])
      .filter(bli => bli.contract_line_item_id === item.id)
      .reduce((s, bli) => s + bli.amount, 0)
    const deviation = billed - item.budgeted_amount
    const devPct = item.budgeted_amount > 0 ? deviation / item.budgeted_amount * 100 : 0
    return { ...item, billed, deviation, devPct }
  })

  const chartData = lineItemAnalysis.map(item => ({
    name: item.description.length > 20 ? item.description.slice(0, 20) + '…' : item.description,
    budget: item.budgeted_amount,
    billed: item.billed,
    deviation: item.deviation
  }))

  const billDropzone = useDropzone({
    accept: { 'application/pdf': [], 'image/*': [] },
    maxFiles: 1,
    onDrop: files => setBillFile(files[0])
  })

  const paymentDropzone = useDropzone({
    accept: { 'application/pdf': [], 'image/*': [] },
    maxFiles: 1,
    onDrop: files => setPaymentFile(files[0])
  })

  const contractDropzone = useDropzone({
    accept: { 'application/pdf': [], 'image/*': [] },
    maxFiles: 1,
    onDrop: files => setContractFile(files[0])
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
      if (extracted.line_items?.length) {
        await supabase.from('contract_line_items').insert(
          extracted.line_items.map((item, i) => ({
            project_id: id,
            description: item.description,
            budgeted_amount: item.amount,
            category: item.category,
            sort_order: i
          }))
        )
      }
      toast.success(`Contract processed — ${extracted.line_items?.length || 0} line items extracted`)
      setContractFile(null)
      loadData()
    } catch (err) {
      toast.error('Contract processing failed: ' + err.message)
    } finally {
      setUploadingContract(false)
    }
  }

  async function processBillWithAI() {
    if (!billFile) return
    setProcessingBill(true)
    toast('AI is reading your bill…', { icon: '🤖' })
    try {
      const extracted = await extractBillData(billFile, lineItems)
      setBillForm({
        bill_number: extracted.bill_number || '',
        contractor_name: extracted.contractor_name || '',
        issue_date: extracted.issue_date || '',
        due_date: extracted.due_date || '',
        total_amount: extracted.total_amount || '',
        notes: extracted.notes || '',
        status: 'pending'
      })
      toast.success('Bill details extracted — review and save')
      window._extractedBillLineItems = extracted.line_items
    } catch (err) {
      toast.error('AI extraction failed: ' + err.message)
    } finally {
      setProcessingBill(false)
    }
  }

  async function saveBill(e) {
    e.preventDefault()
    let drive_file_id = null, drive_file_url = null
    if (billFile && project.drive_folder_id) {
      try {
        await requestDriveAccess()
        const uploaded = await uploadBillFile(billFile, project.drive_folder_id, `Bill-${billForm.bill_number || billForm.issue_date}`)
        drive_file_id = uploaded.id
        drive_file_url = uploaded.webViewLink
      } catch {}
    }
    const { data: bill, error } = await supabase.from('bills').insert({
      project_id: id, ...billForm, total_amount: +billForm.total_amount, drive_file_id, drive_file_url
    }).select().single()
    if (error) { toast.error(error.message); return }
    const aiLineItems = window._extractedBillLineItems
    if (aiLineItems?.length) {
      await supabase.from('bill_line_items').insert(
        aiLineItems.map(item => ({
          bill_id: bill.id,
          contract_line_item_id: item.contract_line_item_id || null,
          description: item.description,
          amount: item.amount,
          is_deviation: item.is_deviation || false,
          deviation_reason: item.deviation_reason || null
        }))
      )
      window._extractedBillLineItems = null
    }
    toast.success('Bill saved')
    setShowBillForm(false)
    setBillFile(null)
    setBillForm({ bill_number: '', contractor_name: '', issue_date: '', due_date: '', total_amount: '', notes: '', status: 'pending' })
    loadData()
  }

  async function savePayment(e) {
    e.preventDefault()
    let drive_file_id = null, drive_file_url = null
    if (paymentFile && project.drive_folder_id) {
      try {
        await requestDriveAccess()
        const uploaded = await uploadPaymentFile(paymentFile, project.drive_folder_id, `Payment-${paymentForm.payment_date}`)
        drive_file_id = uploaded.id
        drive_file_url = uploaded.webViewLink
      } catch {}
    }
    const { error } = await supabase.from('payments').insert({
      project_id: id, bill_id: paymentForm.bill_id || null, paid_by: paymentForm.paid_by,
      amount: +paymentForm.amount, payment_date: paymentForm.payment_date,
      notes: paymentForm.notes, payment_method: paymentForm.payment_method,
      drive_file_id, drive_file_url
    })
    if (error) toast.error(error.message)
    else { toast.success('Payment recorded'); setShowPaymentForm(false); setPaymentFile(null); loadData() }
  }

  async function getEstimate() {
    setLoadingEstimate(true)
    try {
      const est = await generateCostEstimate(project, lineItems, bills, payments)
      setEstimate(est)
    } catch (err) {
      toast.error('Estimation failed: ' + err.message)
    } finally {
      setLoadingEstimate(false)
    }
  }

  if (loading) return <div className="empty-state"><div className="empty-text">Loading…</div></div>
  if (!project) return <div className="empty-state"><div className="empty-text">Project not found</div></div>

  const tabs = ['overview', 'bills', 'payments', 'estimate']

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
          <button className="btn btn-ghost" onClick={() => setShowBillForm(!showBillForm)}><Plus size={15} /> Add Bill</button>
          <button className="btn btn-primary" onClick={() => setShowPaymentForm(!showPaymentForm)}><Plus size={15} /> Log Payment</button>
        </div>
      </div>

      <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
        {[
          { label: 'Budget', value: fmt(totalBudget) },
          { label: 'Total Billed', value: fmt(totalBilled), color: deviationPct > 10 ? '#e05c6a' : deviationPct > 0 ? '#e8a84c' : undefined },
          { label: 'Total Paid', value: fmt(totalPaid), color: '#4caf88' },
          { label: 'Deviation', value: `${deviationPct > 0 ? '+' : ''}${deviationPct.toFixed(1)}%`, color: deviationPct > 10 ? '#e05c6a' : deviationPct > 0 ? '#e8a84c' : '#4caf88', sub: fmt(totalDeviation) }
        ].map((s, i) => (
          <div key={i} className="card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value" style={{ fontSize: '1.4rem', color: s.color }}>{s.value}</div>
            {s.sub && <div className="stat-sub">{s.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(200,169,110,0.1)' }}>
        {tabs.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem 1rem',
            fontSize: '0.82rem', fontFamily: "'DM Sans', sans-serif",
            color: activeTab === tab ? '#c8a96e' : '#8a8090',
            borderBottom: activeTab === tab ? '2px solid #c8a96e' : '2px solid transparent',
            marginBottom: '-1px', transition: 'color 0.15s', textTransform: 'capitalize',
            fontWeight: activeTab === tab ? 500 : 400, letterSpacing: '0.04em'
          }}>
            {tab === 'estimate' ? '🤖 AI Estimate' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div>
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-title">📄 Contract Document</div>
            {lineItems.length > 0 ? (
              <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>✅ Contract uploaded — {lineItems.length} line items extracted</div>
            ) : (
              <div>
                <div style={{ color: '#8a8090', fontSize: '0.85rem', marginBottom: '1rem' }}>No contract uploaded yet. Upload one to extract line items automatically.</div>
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
                    {uploadingContract ? '⏳ Processing…' : '🤖 Upload & Extract with AI'}
                  </button>
                )}
              </div>
            )}
          </div>

          {lineItems.length === 0 ? null : (
            <>
              <div className="card" style={{ marginBottom: '1.5rem' }}>
                <div className="card-title">📊 Budget vs. Billed by Line Item</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartData} layout="vertical">
                    <XAxis type="number" tick={{ fill: '#5a5060', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${v/1000}k`} />
                    <YAxis dataKey="name" type="category" tick={{ fill: '#8a8090', fontSize: 11 }} axisLine={false} tickLine={false} width={120} />
                    <Tooltip contentStyle={{ background: '#1a1a2c', border: '1px solid rgba(200,169,110,0.2)', borderRadius: 8, color: '#e8dcc8' }} formatter={v => [fmt(v)]} />
                    <Bar dataKey="budget" fill="rgba(200,169,110,0.3)" radius={[0,4,4,0]} name="Budget" />
                    <Bar dataKey="billed" radius={[0,4,4,0]} name="Billed">
                      {chartData.map((entry, i) => <Cell key={i} fill={entry.billed > entry.budget ? '#e05c6a' : '#4caf88'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card">
                <div className="card-title">📋 Contract Line Items</div>
                <table className="table">
                  <thead><tr><th>Description</th><th>Category</th><th>Budget</th><th>Billed</th><th>Deviation</th></tr></thead>
                  <tbody>
                    {lineItemAnalysis.map(item => (
                      <tr key={item.id}>
                        <td>{item.description}</td>
                        <td><span className="badge badge-muted">{item.category}</span></td>
                        <td>{fmt(item.budgeted_amount)}</td>
                        <td>{fmt(item.billed)}</td>
                        <td>{item.billed > 0 ? <span className={item.devPct > 10 ? 'amount-negative' : item.devPct > 0 ? 'amount-warning' : 'amount-positive'}>{item.devPct > 0 ? '+' : ''}{item.devPct.toFixed(1)}%</span> : <span style={{ color: '#5a5060' }}>—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'bills' && (
        <div>
          {showBillForm && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <div className="card-title">+ Add Bill</div>
              <div {...billDropzone.getRootProps()} style={{ border: `2px dashed ${billDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`, borderRadius: '10px', padding: '1.5rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem' }}>
                <input {...billDropzone.getInputProps()} />
                {billFile ? (
                  <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>📄 {billFile.name} — <button type="button" className="btn btn-ghost" style={{ fontSize: '0.78rem', padding: '0.25rem 0.75rem' }} onClick={e => { e.stopPropagation(); processBillWithAI() }} disabled={processingBill}>{processingBill ? '⏳ Processing…' : '🤖 Extract with AI'}</button></div>
                ) : (
                  <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>📄 Drop bill/invoice (PDF or photo) — AI will fill the form</div>
                )}
              </div>
              <form onSubmit={saveBill}>
                <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
                  {[['bill_number','Bill Number','text'],['contractor_name','Contractor','text'],['issue_date','Issue Date','date'],['due_date','Due Date','date'],['total_amount','Total Amount (R$)','number']].map(([key, label, type]) => (
                    <div className="form-group" key={key}>
                      <label className="form-label">{label.toUpperCase()}</label>
                      <input className="form-input" type={type} value={billForm[key]} onChange={e => setBillForm(f => ({ ...f, [key]: e.target.value }))} required={key === 'total_amount'} />
                    </div>
                  ))}
                  <div className="form-group">
                    <label className="form-label">STATUS</label>
                    <select className="form-select" value={billForm.status} onChange={e => setBillForm(f => ({ ...f, status: e.target.value }))}>
                      <option value="pending">Pending</option>
                      <option value="partially_paid">Partially Paid</option>
                      <option value="paid">Paid</option>
                      <option value="disputed">Disputed</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-primary" type="submit">Save Bill</button>
                  <button className="btn btn-ghost" type="button" onClick={() => setShowBillForm(false)}>Cancel</button>
                </div>
              </form>
            </div>
          )}
          {bills.length === 0 ? (
            <div className="card"><div className="empty-state"><div className="empty-icon">📄</div><div className="empty-text">No bills yet</div></div></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {bills.map(bill => (
                <div key={bill.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{bill.contractor_name || 'Unknown'} {bill.bill_number ? `— #${bill.bill_number}` : ''}</div>
                      <div style={{ fontSize: '0.78rem', color: '#8a8090' }}>{bill.issue_date} {bill.due_date ? `· Due ${bill.due_date}` : ''}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.2rem', color: '#c8a96e' }}>{fmt(bill.total_amount)}</span>
                      <span className={`badge ${bill.status === 'paid' ? 'badge-green' : bill.status === 'disputed' ? 'badge-red' : bill.status === 'partially_paid' ? 'badge-amber' : 'badge-muted'}`}>{bill.status}</span>
                      {bill.drive_file_url && <a href={bill.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>📁 View</a>}
                    </div>
                  </div>
                  {bill.bill_line_items?.length > 0 && (
                    <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(200,169,110,0.08)' }}>
                      {bill.bill_line_items.map(item => (
                        <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '0.2rem 0', color: item.is_deviation ? '#e8a84c' : '#8a8090' }}>
                          <span>{item.is_deviation ? '⚠️ ' : ''}{item.description}</span>
                          <span>{fmt(item.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'payments' && (
        <div>
          {showPaymentForm && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <div className="card-title">+ Log Payment</div>
              <form onSubmit={savePayment}>
                <div className="grid-3" style={{ gap: '1rem', marginBottom: '1rem' }}>
                  <div className="form-group"><label className="form-label">AMOUNT (R$)</label><input className="form-input" type="number" value={paymentForm.amount} onChange={e => setPaymentForm(f => ({ ...f, amount: e.target.value }))} required /></div>
                  <div className="form-group"><label className="form-label">DATE</label><input className="form-input" type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm(f => ({ ...f, payment_date: e.target.value }))} required /></div>
                  <div className="form-group">
                    <label className="form-label">PAID BY</label>
                    <select className="form-select" value={paymentForm.paid_by} onChange={e => setPaymentForm(f => ({ ...f, paid_by: e.target.value }))} required>
                      <option value="">Select…</option>
                      {profiles.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">LINKED BILL</label>
                    <select className="form-select" value={paymentForm.bill_id} onChange={e => setPaymentForm(f => ({ ...f, bill_id: e.target.value }))}>
                      <option value="">None</option>
                      {bills.map(b => <option key={b.id} value={b.id}>#{b.bill_number || b.id.slice(0,8)} — {fmt(b.total_amount)}</option>)}
                    </select>
                  </div>
                  <div className="form-group"><label className="form-label">METHOD</label><input className="form-input" placeholder="Bank transfer, cash…" value={paymentForm.payment_method} onChange={e => setPaymentForm(f => ({ ...f, payment_method: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">NOTES</label><input className="form-input" value={paymentForm.notes} onChange={e => setPaymentForm(f => ({ ...f, notes: e.target.value }))} /></div>
                </div>
                <div {...paymentDropzone.getRootProps()} style={{ border: '1px dashed rgba(200,169,110,0.2)', borderRadius: '8px', padding: '1rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem', fontSize: '0.8rem', color: '#5a5060' }}>
                  <input {...paymentDropzone.getInputProps()} />
                  {paymentFile ? <span style={{ color: '#4caf88' }}>✅ {paymentFile.name}</span> : <span>📎 Attach proof (optional)</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-primary" type="submit">Record Payment</button>
                  <button className="btn btn-ghost" type="button" onClick={() => setShowPaymentForm(false)}>Cancel</button>
                </div>
              </form>
            </div>
          )}
          {payments.length > 0 && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <div className="card-title">💑 Contributions — {project.name}</div>
              {profiles.map(person => {
                const personTotal = payments.filter(p => (p.paid_by?.id || p.paid_by) === person.id).reduce((s, p) => s + p.amount, 0)
                const pct = totalPaid > 0 ? personTotal / totalPaid * 100 : 0
                return (
                  <div key={person.id} style={{ marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', marginBottom: '0.3rem' }}>
                      <span>{person.full_name}</span>
                      <span style={{ color: '#c8a96e' }}>{fmt(personTotal)} ({pct.toFixed(0)}%)</span>
                    </div>
                    <div style={{ height: '4px', background: '#1a1a2c', borderRadius: '4px' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #c8a96e, #4caf88)', borderRadius: '4px' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {payments.length === 0 ? (
            <div className="card"><div className="empty-state"><div className="empty-icon">💳</div><div className="empty-text">No payments yet</div></div></div>
          ) : (
            <div className="card">
              <div className="card-title">💳 Payment History</div>
              <table className="table">
                <thead><tr><th>Date</th><th>Amount</th><th>Paid By</th><th>Method</th><th>Bill</th><th>Notes</th><th>Proof</th></tr></thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id}>
                      <td>{p.payment_date}</td>
                      <td style={{ color: '#4caf88', fontFamily: "'Cormorant Garamond', serif" }}>{fmt(p.amount)}</td>
                      <td>{p.paid_by?.full_name || '—'}</td>
                      <td style={{ color: '#8a8090' }}>{p.payment_method || '—'}</td>
                      <td style={{ color: '#8a8090', fontSize: '0.78rem' }}>{p.bill_id ? `#${bills.find(b => b.id === p.bill_id)?.bill_number || p.bill_id.slice(0,6)}` : '—'}</td>
                      <td style={{ color: '#8a8090' }}>{p.notes || '—'}</td>
                      <td>{p.drive_file_url ? <a href={p.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>View</a> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'estimate' && (
        <div>
          {!estimate ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🤖</div>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>AI Cost Estimation</div>
              <div style={{ color: '#8a8090', fontSize: '0.85rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                Claude will analyze your contract, bills, and deviations to estimate the final project cost and highlight risks.
              </div>
              <button className="btn btn-primary" onClick={getEstimate} disabled={loadingEstimate} style={{ fontSize: '0.9rem', padding: '0.75rem 1.5rem' }}>
                {loadingEstimate ? '⏳ Analyzing…' : <><Sparkles size={16} /> Generate Estimate</>}
              </button>
            </div>
          ) : (
            <div>
              <div className="grid-3" style={{ marginBottom: '1.5rem' }}>
                {[
                  { label: 'Estimated Final Cost', value: fmt(estimate.estimated_final_cost), color: estimate.estimated_final_cost > totalBudget ? '#e05c6a' : '#4caf88' },
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
