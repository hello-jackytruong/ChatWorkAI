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

export function normalizeProviderThreadEvent(
  kind: "delivered" | "seen" | "typing" | "reaction" | "undo",
  input: unknown,
): ZaloAccountThreadEvent[] {
  const packet = record(input)
  const data = record(packet.data)
  const threadId = id(packet.threadId)
  if (!threadId) {
    return []
  }
  const threadType =
    packet.isGroup === true || packet.type === 1 ? "group" : "user"
  const events: unknown[] = []
  const providerTimestamp = timestamp(data.ts ?? data.mSTs)
  const base = {
    threadId,
    threadType,
    timestampMs: providerTimestamp ?? Date.now(),
    timestampSource: providerTimestamp ? "provider" : "observed",
  }
  if (kind === "typing") {
    events.push({ ...base, type: "typing", actorId: id(data.uid), seconds: 5 })
  } else if (kind === "undo") {
    events.push({
      ...base,
      type: "undo",
      providerMessageId: id(record(data.content).globalMsgId),
    })
  } else if (kind === "reaction") {
    if (!providerTimestamp) {
      return []
    }
    const content = record(data.content)
    if (!Array.isArray(content.rMsg) || content.rMsg.length > 100) {
      return []
    }
    for (const target of content.rMsg) {
      const reactionKey = typeof content.rIcon === "string" ? content.rIcon : ""
      events.push({
        ...base,
        type: "reaction",
        providerMessageId: id(record(target).gMsgID),
        actorId: id(data.uidFrom),
        reactionKey,
        operation: !reactionKey || Number(content.rType) < 0 ? "remove" : "add",
      })
    }
  } else {
    const members = (value: unknown) =>
      Array.isArray(value)
        ? [...new Set(value.map(id).filter((item): item is string => !!item))]
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
      const fallbackMembers = threadType === "user" ? [threadId] : []
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
