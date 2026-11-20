import { channelTypes } from "@chatbotx.io/database/partials"
import {
  contactInboxRepository,
  integrationZaloAccountGroupRepository,
  tagChannelRepository,
} from "@chatbotx.io/database/repositories"
import type {
  ZaloAccountLabel,
  ZaloAccountLabelSnapshot,
} from "@chatbotx.io/sdk"
import { notFoundException } from "../errors"
import { tagService } from "../tag/service"
import { tagSyncService } from "../tag/sync.service"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

const CONTACT_CHUNK_SIZE = 500
const ASSIGNMENT_PAGE_SIZE = 500

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

const readSnapshot = async (input: {
  workspaceId: string
  accountId: string
  inboxId: string
  commandId: string
}): Promise<ZaloAccountLabelSnapshot> =>
  await zaloAccountCommandTransportService.getLabelsAndWait({
    ...input,
    ttlMs: 60_000,
    waitTimeoutMs: 30_000,
  })

const resolveDirectInboxes = async (input: {
  inboxId: string
  sourceIds: string[]
  excludedGroupIds: Set<string>
}) => {
  const sourceIds = [
    ...new Set(
      input.sourceIds.filter(
        (sourceId) => !input.excludedGroupIds.has(sourceId),
      ),
    ),
  ]
  const rows: Awaited<
    ReturnType<typeof contactInboxRepository.listIdsByInboxAndSourceIds>
  > = []
  for (let index = 0; index < sourceIds.length; index += CONTACT_CHUNK_SIZE) {
    rows.push(
      ...(await contactInboxRepository.listIdsByInboxAndSourceIds({
        inboxId: input.inboxId,
        sourceIds: sourceIds.slice(index, index + CONTACT_CHUNK_SIZE),
      })),
    )
  }
  return rows
}

const listAssignmentIds = async (tagChannelId: string): Promise<string[]> => {
  const ids: string[] = []
  let afterContactInboxId: string | undefined
  while (true) {
    const page = await tagChannelRepository.listContactInboxIdsForChannelPage({
      tagChannelId,
      ...(afterContactInboxId ? { afterContactInboxId } : {}),
      limit: ASSIGNMENT_PAGE_SIZE,
    })
    ids.push(...page.map((row) => row.contactInboxId))
    if (page.length < ASSIGNMENT_PAGE_SIZE) {
      return ids
    }
    afterContactInboxId = page.at(-1)?.contactInboxId
  }
}

const reconcileLabel = async (input: {
  workspaceId: string
  accountId: string
  inboxId: string
  label: ZaloAccountLabel
  excludedGroupIds: Set<string>
}): Promise<void> => {
  const externalLabelId = String(input.label.id)
  let mapping = await tagService.findTagChannel({
    workspaceId: input.workspaceId,
    channelType: channelTypes.enum.zaloAccount,
    integrationId: input.accountId,
    externalLabelId,
  })
  if (mapping) {
    const tag = await tagService.findById({
      workspaceId: input.workspaceId,
      id: mapping.tagId,
    })
    if (tag && tag.name !== input.label.text) {
      await tagService.syncNameFromChannel({
        workspaceId: input.workspaceId,
        id: tag.id,
        name: input.label.text,
      })
    }
  } else {
    const tagId = await tagService.ensureTagByName({
      workspaceId: input.workspaceId,
      name: input.label.text,
    })
    if (!tagId) {
      return
    }
    const tagChannelId = await tagService.ensureTagChannel({
      workspaceId: input.workspaceId,
      tagId,
      channelType: channelTypes.enum.zaloAccount,
      integrationId: input.accountId,
      externalLabelId,
    })
    if (!tagChannelId) {
      return
    }
    mapping = { id: tagChannelId, tagId }
  }

  const inboxes = await resolveDirectInboxes({
    inboxId: input.inboxId,
    sourceIds: input.label.conversations,
    excludedGroupIds: input.excludedGroupIds,
  })
  await tagService.linkTagToContactsReturningNewUnscoped({
    tagId: mapping.tagId,
    contactIds: [...new Set(inboxes.map((inbox) => inbox.contactId))],
  })
  await tagService.recordTagChannelAssignmentsUnscoped({
    tagId: mapping.tagId,
    tagChannelId: mapping.id,
    contactInboxIds: inboxes.map((inbox) => inbox.id),
  })

  const desiredIds = new Set(inboxes.map((inbox) => inbox.id))
  const removedIds = (await listAssignmentIds(mapping.id)).filter(
    (contactInboxId) => !desiredIds.has(contactInboxId),
  )
  if (removedIds.length === 0) {
    return
  }
  await tagService.deleteTagChannelAssignmentsUnscoped({
    tagChannelId: mapping.id,
    contactInboxIds: removedIds,
  })
  const removedContacts = await contactInboxRepository.listContactIdsByIds({
    ids: removedIds,
  })
  await tagService.detachTagFromContactsUnscoped({
    tagId: mapping.tagId,
    contactIds: [
      ...new Set(removedContacts.map((contact) => contact.contactId)),
    ],
  })
}

const persistAcceptedAssignment = async (
  input: {
    contactInboxId: string
    tagId: string
    assigned: boolean
  },
  tagChannelId: string,
): Promise<void> => {
  if (input.assigned) {
    await tagSyncService.linkContactInbox({
      tagId: input.tagId,
      tagChannelId,
      contactInboxId: input.contactInboxId,
    })
    return
  }
  await tagSyncService.unlinkContactInbox({
    tagChannelId,
    contactInboxId: input.contactInboxId,
  })
}

export const zaloAccountLabelService = {
  async sync(input: {
    workspaceId: string
    accountId: string
    commandId: string
  }): Promise<{
    version: number
    labelCount: number
    destructiveDiffApplied: boolean
  }> {
    const account = await requireAccount(input)
    const snapshot = await readSnapshot({
      ...input,
      inboxId: account.inboxId,
    })
    if (snapshot.labelData.length === 0) {
      return {
        version: snapshot.version,
        labelCount: 0,
        destructiveDiffApplied: false,
      }
    }

    const groups = await integrationZaloAccountGroupRepository.list(input)
    const excludedGroupIds = new Set(
      groups.map((group) => group.providerGroupId),
    )
    const providerLabelIds = new Set(
      snapshot.labelData.map((label) => String(label.id)),
    )
    for (const label of snapshot.labelData) {
      await reconcileLabel({
        ...input,
        inboxId: account.inboxId,
        label,
        excludedGroupIds,
      })
    }

    const mappings = await tagChannelRepository.listByIntegration({
      workspaceId: input.workspaceId,
      channelType: channelTypes.enum.zaloAccount,
      integrationId: input.accountId,
    })
    for (const mapping of mappings) {
      if (!providerLabelIds.has(mapping.externalLabelId)) {
        await tagSyncService.enqueueDelete({
          workspaceId: input.workspaceId,
          tagId: mapping.tagId,
          channelType: channelTypes.enum.zaloAccount,
          integrationId: input.accountId,
        })
      }
    }
    return {
      version: snapshot.version,
      labelCount: snapshot.labelData.length,
      destructiveDiffApplied: true,
    }
  },

  async mutateAssignment(input: {
    workspaceId: string
    accountId: string
    contactInboxId: string
    sourceId: string
    tagId: string
    assigned: boolean
    commandId: string
  }): Promise<boolean> {
    const account = await requireAccount(input)
    const [ownedInbox] =
      await contactInboxRepository.listIdsByInboxAndSourceIds({
        inboxId: account.inboxId,
        sourceIds: [input.sourceId],
      })
    if (!ownedInbox || ownedInbox.id !== input.contactInboxId) {
      throw notFoundException("Zalo Account contact Inbox not found")
    }
    const mapping = await tagChannelRepository.findByTagAndIntegration({
      workspaceId: input.workspaceId,
      tagId: input.tagId,
      channelType: channelTypes.enum.zaloAccount,
      integrationId: input.accountId,
    })
    if (!mapping) {
      return false
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await readSnapshot({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: account.inboxId,
        commandId: `${input.commandId}:read:${attempt}`,
      })
      const target = snapshot.labelData.find(
        (label) => String(label.id) === mapping.externalLabelId,
      )
      if (!target) {
        return false
      }
      const conversations = new Set(target.conversations)
      if (input.assigned) {
        conversations.add(input.sourceId)
      } else {
        conversations.delete(input.sourceId)
      }
      if (conversations.size === target.conversations.length) {
        await persistAcceptedAssignment(input, mapping.id)
        return true
      }
      const labelData = snapshot.labelData.map((label) =>
        label.id === target.id
          ? { ...label, conversations: [...conversations] }
          : label,
      )
      try {
        await zaloAccountCommandTransportService.updateLabelsAndWait({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          inboxId: account.inboxId,
          commandId: `${input.commandId}:write:${attempt}`,
          expectedVersion: snapshot.version,
          labelData,
          ttlMs: 60_000,
          waitTimeoutMs: 30_000,
        })
        await persistAcceptedAssignment(input, mapping.id)
        return true
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof Error &&
          error.message.includes("label version conflict")
        ) {
          continue
        }
        throw error
      }
    }
    return false
  },
}
