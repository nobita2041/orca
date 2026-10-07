import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const fsState = vi.hoisted<{
  config: string | null
  credentials: string | null
  readError: Error | null
  readPaths: string[]
}>(() => ({
  config: null,
  credentials: null,
  readError: null,
  readPaths: []
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    fsState.readPaths.push(String(path))
    if (fsState.readError) {
      throw fsState.readError
    }
    const content = String(path).endsWith('config.toml') ? fsState.config : fsState.credentials
    if (content === null) {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return content
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchKimiRateLimits } from './kimi-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

// Real shape captured from GET https://api.kimi.com/coding/v1/usages.
const USAGE_RESPONSE = {
  user: { userId: 'u1', membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: { limit: '1000', remaining: '1000', resetTime: '2026-06-09T07:52:41.230862Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', remaining: '40', resetTime: '2026-06-04T08:52:41.230862Z' }
    }
  ],
  subType: 'TYPE_PURCHASE'
}

// Built with `join` so the expectation matches the separator the fetcher emits on this platform.
function hostCredentialsPath(kimiHome: string): string {
  return join(kimiHome, 'credentials', 'kimi-code.json')
}

function hostConfigPath(kimiHome: string): string {
  return join(kimiHome, 'config.toml')
}

// Global-region login as written by the CLI: scoped credentials slot + `.ai` endpoint.
const GLOBAL_CONFIG = `
[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0e4f99c69cc27850"
oauth_host = "https://auth.kimi.ai"
`

function freshCredentials(): string {
  // expires_at far in the future (seconds).
  return JSON.stringify({ access_token: 'tok-abc', expires_at: 99_999_999_999 })
}

describe('fetchKimiRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    fsState.config = null
    fsState.credentials = null
    fsState.readError = null
    fsState.readPaths = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when not signed in', async () => {
    const result = await fetchKimiRateLimits()
    expect(result.provider).toBe('kimi')
    expect(result.status).toBe('unavailable')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps the usages payload to session (5h) and weekly windows', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('kimi')
    // 5h window from limits[]: 40/100 remaining → 60% used.
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.usedPercent).toBeCloseTo(60)
    // Weekly from top-level usage: 1000/1000 remaining → 0% used.
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.weekly?.usedPercent).toBeCloseTo(0)
    // Bearer token from the credentials file is sent.
    const [, init] = netFetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc')
  })

  it('surfaces an error when the usage request fails', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('surfaces an error when the credentials file cannot be parsed', async () => {
    fsState.credentials = '{'

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/json/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error when the credentials file cannot be read', async () => {
    fsState.credentials = freshCredentials()
    fsState.readError = new Error('EACCES')

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/EACCES/)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty usage payload as an error', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/quota windows/)
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('does NOT refresh or call the API when the token is expired (read-only)', async () => {
    // expires_at in the past → token stale; fetcher must not hit the network.
    fsState.credentials = JSON.stringify({ access_token: 'tok-old', expires_at: 1 })

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(result.error).toMatch(/run kimi on the computer running Orca/i)
    expect(result.usageMetadata).toEqual({
      failureKind: 'delegated-refresh-required',
      source: 'oauth'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reads the host ~/.kimi-code credentials by default', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })

  it('honors KIMI_CODE_HOME for the host home', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '/custom/kimi-home')
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/custom/kimi-home'),
      hostCredentialsPath('/custom/kimi-home')
    ])
  })

  it('ignores a blank KIMI_CODE_HOME instead of reading from the process cwd', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '   ')
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })

  it('follows the credentials slot and endpoint recorded in config.toml', async () => {
    fsState.config = GLOBAL_CONFIG
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      join('/home/test/.kimi-code', 'credentials', 'kimi-code-env-0e4f99c69cc27850.json')
    ])
    expect(netFetchMock.mock.calls[0][0]).toBe('https://api.kimi.ai/coding/v1/usages')
  })

  it('keeps the default slot for the official login key', async () => {
    fsState.config = GLOBAL_CONFIG.replace('kimi-code-env-0e4f99c69cc27850', 'kimi-code')
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths[1]).toBe(hostCredentialsPath('/home/test/.kimi-code'))
  })

  it('ignores a credentials key that would escape the credentials directory', async () => {
    fsState.config = GLOBAL_CONFIG.replace(
      'oauth/kimi-code-env-0e4f99c69cc27850',
      'oauth/../../outside'
    )
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths[1]).toBe(hostCredentialsPath('/home/test/.kimi-code'))
  })

  it('falls back to defaults when config.toml cannot be parsed', async () => {
    fsState.config = 'not = [valid'
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths[1]).toBe(hostCredentialsPath('/home/test/.kimi-code'))
    expect(netFetchMock.mock.calls[0][0]).toBe('https://api.kimi.com/coding/v1/usages')
  })

  it('stops after an unreadable config.toml instead of probing credentials', async () => {
    fsState.readError = new Error('EACCES')

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/EACCES/)
    expect(fsState.readPaths).toEqual([hostConfigPath('/home/test/.kimi-code')])
  })
})
