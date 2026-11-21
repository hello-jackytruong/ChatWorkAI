import { automatedResponseService } from "@chatbotx.io/automated-response"
import {
  allowsGroupAutomation,
  zaloAccountGroupService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountGroupInboxService } from "@chatbotx.io/business/zalo-account/group-inbox"
import type { IntegrationJobZaloAccountGroupMessage } from "@chatbotx.io/worker-config"

export const receiveZaloAccountGroupMessage = async (
  input: IntegrationJobZaloAccountGroupMessage["data"],
) => {
  await zaloAccountGroupInboxService.receive(
    input,
    async ({ message, conversation, contactInbox }) => {
      const audience = await zaloAccountGroupService.createAudience({
        workspaceId: input.workspaceId,
        contactInboxId: contactInbox.id,
        conversationId: conversation.id,
        origin: "automation",
      })
      if (
        !audience ||
        audience.accountPolicyEpoch !== input.accountPolicyEpoch ||
        audience.groupPolicyEpoch !== input.groupPolicyEpoch
      ) {
        return
      }
      const group = await zaloAccountGroupService.get({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        id: audience.groupId,
      })
      const account = await zaloAccountService.findById({
        workspaceId: input.workspaceId,
        id: input.accountId,
      })
      if (
        !(
          account &&
          allowsGroupAutomation({
            accountEnabled: account.groupMessagingEnabled,
            accessible: group.accessible,
            receiveEnabled: group.receiveEnabled,
            mode: group.automationMode,
            self: input.message.isSelf,
            accountUid: account.zaloUid,
            mentions: input.message.mentions,
          })
        )
      ) {
        return
      }
      await automatedResponseService.replyToGroupMessage({
        conversation,
        contactInbox,
        groupAudience: audience,
        messageId: message.id,
        text: input.message.text ?? "",
        attachmentFileTypes: input.message.attachments.map(
          (attachment) => attachment.kind,
        ),
        triggerType: "zalo_group_message",
        startedByContactMessage: true,
      })
    },
  )
}
