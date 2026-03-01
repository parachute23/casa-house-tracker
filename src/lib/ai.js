const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY

async function callClaude(systemPrompt, userContent) {
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
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  })

  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  return data.content[0].text
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export async function extractContractLineItems(file) {
  const base64 = await fileToBase64(file)
  const isImage = file.type.startsWith('image/')

  const system = `You are a construction contract analyst. Extract all line items from the contract.
Return ONLY valid JSON with this exact structure, no markdown:
{
  "contractor_name": "string",
  "contract_date": "YYYY-MM-DD or null",
  "total_amount": number,
  "currency": "EUR or USD or other",
  "line_items": [
    {
      "description": "string",
      "category": "string (e.g. Labor, Materials, Equipment, Permits, Other)",
      "amount": number
    }
  ],
  "notes": "any important conditions or observations"
}`

  const content = isImage ? [
    { type: 'image', source: { type: 'base64', media_type: file.type, data: base64 } },
    { type: 'text', text: 'Extract all line items from this contract document.' }
  ] : [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
    { type: 'text', text: 'Extract all line items from this contract document.' }
  ]

  const result = await callClaude(system, content)
  return JSON.parse(result)
}

export async function extractBillData(file, contractLineItems) {
  const base64 = await fileToBase64(file)
  const isImage = file.type.startsWith('image/')

  const lineItemsContext = contractLineItems.map((item, i) =>
    `${i + 1}. [ID: ${item.id}] ${item.description} - Budget: ${item.budgeted_amount}`
  ).join('\n')

  const system = `You are a construction billing analyst. Extract all data from this bill/invoice.
Then map each bill line item to the most relevant contract line item from the provided list.
Return ONLY valid JSON, no markdown:
{
  "bill_number": "string or null",
  "contractor_name": "string",
  "issue_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "total_amount": number,
  "line_items": [
    {
      "description": "string",
      "amount": number,
      "contract_line_item_id": "UUID from list or null if no match",
      "is_deviation": boolean,
      "deviation_reason": "string explaining why this deviates, or null"
    }
  ],
  "notes": "any observations about this bill"
}

Contract line items for mapping:
${lineItemsContext}`

  const content = isImage ? [
    { type: 'image', source: { type: 'base64', media_type: file.type, data: base64 } },
    { type: 'text', text: 'Extract and map all items from this bill.' }
  ] : [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
    { type: 'text', text: 'Extract and map all items from this bill.' }
  ]

  const result = await callClaude(system, content)
  return JSON.parse(result)
}

export async function generateCostEstimate(project, lineItems, bills, payments) {
  const totalBudget = lineItems.reduce((s, i) => s + i.budgeted_amount, 0)
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
  return JSON.parse(result)
}
