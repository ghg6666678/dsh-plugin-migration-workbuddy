import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { MIGRATION_CLIENT_HEADER, sameOrigin } from '../src/routes.js'

const PORT = 18_888
const HOST = `127.0.0.1:${String(PORT)}`
const MARKER = { [MIGRATION_CLIENT_HEADER]: '1' }

function request(headers: Record<string, string | undefined> = {}, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('sameOrigin', () => {
  it('allows a read with no Origin header (Electron shell documents)', () => {
    expect(sameOrigin(request({ host: HOST }), false, PORT)).toBe(true)
  })

  it('allows a read with a matching origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: `http://${HOST}` }), false, PORT)).toBe(true)
  })

  it('rejects a non-loopback peer', () => {
    expect(sameOrigin(request({ host: HOST, ...MARKER }, '192.168.1.5'), true, PORT)).toBe(false)
  })

  it('rejects a DNS-rebinding Host', () => {
    expect(sameOrigin(request({ host: 'evil.example', origin: `http://${HOST}`, ...MARKER }), true, PORT)).toBe(false)
  })

  it('rejects a foreign Origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'https://evil.example', ...MARKER }), true, PORT)).toBe(false)
  })

  it('rejects an http cross-site Origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'http://evil.example', ...MARKER }), true, PORT)).toBe(false)
  })

  it('accepts an opaque custom-scheme Origin from the desktop shell', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'app://dsh-shell', ...MARKER }), true, PORT)).toBe(true)
  })

  it('requires proof of a same-site write (marker or Sec-Fetch-Site)', () => {
    expect(sameOrigin(request({ host: HOST, origin: `http://${HOST}` }), true, PORT)).toBe(false)
    expect(sameOrigin(request({ host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' }), true, PORT)).toBe(false)
  })

  it('accepts a write when a proxy keeps Sec-Fetch-Site but drops the marker', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'null', 'sec-fetch-site': 'same-origin' }), true, PORT)).toBe(true)
  })

  it('accepts a marked write with a matching origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: `http://${HOST}`, ...MARKER }), true, PORT)).toBe(true)
  })

  it('accepts a marked write from an opaque (null) Origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'null', ...MARKER }), true, PORT)).toBe(true)
  })

  it('accepts a marked write with no Origin header', () => {
    expect(sameOrigin(request({ host: HOST, ...MARKER }), true, PORT)).toBe(true)
  })

  it('accepts loopback aliases for Host and Origin', () => {
    expect(sameOrigin(request({ host: `localhost:${String(PORT)}`, origin: `http://localhost:${String(PORT)}`, ...MARKER }), true, PORT)).toBe(true)
  })
})
