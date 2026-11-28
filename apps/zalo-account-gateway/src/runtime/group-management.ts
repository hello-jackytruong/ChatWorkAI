import {
  groupManagementRequiredRole,
  isZaloAccountGroupManagementScoped,
  type ZaloAccountGroupManagementOperation as Operation,
  type ZaloAccountGroupManagementResult as Result,
  ZaloAccountPreDispatchError,
} from "@chatbotx.io/sdk"
import type { Zalo } from "zca-js"
import {
  blockedEntry,
  completeIdSet,
  expiresAt,
  flag,
  groupLink,
  groupSummary,
  idSet,
  invitationEntry,
  isExpired,
  listResult,
  memberFailures,
  memberOutcomes,
  memberResult,
  nativeCode,
  nativeId,
  reviewOutcomes,
} from "./group-management-results"
import { MAX_GROUP_MEMBERS_SCANNED, readGroup } from "./group-members"
import { downloadOutboundAttachment } from "./outbound-attachment"
import { asNonEmptyString, asObject } from "./provider-content"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  | "getOwnId"
  | "getGroupInfo"
  | "createGroup"
  | "changeGroupName"
  | "changeGroupAvatar"
  | "addUserToGroup"
  | "inviteUserToGroups"
  | "removeUserFromGroup"
  | "addGroupDeputy"
  | "removeGroupDeputy"
  | "changeGroupOwner"
  | "getGroupBlockedMember"
  | "addGroupBlockedMember"
  | "removeGroupBlockedMember"
  | "getPendingGroupMembers"
  | "reviewPendingMemberRequest"
  | "getGroupLinkDetail"
  | "enableGroupLink"
  | "disableGroupLink"
  | "getGroupLinkInfo"
  | "joinGroupLink"
  | "getGroupInviteBoxList"
  | "getGroupInviteBoxInfo"
  | "joinGroupInviteBox"
  | "deleteGroupInviteBox"
  | "leaveGroup"
  | "disperseGroup"
>

type AuthorizeDispatch = () => Promise<void>
type Group = Awaited<ReturnType<typeof readGroup>>
type MutationResult = Omit<Result, "kind">
type Write = (call: () => Promise<MutationResult>) => Promise<Result>

const pageLimit = 50
const maxPage = 1000
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"])
const noEvidence = { outcome: "unknown", reason: "no_evidence" } as const
const unavailable = { outcome: "unavailable", reason: "no_evidence" } as const
const confirmed = { outcome: "confirmed" } as const

function exactLink(link: string) {
  const accepted = groupLink(link)
  if (!accepted) {
    throw new ZaloAccountPreDispatchError(
      "A valid Zalo group invitation URL is required",
    )
  }
  return accepted
}

function memberEvidence(group: Group) {
  const memberIds = idSet(group.memberIds) ?? new Set<string>()
  const versioned = Array.isArray(group.memVerList) ? group.memVerList : []
  const inline = Array.isArray(group.currentMems) ? group.currentMems : []
  const ids = idSet([
    ...versioned
      .slice(0, MAX_GROUP_MEMBERS_SCANNED)
      .map((entry) => asNonEmptyString(entry, 255)?.split("_", 1)[0]),
    ...inline.slice(0, MAX_GROUP_MEMBERS_SCANNED).map((entry) => entry?.id),
  ])
  for (const uid of ids ?? []) {
    if (memberIds.size === MAX_GROUP_MEMBERS_SCANNED) {
      break
    }
    memberIds.add(uid)
  }
  return memberIds
}

function groupAuthority(group: Group, uid: string) {
  const owner = nativeId(group.creatorId)
  const deputies = completeIdSet(group.adminIds)
  const members = memberEvidence(group)
  return {
    owner,
    deputies,
    members,
    isOwner: uid === owner,
    isDeputy: deputies?.has(uid) === true,
  }
}

type Authority = ReturnType<typeof groupAuthority>

function forbid() {
  throw new ZaloAccountPreDispatchError(
    "The current Zalo group role does not allow this operation",
  )
}

function ensureAuthority(
  operation: Operation,
  authority: Authority,
  ownUid: string,
) {
  const { isOwner, isDeputy, owner, deputies, members } = authority
  const required = groupManagementRequiredRole(operation)
  const eligible = {
    account: false,
    member: isOwner || isDeputy || members.has(ownUid),
    deputy: isOwner || isDeputy,
    owner: isOwner,
  }
  if (!eligible[required]) {
    forbid()
  }
  switch (operation.kind) {
    case "addGroupDeputy":
      if (
        operation.memberUids.some(
          (uid) => !members.has(uid) || uid === owner || deputies?.has(uid),
        )
      ) {
        forbid()
      }
      break
    case "removeGroupDeputy":
      if (
        operation.memberUids.some((uid) => uid === owner || !deputies?.has(uid))
      ) {
        forbid()
      }
      break
    case "changeGroupOwner":
      if (
        operation.uid === owner ||
        !(members.has(operation.uid) || deputies?.has(operation.uid))
      ) {
        forbid()
      }
      break
    case "removeUserFromGroup":
    case "addGroupBlockedMember":
      if (
        !(owner && deputies) ||
        operation.memberUids.some(
          (uid) =>
            uid === ownUid ||
            uid === owner ||
            deputies.has(uid) ||
            !members.has(uid),
        )
      ) {
        forbid()
      }
      break
    case "addUserToGroup":
    case "removeGroupBlockedMember":
    case "reviewPendingMemberRequest":
      if (operation.memberUids.includes(ownUid)) {
        forbid()
      }
      break
    case "inviteUserToGroups":
      if (operation.uid === ownUid) {
        forbid()
      }
      break
    default:
      break
  }
}

function writeOperation(
  kind: Operation["kind"],
  authorize: AuthorizeDispatch,
): Write {
  return async (call) => {
    await authorize()
    try {
      return { kind, ...(await call()) }
    } catch (error) {
      const code = nativeCode(asObject(error)?.code)
      if (kind === "joinGroupLink") {
        if (code === 240) {
          return { kind, outcome: "pending" }
        }
        if (code === 178) {
          return { kind, ...confirmed }
        }
      }
      if (code === 166) {
        return {
          kind,
          outcome: "rejected",
          reason: kind === "leaveGroup" ? "not_member" : "permission",
        }
      }
      return { kind, ...noEvidence }
    }
  }
}

async function confirmedByGroup(
  api: Provider,
  groupId: string,
  verify: (group: Group) => boolean,
): Promise<MutationResult> {
  const group = await readGroup(api, groupId).catch(() => null)
  return group && verify(group) ? confirmed : noEvidence
}

async function confirmedRemoval(
  api: Provider,
  groupId: string,
): Promise<MutationResult> {
  const result = await api.getGroupInfo(groupId).catch(() => null)
  return result?.removedsGroup?.includes(groupId) ? confirmed : noEvidence
}

async function readInvitation(api: Provider, groupId: string) {
  const invitation = await api
    .getGroupInviteBoxInfo({ groupId, mpage: 1, mcount: 1 })
    .catch(() => null)
  const entry = invitationEntry(invitation)
  return entry?.id === groupId ? entry : undefined
}

async function readInviteList(
  api: Provider,
  page = 0,
  limit = 20,
): Promise<MutationResult> {
  const result = await api
    .getGroupInviteBoxList({ page, invPerPage: limit, mpage: 1, mcount: 1 })
    .catch(() => null)
  const { entries, complete } = listResult(
    result?.invitations,
    limit,
    invitationEntry,
  )
  const hasMore = flag(result?.hasMore)
  return {
    outcome: result ? "confirmed" : "unavailable",
    entries,
    complete: complete && hasMore === false,
    ...(hasMore === true && page < maxPage ? { nextPage: page + 1 } : {}),
  }
}

async function readLinkInfo(api: Provider, link: string) {
  const raw = await api
    .getGroupLinkInfo({ link, memberPage: 1 })
    .catch(() => null)
  return groupSummary(raw)
}

async function createGroup(
  api: Provider,
  operation: Extract<Operation, { kind: "createGroup" }>,
): Promise<MutationResult> {
  const response = await api.createGroup({
    name: operation.name,
    members: operation.memberUids,
  })
  const providerGroupId = nativeId(response?.groupId)
  const successes = idSet(response?.sucessMembers)
  const failures = idSet(response?.errorMembers)
  const members = memberResult(
    memberOutcomes(operation.memberUids, (uid) => {
      if (failures?.has(uid)) {
        return { outcome: "rejected" }
      }
      return {
        outcome:
          providerGroupId && successes?.has(uid) ? "confirmed" : "unknown",
      }
    }),
  )
  if (!providerGroupId) {
    return members.outcome === "rejected"
      ? members
      : { ...members, outcome: "unknown", reason: "no_evidence" }
  }
  return {
    ...members,
    providerGroupId,
    outcome: members.outcome === "confirmed" ? "confirmed" : "partial",
  }
}

async function manageAccount(
  api: Provider,
  operation: Operation,
  ownUid: string,
  write: Write,
): Promise<Result | undefined> {
  const { kind } = operation
  switch (kind) {
    case "createGroup":
      if (operation.memberUids.includes(ownUid)) {
        forbid()
      }
      return await write(() => createGroup(api, operation))
    case "getGroupLinkInfo": {
      const group = await readLinkInfo(api, exactLink(operation.link))
      return group ? { kind, ...confirmed, group } : { kind, ...unavailable }
    }
    case "joinGroupLink": {
      const link = exactLink(operation.link)
      const group = await readLinkInfo(api, link)
      if (!group) {
        return { kind, ...unavailable }
      }
      return await write(async () => {
        await api.joinGroupLink(link)
        return await confirmedByGroup(api, group.providerGroupId, (current) => {
          const { isOwner, isDeputy, members } = groupAuthority(current, ownUid)
          return isOwner || isDeputy || members.has(ownUid)
        })
      })
    }
    case "getGroupInviteBoxList":
      return {
        kind,
        ...(await readInviteList(api, operation.page, operation.limit)),
      }
    case "getGroupInviteBoxInfo":
    case "joinGroupInviteBox":
    case "deleteGroupInviteBox": {
      const groupId = operation.invitedGroupId
      const entry = await readInvitation(api, groupId)
      if (!entry) {
        return { kind, ...unavailable }
      }
      const expired = isExpired(entry.expiresAt)
      if (kind === "getGroupInviteBoxInfo") {
        return expired
          ? {
              kind,
              outcome: "unavailable",
              reason: "expired",
              entries: [entry],
            }
          : { kind, ...confirmed, entries: [entry] }
      }
      if (kind === "joinGroupInviteBox") {
        if (expired) {
          return { kind, outcome: "unavailable", reason: "expired" }
        }
        return await write(async () => {
          await api.joinGroupInviteBox(groupId)
          return await confirmedByGroup(api, groupId, (group) => {
            const { isOwner, isDeputy, members } = groupAuthority(group, ownUid)
            return isOwner || isDeputy || members.has(ownUid)
          })
        })
      }
      return await write(async () => {
        const result = await api.deleteGroupInviteBox(
          groupId,
          operation.blockFutureInvite ?? false,
        )
        const entry =
          result?.errMap && Object.hasOwn(result.errMap, groupId)
            ? result.errMap[groupId]
            : undefined
        const code = nativeCode(entry?.err)
        if (code !== undefined && code !== 0) {
          return {
            outcome: "rejected",
            reason: code === 166 ? "permission" : "provider_rejected",
            providerGroupId: groupId,
            providerCode: code,
          }
        }
        if (code === 0 || idSet(result?.delInvitaionIds)?.has(groupId)) {
          return { ...confirmed, providerGroupId: groupId, providerCode: code }
        }
        return noEvidence
      })
    }
    default:
      return
  }
}

async function readBlocked(
  api: Provider,
  groupId: string,
  page = 1,
  limit = 20,
): Promise<MutationResult> {
  const result = await api
    .getGroupBlockedMember({ page, count: limit }, groupId)
    .catch(() => null)
  const { entries, complete } = listResult(
    result?.blocked_members,
    limit,
    blockedEntry,
  )
  const hasMore = flag(result?.has_more)
  return {
    outcome: result ? "confirmed" : "unavailable",
    entries,
    complete: complete && hasMore === false,
    ...(hasMore === true && page < maxPage ? { nextPage: page + 1 } : {}),
  }
}

async function readPending(
  api: Provider,
  groupId: string,
  offset = 0,
  limit = 20,
): Promise<MutationResult> {
  const result = await api.getPendingGroupMembers(groupId).catch(() => null)
  const raw = result?.users
  if (!Array.isArray(raw)) {
    return { ...unavailable, entries: [], complete: false }
  }
  const bounded = raw.slice(0, MAX_GROUP_MEMBERS_SCANNED)
  const { entries, complete } = listResult(
    bounded.slice(offset, offset + limit),
    limit,
    (value) => {
      const uid = nativeId(value?.uid)
      return uid
        ? { id: uid, uid, name: asNonEmptyString(value?.dpn, 500) }
        : undefined
    },
  )
  const next = offset + limit
  return {
    outcome: "confirmed",
    entries,
    ...(next < bounded.length ? { nextOffset: next } : {}),
    complete:
      complete &&
      raw.length <= MAX_GROUP_MEMBERS_SCANNED &&
      next >= bounded.length &&
      Number.isSafeInteger(result?.time),
  }
}

async function readLinkDetail(
  api: Provider,
  groupId: string,
): Promise<MutationResult> {
  const result = await api.getGroupLinkDetail(groupId).catch(() => null)
  const linkEnabled = flag(result?.enabled)
  const expiry = expiresAt(result?.expiration_date)
  if (linkEnabled === undefined) {
    return unavailable
  }
  if (isExpired(expiry)) {
    return {
      outcome: "unavailable",
      reason: "expired",
      linkEnabled,
      expiresAt: expiry,
    }
  }
  if (!linkEnabled) {
    return { ...confirmed, linkEnabled }
  }
  const link = groupLink(result?.link)
  return link
    ? { ...confirmed, link, linkEnabled, expiresAt: expiry }
    : { ...unavailable, linkEnabled }
}

async function verifyDeputies(
  api: Provider,
  groupId: string,
  members: string[],
  promote: boolean,
) {
  const group = await readGroup(api, groupId).catch(() => null)
  const deputies = completeIdSet(group?.adminIds)
  return memberResult(
    memberOutcomes(members, (uid) => ({
      outcome: deputies?.has(uid) === promote ? "confirmed" : "unknown",
    })),
  )
}

async function verifyBlocked(
  api: Provider,
  groupId: string,
  members: string[],
  blocked: boolean,
) {
  const evidence = await readBlocked(api, groupId, 1, pageLimit)
  const ids = new Set(evidence.entries?.map(({ id }) => id))
  return memberResult(
    memberOutcomes(members, (uid) => ({
      outcome:
        (blocked && ids.has(uid)) ||
        (!(blocked || ids.has(uid)) && evidence.complete)
          ? "confirmed"
          : "unknown",
    })),
  )
}

async function manageGroup(
  api: Provider,
  groupId: string,
  ownUid: string,
  operation: Operation,
  write: Write,
): Promise<Result> {
  const { kind } = operation
  let group = await readGroup(api, groupId)
  ensureAuthority(operation, groupAuthority(group, ownUid), ownUid)
  switch (kind) {
    case "changeGroupName":
      return await write(async () => {
        await api.changeGroupName(operation.name, groupId)
        return await confirmedByGroup(
          api,
          groupId,
          (current) => current.name === operation.name,
        )
      })
    case "changeGroupAvatar": {
      const avatar = await downloadOutboundAttachment(operation.avatar, {
        mimeTypes: imageTypes,
        signal: AbortSignal.timeout(5000),
      }).catch(() => null)
      if (!avatar) {
        throw new ZaloAccountPreDispatchError(
          "Zalo group avatar could not be loaded",
        )
      }
      group = await readGroup(api, groupId)
      ensureAuthority(operation, groupAuthority(group, ownUid), ownUid)
      const previousAvatar = asNonEmptyString(group.fullAvt || group.avt, 4096)
      return await write(async () => {
        await api.changeGroupAvatar(avatar, groupId)
        return await confirmedByGroup(api, groupId, (current) => {
          const currentAvatar = asNonEmptyString(
            current.fullAvt || current.avt,
            4096,
          )
          return currentAvatar !== undefined && currentAvatar !== previousAvatar
        })
      })
    }
    case "addUserToGroup":
      return await write(async () => {
        const value = await api.addUserToGroup(operation.memberUids, groupId)
        return memberFailures(operation.memberUids, value?.errorMembers)
      })
    case "removeUserFromGroup":
      return await write(async () => {
        const value = await api.removeUserFromGroup(
          operation.memberUids,
          groupId,
        )
        return memberFailures(operation.memberUids, value?.errorMembers)
      })
    case "inviteUserToGroups":
      return await write(async () => {
        const { grid_message_map: map } = await api.inviteUserToGroups(
          operation.uid,
          groupId,
        )
        const code =
          map && Object.hasOwn(map, groupId)
            ? nativeCode(map[groupId]?.error_code)
            : undefined
        if (code === undefined) {
          return noEvidence
        }
        return memberResult([
          {
            uid: operation.uid,
            outcome: code === 0 ? "confirmed" : "rejected",
            providerCode: code,
          },
        ])
      })
    case "addGroupDeputy":
      return await write(async () => {
        await api.addGroupDeputy(operation.memberUids, groupId)
        return await verifyDeputies(api, groupId, operation.memberUids, true)
      })
    case "removeGroupDeputy":
      return await write(async () => {
        await api.removeGroupDeputy(operation.memberUids, groupId)
        return await verifyDeputies(api, groupId, operation.memberUids, false)
      })
    case "changeGroupOwner":
      return await write(async () => {
        await api.changeGroupOwner(operation.uid, groupId)
        return await confirmedByGroup(
          api,
          groupId,
          (current) => nativeId(current.creatorId) === operation.uid,
        )
      })
    case "getGroupBlockedMember":
      return {
        kind,
        ...(await readBlocked(api, groupId, operation.page, operation.limit)),
      }
    case "addGroupBlockedMember":
      return await write(async () => {
        await api.addGroupBlockedMember(operation.memberUids, groupId)
        return await verifyBlocked(api, groupId, operation.memberUids, true)
      })
    case "removeGroupBlockedMember":
      return await write(async () => {
        await api.removeGroupBlockedMember(operation.memberUids, groupId)
        return await verifyBlocked(api, groupId, operation.memberUids, false)
      })
    case "getPendingGroupMembers":
      return {
        kind,
        ...(await readPending(api, groupId, operation.offset, operation.limit)),
      }
    case "reviewPendingMemberRequest":
      return await write(async () => {
        const value = await api.reviewPendingMemberRequest(
          { members: operation.memberUids, isApprove: operation.approve },
          groupId,
        )
        return reviewOutcomes(operation.memberUids, value)
      })
    case "getGroupLinkDetail":
      return { kind, ...(await readLinkDetail(api, groupId)) }
    case "enableGroupLink":
      return await write(async () => {
        const value = await api.enableGroupLink(groupId)
        return flag(value?.enabled) === true
          ? { ...confirmed, linkEnabled: true }
          : noEvidence
      })
    case "disableGroupLink":
      return await write(async () => {
        await api.disableGroupLink(groupId)
        const value = await api.getGroupLinkDetail(groupId)
        return flag(value?.enabled) === false
          ? { ...confirmed, linkEnabled: false }
          : noEvidence
      })
    case "leaveGroup":
      return await write(async () => {
        const value = await api.leaveGroup(groupId, operation.silent ?? false)
        if (Array.isArray(value?.memberError) && value.memberError.length > 0) {
          return { outcome: "rejected", reason: "provider_rejected" }
        }
        return await confirmedRemoval(api, groupId)
      })
    case "disperseGroup":
      return await write(async () => {
        await api.disperseGroup(groupId)
        return await confirmedRemoval(api, groupId)
      })
    default:
      return { kind, outcome: "unavailable", reason: "unsupported" }
  }
}

export async function runProviderGroupManagement(
  api: Provider,
  providerGroupId: string | undefined,
  operation: Operation,
  authorizeDispatch: AuthorizeDispatch,
): Promise<Result> {
  const { kind } = operation
  if (kind === "updateGroupSettings" || kind === "upgradeGroupToCommunity") {
    // The pinned settings call forces unrelated fields to zero. Upgrade eligibility is unproven.
    return { kind, outcome: "unavailable", reason: "unsupported" }
  }
  const ownUid = nativeId(api.getOwnId())
  if (!ownUid) {
    throw new ZaloAccountPreDispatchError(
      "The active Zalo account identity is unavailable",
    )
  }
  const scoped = isZaloAccountGroupManagementScoped(operation)
  if (scoped !== (providerGroupId !== undefined)) {
    throw new ZaloAccountPreDispatchError(
      "The Zalo group operation has the wrong scope",
    )
  }
  const write = writeOperation(kind, authorizeDispatch)
  const accountResult = await manageAccount(api, operation, ownUid, write)
  if (accountResult) {
    return accountResult
  }
  if (!providerGroupId) {
    throw new ZaloAccountPreDispatchError(
      "The selected Zalo group is unavailable",
    )
  }
  return await manageGroup(api, providerGroupId, ownUid, operation, write)
}
