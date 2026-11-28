import {
  type ZaloAccountProfile,
  type ZaloAccountProfileField,
  zaloAccountProfileFieldSchema,
} from "@chatbotx.io/sdk"

type Evidence = {
  fields: ZaloAccountProfile["fields"]
  visibleFields: ZaloAccountProfileField[]
  observedAt: Date
  detailObservedAt: Date | null
  largeAvatarObservedAt: Date | null
}
export type ProfileObservation = {
  observedAt: Date
  detail?: boolean
  largeAvatar?: boolean
}

const precedence = {
  getUserInfo: 4,
  findUser: 3,
  friendEvent: 2,
  getAllFriends: 1,
}
const friendVisible = new Set<ZaloAccountProfileField>([
  "zaloName",
  "displayName",
  "avatarUrl",
  "relationship",
  "blocked",
])

export function mergeZaloAccountProfileEvidence(
  prior: Evidence | undefined,
  snapshot: ZaloAccountProfile,
  observation: ProfileObservation,
): Evidence {
  const time = observation.observedAt.getTime()
  const fields = { ...prior?.fields }
  const visible = new Set(prior?.visibleFields)
  const newestDetail =
    observation.detail &&
    (!prior?.detailObservedAt || time >= prior.detailObservedAt.getTime())
  if (newestDetail) {
    visible.clear()
  }
  for (const key of zaloAccountProfileFieldSchema.options) {
    const candidate = snapshot.fields[key]
    if (!candidate) {
      continue
    }
    const observedAt = Math.min(time, candidate.observedAt)
    const old = fields[key]
    const relationship = key === "relationship" || key === "blocked"
    const wins =
      !old ||
      (observedAt >= old.observedAt &&
        (precedence[candidate.source] >= precedence[old.source] ||
          (relationship && candidate.source === "friendEvent")))
    if (wins) {
      fields[key] = { ...candidate, observedAt }
    }
    if (
      (newestDetail && wins) ||
      (!prior?.detailObservedAt && friendVisible.has(key))
    ) {
      visible.add(key)
    }
  }
  return {
    fields,
    visibleFields: [...visible],
    observedAt: new Date(Math.max(prior?.observedAt.getTime() ?? 0, time)),
    detailObservedAt: newestDetail
      ? observation.observedAt
      : (prior?.detailObservedAt ?? null),
    largeAvatarObservedAt:
      newestDetail && observation.largeAvatar
        ? observation.observedAt
        : (prior?.largeAvatarObservedAt ?? null),
  }
}
