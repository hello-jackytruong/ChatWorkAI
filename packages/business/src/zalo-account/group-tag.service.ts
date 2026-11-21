import { contactInboxRepository } from "@chatbotx.io/database/repositories"
import type { ZaloAccountGroupAudience } from "@chatbotx.io/sdk"
import { notFoundException, validationException } from "../errors"
import { tagService } from "../tag/service"
import { tagSyncService } from "../tag/sync.service"
import { zaloAccountGroupService } from "./group.service"

export const zaloAccountGroupTagService = {
  async list(input: {
    workspaceId: string
    accountId: string
    groupId: string
  }) {
    const group = await zaloAccountGroupService.get({
      ...input,
      id: input.groupId,
    })
    if (!group.contactInboxId) {
      throw notFoundException("Group Inbox anchor not found")
    }
    const anchor = await contactInboxRepository.findFullByIdForWorkspace({
      workspaceId: input.workspaceId,
      id: group.contactInboxId,
    })
    if (anchor?.contactKind !== "channelGroup") {
      throw notFoundException("Group Inbox anchor not found")
    }
    return (
      await tagService.listByContactId({ contactId: anchor.contactId })
    ).map((tag) => ({ id: tag.id, name: tag.name }))
  },
  async update(input: {
    workspaceId: string
    accountId: string
    groupId: string
    names?: string[]
    tagIds?: string[]
    assigned: boolean
    audience?: ZaloAccountGroupAudience
  }): Promise<void> {
    const { audience } = input
    if (
      audience &&
      (audience.workspaceId !== input.workspaceId ||
        audience.accountId !== input.accountId ||
        audience.groupId !== input.groupId ||
        !(await zaloAccountGroupService.validateAudience(audience)))
    ) {
      throw notFoundException("Group audience is no longer active")
    }
    const group = await zaloAccountGroupService.get({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      id: input.groupId,
    })
    if (
      !(group.accessible && group.contactInboxId && group.conversationId) ||
      (audience &&
        (audience.contactInboxId !== group.contactInboxId ||
          audience.conversationId !== group.conversationId))
    ) {
      throw notFoundException("Group Inbox anchor not found")
    }
    const anchor = await contactInboxRepository.findFullByIdForWorkspace({
      workspaceId: input.workspaceId,
      id: group.contactInboxId,
    })
    if (anchor?.contactKind !== "channelGroup") {
      throw notFoundException("Group Inbox anchor not found")
    }
    const names = [
      ...new Set(
        (input.names ?? []).map((name) => name.trim()).filter(Boolean),
      ),
    ]
    if (
      names.length > 50 ||
      (input.tagIds?.length ?? 0) > 50 ||
      names.some((name) => name.length > 200)
    ) {
      throw validationException("names", "Too many or invalid group tags")
    }
    let tags: Array<{ id: string; name: string }> = []
    if (input.tagIds) {
      tags = await tagService.findManyByIds({
        workspaceId: input.workspaceId,
        ids: input.tagIds,
      })
    } else if (input.assigned) {
      tags = await tagService.upsertByNames({
        workspaceId: input.workspaceId,
        names,
      })
    }
    if (!(input.assigned || input.tagIds)) {
      for (const name of names) {
        const tag = await tagService.findByKey({
          workspaceId: input.workspaceId,
          key: name,
        })
        if (tag) {
          tags.push(tag)
        }
      }
    }
    for (const tag of tags) {
      const scope = {
        workspaceId: input.workspaceId,
        contactId: anchor.contactId,
        tagId: tag.id,
      }
      if (input.assigned) {
        await tagService.linkTagToContactsReturningNewUnscoped({
          tagId: tag.id,
          contactIds: [anchor.contactId],
        })
        await tagSyncService.enqueueAttach(scope)
      } else {
        await tagService.detachTagFromContactsUnscoped({
          tagId: tag.id,
          contactIds: [anchor.contactId],
        })
        await tagSyncService.enqueueDetach(scope)
      }
    }
  },
}
