import { db } from "@chatbotx.io/database/client"
import {
  flowRepository,
  integrationZaloAccountGroupRepository,
  integrationZaloAccountRepository,
} from "@chatbotx.io/database/repositories"
import type { IntegrationZaloAccountGroupModel } from "@chatbotx.io/database/types"
import type {
  ZaloAccountGroupAudience,
  ZaloAccountOutboundMessage,
  ZaloAccountSendResult,
} from "@chatbotx.io/sdk"
import {
  SdkException,
  ZaloAccountPreDispatchError,
  zaloAccountGroupMembersQuerySchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import { notFoundException } from "../errors"
import { captureZaloAccountResourceMedia } from "../zalo-account-media/resource-capture"
import { scopedZaloCommandId } from "./command-identity"
import { isAllowedGroupFlow } from "./group-policy"
import { takeGroupSendCapacity } from "./group-rate-limit"
import { zaloAccountSendAttemptService } from "./send-attempt.service"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

const requireAccount = async (input: {
  workspaceId: string
  accountId: string
}) => {
  const account = await zaloAccountService.findById({
    workspaceId: input.workspaceId,
    id: input.accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account connection not found")
  }
  return account
}

export const zaloAccountGroupService = {
  async requireInboxAccess(input: {
    workspaceId: string
    accountId: string
    id: string
    restrictToAssignedUserId?: string
    restrictToTeamIds?: string[]
  }) {
    if (!(await integrationZaloAccountGroupRepository.canAccessInbox(input))) {
      throw notFoundException("Zalo group conversation not found")
    }
    return await this.get(input)
  },
  async sendTyping(input: {
    workspaceId: string
    accountId: string
    providerGroupId: string
    commandId: string
  }): Promise<void> {
    const account = await requireAccount(input)
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerGroupId: input.providerGroupId,
    })
    if (
      !(account.groupMessagingEnabled && group?.accessible && group.sendEnabled)
    ) {
      return
    }
    await zaloAccountCommandTransportService.sendTyping({
      ...input,
      inboxId: account.inboxId,
      threadId: group.providerGroupId,
      threadType: "group",
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
      ttlMs: 5000,
    })
  },
  async canRunFlow(input: {
    workspaceId: string
    flowId: string
  }): Promise<boolean> {
    return isAllowedGroupFlow(
      await flowRepository.findCurrentVersionNodes(input),
    )
  },
  async admitSend(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
    accountPolicyEpoch: number
    groupPolicyEpoch: number
    consumeCapacity?: boolean
  }) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerGroupId: input.providerGroupId,
    })
    if (
      !account?.groupMessagingEnabled ||
      account.inboxId !== input.inboxId ||
      account.groupPolicyEpoch !== input.accountPolicyEpoch ||
      !group?.accessible ||
      !group.sendEnabled ||
      group.nativeDetails?.capabilities?.sendMessages === false ||
      group.policyEpoch !== input.groupPolicyEpoch
    ) {
      throw new ZaloAccountPreDispatchError("Zalo Account group policy changed")
    }
    if (input.consumeCapacity === false) {
      return
    }
    try {
      await takeGroupSendCapacity(input)
    } catch (err) {
      if (err instanceof ZaloAccountPreDispatchError) {
        throw err
      }
      throw new ZaloAccountPreDispatchError(
        "Zalo Account group admission is unavailable",
      )
    }
  },
  async createAudience(input: {
    workspaceId: string
    contactInboxId: string
    conversationId: string
    origin: ZaloAccountGroupAudience["origin"]
  }): Promise<ZaloAccountGroupAudience | null> {
    const group = await integrationZaloAccountGroupRepository.findByAnchor({
      workspaceId: input.workspaceId,
      contactInboxId: input.contactInboxId,
      conversationId: input.conversationId,
    })
    if (!group?.accessible) {
      return null
    }
    const account = await requireAccount({
      workspaceId: input.workspaceId,
      accountId: group.accountId,
    })
    if (
      !account.groupMessagingEnabled ||
      (input.origin === "automation"
        ? !group.receiveEnabled || group.automationMode === "disabled"
        : !group.sendEnabled)
    ) {
      return null
    }
    return {
      kind: "zaloAccountGroup",
      ...input,
      accountId: account.id,
      groupId: group.id,
      providerGroupId: group.providerGroupId,
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
    }
  },
  async validateAudience(audience: ZaloAccountGroupAudience): Promise<boolean> {
    const current = await this.createAudience(audience)
    return (
      !!current &&
      current.accountId === audience.accountId &&
      current.groupId === audience.groupId &&
      current.providerGroupId === audience.providerGroupId &&
      current.groupPolicyEpoch === audience.groupPolicyEpoch &&
      current.accountPolicyEpoch === audience.accountPolicyEpoch
    )
  },
  async setGroupMessaging(input: {
    workspaceId: string
    accountId: string
    enabled: boolean
  }) {
    await requireAccount(input)
    await integrationZaloAccountRepository.setGroupMessaging({
      workspaceId: input.workspaceId,
      id: input.accountId,
      enabled: input.enabled,
    })
    await dispatchAuditRecordSafely(
      {
        workspaceId: input.workspaceId,
        action: "zaloAccount.groupMessaging",
        detail: JSON.stringify({
          accountId: input.accountId,
          enabled: input.enabled,
        }),
      },
      "Could not audit Zalo group policy",
    )
    return await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
  },
  async sendByProviderId(input: {
    workspaceId: string
    accountId: string
    providerGroupId: string
    commandId: string
    message: Omit<ZaloAccountOutboundMessage, "recipientId">
    origin?: "inbox" | "flow" | "api"
    localMessage?: { id: string; createdAt: Date }
    audience?: ZaloAccountGroupAudience
  }) {
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerGroupId: input.providerGroupId,
    })
    if (!group) {
      throw notFoundException("Zalo Account group not found")
    }
    return await this.send({ ...input, groupId: group.id })
  },
  async resolveReceivePolicy(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
    allowSendOnly?: boolean
    inboundRuntime?: { epoch: number; fenceToken: string }
  }) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account?.groupMessagingEnabled || account.inboxId !== input.inboxId) {
      return null
    }
    let group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerGroupId: input.providerGroupId,
    })
    if (
      !(
        group?.accessible &&
        (group.receiveEnabled || (input.allowSendOnly && group.sendEnabled))
      )
    ) {
      return null
    }
    const { inboundRuntime } = input
    if (
      inboundRuntime &&
      group.receiveEnabled &&
      !(group.contactInboxId && group.conversationId)
    ) {
      const id = group.id
      group =
        (await integrationZaloAccountRepository.withRuntimeAccount(
          {
            workspaceId: input.workspaceId,
            id: account.id,
            inboxId: account.inboxId,
          },
          async (tx, current) => {
            const runtime = current.operations?.runtime
            if (
              !current.groupMessagingEnabled ||
              current.groupPolicyEpoch !== account.groupPolicyEpoch ||
              runtime?.state !== "connected" ||
              runtime.epoch !== inboundRuntime.epoch ||
              runtime.fenceToken !== inboundRuntime.fenceToken
            ) {
              return null
            }
            return await integrationZaloAccountGroupRepository.updateInboxPolicy(
              {
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                inboxId: input.inboxId,
                id,
                ensureInbox: "receive",
              },
              tx,
            )
          },
        )) || undefined
    }
    if (!(group?.contactInboxId && group.conversationId)) {
      return null
    }
    return {
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
    }
  },
  async ensureSendInbox(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    id: string
  }) {
    const groupId = input.id
    const result = await integrationZaloAccountRepository.withRuntimeAccount(
      {
        workspaceId: input.workspaceId,
        id: input.accountId,
        inboxId: input.inboxId,
      },
      async (tx, account) => {
        if (!account.groupMessagingEnabled) {
          return null
        }
        return await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...input, id: groupId, ensureInbox: "send" },
          tx,
        )
      },
    )
    return result || null
  },
  async updateInboxPolicy(input: {
    workspaceId: string
    accountId: string
    id: string
    receiveEnabled?: boolean
    sendEnabled?: boolean
    automationMode?: "disabled" | "mentionOnly" | "all"
  }): Promise<IntegrationZaloAccountGroupModel> {
    const account = await requireAccount(input)
    const group = await db.transaction(
      async (tx) =>
        await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...input, inboxId: account.inboxId },
          tx,
        ),
    )
    if (!group) {
      throw notFoundException("Accessible Zalo Account group not found")
    }
    await dispatchAuditRecordSafely(
      {
        workspaceId: input.workspaceId,
        action: "zaloAccount.groupPolicy",
        detail: JSON.stringify({
          accountId: input.accountId,
          groupId: group.id,
          receiveEnabled: group.receiveEnabled,
          sendEnabled: group.sendEnabled,
          automationMode: group.automationMode,
          policyEpoch: group.policyEpoch,
        }),
      },
      "Could not audit Zalo group policy",
    )
    return group
  },
  async list(input: {
    workspaceId: string
    accountId: string
    receiveEnabled?: boolean
    sendEnabled?: boolean
    accessible?: boolean
    automationMode?: "disabled" | "mentionOnly" | "all"
  }): Promise<IntegrationZaloAccountGroupModel[]> {
    await requireAccount(input)
    return (await integrationZaloAccountGroupRepository.list(input)).filter(
      (group) =>
        (input.receiveEnabled === undefined ||
          group.receiveEnabled === input.receiveEnabled) &&
        (input.sendEnabled === undefined ||
          group.sendEnabled === input.sendEnabled) &&
        (input.accessible === undefined ||
          group.accessible === input.accessible) &&
        (input.automationMode === undefined ||
          group.automationMode === input.automationMode),
    )
  },

  async get(input: {
    workspaceId: string
    accountId: string
    id: string
  }): Promise<IntegrationZaloAccountGroupModel> {
    await requireAccount(input)
    const group = await integrationZaloAccountGroupRepository.find(input)
    if (!group) {
      throw notFoundException("Zalo Account group not found")
    }
    return group
  },

  async listMembers(input: {
    workspaceId: string
    accountId: string
    groupId: string
    conversationId: string
    query?: string
    limit?: number
  }) {
    const groupMemberQuery = zaloAccountGroupMembersQuerySchema.parse({
      query: input.query,
      limit: input.limit,
    })
    const account = await requireAccount(input)
    const group = await integrationZaloAccountGroupRepository.find({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      id: input.groupId,
    })
    if (
      !(
        account.groupMessagingEnabled &&
        group?.accessible &&
        group.sendEnabled &&
        group.contactInboxId
      ) ||
      group.conversationId !== input.conversationId
    ) {
      throw notFoundException("Zalo group conversation not found")
    }
    const result =
      await zaloAccountCommandTransportService.getGroupMembersAndWait({
        workspaceId: input.workspaceId,
        accountId: account.id,
        inboxId: account.inboxId,
        commandId: createId(),
        ttlMs: 10_000,
        waitTimeoutMs: 5000,
        groupId: group.providerGroupId,
        accountPolicyEpoch: account.groupPolicyEpoch,
        groupPolicyEpoch: group.policyEpoch,
        groupMemberQuery,
      })
    const members = result.members.filter(({ uid }) => uid !== account.zaloUid)
    return {
      members: members.slice(0, groupMemberQuery.limit),
      complete: result.complete && members.length <= groupMemberQuery.limit,
    }
  },

  async sync(input: {
    workspaceId: string
    accountId: string
    commandId: string
  }): Promise<IntegrationZaloAccountGroupModel[]> {
    const account = await requireAccount(input)
    const runId = createId()
    const syncStartedAt = new Date()
    await integrationZaloAccountRepository.beginGroupSync({
      workspaceId: input.workspaceId,
      id: input.accountId,
      runId,
      startedAt: syncStartedAt.toISOString(),
    })
    let snapshot: Awaited<
      ReturnType<typeof zaloAccountCommandTransportService.syncGroupsAndWait>
    >
    try {
      snapshot = await zaloAccountCommandTransportService.syncGroupsAndWait({
        commandId: await scopedZaloCommandId(
          { ...input, commandId: `${input.commandId}:${runId}` },
          "groups",
        ),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: account.inboxId,
        ttlMs: 60_000,
        waitTimeoutMs: 30_000,
      })
    } catch (error) {
      await integrationZaloAccountRepository.commitGroupSync(
        {
          workspaceId: input.workspaceId,
          id: input.accountId,
          runId,
          complete: false,
          count: 0,
          reason: "syncFailed",
        },
        async () => undefined,
      )
      throw error
    }
    const groups = Array.isArray(snapshot) ? snapshot : snapshot.groups
    const complete = !Array.isArray(snapshot) && snapshot.complete
    const syncedAt = new Date()
    await integrationZaloAccountRepository.commitGroupSync(
      {
        workspaceId: input.workspaceId,
        id: input.accountId,
        runId,
        complete,
        count: groups.length,
        reason: Array.isArray(snapshot) ? "legacy_unknown" : snapshot.reason,
      },
      async (tx) => {
        for (const group of groups) {
          await integrationZaloAccountGroupRepository.upsert(
            {
              id: createId(),
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              providerGroupId: group.providerGroupId,
              name: group.name,
              avatarUrl: group.avatarUrl ?? null,
              memberCount: group.memberCount,
              providerVersion: group.providerVersion ?? null,
              syncRunId: runId,
              syncStartedAt,
              syncedAt,
            },
            tx,
          )
        }
        await captureZaloAccountResourceMedia({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          tx,
          resources: groups.map((group) => ({
            ownerKind: "group",
            ownerId: group.providerGroupId,
            avatarUrl: group.avatarUrl,
          })),
        })
        if (complete) {
          await integrationZaloAccountGroupRepository.finishCompleteSync(
            {
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              syncRunId: runId,
              syncStartedAt,
              observedProviderGroupIds: groups.map(
                (group) => group.providerGroupId,
              ),
              syncedAt,
            },
            tx,
          )
        }
      },
    )
    return await integrationZaloAccountGroupRepository.list(input)
  },

  async updatePolicy(input: {
    workspaceId: string
    accountId: string
    id: string
    sendEnabled: boolean
  }): Promise<IntegrationZaloAccountGroupModel> {
    return await this.updateInboxPolicy(input)
  },

  async send(input: {
    workspaceId: string
    accountId: string
    groupId: string
    commandId: string
    message: Omit<ZaloAccountOutboundMessage, "recipientId">
    origin?: "inbox" | "flow" | "api"
    localMessage?: { id: string; createdAt: Date }
    audience?: ZaloAccountGroupAudience
  }): Promise<ZaloAccountSendResult> {
    const account = await requireAccount(input)
    const group = await integrationZaloAccountGroupRepository.find({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      id: input.groupId,
    })
    if (!group) {
      throw notFoundException("Zalo Account group not found")
    }
    if (
      !(account.groupMessagingEnabled && group.accessible && group.sendEnabled)
    ) {
      throw new SdkException("Zalo Account group sending is disabled")
    }
    if (
      input.audience &&
      (input.audience.workspaceId !== input.workspaceId ||
        input.audience.accountId !== account.id ||
        input.audience.groupId !== group.id ||
        input.audience.providerGroupId !== group.providerGroupId ||
        input.audience.accountPolicyEpoch !== account.groupPolicyEpoch ||
        input.audience.groupPolicyEpoch !== group.policyEpoch)
    ) {
      throw new ZaloAccountPreDispatchError("Zalo Account group policy changed")
    }
    return await zaloAccountSendAttemptService.send(
      {
        ...input,
        threadType: "group",
        threadId: group.providerGroupId,
        origin: input.origin ?? "api",
        accountPolicyEpoch: account.groupPolicyEpoch,
        groupPolicyEpoch: group.policyEpoch,
        message: { ...input.message, recipientId: group.providerGroupId },
      },
      async (commandId) =>
        await zaloAccountCommandTransportService.sendGroupAndWait({
          commandId,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          inboxId: account.inboxId,
          groupId: group.providerGroupId,
          accountPolicyEpoch: account.groupPolicyEpoch,
          groupPolicyEpoch: group.policyEpoch,
          ttlMs: 60_000,
          waitTimeoutMs: 30_000,
          message: { ...input.message, recipientId: group.providerGroupId },
        }),
    )
  },
}
