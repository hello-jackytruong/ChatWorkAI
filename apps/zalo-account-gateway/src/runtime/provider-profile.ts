import {
  toZaloAccountWebUrl,
  type ZaloAccountProfile,
  type ZaloAccountProfileField,
  type ZaloAccountProfileSource,
} from "@chatbotx.io/sdk"
import { asNonEmptyString, asObject } from "./provider-content"

const dateParts = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})\/(\d{2})\/(\d{4}))$/
const yearOnly = /^(?:19|20)\d{2}$/
const publicNumber = /^\+?[0-9]{7,15}$/

function birthDate(raw: unknown, epoch: unknown): string | undefined {
  const value = asNonEmptyString(raw, 16)
  if (value && yearOnly.test(value)) {
    return value
  }
  const matches = value?.match(dateParts)
  if (matches) {
    const iso = matches[1]
      ? `${matches[1]}-${matches[2]}-${matches[3]}`
      : `${matches[6]}-${matches[5]}-${matches[4]}`
    const time = Date.parse(iso)
    if (Number.isFinite(time) && new Date(time).toISOString().startsWith(iso)) {
      return iso
    }
    return
  }
  if (yearOnly.test(String(epoch))) {
    return String(epoch)
  }
  const ts = Number(epoch)
  if (!Number.isSafeInteger(ts) || ts === 0) {
    return
  }
  const date = new Date(Math.abs(ts) < 1e12 ? ts * 1000 : ts)
  if (date.getUTCFullYear() >= 1900 && date.getUTCFullYear() < 2100) {
    return date.toISOString().slice(0, 10)
  }
}

function profileImage(value: unknown) {
  const url = toZaloAccountWebUrl(asNonEmptyString(value, 2048), true)
  if (
    url &&
    !url.port &&
    ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"].some(
      (root) => url.hostname === root || url.hostname.endsWith(`.${root}`),
    )
  ) {
    return url.href
  }
}

type ProfileInput = {
  uid: string
  source: ZaloAccountProfileSource
  observedAt: number
  data: unknown
}

export function normalizeZaloProfile({
  uid,
  source,
  observedAt,
  data,
}: ProfileInput): ZaloAccountProfile {
  const fields: ZaloAccountProfile["fields"] = {}
  const raw = asObject(data)
  const providerUid = asNonEmptyString(raw?.userId ?? raw?.uid, 100)
  if (!raw || (providerUid && providerUid !== uid)) {
    return { uid, fields }
  }
  const read = (key: ZaloAccountProfileField, value: unknown, max = 2048) => {
    const normalized = asNonEmptyString(value, max)
    if (normalized) {
      fields[key] = { value: normalized, source, observedAt }
    }
  }
  read("zaloName", raw.zaloName ?? raw.zalo_name, 200)
  read("displayName", raw.displayName ?? raw.display_name, 200)
  read("globalId", raw.globalId, 200)
  read("username", raw.username, 200)
  read("bio", raw.bio ?? raw.status, 1000)
  read("business", asObject(raw.bizPkg)?.name ?? raw.businessName, 200)
  read("avatarUrl", profileImage(raw.avatar ?? raw.avatarUrl))
  read("coverUrl", profileImage(raw.cover ?? raw.coverUrl))
  read("birthDate", birthDate(raw.sdob, raw.dob), 10)
  if (
    typeof raw.phoneNumber === "string" &&
    publicNumber.test(raw.phoneNumber)
  ) {
    read("publicPhone", raw.phoneNumber, 16)
  }
  if (raw.gender === 0 || raw.gender === 1) {
    fields.gender = { value: raw.gender, source, observedAt }
  }
  if (raw.isFr === 0 || raw.isFr === 1) {
    read("relationship", raw.isFr === 1 ? "friend" : "notFriend")
  }
  if (typeof raw.isBlocked === "boolean") {
    fields.blocked = { value: raw.isBlocked, source, observedAt }
  }
  return { uid, fields }
}

export async function readProviderProfiles(
  api: {
    getUserInfo: (ids: string[]) => Promise<unknown>
    getFullAvatar: (uid: string) => Promise<unknown>
    getAvatarUrlProfile: (uid: string) => Promise<unknown>
  },
  query: { uids: string[]; largeAvatar?: boolean },
) {
  const uids = [...new Set(query.uids)]
  const response = asObject(await api.getUserInfo(uids))
  const profiles = asObject(response?.changed_profiles)
  const observedAt = Date.now()
  const result = uids.map((uid) =>
    normalizeZaloProfile({
      uid,
      source: "getUserInfo",
      observedAt,
      data: profiles?.[uid] ?? profiles?.[`${uid}_0`],
    }),
  )
  const only = result[0]
  if (query.largeAvatar && result.length === 1 && only) {
    const large = asObject(await api.getFullAvatar(only.uid).catch(() => null))
    const fallback = large?.full_avatar
      ? undefined
      : asObject(await api.getAvatarUrlProfile(only.uid).catch(() => null))
    const avatar = profileImage(
      large?.full_avatar ?? asObject(fallback?.[only.uid])?.avatar,
    )
    if (avatar) {
      only.fields.avatarUrl = {
        value: avatar,
        source: "getUserInfo",
        observedAt,
      }
    }
  }
  return result
}
