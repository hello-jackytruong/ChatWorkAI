"use server"

import { isWorkspaceScheduledForDeletion } from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  zaloAccountMessageOperationsService,
  zaloAccountMessageRecallService,
} from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  assertConversationAccessForCaller,
  conversationScopeForCaller,
} from "@/lib/public-api/member-scope"
import { workspaceActionClientAllowExpired } from "@/lib/safe-action"

const target = z.object({
  messageId: zodBigintAsString(),
  createdAt: z.coerce.date(),
})
const action = workspaceActionClientAllowExpired
  .use(async ({ ctx, next }) => {
    if (isWorkspaceScheduledForDeletion(ctx.workspace)) {
      throw new ChatbotXException(
        "Workspace deletion scheduled",
        "workspaceScheduledDeletion",
        403,
      )
    }
    return await next({ ctx })
  })
  .bindArgsSchemas([
    zodBigintAsString(),
    zodBigintAsString(),
    zodBigintAsString(),
  ])
export const getZaloSavedContentAction = action
  .inputSchema(target)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId, conversationId],
      parsedInput,
      ctx,
    }) => {
      const caller = {
        workspace: ctx.workspace,
        member: ctx.workspaceMember,
        user: ctx.user,
      }
      await assertConversationAccessForCaller(caller, conversationId)
      return await zaloAccountMessageRecallService.getSavedContent({
        workspaceId,
        accountId,
        conversationId,
        messageId: parsedInput.messageId,
        messageCreatedAt: parsedInput.createdAt,
        scope: await conversationScopeForCaller(caller),
        actorUserId: ctx.user.id,
      })
    },
  )
export const getZaloSavedAttachmentAction = action
  .inputSchema(target.extend({ attachmentId: z.string().min(1).max(200) }))
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId, conversationId],
      parsedInput,
      ctx,
    }) => {
      const caller = {
        workspace: ctx.workspace,
        member: ctx.workspaceMember,
        user: ctx.user,
      }
      await assertConversationAccessForCaller(caller, conversationId)
      return await zaloAccountMessageRecallService.getSavedAttachment({
        workspaceId,
        accountId,
        conversationId,
        messageId: parsedInput.messageId,
        messageCreatedAt: parsedInput.createdAt,
        attachmentId: parsedInput.attachmentId,
        scope: await conversationScopeForCaller(caller),
        actorUserId: ctx.user.id,
      })
    },
  )
export const getZaloMessageCapabilitiesAction = action
  .inputSchema(target)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId, conversationId],
      parsedInput,
      ctx,
    }) => {
      const caller = {
        workspace: ctx.workspace,
        member: ctx.workspaceMember,
        user: ctx.user,
      }
      await assertConversationAccessForCaller(caller, conversationId)
      return await zaloAccountMessageOperationsService.getCapabilities({
        workspaceId,
        accountId,
        conversationId,
        messageId: parsedInput.messageId,
        messageCreatedAt: parsedInput.createdAt,
        scope: await conversationScopeForCaller(caller),
      })
    },
  )
export const mutateZaloMessageAction = action
  .inputSchema(
    target.extend({
      operation: z.enum(["hide", "recall", "deleteOnZalo", "deleteChatOnZalo"]),
      commandId: z.string().min(1).max(200),
    }),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId, conversationId],
      parsedInput,
      ctx,
    }) => {
      const caller = {
        workspace: ctx.workspace,
        member: ctx.workspaceMember,
        user: ctx.user,
      }
      await assertConversationAccessForCaller(caller, conversationId)
      const scope = await conversationScopeForCaller(caller)
      const input = {
        workspaceId,
        accountId,
        conversationId,
        messageId: parsedInput.messageId,
        messageCreatedAt: parsedInput.createdAt,
        scope,
        commandId: parsedInput.commandId,
      }
      if (parsedInput.operation === "hide") {
        await zaloAccountMessageRecallService.hideLocally({
          ...input,
          actorUserId: ctx.user.id,
        })
        return { status: "applied" as const }
      }
      if (parsedInput.operation === "deleteChatOnZalo") {
        return await zaloAccountMessageOperationsService.deleteChatOnZalo({
          workspaceId,
          accountId,
          conversationId,
          boundaryMessageId: parsedInput.messageId,
          boundaryCreatedAt: parsedInput.createdAt,
          scope,
          commandId: parsedInput.commandId,
        })
      }
      return await zaloAccountMessageOperationsService[parsedInput.operation](
        input,
      )
    },
  )
export const getZaloMessageOperationAction = action
  .inputSchema(z.object({ operationId: zodBigintAsString() }))
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId, conversationId],
      parsedInput,
      ctx,
    }) => {
      const caller = {
        workspace: ctx.workspace,
        member: ctx.workspaceMember,
        user: ctx.user,
      }
      await assertConversationAccessForCaller(caller, conversationId)
      return await zaloAccountMessageOperationsService.getOperation({
        workspaceId,
        accountId,
        conversationId,
        operationId: parsedInput.operationId,
        scope: await conversationScopeForCaller(caller),
      })
    },
  )
