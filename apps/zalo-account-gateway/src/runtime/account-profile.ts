import {
  type ZaloAccountNativeToolOperation as Operation,
  type ZaloAccountNativeToolResult as Result,
  toZaloAccountWebUrl,
  zaloAccountOwnProfileSchema,
  zaloAccountOwnSettingEditSchema,
  zaloAccountOwnSettingsSchema,
  zaloAccountProfileQrSchema,
} from "@chatbotx.io/sdk"
import { BusinessCategory, UpdateSettingsType, type Zalo } from "zca-js"
import { downloadOutboundAttachment } from "./outbound-attachment"
import { asNonEmptyString, asObject } from "./provider-content"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  | "getOwnId"
  | "fetchAccountInfo"
  | "getUserInfo"
  | "getQR"
  | "getBizAccount"
  | "getAvatarList"
  | "getSettings"
  | "updateProfile"
  | "updateProfileBio"
  | "changeAccountAvatar"
  | "deleteAvatar"
  | "reuseAvatar"
  | "updateSettings"
>
type OwnProfile = NonNullable<Result["ownProfile"]>
type OwnBusiness = NonNullable<Result["ownBusiness"]>
type AvatarPage = NonNullable<Result["avatarPage"]>
type OwnSettings = NonNullable<Result["ownSettings"]>
type MutationResult = Omit<Result, "kind">
type Write = (send: () => Promise<MutationResult>) => Promise<Result>

type AccountInfo = {
  profile: OwnProfile
  avatarLocator?: string
  avatarKnown: boolean
  packageId?: number
}

type AccountAvatar = AvatarPage["photos"][number] & { locators: string[] }

type AvatarSnapshot = {
  page: AvatarPage
  albumId?: string
  avatars: Map<string, AccountAvatar>
}

type ProfilePatch = Extract<Operation, { kind: "updateOwnProfile" }>["patch"]

const ownIdPattern = /^\d{1,200}$/
const photoIdPattern = /^[A-Za-z0-9_-]{1,200}$/
const providerDisplayDate = /^(\d{2})\/(\d{2})\/(\d{4})$/
const imageHosts = ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"]
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"])
const categoryValues = Object.values(BusinessCategory)
const settingKeys = Object.keys(
  zaloAccountOwnSettingsSchema.shape,
) as (keyof OwnSettings)[]
const providerSettingKeys = Object.values(UpdateSettingsType)
const unavailable = { outcome: "unavailable" } as const
const unknown = { outcome: "unknown" } as const
const confirmed = { outcome: "confirmed" } as const

function ownId(value: unknown) {
  return typeof value === "string" && value !== "0" && ownIdPattern.test(value)
    ? value
    : undefined
}

function imageLink(value: unknown) {
  const url = toZaloAccountWebUrl(asNonEmptyString(value, 2048), true)
  if (
    url &&
    !url.port &&
    url.href.length <= 2048 &&
    imageHosts.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    return url
  }
}

function thumbnailUrl(url: URL | undefined) {
  if (url && !url.search && !url.hash) {
    return url.href
  }
}

function imageLocator(url: URL | undefined) {
  if (url) {
    return `${url.origin}${url.pathname}`
  }
}

function validDate(value: string | undefined) {
  const result = zaloAccountOwnProfileSchema.shape.birthDate.safeParse(value)
  return result.success ? result.data : undefined
}

function dateOfBirth(value: unknown, epoch: unknown) {
  const text = asNonEmptyString(value, 10)
  const display = text && providerDisplayDate.exec(text)
  const iso = display ? `${display[3]}-${display[2]}-${display[1]}` : text
  const date = validDate(iso)
  if (date) {
    return date
  }
  if (
    typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    Math.abs(epoch) >= 100_000
  ) {
    const time = new Date(Math.abs(epoch) < 1e11 ? epoch * 1000 : epoch)
    if (time.getUTCFullYear() >= 1900 && time.getTime() <= Date.now()) {
      return time.toISOString().slice(0, 10)
    }
  }
}

function nonnegative(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
}

function knownGender(value: unknown): 0 | 1 | undefined {
  if (value === 0 || value === 1) {
    return value
  }
}

function knownBio(value: unknown) {
  return typeof value === "string" && value.length <= 500 ? value : undefined
}

function makeAccountInfo(
  raw: Record<string, unknown>,
  uid: string,
): AccountInfo {
  const name =
    asNonEmptyString(raw.displayName, 500) ??
    asNonEmptyString(raw.zaloName, 500)
  const avatar = imageLink(raw.avatar)
  const avatarUrl = thumbnailUrl(avatar)
  const bio = knownBio(raw.status)
  const birthDate = dateOfBirth(raw.sdob, raw.dob)
  const gender = knownGender(raw.gender)
  return {
    profile: {
      uid,
      ...(name ? { name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(bio === undefined ? {} : { bio }),
      ...(birthDate ? { birthDate } : {}),
      ...(gender === undefined ? {} : { gender }),
    },
    avatarLocator: imageLocator(avatar),
    avatarKnown: avatar !== undefined || raw.avatar === "",
    packageId: nonnegative(asObject(raw.bizPkg)?.pkgId),
  }
}

async function readAccountInfo(
  api: Provider,
  uid: string,
  needed: (keyof OwnProfile)[] = ["name"],
): Promise<AccountInfo | undefined> {
  const direct = asObject(await api.fetchAccountInfo().catch(() => null))
  const row = asObject(direct?.profile)
  const base =
    row && ownId(row.userId) === uid ? makeAccountInfo(row, uid) : undefined
  if (base && needed.every((key) => base.profile[key] !== undefined)) {
    return base
  }
  const response = asObject(await api.getUserInfo(uid).catch(() => null))
  const changed = asObject(response?.changed_profiles)
  const candidate = asObject(changed?.[uid] ?? changed?.[`${uid}_0`])
  if (
    !candidate ||
    (candidate.userId !== undefined && ownId(candidate.userId) !== uid)
  ) {
    return base
  }
  const fallback = makeAccountInfo(candidate, uid)
  if (base) {
    const { avatarUrl, ...fallbackProfile } = fallback.profile
    return {
      profile: {
        ...fallbackProfile,
        ...base.profile,
        ...(!base.avatarKnown && avatarUrl ? { avatarUrl } : {}),
      },
      avatarLocator: base.avatarKnown
        ? base.avatarLocator
        : fallback.avatarLocator,
      avatarKnown: base.avatarKnown || fallback.avatarKnown,
      packageId: base.packageId ?? fallback.packageId,
    }
  }
  return fallback
}

function knownCategory(value: unknown): BusinessCategory | undefined {
  if (typeof value === "number" && categoryValues.includes(value)) {
    return value as BusinessCategory
  }
}

async function readBusiness(api: Provider, uid: string) {
  const response = asObject(await api.getBizAccount(uid).catch(() => null))
  const biz = asObject(response?.biz)
  return {
    packageId: nonnegative(response?.pkgId),
    category: knownCategory(biz?.cate),
    description: asNonEmptyString(biz?.desc, 1000),
    hasDetails: biz !== undefined,
  }
}

function businessResult(
  data: Awaited<ReturnType<typeof readBusiness>>,
): OwnBusiness {
  return {
    ...(data.packageId === undefined ? {} : { packageId: data.packageId }),
    ...(data.category === undefined ? {} : { category: data.category }),
    ...(data.description ? { description: data.description } : {}),
  }
}

async function readQr(
  api: Provider,
  uid: string,
): Promise<Result["profileQr"]> {
  const response = asObject(await api.getQR(uid).catch(() => null))
  const url =
    response && Object.hasOwn(response, uid) ? response[uid] : undefined
  const result = zaloAccountProfileQrSchema.safeParse({ imageUrl: url })
  return result.success ? result.data : undefined
}

function photoId(value: unknown) {
  return typeof value === "string" && photoIdPattern.test(value)
    ? value
    : undefined
}

function makeAvatar(value: unknown): AccountAvatar | undefined {
  const photo = asObject(value)
  const id = photoId(photo?.photoId)
  if (!id) {
    return
  }
  const thumbnail = imageLink(photo?.thumbnail)
  const original = imageLink(photo?.url)
  const locators = [imageLocator(original), imageLocator(thumbnail)].filter(
    (url): url is string => url !== undefined,
  )
  const preview = thumbnailUrl(thumbnail) ?? thumbnailUrl(original)
  return {
    photoId: id,
    locators,
    ...(preview ? { thumbnailUrl: preview } : {}),
  }
}

async function readAvatars(
  api: Provider,
  page = 1,
  limit = 20,
): Promise<AvatarSnapshot | undefined> {
  const response = asObject(
    await api.getAvatarList(limit, page).catch(() => null),
  )
  if (!Array.isArray(response?.photos)) {
    return
  }
  const avatars = new Map<string, AccountAvatar>()
  const seen = new Set<string>()
  for (const raw of response.photos.slice(0, limit)) {
    const result = makeAvatar(raw)
    if (result) {
      if (seen.has(result.photoId)) {
        avatars.delete(result.photoId)
      } else {
        seen.add(result.photoId)
        avatars.set(result.photoId, result)
      }
    }
  }
  const hasMore = response.hasMore
  const photos = [...avatars.values()].map(
    ({ photoId: id, thumbnailUrl: preview }) => ({
      photoId: id,
      ...(preview ? { thumbnailUrl: preview } : {}),
    }),
  )
  return {
    avatars,
    albumId: asNonEmptyString(response.albumId, 200),
    page: {
      page,
      ...(hasMore === 1 && page < 1000 ? { nextPage: page + 1 } : {}),
      complete: hasMore === 0 && photos.length === response.photos.length,
      photos,
    },
  }
}

async function readSettings(api: Provider): Promise<OwnSettings> {
  const response = asObject(await api.getSettings().catch(() => null))
  const values = settingKeys.flatMap((key) => {
    const raw = response?.[key]
    const input =
      key === "show_online_status" && typeof raw === "boolean"
        ? Number(raw)
        : raw
    const value = zaloAccountOwnSettingsSchema.shape[key].safeParse(input)
    return value.success && value.data !== undefined ? [[key, value.data]] : []
  })
  return zaloAccountOwnSettingsSchema.parse(Object.fromEntries(values))
}

function readSettingKey(key: UpdateSettingsType): keyof OwnSettings {
  if (key === UpdateSettingsType.ArchivedChat) {
    return "archived_chat_status"
  }
  if (key === UpdateSettingsType.QuickMessage) {
    return "quick_message_status"
  }
  return key
}

async function updateProfile(
  api: Provider,
  uid: string,
  patch: ProfilePatch,
  write: Write,
): Promise<Result> {
  const kind = "updateOwnProfile"
  const profileKeys = ["name", "birthDate", "gender"] as const
  const unchanged = profileKeys.filter((key) => patch[key] === undefined)
  const current = await readAccountInfo(api, uid, unchanged)
  if (!current) {
    return { kind, ...unavailable }
  }
  const name = patch.name ?? current.profile.name
  const dob = patch.birthDate ?? current.profile.birthDate
  const gender = patch.gender ?? current.profile.gender
  if (!(name && dob && gender !== undefined)) {
    return { kind, ...unavailable }
  }
  const business = await readBusiness(api, uid)
  const cate = business.category
  const personal =
    business.packageId === 0 &&
    !business.hasDetails &&
    !(current.packageId && current.packageId > 0)
  if (cate === undefined && !personal) {
    return { kind, ...unavailable }
  }
  return await write(async () => {
    await api.updateProfile({
      profile: { name, dob: dob as `${string}-${string}-${string}`, gender },
      ...(cate === undefined ? {} : { biz: { cate } }),
    })
    const updated = await readAccountInfo(api, uid, [...profileKeys])
    if (
      updated?.profile.name === name &&
      updated.profile.birthDate === dob &&
      updated.profile.gender === gender
    ) {
      return { ...confirmed, ownProfile: updated.profile }
    }
    return unknown
  })
}

async function updateBio(
  api: Provider,
  uid: string,
  bio: string,
  write: Write,
): Promise<Result> {
  return await write(async () => {
    await api.updateProfileBio(bio)
    const updated = await readAccountInfo(api, uid, ["bio"])
    if (updated?.profile.bio === bio) {
      return { ...confirmed, ownProfile: updated.profile }
    }
    return unknown
  })
}

async function changeAvatar(
  api: Provider,
  uid: string,
  avatar: Extract<Operation, { kind: "changeOwnAvatar" }>["avatar"],
  write: Write,
): Promise<Result> {
  const kind = "changeOwnAvatar"
  const source = await downloadOutboundAttachment(avatar, {
    mimeTypes: imageTypes,
    signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (!source) {
    return { kind, ...unavailable }
  }
  const previous = await readAccountInfo(api, uid, [])
  if (!previous) {
    return { kind, ...unavailable }
  }
  return await write(async () => {
    await api.changeAccountAvatar(source)
    const updated = await readAccountInfo(api, uid, [])
    if (
      previous.avatarKnown &&
      updated?.avatarLocator &&
      updated.avatarLocator !== previous.avatarLocator
    ) {
      return { ...confirmed, ownProfile: updated.profile }
    }
    return unknown
  })
}

async function manageAlbumPhoto(
  api: Provider,
  uid: string,
  operation: Extract<Operation, { kind: "deleteOwnAvatar" | "reuseOwnAvatar" }>,
  write: Write,
): Promise<Result> {
  const { kind, photoId: target, page, limit } = operation
  const initial = await readAvatars(api, page, limit)
  const selected = initial?.avatars.get(target)
  if (!(initial && selected)) {
    return { kind, ...unavailable }
  }
  if (kind === "reuseOwnAvatar") {
    if (selected.locators.length === 0) {
      return { kind, ...unavailable }
    }
    return await write(async () => {
      await api.reuseAvatar(target)
      const updated = await readAccountInfo(api, uid, [])
      if (
        updated?.avatarLocator &&
        selected.locators.includes(updated.avatarLocator)
      ) {
        return { ...confirmed, ownProfile: updated.profile }
      }
      return unknown
    })
  }
  return await write(async () => {
    const result = await api.deleteAvatar(target)
    const refreshed = await readAvatars(api, page, limit)
    const errors = asObject(result?.errMap)
    const evidence =
      errors && Object.hasOwn(errors, target)
        ? asObject(errors[target])
        : undefined
    const code = nonnegative(evidence?.err)
    if (code !== undefined && code !== 0) {
      return { outcome: "rejected" }
    }
    const acknowledged =
      code === 0 ||
      (Array.isArray(result?.delPhotoIds) &&
        result.delPhotoIds.slice(0, 50).includes(target))
    if (
      acknowledged &&
      refreshed &&
      initial.albumId &&
      refreshed.albumId === initial.albumId &&
      !refreshed.avatars.has(target)
    ) {
      return { ...confirmed, avatarPage: refreshed.page }
    }
    return unknown
  })
}

async function updateSetting(
  api: Provider,
  setting: Extract<Operation, { kind: "updateOwnSetting" }>["setting"],
  write: Write,
): Promise<Result> {
  const parsed = zaloAccountOwnSettingEditSchema.safeParse(setting)
  const nativeKey = providerSettingKeys.find((key) => key === parsed.data?.key)
  if (!(parsed.success && nativeKey)) {
    return { kind: "updateOwnSetting", ...unavailable }
  }
  const key = readSettingKey(nativeKey)
  const { value } = parsed.data
  return await write(async () => {
    await api.updateSettings(nativeKey, value)
    const readback = await readSettings(api)
    if (readback[key] === value) {
      return { ...confirmed, ownSettings: { [key]: value } }
    }
    return unknown
  })
}

export async function runProviderAccountProfile(
  api: Provider,
  operation: Operation,
  authorizeDispatch: () => Promise<void>,
): Promise<Result> {
  const { kind } = operation
  if (kind === "updateOwnLanguage" || kind === "updateOwnActiveStatus") {
    // The pinned SDK cannot verify a lasting language or active-status setting.
    return { kind, ...unavailable }
  }
  const uid = ownId(api.getOwnId())
  if (!uid) {
    return { kind, ...unavailable }
  }
  const write: Write = async (send) => {
    await authorizeDispatch()
    try {
      return { kind, ...(await send()) }
    } catch {
      return { kind, ...unknown }
    }
  }
  switch (kind) {
    case "readOwnProfile": {
      const result = await readAccountInfo(api, uid)
      if (!result || Object.keys(result.profile).length <= 1) {
        return { kind, ...unavailable }
      }
      return {
        kind,
        outcome: result.profile.name ? "confirmed" : "partial",
        ownProfile: result.profile,
      }
    }
    case "readOwnBusiness": {
      const details = await readBusiness(api, uid)
      const ownBusiness = businessResult(details)
      if (Object.keys(ownBusiness).length === 0) {
        return { kind, ...unavailable }
      }
      const complete =
        details.packageId !== undefined &&
        (!details.hasDetails || details.category !== undefined)
      return { kind, outcome: complete ? "confirmed" : "partial", ownBusiness }
    }
    case "readOwnQr": {
      const profileQr = await readQr(api, uid)
      return profileQr
        ? { kind, ...confirmed, profileQr }
        : { kind, ...unavailable }
    }
    case "listOwnAvatars": {
      const result = await readAvatars(api, operation.page, operation.limit)
      if (!result) {
        return { kind, ...unavailable }
      }
      const { page: avatarPage } = result
      return {
        kind,
        outcome:
          avatarPage.complete || avatarPage.nextPage ? "confirmed" : "partial",
        avatarPage,
      }
    }
    case "readOwnSettings": {
      const ownSettings = await readSettings(api)
      const count = Object.keys(ownSettings).length
      if (count === 0) {
        return { kind, ...unavailable }
      }
      return {
        kind,
        outcome: count === settingKeys.length ? "confirmed" : "partial",
        ownSettings,
      }
    }
    case "updateOwnProfile":
      return await updateProfile(api, uid, operation.patch, write)
    case "updateOwnBio":
      return await updateBio(api, uid, operation.bio, write)
    case "changeOwnAvatar":
      return await changeAvatar(api, uid, operation.avatar, write)
    case "deleteOwnAvatar":
    case "reuseOwnAvatar":
      return await manageAlbumPhoto(api, uid, operation, write)
    case "updateOwnSetting":
      return await updateSetting(api, operation.setting, write)
    default:
      return { kind, ...unavailable }
  }
}
