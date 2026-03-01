import * as XLSX from 'xlsx'

export function parseProtocoloExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array', cellDates: true })

        const allItems = []

        workbook.SheetNames.forEach(sheetName => {
          const ws = workbook.Sheets[sheetName]
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' })

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
              parsedAmount = parseFloat(amount.replace(/[^0-9,]/g, '').replace(',', '.'))
            } else {
              parsedAmount = parseFloat(amount)
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
  // Separate boletos and NFs
  const boletos = files.filter(f => f.name.toUpperCase().includes('BOLETO') && !f.name.toUpperCase().includes('NF'))
  const nfs = files.filter(f => f.name.toUpperCase().includes('NF') || f.name.toUpperCase().includes('NOTA'))

  const updated = items.map(item => {
    // Match boleto by amount in filename or by order
    const boleto = boletos.find(f => {
      const amountStr = String(item.amount).replace('.', '_').replace(',', '_')
  const amountStr2 = String(Math.round(item.amount)).padStart(4, '0')
      const supplierKey = item.supplier.toUpperCase().replace(/\s+/g, '').substring(0, 6)
      return f.name.toUpperCase().includes(supplierKey) ||
             f.name.includes(amountStr) ||
             f.name.includes(amountStr2)
    })

    const nf = nfs.find(f => {
      const amountStr = String(item.amount).replace('.', '_').replace(',', '_')
      const amountStr2 = String(Math.round(item.amount)).padStart(4, '0')
      const supplierKey = item.supplier.toUpperCase().replace(/\s+/g, '').substring(0, 6)
      return f.name.toUpperCase().includes(supplierKey) ||
             f.name.includes(amountStr) ||
             f.name.includes(amountStr2)
    })

    return {
      ...item,
      boleto_file: boleto || null,
      nf_file: nf || null
    }
  })

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
