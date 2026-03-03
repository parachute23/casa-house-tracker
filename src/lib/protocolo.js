import * as XLSX from 'xlsx'

export function parseProtocoloExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array', cellDates: true })

        const allItems = []

        const lastSheet = workbook.SheetNames[workbook.SheetNames.length - 1]
;[lastSheet].forEach(sheetName => {
          const ws = workbook.Sheets[sheetName]
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, dateNF: 'yyyy-mm-dd' })

          let protocolNumber = null
          let headerFound = false

          rows.forEach(row => {
            // Find protocol number
            if (!protocolNumber) {
              row.forEach((cell, i) => {
                if (String(cell).trim() === 'Nº' && row[i+1]) {
                  protocolNumber = row[i+1]
                }
              })
            }

            // Find header row
            if (!headerFound) {
              if (row.some(cell => String(cell || '').includes('FORNECEDOR'))) {
                headerFound = true
              }
              return
            }

            const supplier = row[1]
            const invoice = row[2]
            const dueDate = row[3]
            const amount = row[4]
            const category = row[5]
            const status = row[6]
            const paymentMethod = row[7]

            if (!supplier || !amount) return
            if (String(supplier).includes('TOTAL') || String(supplier).includes('total')) return

            // Parse amount
            let parsedAmount = 0
if (typeof amount === 'string') {
  // Handle Brazilian format: 1.234,56 → 1234.56
  const str = String(amount)
const cleaned = str.replace(/R\$\s*/gi, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
parsedAmount = parseFloat(cleaned) || 0
} else if (typeof amount === 'number') {
  parsedAmount = amount
} else if (amount instanceof Date) {
  // XLSX sometimes misreads numbers as dates — skip
  parsedAmount = 0
}
            if (isNaN(parsedAmount) || parsedAmount <= 0) return

            // Parse due date
            let parsedDate = null
            if (dueDate) {
              if (typeof dueDate === 'string' && dueDate.includes('/')) {
                const parts = dueDate.split('/')
                if (parts.length === 3) {
                  parsedDate = `${parts[2].length === 2 ? '20' + parts[2] : parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`
                }
              } else if (typeof dueDate === 'string' && dueDate.includes('-')) {
                parsedDate = dueDate.split('T')[0]
              } else if (dueDate instanceof Date) {
                parsedDate = dueDate.toISOString().split('T')[0]
              }
            }

            allItems.push({
              protocol_number: protocolNumber,
              sheet_name: sheetName,
              supplier: String(supplier).trim(),
              invoice_number: invoice ? String(invoice).trim() : null,
              due_date: parsedDate,
              amount: parsedAmount,
              category: category ? String(category).trim() : null,
              status: status ? String(status).trim().toUpperCase() : 'A VENCER',
              payment_method: paymentMethod ? String(paymentMethod).trim() : null,
              assigned_to: null,
              boleto_file: null,
              nf_file: null,
              linha_digitavel: null,
              boleto_drive_url: null,
              nf_drive_url: null
            })
          })
        })

        resolve(allItems)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

export function matchFilesToItems(items, files) {
  const boletos = files.filter(f => f.name.toUpperCase().includes('BOLETO') && !f.name.toUpperCase().includes('NF'))
  const nfs = files.filter(f =>
    f.name.toUpperCase().includes('NF') ||
    f.name.toUpperCase().includes('NOTA') ||
    f.name.toUpperCase().includes('RECIBO') ||
    f.name.toUpperCase().includes('REEMBOLSO') ||
    f.name.toUpperCase().includes('ND')
  )
  const unmatched = files.filter(f => !boletos.includes(f) && !nfs.includes(f))

  const updated = items.map(item => {
    const supplierKey = item.supplier.toUpperCase().replace(/\s+/g, '').substring(0, 6)
    const amountStr = String(item.amount).replace('.', '_').replace(',', '_')
    const amountStrComma = String(item.amount).replace('.', ',')
    const amountStr2 = String(Math.round(item.amount)).padStart(4, '0')

    const matchFile = (fileList) => {
      const amountMatch = fileList.find(f =>
        f.name.includes(amountStr) ||
        f.name.includes(amountStr2) ||
        f.name.includes(amountStrComma)
      )
      if (amountMatch) return amountMatch
      return fileList.find(f => f.name.toUpperCase().includes(supplierKey))
    }

    const boleto = matchFile(boletos)
    const nf = matchFile(nfs) || matchFile(unmatched)
    return { ...item, boleto_file: boleto || null, nf_file: nf || null }
  })

  const allAssigned = updated.flatMap(i => [i.boleto_file, i.nf_file]).filter(Boolean)
  const remainingFiles = files.filter(f => !allAssigned.includes(f))

if (remainingFiles.length > 0) {
    const sorted = [...remainingFiles].sort((a, b) => {
      const isPayment = f => ['NF','RECIBO','REEMBOLSO','ND','NOTA','BOLETO'].some(k => f.name.toUpperCase().includes(k))
      return isPayment(b) - isPayment(a)
    })
    sorted.forEach(file => {
      const itemWithoutFile = updated.find(i => !i.boleto_file && !i.nf_file)
      if (itemWithoutFile) itemWithoutFile.nf_file = file
    })
  }

  return updated
}

export function generateWhatsAppMessage(items, protocolName) {
  const patiItems = items.filter(i => i.assigned_to === 'pati')
  if (patiItems.length === 0) return null

  const total = patiItems.reduce((s, i) => s + i.amount, 0)
  const fmt = (n) => 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtDate = (d) => d ? d.split('-').reverse().join('/') : '—'

  let message = `🏠 *Casa - ${protocolName}*\n`
  message += `Olá Pati, seguem os pagamentos desta semana:\n\n`

  patiItems.forEach(item => {
    message += `• *${item.supplier}*\n`
    message += `  Valor: ${fmt(item.amount)}\n`
    message += `  Vencimento: ${fmtDate(item.due_date)}\n`
    message += `  Forma: ${item.payment_method || '—'}\n`
    if (item.linha_digitavel) {
      message += `  Linha digitável:\n  \`${item.linha_digitavel}\`\n`
    } else if (item.invoice_number) {
      message += `  Nº: ${item.invoice_number}\n`
    }
    message += '\n'
  })

  message += `*Total: ${fmt(total)}*`
  return message
}

export function openWhatsApp(message) {
  const phone = '5511984055050'
  const encoded = encodeURIComponent(message)
  window.open(`https://wa.me/${phone}?text=${encoded}`, '_blank')
}
