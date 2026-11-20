import { integrationZaloAccountGroupRepository } from "@chatbotx.io/database/repositories"
import type { IntegrationZaloAccountGroupModel } from "@chatbotx.io/database/types"
import type { ZaloAccountOutboundMessage } from "@chatbotx.io/sdk"
import { SdkException } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { notFoundException } from "../errors"
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
  async list(input: {
    workspaceId: string
    accountId: string
  }): Promise<IntegrationZaloAccountGroupModel[]> {
    await requireAccount(input)
    return await integrationZaloAccountGroupRepository.list(input)
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

  async sync(input: {
    workspaceId: string
    accountId: string
    commandId: string
  }): Promise<IntegrationZaloAccountGroupModel[]> {
    const account = await requireAccount(input)
    const groups = await zaloAccountCommandTransportService.syncGroupsAndWait({
      commandId: input.commandId,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: account.inboxId,
      ttlMs: 60_000,
      waitTimeoutMs: 30_000,
    })
    const syncedAt = new Date()
    for (const group of groups) {
      await integrationZaloAccountGroupRepository.upsert({
        id: createId(),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerGroupId: group.providerGroupId,
        name: group.name,
        avatarUrl: group.avatarUrl ?? null,
        memberCount: group.memberCount,
        providerVersion: group.providerVersion ?? null,
        syncRunId: input.commandId,
        syncedAt,
      })
    }
    await integrationZaloAccountGroupRepository.finishCompleteSync({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      syncRunId: input.commandId,
      syncedAt,
    })
    return await integrationZaloAccountGroupRepository.list(input)
  },

  async updatePolicy(input: {
    workspaceId: string
    accountId: string
    id: string
    sendEnabled: boolean
  }): Promise<IntegrationZaloAccountGroupModel> {
    await requireAccount(input)
    const group =
      await integrationZaloAccountGroupRepository.updatePolicy(input)
    if (!group) {
      throw notFoundException("Accessible Zalo Account group not found")
    }
    return group
  },

  async send(input: {
    workspaceId: string
    accountId: string
    groupId: string
    commandId: string
    message: Omit<ZaloAccountOutboundMessage, "recipientId">
  }): Promise<{ messageIds: string[]; sentCount: number }> {
    const account = await requireAccount(input)
    const group = await integrationZaloAccountGroupRepository.find({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      id: input.groupId,
    })
    if (!group) {
      throw notFoundException("Zalo Account group not found")
    }
    if (!(group.accessible && group.sendEnabled)) {
      throw new SdkException("Zalo Account group sending is disabled")
    }
    return await zaloAccountCommandTransportService.sendGroupAndWait({
      commandId: input.commandId,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: account.inboxId,
      groupId: group.providerGroupId,
      ttlMs: 60_000,
      waitTimeoutMs: 30_000,
      message: { ...input.message, recipientId: group.providerGroupId },
    })
  },
}
