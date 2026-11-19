import { z } from 'zod'
import { formatIssues } from '../db/applications'
import { eventDateMessage, isEventDate } from '../db/dates'
import { OUTCOME_KINDS } from '../db/outcomes'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const Ref = z.union([z.string(), z.number()]).nullish()

export const SyncOutcome = z.looseObject({
  messageId: z.string().min(1),
  receivedAt: z.string().min(1),
  senderDomain: z.string().nullish(),
  subject: z.string().nullish(),
  company: z.string().nullish(),
  title: z.string().nullish(),
  jobUrl: z.string().nullish(),
  jobRef: z.string().nullish(),
  applicationId: Ref,
  jobId: Ref,
  queuedAt: z.string().nullish(),
  kind: z.enum(OUTCOME_KINDS).nullish(),
  scheduledAt: z.string().refine(isEventDate, eventDateMessage('scheduledAt')).nullish(),
})
export type SyncOutcome = z.infer<typeof SyncOutcome>

export interface InvalidOutcome {
  messageId: string
  receivedAt: string
  error: string
}

const Failure = z.object({ ok: z.literal(false), error: z.string() })
const Pending = z.looseObject({ ok: z.literal(true), scriptVersion: z.string(), outcomes: z.array(z.unknown()) })
const Acked = z.looseObject({ ok: z.literal(true), acked: z.number() })
const Status = z.looseObject({ ok: z.literal(true), scriptVersion: z.string(), mode: z.string().optional(), pending: z.number().optional() })

export interface PendingResponse {
  ok: true
  scriptVersion: string
  outcomes: SyncOutcome[]
  invalid: InvalidOutcome[]
}
export type StatusResponse = z.infer<typeof Status>

export const ACK_BATCH = 100
const EXCERPT = 200

const textField = (value: unknown, key: string) => {
  const field = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  return typeof field === 'string' ? field : ''
}

function splitOutcomes(raw: unknown[]): { outcomes: SyncOutcome[]; invalid: InvalidOutcome[] } {
  const outcomes: SyncOutcome[] = []
  const invalid: InvalidOutcome[] = []
  for (const entry of raw) {
    const parsed = SyncOutcome.safeParse(entry)
    if (parsed.success) outcomes.push(parsed.data)
    else {
      invalid.push({
        messageId: textField(entry, 'messageId'), receivedAt: textField(entry, 'receivedAt'),
        error: `invalid outcome: ${formatIssues(parsed.error)}`.slice(0, EXCERPT),
      })
    }
  }
  return { outcomes, invalid }
}

export class SyncAuthError extends Error {
  constructor() {
    super('sync_token rejected; run generateSyncToken in the Apps Script and update permissions.toml')
    this.name = 'SyncAuthError'
  }
}

export interface SyncClientOptions {
  url: string
  token: string
  fetch?: FetchLike
}

export interface SyncClient {
  pending(): Promise<PendingResponse>
  ack(messageIds: string[]): Promise<number>
  status(): Promise<StatusResponse>
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))

  async function call<T extends z.ZodType>(action: string, schema: T, extra: Record<string, unknown> = {}): Promise<z.infer<T>> {
    let response: Response
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: options.token, action, ...extra }),
        redirect: 'follow',
      })
    } catch (error) {
      throw new Error(`sync ${action} request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    const excerpt = text.slice(0, EXCERPT)
    if (!response.ok) throw new Error(`sync ${action} failed: HTTP ${response.status}: ${excerpt}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`sync ${action} failed: HTTP ${response.status} returned non-JSON: ${excerpt}`)
    }
    const failure = Failure.safeParse(body)
    if (failure.success) {
      if (failure.data.error === 'unauthorized') throw new SyncAuthError()
      throw new Error(`sync ${action} failed: ${failure.data.error.slice(0, EXCERPT)}`)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new Error(`sync ${action} failed: unexpected response: ${excerpt}`)
    return parsed.data
  }

  return {
    async pending() {
      const response = await call('pending', Pending)
      return { ...response, ...splitOutcomes(response.outcomes) }
    },
    status: () => call('status', Status),
    async ack(messageIds) {
      let acked = 0
      for (let i = 0; i < messageIds.length; i += ACK_BATCH) {
        const result = await call('ack', Acked, { messageIds: messageIds.slice(i, i + ACK_BATCH) })
        acked += result.acked
      }
      return acked
    },
  }
}
