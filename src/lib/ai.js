const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY

async function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

async function callClaude(systemPrompt, userPrompt, imageFile = null) {
  const content = []
  if (imageFile) {
    const base64 = await fileToBase64(imageFile)
    content.push({ type: 'image', source: { type: 'base64', media_type: imageFile.type, data: base64 } })
  }
  content.push({ type: 'text', text: userPrompt })

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
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content }]
    })
  })

  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  return data.content[0].text
}

export async function extractContractLineItems(file) {
  const base64 = await fileToBase64(file)
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
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: file.type, data: base64 } },
          { type: 'text', text: `This is a Brazilian construction contract. Extract all line items and return ONLY valid JSON, no markdown:
{
  "contractor_name": "string",
  "total_amount": number,
  "contract_date": "YYYY-MM-DD or null",
  "line_items": [
    {
      "description": "string",
      "amount": number,
      "category": "string (e.g. Demolição, Elétrica, Estrutural, etc)"
    }
  ]
}` }
        ]
      }]
    })
  })
  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  const text = data.content[0].text
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

export async function extractBillData(file, lineItems = []) {
  const system = `You are an expert at reading Brazilian invoices and bills. Extract structured data and return ONLY valid JSON.`
  const prompt = `Extract the bill details from this document and return ONLY valid JSON, no markdown:
{
  "bill_number": "string or null",
  "contractor_name": "string",
  "issue_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "total_amount": number,
  "notes": "string or null",
  "line_items": [
    {
      "description": "string",
      "amount": number,
      "contract_line_item_id": null,
      "is_deviation": false,
      "deviation_reason": null
    }
  ]
}`
  const result = await callClaude(system, prompt, file)
  return JSON.parse(result.replace(/```json|```/g, '').trim())
}

export async function extractBoletoDetails(file) {
  const base64 = await fileToBase64(file)
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
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: `This is a Brazilian boleto bancário. Extract the payment details and return ONLY valid JSON, no markdown:
{
  "linha_digitavel": "the long numeric code used to pay (linha digitável), format like: 23790.12004 91360.370240 43010.010304 4 13630000249000",
  "beneficiario": "name of who receives the payment",
  "valor": number,
  "vencimento": "YYYY-MM-DD",
  "nosso_numero": "string or null",
  "numero_documento": "string or null"
}` }
        ]
      }]
    })
  })
  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  const text = data.content[0].text
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

export async function generateCostEstimate(project, lineItems, bills, payments) {
  const totalBudget = lineItems.reduce((s, i) => s + i.budgeted_amount, 0) || project?.contract_amount || 0
  const totalBilled = bills.reduce((s, b) => s + b.total_amount, 0)
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)

  const deviations = lineItems.map(item => {
    const billedForItem = bills
      .flatMap(b => b.bill_line_items || [])
      .filter(bli => bli.contract_line_item_id === item.id)
      .reduce((s, bli) => s + bli.amount, 0)
    return {
      description: item.description,
      budgeted: item.budgeted_amount,
      billed: billedForItem,
      deviation_pct: item.budgeted_amount > 0
        ? ((billedForItem - item.budgeted_amount) / item.budgeted_amount * 100).toFixed(1)
        : 0
    }
  })

  const system = `You are a construction cost analyst with expertise in European residential renovation projects.
Analyze the project data and provide a cost estimate. Return ONLY valid JSON, no markdown:
{
  "estimated_final_cost": number,
  "confidence_low": number,
  "confidence_high": number,
  "risk_level": "low|medium|high",
  "key_observations": ["string", "string"],
  "recommendations": ["string", "string"],
  "summary": "2-3 sentence plain language summary"
}`

  const prompt = `Project: ${project.name}
Status: ${project.status}
Contract amount: ${totalBudget}
Total billed so far: ${totalBilled}
Total paid so far: ${totalPaid}

Deviations by line item:
${JSON.stringify(deviations, null, 2)}

Based on the deviation patterns observed, construction cost trends, and typical renovation project overruns, provide a final cost estimate.`

  const result = await callClaude(system, prompt)
  return JSON.parse(result.replace(/```json|```/g, '').trim())
}
