import { createHash } from "node:crypto"
import {
  toZaloAccountWebUrl,
  type ZaloAccountGroupAdministrationRead,
  type ZaloAccountGroupAdministrationResult,
  ZaloAccountPreDispatchError,
  type zaloAccountGroupOverviewSchema,
  zaloAccountGroupSettingsSchema,
} from "@chatbotx.io/sdk"
import type { Zalo } from "zca-js"
import type { z } from "zod"
import { MAX_GROUP_MEMBERS_SCANNED, readGroup } from "./group-members"
import { asNonEmptyString, asObject } from "./provider-content"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  | "getGroupInfo"
  | "getGroupMembersInfo"
  | "getOwnId"
  | "getRelatedFriendGroup"
  | "getFriendRequestStatus"
  | "fetchAccountInfo"
>
type Group = Awaited<ReturnType<typeof readGroup>>
type Overview = z.infer<typeof zaloAccountGroupOverviewSchema>
type GroupMember = Extract<
  ZaloAccountGroupAdministrationResult,
  { kind: "members" }
>["members"][number]
type Profile = Pick<GroupMember, "name" | "avatarUrl">

const settingsKeys = zaloAccountGroupSettingsSchema.keyof().options
const groupTypes = new Map<number, Overview["type"]>([
  [1, "group"],
  [2, "community"],
])
const numericUid = /^\d{1,200}$/
const cursorPattern = /^(\d{1,4})\.([A-Za-z0-9_-]{43})$/

function knownUid(value: unknown) {
  const id = asNonEmptyString(value, 200)
  return id && id !== "0" && numericUid.test(id) ? id : undefined
}

function knownFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") {
    return true
  }
  if (value === false || value === 0 || value === "0") {
    return false
  }
}

function safeAvatar(value: unknown): string | undefined {
  const url = toZaloAccountWebUrl(asNonEmptyString(value, 2048), true)
  if (
    url &&
    !url.port &&
    url.href.length <= 2048 &&
    ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"].some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    return url.href
  }
}

function readMembers(group: Group) {
  const direct = Array.isArray(group.memberIds) ? group.memberIds : []
  const versioned = Array.isArray(group.memVerList) ? group.memVerList : []
  const inline = Array.isArray(group.currentMems) ? group.currentMems : []
  const ids = new Set<string>()
  let truncated = [direct, versioned, inline].some(
    (values) => values.length > MAX_GROUP_MEMBERS_SCANNED,
  )
  for (const source of [
    direct.slice(0, MAX_GROUP_MEMBERS_SCANNED),
    versioned
      .slice(0, MAX_GROUP_MEMBERS_SCANNED)
      .map((value) => asNonEmptyString(value, 255)?.split("_", 1)[0]),
    inline.slice(0, MAX_GROUP_MEMBERS_SCANNED).map((value) => value?.id),
  ]) {
    for (const value of source) {
      const uid = knownUid(value)
      if (!uid || ids.has(uid)) {
        continue
      }
      if (ids.size === MAX_GROUP_MEMBERS_SCANNED) {
        truncated = true
        break
      }
      ids.add(uid)
    }
  }
  return {
    ids,
    complete:
      !truncated && group.hasMoreMember === 0 && group.totalMember === ids.size,
  }
}

function canUseGroupCapability(
  role: Overview["role"],
  knownMember: boolean,
  locked?: boolean,
) {
  if (role === "owner" || role === "deputy") {
    return true
  }
  if (locked === false && knownMember) {
    return true
  }
  if (locked === true && role === "member") {
    return false
  }
}

function makeProfile(
  name: unknown,
  alternateName: unknown,
  avatar: unknown,
): Profile {
  return {
    name: asNonEmptyString(name, 500) ?? asNonEmptyString(alternateName, 500),
    avatarUrl: safeAvatar(avatar),
  }
}

async function enrichPage(api: Provider, group: Group, ids: string[]) {
  const profiles = new Map<string, Profile>()
  const pageIds = new Set(ids)
  const inline = Array.isArray(group.currentMems) ? group.currentMems : []
  for (const member of inline.slice(0, MAX_GROUP_MEMBERS_SCANNED)) {
    const uid = knownUid(member?.id)
    if (uid && pageIds.has(uid)) {
      const profile = makeProfile(member.dName, member.zaloName, member.avatar)
      const previous = profiles.get(uid)
      profiles.set(uid, {
        name: previous?.name ?? profile.name,
        avatarUrl: previous?.avatarUrl ?? profile.avatarUrl,
      })
    }
  }
  const missing = ids.filter((id) => !profiles.get(id)?.name)
  if (missing.length > 0) {
    try {
      const { profiles: enriched } = await api.getGroupMembersInfo(missing)
      for (const uid of missing) {
        const profile = Object.hasOwn(enriched, uid) ? enriched[uid] : undefined
        if (profile && (!profile.id || knownUid(profile.id) === uid)) {
          const { name, avatarUrl } = makeProfile(
            profile.displayName,
            profile.zaloName,
            profile.avatar,
          )
          profiles.set(uid, {
            name,
            avatarUrl: avatarUrl ?? profiles.get(uid)?.avatarUrl,
          })
        }
      }
    } catch {
      // A failed optional profile lookup leaves the known membership intact.
    }
  }
  return profiles
}

async function readRelatedGroups(
  api: Provider,
  uid: string,
  allowed: boolean,
): Promise<Extract<ZaloAccountGroupAdministrationResult, { kind: "related" }>> {
  const unavailable = {
    kind: "related" as const,
    providerGroupIds: [],
    complete: false,
  }
  if (!allowed) {
    return unavailable
  }
  try {
    const { profile } = await api.fetchAccountInfo()
    if (
      !(
        Number.isSafeInteger(profile?.bizPkg?.pkgId) && profile.bizPkg.pkgId > 0
      )
    ) {
      return unavailable
    }
    const status = asObject(await api.getFriendRequestStatus(uid))
    if (knownFlag(status?.is_friend ?? status?.isFriend) !== true) {
      return unavailable
    }
    const { groupRelateds } = await api.getRelatedFriendGroup(uid)
    const ids = Object.hasOwn(groupRelateds, uid) && groupRelateds[uid]
    if (!Array.isArray(ids)) {
      return unavailable
    }
    const providerGroupIds = [
      ...new Set(
        ids.slice(0, 100).flatMap((id) => {
          const known = knownUid(id)
          return known ? [known] : []
        }),
      ),
    ]
    return {
      kind: "related",
      providerGroupIds,
      complete:
        ids.length <= 100 && ids.every((id) => knownUid(id) !== undefined),
    }
  } catch {
    return unavailable
  }
}

export async function readProviderGroupAdministration(
  api: Provider,
  groupId: string,
  input: ZaloAccountGroupAdministrationRead,
  scope: { workspaceId: string; accountId: string },
): Promise<ZaloAccountGroupAdministrationResult> {
  const group = await readGroup(api, groupId)
  const ownUid = knownUid(api.getOwnId())
  const ownerUid = knownUid(group.creatorId)
  const deputies = Array.isArray(group.adminIds)
    ? new Set(
        group.adminIds.slice(0, MAX_GROUP_MEMBERS_SCANNED).flatMap((value) => {
          const uid = knownUid(value)
          return uid && uid !== ownerUid ? [uid] : []
        }),
      )
    : undefined
  const deputyUids = deputies && [...deputies].sort()
  const { ids, complete } = readMembers(group)
  const roleOf = (uid: string): Overview["role"] => {
    if (uid === ownerUid) {
      return "owner"
    }
    if (deputies?.has(uid)) {
      return "deputy"
    }
    return ids.has(uid) && ownerUid && deputyUids ? "member" : "unknown"
  }
  const role = ownUid ? roleOf(ownUid) : "unknown"
  const knownMember = ownUid !== undefined && ids.has(ownUid)
  const locked = knownFlag(group.setting?.lockViewMember)
  const viewMembers = canUseGroupCapability(role, knownMember, locked)
  if (input.kind === "related") {
    return await readRelatedGroups(
      api,
      input.uid,
      viewMembers === true && input.uid !== ownUid && ids.has(input.uid),
    )
  }
  const providerVersion = asNonEmptyString(group.version, 100)
  if (input.kind === "overview") {
    const type = groupTypes.get(group.type)
    const settings = Object.fromEntries(
      settingsKeys.flatMap((key) => {
        const flag = knownFlag(group.setting?.[key])
        return flag === undefined ? [] : [[key, flag]]
      }),
    )
    const sendMessages = canUseGroupCapability(
      role,
      knownMember,
      knownFlag(group.setting?.lockSendMsg),
    )
    const accessible = role !== "unknown" || !complete || knownMember
    return {
      kind: "overview",
      overview: {
        name: asNonEmptyString(group.name, 500) ?? groupId,
        accessible,
        ...(type === undefined ? {} : { type }),
        description:
          typeof group.desc === "string" && group.desc.length <= 2000
            ? group.desc
            : undefined,
        role,
        ownerUid,
        deputyUids:
          deputyUids && deputyUids.length <= 100 ? deputyUids : undefined,
        avatarUrl: safeAvatar(group.fullAvt) ?? safeAvatar(group.avt),
        memberCount:
          Number.isSafeInteger(group.totalMember) && group.totalMember >= 0
            ? group.totalMember
            : undefined,
        providerVersion,
        observedAt: new Date().toISOString(),
        ...(Object.keys(settings).length ? { settings } : {}),
        ...(viewMembers !== undefined || sendMessages !== undefined
          ? { capabilities: { viewMembers, sendMessages } }
          : {}),
      },
    }
  }
  if (viewMembers !== true) {
    return {
      kind: "members",
      members: [],
      complete: false,
      visibility: locked === true ? "restricted" : "unknown",
    }
  }

  // An owner or deputy has provider evidence of membership even if the list omits them.
  const accountOmitted = ownUid !== undefined && !knownMember
  const ordered = [...ids].sort()
  if (accountOmitted) {
    if (ordered.length === MAX_GROUP_MEMBERS_SCANNED) {
      ordered.pop()
    }
    ordered.push(ownUid)
    ordered.sort()
  }
  const snapshot = createHash("sha256")
    .update(
      JSON.stringify([
        scope.workspaceId,
        scope.accountId,
        groupId,
        providerVersion,
        ownerUid,
        deputyUids,
        locked,
        complete,
        ordered,
      ]),
    )
    .digest("base64url")
  let offset = 0
  if (input.cursor) {
    const parts = cursorPattern.exec(input.cursor)
    offset = Number(parts?.[1])
    if (parts?.[2] !== snapshot || offset >= ordered.length) {
      throw new ZaloAccountPreDispatchError(
        "The Zalo group roster changed. Start again from the first page.",
      )
    }
  }
  const page = ordered.slice(offset, offset + (input.limit ?? 20))
  const profiles = await enrichPage(api, group, page)
  const end = offset + page.length
  return {
    kind: "members",
    members: page.map((uid) => ({
      uid,
      role: roleOf(uid),
      ...(uid === ownUid ? { isSelf: true as const } : {}),
      ...profiles.get(uid),
    })),
    complete:
      complete &&
      !accountOmitted &&
      page.every((uid) => profiles.get(uid)?.name),
    visibility: "visible",
    ...(end < ordered.length ? { nextCursor: `${end}.${snapshot}` } : {}),
  }
}
