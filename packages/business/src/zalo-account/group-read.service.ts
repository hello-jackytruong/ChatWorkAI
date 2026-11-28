import { integrationZaloAccountGroupRepository } from "@chatbotx.io/database/repositories"
import type { IntegrationZaloAccountGroupModel } from "@chatbotx.io/database/types"
import {
  type ZaloAccountGroupAdministrationRead,
  type ZaloAccountGroupAdministrationResult,
  ZaloAccountPreDispatchError,
  zaloAccountGroupAdministrationReadSchema,
  zaloAccountGroupRosterQuerySchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { notFoundException } from "../errors"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type GroupScope = { workspaceId: string; accountId: string; groupId: string }
type Account = NonNullable<
  Awaited<ReturnType<typeof zaloAccountService.findById>>
>
type Group = IntegrationZaloAccountGroupModel

const readsInProgress = new Map<
  string,
  Promise<ZaloAccountGroupAdministrationResult>
>()

async function resolveGroup(input: GroupScope) {
  const { workspaceId, accountId, groupId } = input
  const account = await zaloAccountService.findById({
    workspaceId,
    id: accountId,
  })
  const group =
    account &&
    (await integrationZaloAccountGroupRepository.find({
      workspaceId,
      accountId,
      id: groupId,
    }))
  if (!(account && group)) {
    throw notFoundException("Zalo Account group not found")
  }
  return { account, group }
}

async function readProviderGroup(
  account: Account,
  group: Group,
  groupRead: ZaloAccountGroupAdministrationRead,
) {
  const key = JSON.stringify([
    account.workspaceId,
    account.id,
    group.id,
    account.groupPolicyEpoch,
    group.policyEpoch,
    group.providerVersion,
    group.nativeMetadataAt,
    groupRead,
  ])
  const inProgress = readsInProgress.get(key)
  if (inProgress) {
    return await inProgress
  }
  const pending =
    zaloAccountCommandTransportService.readGroupAdministrationAndWait({
      workspaceId: account.workspaceId,
      accountId: account.id,
      inboxId: account.inboxId,
      commandId: createId(),
      ttlMs: 10_000,
      waitTimeoutMs: 5000,
      groupId: group.providerGroupId,
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
      groupRead,
    })
  readsInProgress.set(key, pending)
  try {
    return await pending
  } finally {
    readsInProgress.delete(key)
  }
}

function storedOverview(group: Group) {
  const details = group.accessible ? group.nativeDetails : null
  return {
    groupId: group.id,
    name: group.name,
    accessible: group.accessible,
    role: "unknown" as const,
    memberCount: group.memberCount,
    ...(details?.type ? { type: details.type } : {}),
    ...(details?.description === undefined
      ? {}
      : { description: details.description }),
  }
}

export const zaloAccountGroupReadService = {
  async admit(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
    accountPolicyEpoch: number
    groupPolicyEpoch: number
  }): Promise<void> {
    const { workspaceId, accountId, providerGroupId } = input
    const account = await zaloAccountService.findById({
      workspaceId,
      id: accountId,
    })
    if (
      account?.inboxId !== input.inboxId ||
      account.groupPolicyEpoch !== input.accountPolicyEpoch
    ) {
      throw new ZaloAccountPreDispatchError(
        "This Zalo group read is no longer authorized",
      )
    }
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId,
      accountId,
      providerGroupId,
    })
    if (!group?.accessible || group.policyEpoch !== input.groupPolicyEpoch) {
      throw new ZaloAccountPreDispatchError(
        "This Zalo group read is no longer authorized",
      )
    }
  },

  async overview(input: GroupScope) {
    const { account, group } = await resolveGroup(input)
    if (!group.accessible) {
      return storedOverview(group)
    }
    const requestedAt = new Date()
    const result = await readProviderGroup(account, group, {
      kind: "overview",
    }).catch(() => null)
    if (result?.kind !== "overview") {
      return storedOverview((await resolveGroup(input)).group)
    }
    const { overview } = result
    if (overview.accessible && overview.observedAt) {
      const stored =
        await integrationZaloAccountGroupRepository.storeNativeOverview({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          id: group.id,
          policyEpoch: group.policyEpoch,
          requestedAt,
          overview: { ...overview, observedAt: overview.observedAt },
        })
      if (!stored) {
        const { group: current } = await resolveGroup(input)
        if (
          !current.accessible ||
          current.nativeDetails?.observedAt !== overview.observedAt
        ) {
          return storedOverview(current)
        }
      }
    }
    return { ...overview, groupId: group.id }
  },

  async members(input: GroupScope & { cursor?: string; limit?: number }) {
    const query = zaloAccountGroupRosterQuerySchema.parse({
      cursor: input.cursor,
      limit: input.limit,
    })
    const { account, group } = await resolveGroup(input)
    if (!group.accessible) {
      throw notFoundException("Accessible Zalo Account group not found")
    }
    const result = await readProviderGroup(account, group, {
      kind: "members",
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit ?? 20,
    })
    if (result.kind !== "members") {
      throw new Error("Zalo Account group roster unavailable")
    }
    return result
  },

  async related(input: GroupScope & { uid: string }) {
    const groupRead = zaloAccountGroupAdministrationReadSchema.parse({
      kind: "related",
      uid: input.uid,
    })
    const { account, group } = await resolveGroup(input)
    if (!group.accessible) {
      throw notFoundException("Accessible Zalo Account group not found")
    }
    const result = await readProviderGroup(account, group, groupRead).catch(
      () => null,
    )
    if (result?.kind !== "related") {
      return { groups: [], complete: false }
    }
    const providerGroupIds = [...new Set(result.providerGroupIds)].filter(
      (id) => id !== group.providerGroupId,
    )
    const groups =
      await integrationZaloAccountGroupRepository.listAccessibleByProviderIds({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerGroupIds,
      })
    return {
      groups: groups.map(({ id, name }) => ({ groupId: id, name })),
      complete: result.complete && groups.length === providerGroupIds.length,
    }
  },
}
