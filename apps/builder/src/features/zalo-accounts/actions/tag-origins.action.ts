"use server"

import { contactInboxService, tagService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import {
  zaloAccountLabelService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"

export const listZaloDirectTagOriginsAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(
    z.object({
      conversationId: zodBigintAsString(),
      contactInboxId: zodBigintAsString(),
    }),
  )
  .action(async ({ bindArgsParsedInputs: [workspaceId], ctx, parsedInput }) => {
    const conversation = await assertConversationAccessForCaller(
      { workspace: ctx.workspace, member: ctx.workspaceMember, user: ctx.user },
      parsedInput.conversationId,
    )
    const inbox = await contactInboxService.findByIdForWorkspace({
      workspaceId,
      id: parsedInput.contactInboxId,
    })
    if (
      inbox?.channel !== "zaloAccount" ||
      inbox.contactKind !== "person" ||
      inbox.contactId !== conversation.contactId
    ) {
      throw notFoundException("Zalo Account contact inbox not found")
    }
    const account = await zaloAccountService.findByInboxId({
      workspaceId,
      inboxId: inbox.inboxId,
    })
    if (!account) {
      throw notFoundException("Zalo Account contact inbox not found")
    }
    const tags = await tagService.listForContact({
      workspaceId,
      contactId: inbox.contactId,
    })
    return await zaloAccountLabelService.listMappedTagIds({
      workspaceId,
      accountId: account.id,
      tagIds: tags.map((tag) => tag.id),
    })
  })
