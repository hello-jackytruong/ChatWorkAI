import {
  type ZaloAccountThreadEvent,
  zaloAccountThreadEventSchema,
} from "@chatbotx.io/sdk"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const id = (value: unknown): string | undefined => {
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    return
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return
  }
  const result = String(value).trim()
  return result && result !== "0" && result.length <= 200 ? result : undefined
}
const timestamp = (value: unknown): number | undefined => {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) {
    return
  }
  return Math.trunc(raw < 100_000_000_000 ? raw * 1000 : raw)
}

function reactionContent(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return record(value)
  }
  // Old zca-js reaction callbacks can keep the provider content JSON encoded.
  if (value.length <= 65_536) {
    try {
      return record(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return {}
}

function reactionPeer(input: {
  ownUid?: string
  actorId: string
  recipient: unknown
  sdkThreadId: string
}): string | undefined {
  const { ownUid, actorId, recipient, sdkThreadId } = input
  const recipientId = id(recipient)
  if (actorId === ownUid) {
    // The SDK may use the connected UID as threadId when uidFrom wasn't "0".
    if (
      recipientId &&
      recipientId !== ownUid &&
      (sdkThreadId === ownUid || sdkThreadId === recipientId)
    ) {
      return recipientId
    }
    return
  }
  if (
    actorId === sdkThreadId &&
    (!ownUid || recipientId === ownUid || recipient === "0" || recipient === 0)
  ) {
    return actorId
  }
}

function normalizeReaction(
  packet: Record<string, unknown>,
  data: Record<string, unknown>,
  sdkThreadId: string,
  threadType: "user" | "group",
  ownUid: string | undefined,
): ZaloAccountThreadEvent[] {
  const actorId =
    data.uidFrom === "0" || data.uidFrom === 0 ? id(ownUid) : id(data.uidFrom)
  const timestampMs = timestamp(data.ts ?? data.mSTs)
  if (
    !(actorId && timestampMs) ||
    (packet.isSelf === true && ownUid && actorId !== ownUid)
  ) {
    return []
  }
  const threadId =
    threadType === "group"
      ? sdkThreadId
      : reactionPeer({ ownUid, actorId, recipient: data.idTo, sdkThreadId })
  if (
    !threadId ||
    (threadType === "group" &&
      data.idTo !== undefined &&
      id(data.idTo) !== threadId)
  ) {
    return []
  }
  const content = reactionContent(data.content)
  if (!Array.isArray(content.rMsg) || content.rMsg.length > 100) {
    return []
  }
  const icon =
    typeof content.rIcon === "string" ? content.rIcon.trim() : undefined
  const remove = icon === "" || Number(content.rType) < 0
  if (!(remove || icon)) {
    return []
  }
  return content.rMsg.flatMap((target) => {
    const parsed = zaloAccountThreadEventSchema.safeParse({
      type: "reaction",
      threadId,
      threadType,
      timestampMs,
      timestampSource: "provider",
      providerMessageId: id(record(target).gMsgID),
      actorId,
      reactionKey: icon ?? "",
      operation: remove ? "remove" : "add",
    })
    return parsed.success ? [parsed.data] : []
  })
}

export function normalizeProviderThreadEvent(
  kind: "delivered" | "seen" | "typing" | "reaction" | "undo",
  input: unknown,
  ownUid?: string,
): ZaloAccountThreadEvent[] {
  const packet = record(input)
  const data = record(packet.data)
  const threadId = id(packet.threadId)
  if (!threadId) {
    return []
  }
  const threadType =
    packet.isGroup === true || packet.type === 1 ? "group" : "user"
  if (kind === "reaction") {
    return normalizeReaction(packet, data, threadId, threadType, ownUid)
  }
  const events: unknown[] = []
  const providerTimestamp = timestamp(data.ts ?? data.mSTs)
  const base = {
    threadId,
    threadType,
    timestampMs: providerTimestamp ?? Date.now(),
    timestampSource: providerTimestamp ? "provider" : "observed",
  }
  if (kind === "typing") {
    const actorId = id(data.uid)
    if (actorId === ownUid || (threadType === "user" && actorId !== threadId)) {
      return []
    }
    const actorName =
      typeof data.dName === "string" && data.dName.trim()
        ? data.dName.trim().slice(0, 255)
        : undefined
    events.push({ ...base, type: "typing", actorId, actorName, seconds: 5 })
  } else if (kind === "undo") {
    events.push({
      ...base,
      type: "undo",
      providerMessageId: id(record(data.content).globalMsgId),
    })
  } else {
    const members = (value: unknown) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value
                .map(id)
                .filter(
                  (item): item is string =>
                    !!item &&
                    item !== ownUid &&
                    (threadType === "group" || item === threadId),
                ),
            ),
          ]
        : []
    const delivered = members(data.deliveredUids)
    const seen = members(data.seenUids)
    if (kind === "delivered" && delivered.length) {
      events.push({
        ...base,
        type: "receipt",
        providerMessageId: id(data.msgId),
        status: "delivered",
        memberIds: delivered,
      })
    }
    if (seen.length || kind === "seen") {
      const fallbackMembers =
        threadType === "user" && !Array.isArray(data.seenUids) ? [threadId] : []
      events.push({
        ...base,
        type: "receipt",
        providerMessageId: id(data.msgId),
        status: "read",
        memberIds: seen.length ? seen : fallbackMembers,
      })
    }
  }
  return events.flatMap((event) => {
    const parsed = zaloAccountThreadEventSchema.safeParse(event)
    return parsed.success ? [parsed.data] : []
  })
}
