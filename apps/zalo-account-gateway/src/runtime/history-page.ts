import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
  ZALO_ACCOUNT_HISTORY_MAX_BYTES,
  ZALO_ACCOUNT_HISTORY_MAX_ROWS,
  type ZaloAccountDirectMessage,
  type ZaloAccountGroupMessage,
} from "@chatbotx.io/sdk"
import { ThreadType } from "zca-js"
import { asNonEmptyString, asObject } from "./provider-content"
import { normalizeProviderMessage } from "./provider-message"

const MAX_GROUP_WINDOW = 50
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000

type OldMessageCallback = (messages: unknown, type: unknown) => void

type HistoryApi = {
  listener: {
    on(event: "old_messages", callback: OldMessageCallback): unknown
    removeListener(event: "old_messages", callback: OldMessageCallback): unknown
    requestOldMessages(threadType: ThreadType, cursor: string | null): void
  }
  getGroupChatHistory(groupId: string, count: number): Promise<unknown>
}

type HistoryErrorCode =
  | "history_busy"
  | "history_cancelled"
  | "history_invalid_response"
  | "history_page_limit"
  | "history_socket_stale"
  | "history_timeout"

export class ZaloAccountHistoryPageError extends Error {
  readonly code: HistoryErrorCode
  readonly partial: boolean

  constructor(code: HistoryErrorCode) {
    super(code)
    this.code = code
    this.name = "ZaloAccountHistoryPageError"
    this.partial = code === "history_page_limit"
  }
}

type ReadOptions = { timeoutMs: number; signal?: AbortSignal }
type DirectRequest = ReadOptions & { cursor: string | null; threadId?: string }
type GroupRequest = ReadOptions & { groupId: string }

type ReaderOptions = {
  ownUid: string
  messageIntegrityEnabled?: boolean
  maxRows?: number
  maxBytes?: number
}

type HistoryMessage = ZaloAccountDirectMessage | ZaloAccountGroupMessage
type Page<Message extends HistoryMessage> = {
  messages: Message[]
  providerRowCount: number
  invalidRowCount: number
  providerExhausted: boolean
  fingerprint: string
}

type DirectPage = Page<ZaloAccountDirectMessage> & {
  // The socket event has no continuation field. The worker decides whether
  // to use this evidence as a cursor for an enabled provider contract.
  oldestProviderMessageId?: string
}

type Identity = {
  threadId: string
  providerMessageId: string
  timestampMs: number
}

function parsePage<Message extends HistoryMessage>(
  rows: unknown,
  input: { maxRows: number; maxBytes: number; providerExhausted: boolean },
  parse: (row: unknown) => { identity: Identity; message?: Message } | null,
): { page: Page<Message>; oldest?: Identity } {
  if (!Array.isArray(rows)) {
    throw new ZaloAccountHistoryPageError("history_invalid_response")
  }
  if (rows.length > input.maxRows) {
    throw new ZaloAccountHistoryPageError("history_page_limit")
  }

  const fingerprints: string[] = []
  const messages: Message[] = []
  let oldest: Identity | undefined
  let invalidRowCount = 0
  let bytes = 2 // Serialized array brackets.
  for (const row of rows) {
    const entry = parse(row)
    if (!entry) {
      invalidRowCount++
      continue
    }
    const { identity, message } = entry
    fingerprints.push(
      JSON.stringify([
        identity.threadId,
        identity.providerMessageId,
        identity.timestampMs,
      ]),
    )
    if (!oldest || identity.timestampMs < oldest.timestampMs) {
      oldest = identity
    }
    if (message) {
      bytes += Buffer.byteLength(JSON.stringify(message))
      if (messages.length) {
        bytes++ // Serialized array separator.
      }
      if (bytes > input.maxBytes) {
        throw new ZaloAccountHistoryPageError("history_page_limit")
      }
      messages.push(message)
    }
  }

  return {
    oldest,
    page: {
      messages,
      providerRowCount: rows.length,
      invalidRowCount,
      providerExhausted: input.providerExhausted && invalidRowCount === 0,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([rows.length, fingerprints.sort()]))
        .digest("hex"),
    },
  }
}

function readIdentity(
  row: Record<string, unknown> | undefined,
  type: ThreadType,
): Identity | undefined {
  if (row?.type !== type) {
    return
  }
  const data = asObject(row.data)
  const threadId = asNonEmptyString(row.threadId, 200)
  const providerMessageId = asNonEmptyString(data?.msgId, 200)
  const timestampMs = Number(asNonEmptyString(data?.ts, 24))
  if (
    threadId &&
    providerMessageId &&
    Number.isSafeInteger(timestampMs) &&
    timestampMs > 0 &&
    timestampMs <= MAX_TIMESTAMP_MS
  ) {
    return { threadId, providerMessageId, timestampMs }
  }
}

function withHistoryDeadline<T>(
  options: ReadOptions,
  run: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const { signal } = options
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    }
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const cancel = () =>
      fail(new ZaloAccountHistoryPageError("history_cancelled"))
    const timer = setTimeout(
      () => fail(new ZaloAccountHistoryPageError("history_timeout")),
      options.timeoutMs,
    )
    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener("abort", cancel, { once: true })
    run().then((page) => {
      cleanup()
      resolve(page)
    }, fail)
  })
}

export function createZaloAccountHistoryReader(
  api: HistoryApi,
  options: ReaderOptions,
) {
  const maxRows = Math.min(
    options.maxRows ?? ZALO_ACCOUNT_HISTORY_MAX_ROWS,
    ZALO_ACCOUNT_HISTORY_MAX_ROWS,
  )
  const maxBytes = Math.min(
    options.maxBytes ?? ZALO_ACCOUNT_HISTORY_MAX_BYTES,
    ZALO_ACCOUNT_HISTORY_MAX_BYTES,
  )
  const groupWindow = Math.min(maxRows, MAX_GROUP_WINDOW)
  let directPending = false
  let directStale = false

  const normalize = (row: Record<string, unknown>) =>
    normalizeProviderMessage(
      {
        data: asObject(row.data),
        threadId: row.threadId,
        type: row.type,
        isSelf: row.isSelf,
      },
      options,
    )

  return {
    async direct(input: DirectRequest): Promise<DirectPage> {
      if (input.signal?.aborted) {
        throw new ZaloAccountHistoryPageError("history_cancelled")
      }
      if (directStale) {
        throw new ZaloAccountHistoryPageError("history_socket_stale")
      }
      if (directPending) {
        throw new ZaloAccountHistoryPageError("history_busy")
      }
      directPending = true

      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          input.signal?.removeEventListener("abort", cancel)
          api.listener.removeListener("old_messages", receive)
          directPending = false
        }
        const failUncertain = (error: unknown) => {
          // The SDK callback carries no request ID. A late response on this
          // socket could otherwise satisfy a later request for another scope.
          directStale = true
          cleanup()
          reject(error)
        }
        const cancel = () => {
          failUncertain(new ZaloAccountHistoryPageError("history_cancelled"))
        }
        const receive: OldMessageCallback = (rows, type) => {
          if (type !== ThreadType.User) {
            return
          }
          cleanup()
          try {
            const { page, oldest } = parsePage<ZaloAccountDirectMessage>(
              rows,
              {
                maxRows,
                maxBytes,
                providerExhausted: Array.isArray(rows) && rows.length === 0,
              },
              (value) => {
                const row = asObject(value)
                const identity = readIdentity(row, ThreadType.User)
                if (!(row && identity)) {
                  return null
                }
                if (input.threadId && identity.threadId !== input.threadId) {
                  return { identity }
                }
                const normalized = normalize(row)
                return normalized.kind === "direct"
                  ? { identity, message: normalized.message }
                  : null
              },
            )
            resolve({
              ...page,
              ...(oldest
                ? { oldestProviderMessageId: oldest.providerMessageId }
                : {}),
            })
          } catch (error) {
            reject(error)
          }
        }
        const timer = setTimeout(
          () =>
            failUncertain(new ZaloAccountHistoryPageError("history_timeout")),
          input.timeoutMs,
        )
        input.signal?.addEventListener("abort", cancel, { once: true })
        api.listener.on("old_messages", receive)
        try {
          api.listener.requestOldMessages(ThreadType.User, input.cursor)
        } catch (error) {
          failUncertain(error)
        }
      })
    },

    async group(input: GroupRequest): Promise<Page<ZaloAccountGroupMessage>> {
      const response = await withHistoryDeadline(input, async () =>
        api.getGroupChatHistory(input.groupId, groupWindow),
      )
      const data = asObject(response)
      const more = data?.more
      if (typeof more !== "number" || !Number.isSafeInteger(more) || more < 0) {
        throw new ZaloAccountHistoryPageError("history_invalid_response")
      }
      const { page } = parsePage<ZaloAccountGroupMessage>(
        data?.groupMsgs,
        { maxRows: groupWindow, maxBytes, providerExhausted: more === 0 },
        (value) => {
          const row = asObject(value)
          const identity = readIdentity(row, ThreadType.Group)
          if (!(row && identity)) {
            return null
          }
          if (identity.threadId !== input.groupId) {
            throw new ZaloAccountHistoryPageError("history_invalid_response")
          }
          const normalized = normalize(row)
          return normalized.kind === "group"
            ? { identity, message: normalized.message }
            : null
        },
      )
      return page
    },
  }
}
