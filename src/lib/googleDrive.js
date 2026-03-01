const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY
const SCOPES = 'https://www.googleapis.com/auth/drive.file'
const ROOT_FOLDER_NAME = 'House Tracker'

let tokenClient = null
let accessToken = null

export function initGoogleDrive() {
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.onload = () => {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
          accessToken = response.access_token
          localStorage.setItem('gdrive_token', accessToken)
          localStorage.setItem('gdrive_token_expiry', Date.now() + 3500 * 1000)
        }
      })
      resolve()
    }
    document.head.appendChild(script)
  })
}

export async function requestDriveAccess() {
  const stored = localStorage.getItem('gdrive_token')
  const expiry = localStorage.getItem('gdrive_token_expiry')
  if (stored && expiry && Date.now() < parseInt(expiry)) {
    accessToken = stored
    return true
  }
  return new Promise((resolve) => {
    tokenClient.callback = (response) => {
      if (response.error) { resolve(false); return }
      accessToken = response.access_token
      localStorage.setItem('gdrive_token', accessToken)
      localStorage.setItem('gdrive_token_expiry', Date.now() + 3500 * 1000)
      resolve(true)
    }
    tokenClient.requestAccessToken({ prompt: '' })
  })
}

async function driveApi(path, options = {}) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  })
  return res.json()
}

async function findOrCreateFolder(name, parentId = null) {
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`

  const search = await driveApi(`files?q=${encodeURIComponent(query)}&fields=files(id,name)`)

  if (search.files && search.files.length > 0) {
    return search.files[0].id
  }

  const body = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]

  const created = await driveApi('files', {
    method: 'POST',
    body: JSON.stringify(body)
  })
  return created.id
}

export async function ensureRootStructure() {
  const rootId = await findOrCreateFolder(ROOT_FOLDER_NAME)
  const mortgageId = await findOrCreateFolder('Mortgage', rootId)
  const renovationId = await findOrCreateFolder('Renovation Projects', rootId)
  const otherId = await findOrCreateFolder('Other Documents', rootId)

  localStorage.setItem('gdrive_root_id', rootId)
  localStorage.setItem('gdrive_mortgage_id', mortgageId)
  localStorage.setItem('gdrive_renovation_id', renovationId)
  localStorage.setItem('gdrive_other_id', otherId)

  return { rootId, mortgageId, renovationId, otherId }
}

export async function ensureProjectFolder(projectName) {
  const renovationId = localStorage.getItem('gdrive_renovation_id')
    || (await ensureRootStructure()).renovationId

  const projectId = await findOrCreateFolder(projectName, renovationId)
  await findOrCreateFolder('Bills', projectId)
  await findOrCreateFolder('Payment Proofs', projectId)

  return projectId
}

export async function uploadFileToDrive(file, folderId, fileName = null) {
  const name = fileName || file.name
  const metadata = { name, parents: [folderId] }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', file)

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: form
  })
  return res.json()
}

export async function uploadContractFile(file, projectName, projectFolderId) {
  return await uploadFileToDrive(file, projectFolderId, `Contract - ${projectName}`)
}

export async function uploadBillFile(file, projectFolderId, billName) {
  const billsFolderId = await findOrCreateFolder('Bills', projectFolderId)
  return await uploadFileToDrive(file, billsFolderId, billName)
}

export async function uploadPaymentFile(file, projectFolderId, paymentName) {
  const paymentsFolderId = await findOrCreateFolder('Payment Proofs', projectFolderId)
  return await uploadFileToDrive(file, paymentsFolderId, paymentName)
}

export async function uploadMortgagePaymentFile(file, paymentDate) {
  const mortgageId = localStorage.getItem('gdrive_mortgage_id')
  const name = `Payment - ${paymentDate}`
  return await uploadFileToDrive(file, mortgageId, name)
}
