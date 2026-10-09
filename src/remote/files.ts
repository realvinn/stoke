import { MAX_FILE_BYTES, type PhoneFileListing, type PhoneFileSent } from '@shared/remoteFiles'
import { quotePath, isInsertable } from '@shared/drop'
import { api, fileApiError, host } from './api'
import { el, openSheet } from './dom'

/** One file operation belongs to this sheet and ends when its screen leaves. */
export function openSessionFiles(opts: { ptyId: string; destination: string; ssh: boolean; signal: AbortSignal; insert: (path: string) => void }): void {
  const lifetime = new AbortController()
  let transfer: AbortController | null = null
  let busy = false
  let chosen: File | null = null
  let sent: PhoneFileSent | null = null
  let folder = ''
  let listingGeneration = 0
  const sheet = openSheet({ title: 'Session files', onClose: () => { lifetime.abort(); transfer?.abort(); opts.signal.removeEventListener('abort', leave) } })
  const leave = (): void => sheet.close()
  opts.signal.addEventListener('abort', leave, { once: true })
  if (opts.signal.aborted) { sheet.close(); return }
  const picker = el('input', { type: 'file', hidden: true, 'aria-label': 'Choose a file to send' })
  const selected = el('p', { class: 'menu-note' }, 'Choose one file, up to 100 MB.')
  const destination = el('p', { class: 'menu-note' }, `From this device → ${opts.destination}${opts.ssh ? ' · SSH upload cache' : ' · session working folder'}`)
  const choose = el('button', { type: 'button', class: 'btn' }, 'Choose file')
  const send = el('button', { type: 'button', class: 'btn', disabled: true }, 'Send file')
  const cancel = el('button', { type: 'button', class: 'btn', hidden: true }, 'Cancel')
  const insert = el('button', { type: 'button', class: 'btn', hidden: true }, 'Insert path into message')
  const message = el('p', { class: 'menu-note', role: 'status', 'aria-live': 'polite' })
  const progress = el('progress', { max: 100, value: 0, hidden: true, 'aria-label': 'File transfer progress' })
  const pathLine = el('p', { class: 'phone-file-path', hidden: true })
  const rows = el('div', { class: 'phone-file-list', role: 'group', 'aria-label': 'Files in the working folder' })
  const browsing = el('p', { class: 'menu-note' })
  const up = el('button', { type: 'button', class: 'btn', hidden: true }, 'Up one folder')
  const paintBusy = (): void => {
    choose.disabled = busy; send.disabled = busy || !chosen; cancel.hidden = !busy
    progress.hidden = !busy; up.disabled = busy; rows.inert = busy
  }
  const run = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (busy || lifetime.signal.aborted) return
    busy = true
    const mine = new AbortController()
    transfer = mine
    progress.value = 0
    message.textContent = ''
    paintBusy()
    try { await work(mine.signal) }
    catch (error) {
      if (!lifetime.signal.aborted) message.textContent = mine.signal.aborted ? 'Transfer cancelled. Check the destination before retrying.' : error instanceof Error ? error.message : 'The transfer failed. Retry when the connection returns.'
    } finally {
      if (transfer === mine) { transfer = null; busy = false; paintBusy() }
    }
  }
  choose.addEventListener('click', () => picker.click(), { signal: lifetime.signal })
  picker.addEventListener('change', () => {
    chosen = picker.files?.[0] ?? null
    sent = null; insert.hidden = true; pathLine.hidden = true
    if (chosen && chosen.size > MAX_FILE_BYTES) { selected.textContent = 'This file exceeds 100 MB. Choose a smaller file.'; chosen = null }
    else selected.textContent = chosen ? `${chosen.name} · ${(chosen.size / 1024 / 1024).toFixed(1)} MB` : 'Choose one file, up to 100 MB.'
    send.textContent = 'Send file'; paintBusy()
  }, { signal: lifetime.signal })
  cancel.addEventListener('click', () => transfer?.abort(), { signal: lifetime.signal })
  insert.addEventListener('click', () => {
    if (!sent || !isInsertable(sent.path)) return
    opts.insert(quotePath(sent.path, sent.destination === 'ssh' ? 'linux' : host?.platform ?? 'darwin'))
    sheet.close()
  }, { signal: lifetime.signal })
  send.addEventListener('click', () => void run(async (signal) => {
    const file = chosen
    if (!file) return
    sent = null; insert.hidden = true; pathLine.hidden = true
    const params = new URLSearchParams({ ptyId: opts.ptyId, name: file.name, size: String(file.size) })
    send.textContent = 'Retry send'
    message.textContent = 'Sending file…'
    const result = await new Promise<PhoneFileSent>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abort = (): void => xhr.abort()
      const done = (): void => signal.removeEventListener('abort', abort)
      xhr.open('POST', `/api/files/upload?${params}`)
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.timeout = 185_000
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) progress.value = Math.min(99, event.loaded / event.total * 100)
        message.textContent = event.loaded === event.total ? 'Bytes sent. Waiting for the destination to verify the file…' : `Sending · ${Math.round(progress.value)}%`
      }
      xhr.onload = () => {
        done()
        let body: unknown
        try { body = JSON.parse(xhr.responseText) } catch { reject(new Error('The destination’s reply could not be read. Check it before retrying.')); return }
        if (xhr.status < 200 || xhr.status >= 300) { reject(fileApiError(xhr.status, body)); return }
        const result = body as PhoneFileSent
        if (typeof result.path !== 'string' || !isInsertable(result.path) || !['ssh', 'local'].includes(result.destination) || result.size !== file.size) { reject(new Error('The destination did not verify this file. Check it before retrying.')); return }
        resolve(result)
      }
      xhr.onerror = () => { done(); reject(new Error('The connection dropped. Check the destination before retrying.')) }
      xhr.ontimeout = () => { done(); reject(new Error('The transfer timed out. Check the destination before retrying.')) }
      xhr.onabort = () => { done(); reject(new Error('Transfer cancelled.')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { done(); reject(new Error('Transfer cancelled.')); return }
      xhr.send(file)
    })
    if (signal.aborted || lifetime.signal.aborted) return
    sent = result; progress.value = 100
    message.textContent = 'File saved. Insert its path when you’re ready to refer to it.'
    pathLine.textContent = result.path; pathLine.hidden = false; insert.hidden = false
    send.textContent = 'Send another copy'
  }), { signal: lifetime.signal })

  const download = (path: string, name: string): void => { void run(async (signal) => {
    message.textContent = `Downloading ${name}…`
    const params = new URLSearchParams({ ptyId: opts.ptyId, path })
    const response = await fetch(`/api/files/download?${params}`, { signal, credentials: 'same-origin' })
    if (!response.ok) throw fileApiError(response.status, await response.json().catch(() => null))
    const size = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || !response.body) throw new Error('The file’s size could not be verified.')
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let received = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        received += next.value.byteLength
        if (received > size || received > MAX_FILE_BYTES) throw new Error('The download exceeded its declared size.')
        chunks.push(new Uint8Array(next.value))
        progress.value = size ? received / size * 100 : 100
      }
      if (received !== size) throw new Error('The download was interrupted. Choose the file again to retry.')
    } finally { await reader.cancel().catch(() => {}) }
    if (signal.aborted || lifetime.signal.aborted) return
    const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }))
    const link = el('a', { href: url, download: name })
    sheet.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    message.textContent = 'Download ready. Your browser handles saving the file.'
  }) }
  const browse = async (path: string): Promise<void> => { await run(async (signal) => {
    const request = ++listingGeneration
    browsing.textContent = 'Reading folder…'; rows.replaceChildren()
    try {
      const listing = await api<PhoneFileListing>(`/api/files/list?${new URLSearchParams({ ptyId: opts.ptyId, path })}`, { signal })
      if (lifetime.signal.aborted || request !== listingGeneration) return
      folder = listing.path; up.hidden = !folder
      browsing.textContent = `${folder || 'Working folder'}${listing.truncated ? ' · listing limited' : ''}`
      for (const entry of listing.entries) {
        const button = el('button', { type: 'button', class: 'phone-file-entry' }, el('span', {}, entry.name), el('small', {}, entry.kind === 'folder' ? 'Open folder' : entry.size !== null ? `${(entry.size / 1024 / 1024).toFixed(1)} MB · Download` : 'Download'))
        button.disabled = entry.kind === 'file' && entry.size !== null && entry.size > MAX_FILE_BYTES
        button.addEventListener('click', () => { if (busy) return; if (entry.kind === 'folder') void browse(entry.path); else download(entry.path, entry.name) }, { signal: lifetime.signal })
        rows.append(button)
      }
      if (!listing.entries.length) rows.append(el('p', { class: 'menu-note' }, 'No visible files in this folder.'))
    } catch (error) { if (!lifetime.signal.aborted && request === listingGeneration) browsing.textContent = error instanceof Error ? error.message : 'The folder could not be read.' }
  }) }
  up.addEventListener('click', () => void browse(folder.split('/').slice(0, -1).join('/')), { signal: lifetime.signal })
  sheet.body.append(el('div', { class: 'phone-files' }, destination, picker, selected, el('div', { class: 'phone-file-actions' }, choose, send, cancel), progress, message, pathLine, insert))
  sheet.body.append(el('div', { class: 'phone-files' }, el('h3', {}, opts.ssh ? 'Download from SSH folder' : 'Download from working folder'), browsing, up, rows))
  if (opts.ssh) sheet.body.append(el('p', { class: 'menu-note' }, 'Browse the download folder chosen for this host in Stoke’s SSH settings. Files are verified on Stoke before they reach this browser.'))
  void browse('')
}
