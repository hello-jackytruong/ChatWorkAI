import type { ZaloAccountGroupManagementResult as Result } from "@chatbotx.io/sdk"
import { MAX_GROUP_MEMBERS_SCANNED } from "./group-members"
import { asNonEmptyString, asObject } from "./provider-content"

type MemberResult = NonNullable<Result["memberOutcomes"]>[number]
type Entry = NonNullable<Result["entries"]>[number]
type MutationResult = Omit<Result, "kind">

const numericId = /^\d{1,200}$/
const linkPath = /^\/g\/[A-Za-z0-9_-]{1,128}\/?$/
const linkHosts = new Set(["zalo.me", "zalo.vn"])
const groupTypes = new Map<number, NonNullable<Result["group"]>["type"]>([
  [1, "group"],
  [2, "community"],
])
export function nativeId(value: unknown) {
  const id = asNonEmptyString(value, 200)
  return id && id !== "0" && numericId.test(id) ? id : undefined
}

export function flag(value: unknown): boolean | undefined {
  if (value === 0 || value === false || value === "0") {
    return false
  }
  if (value === 1 || value === true || value === "1") {
    return true
  }
}

export function groupLink(value: unknown) {
  const input = asNonEmptyString(value, 512)
  if (input) {
    try {
      const url = new URL(input)
      if (
        url.protocol === "https:" &&
        linkHosts.has(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        linkPath.test(url.pathname)
      ) {
        return url.href
      }
    } catch {
      // The input must be an absolute Zalo invitation URL.
    }
  }
}

export function expiresAt(value: unknown) {
  const timestamp = Number(value)
  if (Number.isSafeInteger(timestamp) && timestamp > 0) {
    const time = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp)
    if (Number.isFinite(time.getTime()) && time.getUTCFullYear() < 10_000) {
      return time.toISOString()
    }
  }
}

export function isExpired(expiry?: string) {
  return expiry !== undefined && Date.parse(expiry) <= Date.now()
}

export function nativeCode(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 9999
    ? value
    : undefined
}

export function groupSummary(value: unknown): Result["group"] {
  const group = asObject(value)
  const providerGroupId = nativeId(group?.groupId)
  if (!providerGroupId) {
    return
  }
  const count = group?.totalMember
  const type = group?.type
  return {
    providerGroupId,
    name: asNonEmptyString(group?.name, 500),
    type: typeof type === "number" ? groupTypes.get(type) : undefined,
    memberCount:
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0
        ? count
        : undefined,
  }
}

export function idSet(input: unknown, limit = MAX_GROUP_MEMBERS_SCANNED) {
  if (!Array.isArray(input)) {
    return
  }
  return new Set(
    input
      .slice(0, limit)
      .map(nativeId)
      .filter((uid): uid is string => uid !== undefined),
  )
}

export function completeIdSet(input: unknown) {
  if (
    Array.isArray(input) &&
    input.length <= MAX_GROUP_MEMBERS_SCANNED &&
    input.every((uid) => nativeId(uid) !== undefined)
  ) {
    return idSet(input)
  }
}

export function memberOutcomes(
  members: string[],
  map: (uid: string) => Omit<MemberResult, "uid">,
): MemberResult[] {
  return [...new Set(members)].map((uid) => ({ uid, ...map(uid) }))
}

export function memberResult(results: MemberResult[]): MutationResult {
  const confirmedCount = results.filter(
    (result) => result.outcome === "confirmed",
  ).length
  const rejectedCount = results.filter(
    (result) => result.outcome === "rejected",
  ).length
  let outcome: Result["outcome"] = "unknown"
  if (results.length > 0 && confirmedCount === results.length) {
    outcome = "confirmed"
  } else if (results.length > 0 && rejectedCount === results.length) {
    outcome = "rejected"
  } else if (confirmedCount > 0 || rejectedCount > 0) {
    outcome = "partial"
  }
  return { outcome, memberOutcomes: results }
}

export function memberFailures(members: string[], raw: unknown) {
  const failures = completeIdSet(raw)
  return memberResult(
    memberOutcomes(members, (uid) => {
      if (!failures) {
        return { outcome: "unknown" }
      }
      return { outcome: failures.has(uid) ? "rejected" : "confirmed" }
    }),
  )
}

export function invitationEntry(value: unknown): Entry | undefined {
  const invitation = asObject(value)
  const group = groupSummary(invitation?.groupInfo)
  if (group) {
    return {
      id: group.providerGroupId,
      name: group.name,
      memberCount: group.memberCount,
      expiresAt: expiresAt(invitation?.expiredTs),
      inviterUid: nativeId(asObject(invitation?.inviterInfo)?.id),
    }
  }
}

export function listResult<T>(
  raw: T[] | undefined,
  limit: number,
  project: (value: T) => Entry | undefined,
) {
  const entries = new Map<string, Entry>()
  if (!Array.isArray(raw)) {
    return { entries: [], complete: false }
  }
  for (const value of raw.slice(0, limit)) {
    const entry = project(value)
    if (entry) {
      entries.set(entry.id, entry)
    }
  }
  return {
    entries: [...entries.values()],
    complete: entries.size === raw.length,
  }
}

export function blockedEntry(value: unknown): Entry | undefined {
  const row = asObject(value)
  const uid = nativeId(row?.id)
  if (uid) {
    return {
      id: uid,
      uid,
      name:
        asNonEmptyString(row?.dName, 500) ??
        asNonEmptyString(row?.zaloName, 500),
    }
  }
}

export function reviewOutcomes(members: string[], result: unknown) {
  const statuses = asObject(result)
  return memberResult(
    memberOutcomes(members, (uid) => {
      const code =
        statuses && Object.hasOwn(statuses, uid)
          ? nativeCode(statuses[uid])
          : undefined
      if (code === 0) {
        return { outcome: "confirmed", providerCode: code }
      }
      if (code === 166 || code === 170 || code === 178) {
        return { outcome: "rejected", providerCode: code }
      }
      return { outcome: "unknown" }
    }),
  )
}
