import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const DEFAULT_KIMI_BASE_URL = 'https://api.kimi.com/coding/v1'
const CREDENTIALS_READ_TIMEOUT_MS = 5_000

// Why: overridable via the same env var the CLI honours (self-hosted/staging).
const KIMI_BASE_URL_OVERRIDE = process.env.KIMI_CODE_BASE_URL

const DEFAULT_CREDENTIALS_NAME = 'kimi-code'
// Why: the CLI stores non-default environments (e.g. the global `.ai` region) in
// `kimi-code-env-<16 hex>.json`; the pattern also keeps config-derived names inside `credentials/`.
const CREDENTIALS_NAME_PATTERN = /^kimi-code(?:-env-[0-9a-f]{16})?$/

function joinKimiPath(kimiHome: string, ...segments: string[]): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(kimiHome)
    ? pathWin32.join(kimiHome, ...segments)
    : join(kimiHome, ...segments)
}

export type KimiConnection = {
  credentialsName: string
  baseUrl: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

// Why: the CLI records its login slot and endpoint under the managed provider
// (`oauth.key` = `oauth/<credentials file name>`), so follow it instead of assuming `.com`.
function parseKimiConnection(rawConfig: string): Partial<KimiConnection> {
  try {
    const providers = asRecord(asRecord(parseToml(rawConfig))?.providers)
    const provider = asRecord(providers?.['managed:kimi-code'])
    const key = asRecord(provider?.oauth)?.key
    const name = typeof key === 'string' ? key.split('/').pop() : undefined
    const baseUrl = provider?.base_url
    return {
      credentialsName: name && CREDENTIALS_NAME_PATTERN.test(name) ? name : undefined,
      baseUrl: typeof baseUrl === 'string' && /^https?:\/\//.test(baseUrl) ? baseUrl : undefined
    }
  } catch {
    return {}
  }
}

export type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

type FileReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; raw: string }

export type CredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: KimiCredentials }

function parseCredentials(value: unknown): KimiCredentials | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const credentials: KimiCredentials = {}
  if ('access_token' in value && typeof value.access_token === 'string') {
    credentials.access_token = value.access_token
  }
  if ('expires_at' in value && typeof value.expires_at === 'number') {
    credentials.expires_at = value.expires_at
  }
  return credentials
}

const fileReadByPath = new Map<string, SharedAuthFilesystemOperation<FileReadResult>>()

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function readErrorMessage(err: unknown): string {
  // Why: AbortSignal timeouts reject with a DOMException, not an Error.
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'Unable to read Kimi credentials'
}

function getFileRead(path: string): SharedAuthFilesystemOperation<FileReadResult> {
  const existing = fileReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Why: aborting an fs promise does not cancel an already issued UNC request, so
  // share one raw read per path until it settles (mirrors codex-fetcher's auth read).
  const read = createAuthFilesystemOperation(path, async (): Promise<FileReadResult> => {
    try {
      return { status: 'ok', raw: await readFile(path, 'utf-8') }
    } catch (err) {
      return isMissingPathError(err)
        ? { status: 'missing' }
        : { status: 'error', error: readErrorMessage(err) }
    }
  })
  fileReadByPath.set(path, read)
  const clearRead = (): void => {
    if (fileReadByPath.get(path) === read) {
      fileReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readFileBounded(path: string): Promise<FileReadResult> {
  try {
    // Why: a stopped distro parks a UNC read for minutes; bound it so a WSL home
    // degrades to an error instead of stalling the poll cycle.
    return await getFileRead(path).wait(AbortSignal.timeout(CREDENTIALS_READ_TIMEOUT_MS))
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

export async function readKimiConnection(
  kimiHome: string
): Promise<KimiConnection | { error: string }> {
  const config = await readFileBounded(joinKimiPath(kimiHome, 'config.toml'))
  // Why: a timed-out read means an unreachable home; stop here instead of stalling on credentials too.
  if (config.status === 'error') {
    return { error: config.error }
  }
  const parsed = config.status === 'ok' ? parseKimiConnection(config.raw) : {}
  return {
    credentialsName: parsed.credentialsName ?? DEFAULT_CREDENTIALS_NAME,
    baseUrl: KIMI_BASE_URL_OVERRIDE ?? parsed.baseUrl ?? DEFAULT_KIMI_BASE_URL
  }
}

export async function readKimiCredentials(
  kimiHome: string,
  credentialsName: string
): Promise<CredentialsReadResult> {
  const file = await readFileBounded(
    joinKimiPath(kimiHome, 'credentials', `${credentialsName}.json`)
  )
  if (file.status !== 'ok') {
    return file
  }
  try {
    const credentials = parseCredentials(JSON.parse(file.raw))
    return credentials
      ? { status: 'ok', credentials }
      : { status: 'error', error: 'Kimi credentials file is invalid' }
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

export function isAccessTokenFresh(creds: KimiCredentials): boolean {
  return (
    typeof creds.access_token === 'string' &&
    creds.access_token.length > 0 &&
    typeof creds.expires_at === 'number' &&
    // Why: small skew margin so we don't fire a request against a token that
    // expires mid-flight. The CLI refreshes the file on its next run.
    creds.expires_at - Math.floor(Date.now() / 1000) > 5
  )
}
