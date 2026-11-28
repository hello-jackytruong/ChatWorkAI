"use server"

import { contactInboxService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import {
  isZaloAccountReactionEnabled,
  zaloAccountGroupService,
  zaloAccountMessageActivityService,
  zaloAccountMessageStateService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountReactionChoiceSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"
import {
  assertConversationAccessForCaller,
  type MemberScopeContext,
} from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"
import { zaloMessageSendAttemptInput } from "../schema/send-attempt"

const scopedAccount = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)
const conversationId = zodBigintAsString()
const commandId = z.string().min(1).max(200)
const inboxThread = z.object({
  conversationId,
  groupId: zodBigintAsString().optional(),
  contactInboxId: zodBigintAsString(),
})
const messagePointer = zaloMessageSendAttemptInput.extend({ conversationId })

async function accessibleThread(
  context: MemberScopeContext,
  accountId: string,
  input: z.infer<typeof inboxThread>,
) {
  const workspaceId = context.workspace.id
  const conversation = await assertConversationAccessForCaller(
    context,
    input.conversationId,
  )
  if (input.groupId) {
    const scope = await requireContactsAccess(workspaceId)
    const group = await zaloAccountGroupService.requireInboxAccess({
      workspaceId,
      accountId,
      id: input.groupId,
      ...scope,
    })
    if (
      group.conversationId !== conversation.id ||
      group.contactInboxId !== input.contactInboxId
    ) {
      throw notFoundException("Zalo group conversation not found")
    }
    return { groupId: group.id }
  }
  const inbox = await contactInboxService.findByIdForWorkspace({
    id: input.contactInboxId,
    workspaceId,
  })
  if (
    inbox?.contactId !== conversation.contactId ||
    inbox.channel !== "zaloAccount" ||
    inbox.contactKind !== "person"
  ) {
    throw notFoundException("Zalo direct conversation not found")
  }
  return { contactInboxId: inbox.id }
}

export const getZaloMessageStateAction = scopedAccount
  .inputSchema(
    inboxThread.extend({
      providerMessageIds: z.array(z.string().min(1).max(200)).max(50),
    }),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      const thread = await accessibleThread(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        accountId,
        parsedInput,
      )
      return {
        ...(await zaloAccountMessageStateService.get({
          workspaceId,
          accountId,
          ...thread,
          providerMessageIds: parsedInput.providerMessageIds,
        })),
        canReact: isZaloAccountReactionEnabled(),
      }
    },
  )

export const sendZaloInboxTypingAction = scopedAccount
  .inputSchema(inboxThread.extend({ commandId }))
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      const thread = await accessibleThread(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        accountId,
        parsedInput,
      )
      return await zaloAccountMessageStateService.sendTyping({
        workspaceId,
        accountId,
        ...thread,
        commandId: parsedInput.commandId,
      })
    },
  )

export const getZaloMessageActivityDetailsAction = scopedAccount
  .inputSchema(messagePointer)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await assertConversationAccessForCaller(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        parsedInput.conversationId,
      )
      return await zaloAccountMessageStateService.getDetails({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const setZaloMessageReactionAction = scopedAccount
  .inputSchema(
    messagePointer.extend({
      commandId,
      reaction: zaloAccountReactionChoiceSchema.nullable(),
    }),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await assertConversationAccessForCaller(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        parsedInput.conversationId,
      )
      return await zaloAccountMessageActivityService.setReaction({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
