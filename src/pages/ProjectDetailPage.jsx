import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { uploadBillFile, uploadContractFile, requestDriveAccess, uploadPaymentFile } from '../lib/googleDrive'
import { extractBillData, generateCostEstimate, extractContractLineItems, extractBoletoDetails } from '../lib/ai'
import { parseProtocoloExcel, matchFilesToItems, generateWhatsAppMessage, openWhatsApp } from '../lib/protocolo'
import toast from 'react-hot-toast'
import { useDropzone } from 'react-dropzone'
import { format } from 'date-fns'
import { Sparkles, ArrowLeft, Plus, Trash2, Send } from 'lucide-react'

const fmt = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const fmtDate = (d) => d ? d.split('-').reverse().join('/') : '—'

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
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: file.type, data: base64 } },
          { type: 'text', text: `This is a Brazilian PIX payment confirmation. Extract and return ONLY valid JSON:
{
  "amount": number,
  "payment_date": "YYYY-MM-DD",
  "recipient_name": "string",
  "notes": "string (e.g. PIX para [recipient])"
}` }
        ]
      }]
    })
  })
  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  return JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim())
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

  // Protocolo state
  const [protocoloFiles, setProtocoloFiles] = useState([])
  const [protocoloItems, setProtocoloItems] = useState([])
  const [protocoloStep, setProtocoloStep] = useState('upload') // upload | review | done
  const [processingProtocolo, setProcessingProtocolo] = useState(false)
  const [savingProtocolo, setSavingProtocolo] = useState(false)
  const [whatsAppMessage, setWhatsAppMessage] = useState(null)
const [showWhatsApp, setShowWhatsApp] = useState(false)
  const [allProjects, setAllProjects] = useState([])

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
  const [{ data: p }, { data: b }, { data: bli }, { data: py }, { data: pr }, { data: ap }] = await Promise.all([
  supabase.from('projects').select('*').eq('id', id).single(),
  supabase.from('bills').select('*').eq('project_id', id).order('issue_date', { ascending: false }),
  supabase.from('bill_line_items').select('*'),
  supabase.from('payments').select('*, paid_by:profiles(id, full_name)').eq('project_id', id).order('payment_date', { ascending: false }),
  supabase.from('profiles').select('*'),
  supabase.from('projects').select('id, name').order('name')
])
setProject(p)
setBills((b || []).map(bill => ({ ...bill, bill_line_items: (bli || []).filter(i => i.bill_id === bill.id) })))
setPayments(py || [])
setProfiles(pr || [])
setAllProjects(ap || [])
setLoading(false)
    setPaymentForm(f => ({ ...f, paid_by: user?.id || '' }))
  }

  const budget = project?.contract_amount || 0
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)
  const totalExpenses = bills.reduce((s, b) => s + b.total_amount, 0)
  const remaining = budget - totalPaid
  const pctComplete = budget > 0 ? Math.min(totalPaid / budget * 100, 100) : 0

  // Protocolo dropzone - accepts all files
  const protocoloDropzone = useDropzone({
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [],
      'application/vnd.ms-excel': [],
      'application/pdf': [],
      'image/*': []
    },
    onDrop: files => setProtocoloFiles(prev => [...prev, ...files])
  })

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

  async function processProtocolo() {
    const excelFile = protocoloFiles.find(f =>
      f.name.endsWith('.xlsx') || f.name.endsWith('.xls')
    )
    if (!excelFile) {
      toast.error('Please include the Excel file (.xlsx)')
      return
    }

    setProcessingProtocolo(true)
    toast('Reading Protocolo…', { icon: '📋' })

    try {
      // Parse Excel
      let items = await parseProtocoloExcel(excelFile)

      // Match boletos and NFs to items
      const pdfFiles = protocoloFiles.filter(f => f.name.endsWith('.pdf') || f.type.startsWith('image/'))
      items = matchFilesToItems(items, pdfFiles)

      // Extract linha digitável from boletos using AI
      const itemsWithBoleto = items.filter(i => i.boleto_file)
      if (itemsWithBoleto.length > 0) {
        toast(`Reading ${itemsWithBoleto.length} boleto(s) with AI…`, { icon: '🤖' })
        await Promise.all(
          itemsWithBoleto.map(async (item, idx) => {
            try {
              const details = await extractBoletoDetails(item.boleto_file)
              items[items.indexOf(item)].linha_digitavel = details.linha_digitavel
            } catch (err) {
              console.warn('Could not extract boleto details:', err)
            }
          })
        )
      }

      setProtocoloItems(items)
      setProtocoloStep('review')
      toast.success(`${items.length} payment items found`)
    } catch (err) {
      toast.error('Failed to process Protocolo: ' + err.message)
    } finally {
      setProcessingProtocolo(false)
    }
  }

  function assignItem(idx, assignedTo) {
    setProtocoloItems(prev => prev.map((item, i) =>
      i === idx ? { ...item, assigned_to: assignedTo } : item
    ))
  }

  async function saveProtocolo() {
  setSavingProtocolo(true)
  const protocolName = `Protocolo ${protocoloItems[0]?.protocol_number || '?'}`

  try {
    // Load all existing payments for matching
    const { data: allPayments } = await supabase
      .from('payments')
      .select('*')

    for (const item of protocoloItems) {
      // For PAGO items: check if already in system
      if (item.status === 'PAGO') {
        const alreadyLogged = allPayments?.some(p =>
          Math.abs(p.amount - item.amount) < 1 &&
          p.notes?.toLowerCase().includes(item.supplier.toLowerCase().substring(0, 5))
        )
        if (alreadyLogged) continue // skip — already in system
        // Not found — save as paid bill with warning flag
        await supabase.from('bills').insert({
          project_id: item.project_id_override || id,
          contractor_name: item.supplier,
          bill_number: item.invoice_number,
          issue_date: item.due_date,
          due_date: item.due_date,
          total_amount: item.amount,
          status: 'paid',
          notes: [
            item.category,
            item.payment_method,
            `Responsável: ${item.assigned_to === 'pati' ? 'Patricia' : item.assigned_to === 'jorge' ? 'Jorge' : 'A definir'}`,
            protocolName,
            '⚠️ PAGO no protocolo mas não encontrado no sistema'
          ].filter(Boolean).join(' · ')
        })
        continue
      }

      // For A VENCER items: save as pending bill as before
      let boleto_drive_url = null
      let nf_drive_url = null

      if (item.boleto_file && project.drive_folder_id) {
        try {
          await requestDriveAccess()
          const uploaded = await uploadBillFile(item.boleto_file, project.drive_folder_id, `Boleto-${item.supplier}-${item.due_date}`)
          boleto_drive_url = uploaded.webViewLink
        } catch (e) { console.warn('Drive upload failed', e) }
      }
      if (item.nf_file && project.drive_folder_id) {
        try {
          await requestDriveAccess()
          const uploaded = await uploadBillFile(item.nf_file, project.drive_folder_id, `NF-${item.supplier}-${item.due_date}`)
          nf_drive_url = uploaded.webViewLink
        } catch (e) { console.warn('NF Drive upload failed', e) }
      }

      await supabase.from('bills').insert({
        project_id: item.project_id_override || id,
        contractor_name: item.supplier,
        bill_number: item.invoice_number,
        issue_date: item.due_date,
        due_date: item.due_date,
        total_amount: item.amount,
        status: 'pending',
        notes: [
          item.category,
          item.payment_method,
          item.linha_digitavel ? `Linha digitável: ${item.linha_digitavel}` : null,
          item.assigned_to ? `Responsável: ${item.assigned_to === 'pati' ? 'Patricia' : 'Jorge'}` : null,
          protocolName
        ].filter(Boolean).join(' · '),
        drive_file_url: boleto_drive_url || nf_drive_url
      })
    }

    // Generate WhatsApp message and store it
    const msg = generateWhatsAppMessage(protocoloItems, protocolName)
    if (msg) setWhatsAppMessage(msg)

    toast.success(`${protocolName} saved!`)
    setProtocoloStep('done')
    setProtocoloFiles([])
    loadData()
  } catch (err) {
    toast.error('Failed to save: ' + err.message)
  } finally {
    setSavingProtocolo(false)
  }
}

  async function createCalendarEvent(items, protocolName) {
    // Find earliest due date
    const dueDates = items.map(i => i.due_date).filter(Boolean).sort()
    if (dueDates.length === 0) return

    const eventDate = dueDates[0]
    const total = items.reduce((s, i) => s + i.amount, 0)
    const pendingItems = items.filter(i => i.status !== 'PAGO')

    const description = [
      `${protocolName} — ${pendingItems.length} pagamentos pendentes`,
      `Total: ${fmt(total)}`,
      '',
      ...pendingItems.map(item => [
        `• ${item.supplier}`,
        `  Valor: ${fmt(item.amount)}`,
        `  Vencimento: ${fmtDate(item.due_date)}`,
        `  Forma: ${item.payment_method || '—'}`,
        item.linha_digitavel ? `  Linha: ${item.linha_digitavel}` : null,
        `  Responsável: ${item.assigned_to === 'pati' ? 'Patricia' : item.assigned_to === 'jorge' ? 'Jorge' : 'A definir'}`
      ].filter(Boolean).join('\n'))
    ].join('\n')

    await fetch('https://gcal.mcp.claude.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'gcal_create_event',
          arguments: {
            summary: `🏠 Casa — ${protocolName} — ${fmt(total)} a pagar`,
            description,
            start_time: `${eventDate}T09:00:00`,
            end_time: `${eventDate}T09:30:00`,
            reminders: [{ method: 'popup', minutes: 1440 }, { method: 'popup', minutes: 120 }]
          }
        }
      })
    })
  }

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
      } catch {}
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
      toast.success('Invoice details extracted')
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

  const pendingBills = bills.filter(b => b.status === 'pending')
  const dueSoon = pendingBills.filter(b => {
    if (!b.due_date) return false
    const days = (new Date(b.due_date) - new Date()) / (1000 * 60 * 60 * 24)
    return days <= 7 && days >= 0
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

      {/* Due soon alert */}
      {dueSoon.length > 0 && (
        <div style={{ background: 'rgba(232,168,76,0.1)', border: '1px solid rgba(232,168,76,0.3)', borderRadius: '10px', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>⚠️</span>
          <span style={{ fontSize: '0.85rem', color: '#e8a84c' }}>
            <strong>{dueSoon.length} payment{dueSoon.length > 1 ? 's' : ''} due within 7 days:</strong>{' '}
            {dueSoon.map(b => `${b.contractor_name} ${fmt(b.total_amount)}`).join(', ')}
          </span>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
        {[
          { label: 'Contract Value', value: fmt(budget) },
          { label: 'Total Paid', value: fmt(totalPaid), color: '#4caf88' },
          { label: 'Pending Bills', value: fmt(pendingBills.reduce((s,b) => s+b.total_amount, 0)), color: pendingBills.length > 0 ? '#e8a84c' : undefined },
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
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(200,169,110,0.1)', flexWrap: 'wrap' }}>
        {['payments', 'protocolo', 'pending', 'expenses', 'contract', 'estimate'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem 1rem',
            fontSize: '0.82rem', fontFamily: "'DM Sans', sans-serif",
            color: activeTab === tab ? '#c8a96e' : '#8a8090',
            borderBottom: activeTab === tab ? '2px solid #c8a96e' : '2px solid transparent',
            marginBottom: '-1px', transition: 'color 0.15s',
            fontWeight: activeTab === tab ? 500 : 400, letterSpacing: '0.04em'
          }}>
            {tab === 'estimate' ? '🤖 AI Estimate' :
             tab === 'protocolo' ? '📋 Protocolo' :
             tab === 'pending' ? `⏳ Pending${pendingBills.length > 0 ? ` (${pendingBills.length})` : ''}` :
             tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Log Payment Form */}
      {showPaymentForm && (
        <div className="card" style={{ marginBottom: '1.5rem', border: '1px solid rgba(76,175,136,0.3)' }}>
          <div className="card-title">💳 Log Payment</div>
          <div {...receiptDropzone.getRootProps()} style={{
            border: `2px dashed ${receiptDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`,
            borderRadius: '10px', padding: '1.25rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem'
          }}>
            <input {...receiptDropzone.getInputProps()} />
            {processingReceipt ? (
              <div style={{ color: '#c8a96e', fontSize: '0.85rem' }}>🤖 Reading PIX receipt…</div>
            ) : paymentFile ? (
              <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>✅ {paymentFile.name} — form filled automatically</div>
            ) : (
              <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>📱 Drop PIX screenshot — AI fills form automatically</div>
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
              <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>📄 Drop invoice here — AI will fill the form</div>
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
            <div className="empty-state"><div className="empty-icon">💳</div><div className="empty-text">No payments yet</div></div>
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
                    <td style={{ color: '#8a8090', fontSize: '0.8rem' }}>{p.notes || '—'}</td>
                    <td>{p.drive_file_url ? <a href={p.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#c8a96e', fontSize: '0.78rem' }}>📱 View</a> : '—'}</td>
                    <td>
                      <button onClick={() => deletePayment(p.id)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer', padding: '0.2rem' }}>
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

      {/* PROTOCOLO TAB */}
      {activeTab === 'protocolo' && (
        <div>
          {protocoloStep === 'upload' && (
            <div className="card">
              <div className="card-title">📋 Upload Protocolo</div>
              <div style={{ color: '#8a8090', fontSize: '0.85rem', marginBottom: '1rem' }}>
                Drop all files at once: the Excel spreadsheet + all boleto PDFs + all NF PDFs
              </div>
              <div {...protocoloDropzone.getRootProps()} style={{
                border: `2px dashed ${protocoloDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`,
                borderRadius: '12px', padding: '2rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem'
              }}>
                <input {...protocoloDropzone.getInputProps()} />
                <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📂</div>
                <div style={{ color: '#8a8090', fontSize: '0.85rem' }}>
                  {protocoloDropzone.isDragActive ? 'Drop files here…' : 'Drop Excel + Boletos + NFs here, or click to select'}
                </div>
              </div>
              {protocoloFiles.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ fontSize: '0.78rem', color: '#8a8090', marginBottom: '0.5rem' }}>{protocoloFiles.length} file(s) selected:</div>
                  {protocoloFiles.map((f, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0', fontSize: '0.8rem', borderBottom: '1px solid rgba(200,169,110,0.08)' }}>
                      <span style={{ color: f.name.endsWith('.xlsx') || f.name.endsWith('.xls') ? '#c8a96e' : '#8a8090' }}>
                        {f.name.endsWith('.xlsx') || f.name.endsWith('.xls') ? '📊' : f.name.toUpperCase().includes('NF') ? '🧾' : '📄'} {f.name}
                      </span>
                      <button onClick={() => setProtocoloFiles(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              {protocoloFiles.length > 0 && (
                <button className="btn btn-primary" onClick={processProtocolo} disabled={processingProtocolo}>
                  {processingProtocolo ? '⏳ Processing…' : '🤖 Process Protocolo'}
                </button>
              )}
            </div>
          )}

          {protocoloStep === 'review' && (
            <div>
              <div className="card" style={{ marginBottom: '1rem' }}>
                <div className="card-title">👀 Review & Assign — {protocoloItems[0]?.protocol_number ? `Protocolo ${protocoloItems[0].protocol_number}` : 'Protocolo'}</div>
                <div style={{ color: '#8a8090', fontSize: '0.85rem', marginBottom: '1rem' }}>
                  Assign each payment to Jorge or Pati, then confirm to save and send.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {protocoloItems.map((item, idx) => (
                    <div key={idx} style={{
                      background: '#13131f', borderRadius: '10px', padding: '1rem',
                      border: `1px solid ${item.status === 'PAGO' ? 'rgba(76,175,136,0.2)' : 'rgba(200,169,110,0.15)'}`
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                        <div>
                          <div style={{ fontWeight: 500, fontSize: '0.95rem' }}>{item.supplier}</div>
                          <div style={{ fontSize: '0.75rem', color: '#5a5060' }}>
                            {item.category} · {item.payment_method} · Due {fmtDate(item.due_date)}
                            {item.invoice_number && ` · NF ${item.invoice_number}`}
                          </div>
                          {item.linha_digitavel && (
                            <div style={{ fontSize: '0.72rem', color: '#8a8090', marginTop: '0.3rem', fontFamily: 'monospace', background: 'rgba(0,0,0,0.2)', padding: '0.25rem 0.5rem', borderRadius: '4px' }}>
                              {item.linha_digitavel}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem' }}>
                          <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.1rem', color: '#c8a96e' }}>{fmt(item.amount)}</span>
                          <span className={`badge ${item.status === 'PAGO' ? 'badge-green' : 'badge-amber'}`}>{item.status}</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
  <div style={{ fontSize: '0.75rem', color: '#5a5060', marginRight: '0.5rem', alignSelf: 'center' }}>Assign to:</div>
  {['jorge', 'pati', null].map(person => (
    <button key={String(person)} onClick={() => assignItem(idx, person)} style={{
      padding: '0.25rem 0.75rem', borderRadius: '6px', fontSize: '0.78rem', cursor: 'pointer',
      border: `1px solid ${item.assigned_to === person ? '#c8a96e' : 'rgba(200,169,110,0.2)'}`,
      background: item.assigned_to === person ? 'rgba(200,169,110,0.15)' : 'transparent',
      color: item.assigned_to === person ? '#c8a96e' : '#8a8090'
    }}>
      {person === null ? 'Unassigned' : person === 'jorge' ? '👤 Jorge' : '👤 Pati'}
    </button>
  ))}
  {item.status === 'PAGO' && (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ fontSize: '0.72rem', color: '#5a5060' }}>Project:</span>
      <select
        value={item.project_id_override || id}
        onChange={e => setProtocoloItems(prev => prev.map((it, i) => i === idx ? { ...it, project_id_override: e.target.value } : it))}
        style={{ background: '#13131f', border: '1px solid rgba(200,169,110,0.2)', borderRadius: '6px', color: '#c8a96e', fontSize: '0.72rem', padding: '0.2rem 0.4rem' }}
      >
        {allProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  )}
  <div style={{ display: 'flex', gap: '0.3rem', fontSize: '0.72rem', color: '#5a5060' }}>
    {item.boleto_file && <span>📄 Boleto</span>}
    {item.nf_file && <span>🧾 NF</span>}
  </div>
</div>
                    </div>
                  ))}
                </div>
              </div>

              {protocoloItems.some(i => i.assigned_to === 'pati') && (
                <div style={{ background: 'rgba(76,175,136,0.05)', border: '1px solid rgba(76,175,136,0.2)', borderRadius: '10px', padding: '1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#4caf88' }}>
                  💬 WhatsApp will open for Pati with {protocoloItems.filter(i => i.assigned_to === 'pati').length} payment(s) totalling {fmt(protocoloItems.filter(i => i.assigned_to === 'pati').reduce((s,i) => s+i.amount, 0))}
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn btn-primary" onClick={saveProtocolo} disabled={savingProtocolo} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {savingProtocolo ? '⏳ Saving…' : <><Send size={15} /> Confirm & Send</>}
                </button>
                <button className="btn btn-ghost" onClick={() => { setProtocoloStep('upload'); setProtocoloFiles([]) }}>Back</button>
              </div>
            </div>
          )}

          {protocoloStep === 'done' && (
  <div>
    <div className="card" style={{ textAlign: 'center', padding: '2rem', marginBottom: '1rem' }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>✅</div>
      <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>Protocolo saved!</div>
      <div style={{ color: '#8a8090', fontSize: '0.85rem', marginBottom: '1.5rem' }}>Bills created and saved to pending</div>
      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => { setProtocoloStep('upload'); setActiveTab('pending') }}>View Pending Bills</button>
        {whatsAppMessage && (
          <button className="btn btn-ghost" onClick={() => setShowWhatsApp(true)}>💬 View Message for Pati</button>
        )}
      </div>
    </div>
    {whatsAppMessage && showWhatsApp && (
      <div className="card" style={{ border: '1px solid rgba(76,175,136,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div className="card-title" style={{ marginBottom: 0 }}>💬 Message for Pati</div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-primary" style={{ fontSize: '0.78rem' }} onClick={() => { navigator.clipboard.writeText(whatsAppMessage); toast.success('Copied!') }}>📋 Copy</button>
            <button className="btn btn-ghost" style={{ fontSize: '0.78rem' }} onClick={() => window.open(`https://wa.me/5511984055050?text=${encodeURIComponent(whatsAppMessage)}`, '_blank')}>📱 Open WhatsApp</button>
            <button onClick={() => setShowWhatsApp(false)} style={{ background: 'none', border: 'none', color: '#5a5060', cursor: 'pointer' }}>✕</button>
          </div>
        </div>
        <pre style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#c8c0b8', whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', lineHeight: 1.6 }}>{whatsAppMessage}</pre>
      </div>
    )}
  </div>
)}
        </div>
      )}

      {/* PENDING BILLS TAB */}
      {activeTab === 'pending' && (
        <div>
          {pendingBills.length === 0 ? (
            <div className="card"><div className="empty-state"><div className="empty-icon">✅</div><div className="empty-text">No pending bills</div></div></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {pendingBills.sort((a,b) => (a.due_date||'').localeCompare(b.due_date||'')).map(bill => {
                const daysUntil = bill.due_date ? Math.ceil((new Date(bill.due_date) - new Date()) / (1000 * 60 * 60 * 24)) : null
                const isOverdue = daysUntil !== null && daysUntil < 0
                const isDueSoon = daysUntil !== null && daysUntil <= 7 && daysUntil >= 0

                // Extract linha digitável from notes
                const linhaMatch = bill.notes?.match(/Linha digitável: ([^\s·]+(?:\s+[^\s·]+)*?)(?:\s*·|$)/)
                const linha = linhaMatch ? linhaMatch[1] : null

                return (
                  <div key={bill.id} className="card" style={{ borderLeft: `3px solid ${isOverdue ? '#e05c6a' : isDueSoon ? '#e8a84c' : 'rgba(200,169,110,0.2)'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{bill.contractor_name}</div>
                        <div style={{ fontSize: '0.78rem', color: '#8a8090', marginBottom: '0.25rem' }}>
                          {bill.due_date ? `Due ${fmtDate(bill.due_date)}` : 'No due date'}
                          {daysUntil !== null && (
                            <span style={{ marginLeft: '0.5rem', color: isOverdue ? '#e05c6a' : isDueSoon ? '#e8a84c' : '#5a5060' }}>
                              {isOverdue ? `${Math.abs(daysUntil)} days overdue` : daysUntil === 0 ? 'Due today!' : `${daysUntil} days`}
                            </span>
                          )}
                        </div>
                        {bill.notes && <div style={{ fontSize: '0.75rem', color: '#5a5060' }}>{bill.notes.replace(/Linha digitável:.*/, '').trim()}</div>}
                        {linha && (
                          <div style={{ marginTop: '0.5rem', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '0.4rem 0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.72rem', color: '#c8a96e', fontFamily: 'monospace' }}>{linha}</span>
                            <button onClick={() => { navigator.clipboard.writeText(linha); toast.success('Copied!') }} style={{ background: 'none', border: 'none', color: '#8a8090', cursor: 'pointer', fontSize: '0.72rem' }}>📋 Copy</button>
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem', marginLeft: '1rem' }}>
                        <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.2rem', color: '#c8a96e' }}>{fmt(bill.total_amount)}</span>
                        {bill.drive_file_url && <a href={bill.drive_file_url} target="_blank" rel="noreferrer" style={{ color: '#8a8090', fontSize: '0.75rem' }}>📄 View</a>}
                        <button className="btn btn-ghost" style={{ fontSize: '0.75rem', padding: '0.25rem 0.75rem' }}
                          onClick={async () => {
                            await supabase.from('bills').update({ status: 'paid' }).eq('id', bill.id)
                            toast.success('Marked as paid')
                            loadData()
                          }}>
                          ✅ Mark paid
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* EXPENSES TAB */}
      {activeTab === 'expenses' && (
        <div>
          {bills.filter(b => b.status !== 'pending').length === 0 ? (
            <div className="card"><div className="empty-state"><div className="empty-icon">🧾</div><div className="empty-text">No expenses yet</div></div></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {bills.filter(b => b.status !== 'pending').map(bill => (
                <div key={bill.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{bill.contractor_name}{bill.bill_number ? ` — #${bill.bill_number}` : ''}</div>
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
          <div {...contractDropzone.getRootProps()} style={{ border: `2px dashed ${contractDropzone.isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`, borderRadius: '10px', padding: '1.5rem', textAlign: 'center', cursor: 'pointer', marginBottom: '1rem' }}>
            <input {...contractDropzone.getInputProps()} />
            {contractFile ? <div style={{ color: '#4caf88', fontSize: '0.85rem' }}>📄 {contractFile.name}</div> : <div style={{ color: '#5a5060', fontSize: '0.85rem' }}>Drop contract here</div>}
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
              <div style={{ color: '#8a8090', fontSize: '0.85rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>Claude will analyze your payments and expenses to estimate the final project cost.</div>
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
                <button className="btn btn-ghost" onClick={() => { setEstimate(null); getEstimate() }}>🔄 Refresh</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
