import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ensureProjectFolder, requestDriveAccess, ensureRootStructure, uploadContractFile } from '../lib/googleDrive'
import { extractContractLineItems } from '../lib/ai'
import toast from 'react-hot-toast'
import { useDropzone } from 'react-dropzone'

export default function NewProjectPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: '', contractor_name: '', contract_date: '',
    contract_amount: '', status: 'active', notes: ''
  })
  const [contractFile, setContractFile] = useState(null)
  const [processing, setProcessing] = useState(false)

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/pdf': [], 'image/*': [] },
    maxFiles: 1,
    onDrop: files => setContractFile(files[0])
  })

  async function handleSubmit(e) {
    e.preventDefault()
    setProcessing(true)

    try {
      const { data: project, error } = await supabase.from('projects').insert({
        name: form.name,
        contractor_name: form.contractor_name,
        contract_date: form.contract_date || null,
        contract_amount: form.contract_amount ? +form.contract_amount : null,
        status: form.status,
        notes: form.notes
      }).select().single()

      if (error) throw error

      let driveFolderId = null
      try {
        toast('Creating Google Drive folder…', { icon: '📁' })
        await requestDriveAccess()
        await ensureRootStructure()
        driveFolderId = await ensureProjectFolder(form.name)
        await supabase.from('projects').update({ drive_folder_id: driveFolderId }).eq('id', project.id)
      } catch (driveErr) {
        toast.error('Drive folder creation failed — you can reconnect Drive later')
      }

      if (contractFile) {
        toast('Uploading contract to Drive…', { icon: '📤' })
        if (driveFolderId) {
          await uploadContractFile(contractFile, form.name, driveFolderId)
          toast('AI is reading your contract…', { icon: '🤖' })
          try {
            const extracted = await extractContractLineItems(contractFile)
            const updates = {}
            if (!form.contract_amount && extracted.total_amount) updates.contract_amount = extracted.total_amount
            if (!form.contractor_name && extracted.contractor_name) updates.contractor_name = extracted.contractor_name
            if (!form.contract_date && extracted.contract_date) updates.contract_date = extracted.contract_date
            if (Object.keys(updates).length) await supabase.from('projects').update(updates).eq('id', project.id)
            if (extracted.line_items?.length) {
              await supabase.from('contract_line_items').insert(
                extracted.line_items.map((item, i) => ({
                  project_id: project.id,
                  description: item.description,
                  budgeted_amount: item.amount,
                  category: item.category,
                  sort_order: i
                }))
              )
            }
            toast.success(`Contract processed — ${extracted.line_items?.length || 0} line items extracted`)
          } catch (aiErr) {
            toast.error('AI extraction failed — you can add line items manually')
          }
        }
      }

      toast.success(`Project "${form.name}" created!`)
      navigate(`/projects/${project.id}`)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div style={{ maxWidth: '640px' }}>
      <div className="page-header">
        <div className="page-title">New Project</div>
        <div className="page-subtitle">Set up a new renovation contract</div>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
            <div className="form-group">
              <label className="form-label">PROJECT NAME *</label>
              <input className="form-input" placeholder="e.g. Demolition, Kitchen Renovation..." value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">CONTRACTOR NAME</label>
                <input className="form-input" value={form.contractor_name} onChange={e => setForm(f => ({ ...f, contractor_name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">STATUS</label>
                <select className="form-select" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="planning">Planning</option>
                  <option value="active">Active</option>
                  <option value="on_hold">On Hold</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">CONTRACT DATE</label>
                <input className="form-input" type="date" value={form.contract_date} onChange={e => setForm(f => ({ ...f, contract_date: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">CONTRACT AMOUNT (€)</label>
                <input className="form-input" type="number" placeholder="Will be extracted from contract" value={form.contract_amount} onChange={e => setForm(f => ({ ...f, contract_amount: e.target.value }))} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">NOTES</label>
              <input className="form-input" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <div className="form-label" style={{ marginBottom: '0.5rem' }}>CONTRACT DOCUMENT (PDF or photo)</div>
            <div {...getRootProps()} style={{
              border: `2px dashed ${isDragActive ? '#c8a96e' : 'rgba(200,169,110,0.25)'}`,
              borderRadius: '10px', padding: '2rem', textAlign: 'center', cursor: 'pointer',
              background: isDragActive ? 'rgba(200,169,110,0.05)' : 'transparent', transition: 'all 0.15s'
            }}>
              <input {...getInputProps()} />
              {contractFile ? (
                <div style={{ color: '#4caf88' }}>
                  <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>✅</div>
                  <div style={{ fontSize: '0.85rem' }}>{contractFile.name}</div>
                  <div style={{ fontSize: '0.75rem', color: '#8a8090', marginTop: '0.25rem' }}>Click to change</div>
                </div>
              ) : (
                <div style={{ color: '#5a5060' }}>
                  <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>📄</div>
                  <div style={{ fontSize: '0.85rem' }}>Drop your contract here, or tap to select</div>
                  <div style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>AI will extract all line items automatically</div>
                </div>
              )}
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={processing} style={{ width: '100%', justifyContent: 'center', padding: '0.75rem' }}>
            {processing ? '⏳ Creating project…' : '+ Create Project'}
          </button>
        </form>
      </div>
    </div>
  )
}
