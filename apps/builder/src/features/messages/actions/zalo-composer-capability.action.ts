"use server"

import { conversationService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import {
  isZaloAccountRichSendEnabled,
  zaloAccountService,
  zaloAccountStickerCatalogService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountStickerCatalogQuerySchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"

const composerInboxInput = z.object({ inboxId: zodBigintAsString() })

async function resolveZaloComposerAccount(input: {
  workspaceId: string
  conversationId: string
  inboxId: string
  scope: Parameters<typeof assertConversationAccessForCaller>[0]
}) {
  const { workspaceId, conversationId, inboxId, scope } = input
  const conversation = await assertConversationAccessForCaller(
    scope,
    conversationId,
  )
  const inbox = await conversationService.resolveContactInboxForConversation({
    workspaceId,
    conversation,
    inboxId,
  })
  if (inbox.channel !== "zaloAccount" || inbox.inboxId !== inboxId) {
    return null
  }
  const account = await zaloAccountService.findByInboxId({
    workspaceId,
    inboxId,
  })
  return account && isZaloAccountRichSendEnabled(account.id) ? account : null
}

export const getZaloComposerCapabilityAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(composerInboxInput)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      ctx,
      parsedInput,
    }) => {
      const account = await resolveZaloComposerAccount({
        workspaceId,
        conversationId,
        inboxId: parsedInput.inboxId,
        scope: {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
      })
      return { enabled: Boolean(account) }
    },
  )

export const listZaloComposerStickersAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(
    composerInboxInput.extend({ query: zaloAccountStickerCatalogQuerySchema }),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      ctx,
      parsedInput,
    }) => {
      const account = await resolveZaloComposerAccount({
        workspaceId,
        conversationId,
        inboxId: parsedInput.inboxId,
        scope: {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
      })
      if (!account) {
        throw notFoundException("Zalo sticker catalog unavailable")
      }
      return await zaloAccountStickerCatalogService.list({
        workspaceId,
        accountId: account.id,
        query: parsedInput.query,
      })
    },
  )
