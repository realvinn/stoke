/** Disposable loopback HTTPS fixtures. No committed key, real site or account. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { join } from 'node:path'

export function createCertificate(directory, name = 'site') {
  const keyPath = join(directory, `${name}.key`)
  const certPath = join(directory, `${name}.crt`)
  const configPath = join(directory, `${name}.cnf`)
  writeFileSync(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=Stoke disposable fixture\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n')
  const commands = process.platform === 'win32'
    ? ['openssl', join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')]
    : ['openssl']
  let last
  for (const command of commands) {
    try {
      execFileSync(command, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { stdio: 'pipe', timeout: 30_000, windowsHide: true })
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) }
    } catch (error) { last = error }
  }
  throw new Error(`Could not generate disposable HTTPS certificate: ${last?.message}`)
}

export function startTlsServer(certificate, port = 0) {
  const server = createServer(certificate, (request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) request.destroy() })
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      const data = JSON.stringify({ method: request.method, body }).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      response.end(`<!doctype html><title>HTTPS fixture</title><h1 id="tls-ready">Reviewed HTTPS fixture</h1><pre id="tls-request">${data}</pre>`)
    })
  })
  // A browser refusing the fixture's certificate is expected.
  server.on('tlsClientError', () => {})
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({ origin: `https://127.0.0.1:${server.address().port}`, port: server.address().port,
        close: () => new Promise(done => { server.close(done); server.closeAllConnections() }) })
    })
  })
}
