import type {
  ZaloAccountNativeThread as NativeThread,
  ZaloAccountNativeToolOperation as Operation,
  ZaloAccountNativeToolResult as Result,
} from "@chatbotx.io/sdk"
import { MuteAction, ThreadType, type Zalo } from "zca-js"
import { asObject } from "./provider-content"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  | "getPinConversations"
  | "getMute"
  | "getArchivedChatList"
  | "getUnreadMark"
  | "getAutoDeleteChat"
  | "getHiddenConversations"
  | "setPinnedConversations"
  | "setMute"
  | "updateArchivedChatList"
  | "addUnreadMark"
  | "removeUnreadMark"
  | "updateAutoDeleteChat"
  | "setHiddenConversations"
>
type Settings = NonNullable<Result["conversation"]>
type StateValue = NonNullable<Settings[keyof Settings]>
type Observation<T extends StateValue> = { identity: NativeThread; value?: T }

const MAX_SCANNED = 5000
const MAX_MUTE_SECONDS = 31_536_000
const nativeIdPattern = /^\d{1,200}$/
const typedPinPattern = /^([ug])(\d{1,200})$/

function nativeId(raw: unknown) {
  if (typeof raw === "string" && nativeIdPattern.test(raw) && raw !== "0") {
    return raw
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return String(raw)
  }
}

function providerThreadType(thread: NativeThread) {
  return thread.threadType === "group" ? ThreadType.Group : ThreadType.User
}

function observe<T extends StateValue>(
  threadId: string | undefined,
  threadType: NativeThread["threadType"],
  value?: T,
): Observation<T> | undefined {
  if (threadId) {
    return { identity: { threadId, threadType }, value }
  }
}

function selectThread<T extends StateValue>(
  rows: unknown,
  thread: NativeThread,
  decode: (row: unknown) => Observation<T> | undefined,
  fallback: T,
): T | undefined {
  if (!Array.isArray(rows)) {
    return
  }
  let complete = rows.length <= MAX_SCANNED
  let value: T | undefined
  for (const row of rows.slice(0, MAX_SCANNED)) {
    const observation = decode(row)
    if (!observation) {
      complete = false
      continue
    }
    if (
      observation.identity.threadId !== thread.threadId ||
      observation.identity.threadType !== thread.threadType
    ) {
      continue
    }
    if (
      observation.value === undefined ||
      (value !== undefined && value !== observation.value)
    ) {
      return
    }
    value = observation.value
  }
  if (value !== undefined && (complete || typeof value === "boolean")) {
    return value
  }
  if (complete) {
    return fallback
  }
}

const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

async function readPinned(api: Provider, thread: NativeThread) {
  const response = asObject(await api.getPinConversations())
  if (!isVersion(response?.version)) {
    return
  }
  return selectThread(
    response.conversations,
    thread,
    (entry) => {
      const match =
        typeof entry === "string" ? typedPinPattern.exec(entry) : null
      if (match) {
        return observe(
          nativeId(match[2]),
          match[1] === "g" ? "group" : "user",
          true,
        )
      }
    },
    false,
  )
}

function epochSeconds(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value >= 1e12 ? value / 1000 : value
  }
}

function muteSeconds(entry: Record<string, unknown>) {
  const { duration, muteMode } = entry
  if (muteMode === MuteAction.UNMUTE) {
    return 0
  }
  if (
    muteMode !== MuteAction.MUTE ||
    typeof duration !== "number" ||
    !Number.isSafeInteger(duration) ||
    duration < -1 ||
    duration > MAX_MUTE_SECONDS
  ) {
    return
  }
  if (duration <= 0) {
    return duration
  }
  const start = epochSeconds(entry.startTime)
  const current =
    epochSeconds(entry.currentTime) ?? epochSeconds(entry.systemTime)
  if (start !== undefined && current !== undefined && current >= start) {
    return current - start >= duration ? 0 : duration
  }
}

async function readMute(api: Provider, thread: NativeThread) {
  const response = asObject(await api.getMute())
  const rows =
    thread.threadType === "group"
      ? response?.groupChatEntries
      : response?.chatEntries
  return selectThread(
    rows,
    thread,
    (raw) => {
      const row = asObject(raw)
      if (row) {
        return observe(nativeId(row.id), thread.threadType, muteSeconds(row))
      }
    },
    0,
  )
}

async function readArchived(
  api: Provider,
  thread: NativeThread,
  minimumVersion?: number,
) {
  const response = asObject(await api.getArchivedChatList())
  if (
    !isVersion(response?.version) ||
    (response.needResync !== undefined && response.needResync !== false) ||
    (minimumVersion !== undefined && response.version < minimumVersion)
  ) {
    return
  }
  return selectThread(
    response.items,
    thread,
    (raw) => {
      const row = asObject(raw)
      if (row?.type === ThreadType.User || row?.type === ThreadType.Group) {
        return observe(
          nativeId(row.id),
          row.type === ThreadType.Group ? "group" : "user",
          true,
        )
      }
    },
    false,
  )
}

async function readUnread(api: Provider, thread: NativeThread) {
  const response = asObject(await api.getUnreadMark())
  if (response?.status !== 0) {
    return
  }
  const data = asObject(response.data)
  const rows =
    thread.threadType === "group" ? data?.convsGroup : data?.convsUser
  return selectThread(
    rows,
    thread,
    (entry) => observe(nativeId(asObject(entry)?.id), thread.threadType, true),
    false,
  )
}

function autoDeleteMs(ttl: unknown): Settings["autoDeleteMs"] {
  if (
    ttl === 0 ||
    ttl === 86_400_000 ||
    ttl === 604_800_000 ||
    ttl === 1_209_600_000
  ) {
    return ttl
  }
}

async function readAutoDelete(api: Provider, thread: NativeThread) {
  const rows = asObject(await api.getAutoDeleteChat())?.convers
  return selectThread<NonNullable<Settings["autoDeleteMs"]>>(
    rows,
    thread,
    (raw) => {
      const row = asObject(raw)
      if (typeof row?.isGroup === "boolean") {
        return observe(
          nativeId(row.destId),
          row.isGroup ? "group" : "user",
          autoDeleteMs(row.ttl),
        )
      }
    },
    0,
  )
}

async function readHidden(api: Provider, thread: NativeThread) {
  // The provider also returns an account PIN. Read only the threads field.
  const rows = asObject(await api.getHiddenConversations())?.threads
  return selectThread(
    rows,
    thread,
    (raw) => {
      const row = asObject(raw)
      if (row?.is_group === 0 || row?.is_group === 1) {
        return observe(
          nativeId(row.thread_id),
          row.is_group === 1 ? "group" : "user",
          true,
        )
      }
    },
    false,
  )
}

async function readSettings(
  api: Provider,
  thread: NativeThread,
): Promise<Result> {
  const [pinned, muteSeconds, archived] = await Promise.all([
    readPinned(api, thread).catch(() => undefined),
    readMute(api, thread).catch(() => undefined),
    readArchived(api, thread).catch(() => undefined),
  ])
  const [unread, autoDeleteMs, hidden] = await Promise.all([
    readUnread(api, thread).catch(() => undefined),
    readAutoDelete(api, thread).catch(() => undefined),
    readHidden(api, thread).catch(() => undefined),
  ])
  const selected = {
    pinned,
    muteSeconds,
    archived,
    unread,
    autoDeleteMs,
    hidden,
  }
  const known = Object.entries(selected).filter(
    ([, value]) => value !== undefined,
  )
  const kind = "readConversationSettings"
  if (known.length === 0) {
    return { kind, outcome: "unavailable" }
  }
  return {
    kind,
    outcome:
      known.length === Object.keys(selected).length ? "confirmed" : "partial",
    conversation: Object.fromEntries(known),
  }
}

export async function runProviderConversationSettings(
  api: Provider,
  thread: NativeThread,
  operation: Operation,
  authorizeDispatch: () => Promise<void>,
): Promise<Result> {
  if (!nativeId(thread.threadId)) {
    return { kind: operation.kind, outcome: "unavailable" }
  }
  if (operation.kind === "readConversationSettings") {
    return await readSettings(api, thread)
  }
  const kind = operation.kind
  const { threadId } = thread
  const threadType = providerThreadType(thread)
  const write = async <K extends keyof Settings, W>(
    field: K,
    desired: Settings[K],
    dispatch: () => Promise<W>,
    readback: (result: W) => Promise<Settings[K]>,
  ): Promise<Result> => {
    await authorizeDispatch()
    try {
      const result = await dispatch()
      const actual = await readback(result)
      if (actual !== undefined) {
        return {
          kind,
          outcome: actual === desired ? "confirmed" : "unknown",
          conversation: { [field]: actual },
        }
      }
    } catch {
      // A dispatched request may have reached Zalo. Its desired state stays unconfirmed.
    }
    return { kind, outcome: "unknown" }
  }

  switch (operation.kind) {
    case "setPinned":
      return await write(
        "pinned",
        operation.enabled,
        () =>
          api.setPinnedConversations(operation.enabled, threadId, threadType),
        () => readPinned(api, thread),
      )
    case "setMute":
      return await write(
        "muteSeconds",
        operation.durationSeconds,
        () =>
          api.setMute(
            {
              action:
                operation.durationSeconds === 0
                  ? MuteAction.UNMUTE
                  : MuteAction.MUTE,
              duration:
                operation.durationSeconds === 0
                  ? -1
                  : operation.durationSeconds,
            },
            threadId,
            threadType,
          ),
        () => readMute(api, thread),
      )
    case "setArchived":
      return await write(
        "archived",
        operation.enabled,
        () =>
          api.updateArchivedChatList(operation.enabled, {
            id: threadId,
            type: threadType,
          }),
        async (result) => {
          const version = asObject(result)?.version
          const minimumVersion = isVersion(version) ? version : undefined
          const observed = await readArchived(api, thread, minimumVersion)
          return minimumVersion === undefined ? undefined : observed
        },
      )
    case "setUnread":
      return await write(
        "unread",
        operation.enabled,
        () =>
          operation.enabled
            ? api.addUnreadMark(threadId, threadType)
            : api.removeUnreadMark(threadId, threadType),
        () => readUnread(api, thread),
      )
    case "setAutoDelete":
      return await write(
        "autoDeleteMs",
        operation.ttlMs,
        () => api.updateAutoDeleteChat(operation.ttlMs, threadId, threadType),
        () => readAutoDelete(api, thread),
      )
    case "setHidden":
      return await write(
        "hidden",
        operation.enabled,
        () =>
          api.setHiddenConversations(operation.enabled, threadId, threadType),
        () => readHidden(api, thread),
      )
    default:
      return { kind, outcome: "unavailable" }
  }
}
