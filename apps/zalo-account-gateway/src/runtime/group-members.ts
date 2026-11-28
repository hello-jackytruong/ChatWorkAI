import {
  type ZaloAccountGroupMembersQuery,
  type ZaloAccountGroupMembersResult,
  ZaloAccountPreDispatchError,
  zaloAccountGroupMembersQuerySchema,
} from "@chatbotx.io/sdk"
import type { Mention, Zalo } from "zca-js"
import { asNonEmptyString } from "./provider-content"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  "getGroupInfo" | "getOwnId"
>

export const MAX_GROUP_MEMBERS_SCANNED = 5000

export const readGroup = async (api: Provider, groupId: string) => {
  try {
    const result = await api.getGroupInfo(groupId)
    const group = Object.hasOwn(result.gridInfoMap, groupId)
      ? result.gridInfoMap[groupId]
      : undefined
    if (group?.groupId !== groupId) {
      throw new Error("Unknown provider group")
    }
    return group
  } catch {
    throw new ZaloAccountPreDispatchError(
      "Current Zalo Account group information is unavailable",
    )
  }
}

const memberIdsOf = (ids: string[]) =>
  new Set(
    ids.slice(0, MAX_GROUP_MEMBERS_SCANNED).flatMap((value) => {
      const uid = asNonEmptyString(value, 200)
      return uid && uid !== "0" && uid !== "-1" ? [uid] : []
    }),
  )

export const readGroupMembers = async (
  api: Provider,
  groupId: string,
  input: ZaloAccountGroupMembersQuery,
): Promise<ZaloAccountGroupMembersResult> => {
  const group = await readGroup(api, groupId)
  const ownUid = api.getOwnId()
  if (
    Number(group.setting?.lockViewMember) === 1 &&
    ownUid !== group.creatorId &&
    !group.adminIds?.includes(ownUid)
  ) {
    return { members: [], complete: false }
  }
  const ids = memberIdsOf(group.memberIds ?? [])
  const profiles = new Map<string, string>()
  for (const member of (group.currentMems ?? []).slice(
    0,
    MAX_GROUP_MEMBERS_SCANNED,
  )) {
    const uid = asNonEmptyString(member.id, 200)
    const name = asNonEmptyString(member.dName ?? member.zaloName, 255)
    if (uid && name && ids.has(uid)) {
      profiles.set(uid, name)
    }
  }
  const { query, limit } = zaloAccountGroupMembersQuerySchema.parse(input)
  const search = query?.toLowerCase()
  const members: ZaloAccountGroupMembersResult["members"] = []
  let complete = group.hasMoreMember === 0 && group.totalMember <= ids.size
  for (const uid of ids) {
    if (uid === ownUid) {
      continue
    }
    const name = profiles.get(uid)
    if (
      search &&
      !(uid.includes(search) || name?.toLowerCase().includes(search))
    ) {
      if (!name) {
        complete = false
      }
      continue
    }
    if (members.length >= limit) {
      complete = false
      break
    }
    members.push({ uid, ...(name ? { name } : {}) })
  }
  return { members, complete }
}

export const verifyGroupMentions = async (
  api: Provider,
  groupId: string,
  mentions: ReadonlyArray<{ uid: string; offset: number; length: number }>,
): Promise<Mention[]> => {
  const ownUid = api.getOwnId()
  if (
    mentions.some(({ uid }) => uid === "-1" || uid === "0" || uid === ownUid)
  ) {
    throw new ZaloAccountPreDispatchError(
      "Zalo Account group mentions require another individual member",
    )
  }
  const group = await readGroup(api, groupId)
  if (
    Number(group.setting?.lockSendMsg) === 1 &&
    ownUid !== group.creatorId &&
    !group.adminIds?.includes(ownUid)
  ) {
    throw new ZaloAccountPreDispatchError(
      "The Zalo Account group is locked for this sender",
    )
  }
  const memberIds = memberIdsOf(group.memberIds ?? [])
  if (mentions.some(({ uid }) => !memberIds.has(uid))) {
    throw new ZaloAccountPreDispatchError(
      "A Zalo Account mention target is no longer a known member of this group",
    )
  }
  return mentions.map(({ uid, offset, length }) => ({
    uid,
    pos: offset,
    len: length,
  }))
}
