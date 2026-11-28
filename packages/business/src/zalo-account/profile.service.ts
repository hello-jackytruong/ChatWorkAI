import {
  createMessageRepository,
  integrationZaloAccountGroupRepository,
  zaloAccountSendAttemptRepository,
  zaloAccountUserProfileRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountUserProfileModel } from "@chatbotx.io/database/types"
import { distributedLock, isLockAcquisitionError } from "@chatbotx.io/redis"
import {
  type ZaloAccountProfileField,
  zaloAccountProfileSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { notFoundException } from "../errors"
import { captureZaloAccountResourceMedia } from "../zalo-account-media/resource-capture"
import { parseZaloAccountSourceId } from "./message-projection"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type ProfileInput = {
  workspaceId: string
  accountId: string
  conversationId: string
  contactInboxId: string
  memberUid?: string
  refresh?: boolean
  largeAvatar?: boolean
}
type ProfileScope = Pick<ProfileInput, "workspaceId" | "accountId"> & {
  providerUid: string
}
const REFRESH_TTL_MS = 5 * 60_000
const MEMBER_EVIDENCE_LOOKBACK_MS = 90 * 24 * 60 * 60_000
const unavailable = () => notFoundException("Zalo Account profile not found")

async function verifyMember(
  input: ProfileInput,
  providerUid: string,
  account: {
    id: string
    inboxId: string
    groupPolicyEpoch: number
    groupMessagingEnabled: boolean
  },
) {
  const group = await integrationZaloAccountGroupRepository.findByAnchor({
    workspaceId: input.workspaceId,
    contactInboxId: input.contactInboxId,
    conversationId: input.conversationId,
  })
  if (
    !(
      account.groupMessagingEnabled &&
      group?.accessible &&
      group.accountId === input.accountId &&
      (group.receiveEnabled || group.sendEnabled)
    )
  ) {
    return false
  }
  const messages = await (await createMessageRepository()).listByConversation({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    contactInboxId: input.contactInboxId,
    sinceTime: new Date(Date.now() - MEMBER_EVIDENCE_LOOKBACK_MS),
    pagination: { limit: 50 },
  })
  if (
    messages.data.some((entry) => {
      const identity = parseZaloAccountSourceId(entry.sourceId)
      const attributes = entry.contentAttributes?.zaloAccount as
        | {
            group?: { senderId?: string }
          }
        | undefined
      return (
        !entry.deletedAt &&
        entry.contactInboxId === input.contactInboxId &&
        identity?.accountId === account.id &&
        identity.threadType === "group" &&
        identity.threadId === group.providerGroupId &&
        attributes?.group?.senderId === providerUid
      )
    })
  ) {
    return true
  }
  const roster = await zaloAccountCommandTransportService
    .getGroupMembersAndWait({
      workspaceId: input.workspaceId,
      accountId: account.id,
      inboxId: account.inboxId,
      commandId: createId(),
      ttlMs: 8000,
      waitTimeoutMs: 4000,
      groupId: group.providerGroupId,
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
      groupMemberQuery: { query: providerUid, limit: 20 },
    })
    .catch(() => null)
  return roster?.members.some(({ uid }) => uid === providerUid) ?? false
}

function isFresh(observedAt: Date | null | undefined) {
  return !!observedAt && Date.now() - observedAt.getTime() < REFRESH_TTL_MS
}

function project(row: ZaloAccountUserProfileModel | null, group: boolean) {
  const fields: Partial<
    Record<ZaloAccountProfileField, string | number | boolean>
  > = {}
  for (const key of row?.visibleFields ?? []) {
    const value = row?.fields[key]?.value
    if (key !== "globalId" && !(group && key === "publicPhone")) {
      fields[key] = value
    }
  }
  if (!(row && Object.values(fields).some((value) => value !== undefined))) {
    return { profile: null, staleness: "unavailable" as const }
  }
  const primaryObservation = row.detailObservedAt ?? row.observedAt
  return {
    profile: { uid: row.providerUid, fields },
    observedAt: primaryObservation.getTime(),
    staleness: isFresh(row.detailObservedAt)
      ? ("fresh" as const)
      : ("stale" as const),
  }
}

async function refreshProfile(
  scope: ProfileScope,
  inboxId: string,
  largeAvatar: boolean,
) {
  const lockKey = `zalo-account:profile:${await sha256Hex(JSON.stringify([scope.workspaceId, scope.accountId, scope.providerUid]))}`
  try {
    return await distributedLock.runExclusive({
      key: lockKey,
      timeoutInSeconds: 15,
      retryTimeoutInSeconds: 2,
      fn: async () => {
        const saved = await zaloAccountUserProfileRepository.find(scope)
        const latest = largeAvatar
          ? saved?.largeAvatarObservedAt
          : saved?.detailObservedAt
        if (isFresh(latest)) {
          return saved
        }
        const response = await zaloAccountCommandTransportService
          .readProfilesAndWait({
            workspaceId: scope.workspaceId,
            accountId: scope.accountId,
            inboxId,
            commandId: createId(),
            profileQuery: {
              uids: [scope.providerUid],
              ...(largeAvatar ? { largeAvatar } : {}),
            },
            ttlMs: 10_000,
            waitTimeoutMs: 5000,
          })
          .catch(() => [])
        const match = response.find(
          (candidate) => candidate.uid === scope.providerUid,
        )
        const snapshot = zaloAccountProfileSchema.safeParse(match)
        if (!snapshot.success) {
          return saved
        }
        const observationTimes = Object.values(snapshot.data.fields).map(
          (field) => field?.observedAt ?? 0,
        )
        const observedAt = new Date(
          observationTimes.length
            ? Math.min(Date.now(), Math.max(...observationTimes))
            : Date.now(),
        )
        const [current] = await zaloAccountUserProfileRepository.observe({
          ...scope,
          inboxId,
          profiles: [snapshot.data],
          detail: true,
          largeAvatar,
          observedAt,
        })
        if (largeAvatar && current) {
          const avatar =
            current.visibleFields.includes("avatarUrl") &&
            current.fields.avatarUrl?.value
          const cover =
            current.visibleFields.includes("coverUrl") &&
            current.fields.coverUrl?.value
          await captureZaloAccountResourceMedia({
            workspaceId: scope.workspaceId,
            accountId: scope.accountId,
            resources: [
              {
                ownerKind: "contact",
                ownerId: scope.providerUid,
                avatarUrl: typeof avatar === "string" ? avatar : undefined,
                coverUrl: typeof cover === "string" ? cover : undefined,
                coverConsumed: true,
              },
            ],
          })
        }
        return current ?? null
      },
    })
  } catch (error) {
    if (isLockAcquisitionError(error, lockKey)) {
      return await zaloAccountUserProfileRepository.find(scope)
    }
    throw error
  }
}

export const zaloAccountProfileService = {
  async get(input: ProfileInput) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    const anchor =
      account &&
      (await zaloAccountSendAttemptRepository.preparedContext({
        workspaceId: input.workspaceId,
        inboxId: account.inboxId,
        conversationId: input.conversationId,
        contactInboxId: input.contactInboxId,
      }))
    if (!account || anchor?.contactInbox.channel !== "zaloAccount") {
      throw unavailable()
    }
    const group = anchor.contactInbox.contactKind === "channelGroup"
    const uid = zaloAccountProfileSchema.shape.uid.safeParse(
      group ? input.memberUid : anchor.contactInbox.sourceId,
    )
    if (
      !uid.success ||
      uid.data === "0" ||
      uid.data === account.zaloUid ||
      (!group &&
        (anchor.contactInbox.contactKind !== "person" ||
          (input.memberUid !== undefined && input.memberUid !== uid.data))) ||
      (group && !(await verifyMember(input, uid.data, account)))
    ) {
      throw unavailable()
    }
    const scope = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerUid: uid.data,
    }
    const saved = await zaloAccountUserProfileRepository.find(scope)
    const latest = input.largeAvatar
      ? saved?.largeAvatarObservedAt
      : saved?.detailObservedAt
    return project(
      input.refresh === false || isFresh(latest)
        ? saved
        : await refreshProfile(scope, account.inboxId, !!input.largeAvatar),
      group,
    )
  },
}
