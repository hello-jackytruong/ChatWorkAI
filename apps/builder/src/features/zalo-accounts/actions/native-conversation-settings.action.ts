"use server"

import { contactInboxService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import { zaloAccountService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountNativeSettingsService } from "@chatbotx.io/business/zalo-account/native-settings"
import { zodBigintAsString } from "@chatbotx.io/utils"
import {
  assertConversationAccessForCaller,
  conversationScopeForCaller,
  type MemberScopeContext,
} from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  nativeConversationScope,
  nativeConversationSettingAttempt,
  nativeConversationSettingWrite,
} from "../schema/native-conversation-settings"

const conversationAction = workspaceActionClient.bindArgsSchemas([
  zodBigintAsString(),
  zodBigintAsString().nullable(),
])

async function resolveAccount(
  context: MemberScopeContext,
  accountId: string | null,
  target: { conversationId: string; contactInboxId: string },
) {
  const conversation = await assertConversationAccessForCaller(
    context,
    target.conversationId,
  )
  const scope = await conversationScopeForCaller(context)
  if (accountId) {
    return { accountId, scope }
  }
  const workspaceId = context.workspace.id
  const binding = await contactInboxService.findByIdForWorkspace({
    workspaceId,
    id: target.contactInboxId,
  })
  if (
    binding?.channel !== "zaloAccount" ||
    binding.contactId !== conversation.contactId
  ) {
    throw notFoundException("Zalo conversation settings are unavailable")
  }
  const account = await zaloAccountService.findByInboxId({
    workspaceId,
    inboxId: binding.inboxId,
  })
  if (!account) {
    throw notFoundException("Zalo conversation settings are unavailable")
  }
  return { accountId: account.id, scope }
}

export const getZaloNativeConversationSettingsAction = conversationAction
  .inputSchema(nativeConversationScope)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      const scopedAccount = await resolveAccount(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        accountId,
        parsedInput,
      )
      return await zaloAccountNativeSettingsService.read({
        workspaceId,
        ...scopedAccount,
        ...parsedInput,
        operation: { kind: "readConversationSettings" },
      })
    },
  )

export const setZaloNativeConversationSettingAction = conversationAction
  .inputSchema(nativeConversationSettingWrite)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      const scopedAccount = await resolveAccount(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        accountId,
        parsedInput,
      )
      return await zaloAccountNativeSettingsService.mutate({
        workspaceId,
        ...scopedAccount,
        ...parsedInput,
        actor: { type: "member", id: ctx.user.id },
      })
    },
  )

export const getZaloNativeConversationSettingAttemptAction = conversationAction
  .inputSchema(nativeConversationSettingAttempt)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      const scopedAccount = await resolveAccount(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        accountId,
        parsedInput,
      )
      return await zaloAccountNativeSettingsService.attempt({
        workspaceId,
        ...scopedAccount,
        ...parsedInput,
      })
    },
  )
