import { zaloAccountNativeSettingsService } from "@chatbotx.io/business/zalo-account/native-settings"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import {
  assertConversationAccessForCaller,
  conversationScopeForCaller,
} from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  nativeConversationScope,
  nativeConversationSettingAttempt,
  nativeConversationSettingAttemptResource,
  nativeConversationSettingsResource,
  nativeConversationSettingWrite,
} from "../schema/native-conversation-settings"

const api = workspaceTokenAuthAPIForScope("inbox")
const accountId = zodBigintAsString().describe(
  "Zalo account ID from zaloAccounts.list",
)
const path =
  "/v1/zalo-accounts/{accountId}/conversations/{conversationId}/native-settings"
const tags = ["Zalo Accounts"]

export const zaloAccountNativeConversationOperations = {
  getNativeConversationSettings: api
    .route({
      method: "GET",
      path,
      tags,
      summary: "Get native Zalo conversation settings",
      description:
        "Read provider settings for the selected conversation and ContactInbox. Missing values are unknown. The response contains no PIN.",
    })
    .input(nativeConversationScope.extend({ accountId }))
    .output(nativeConversationSettingsResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      const scope = await conversationScopeForCaller(context)
      return await zaloAccountNativeSettingsService.read({
        ...input,
        ...(scope ? { scope } : {}),
        workspaceId: context.workspace.id,
        operation: { kind: "readConversationSettings" },
      })
    }),
  setNativeConversationSetting: api
    .route({
      method: "PATCH",
      path,
      tags,
      summary: "Update native Zalo conversation setting",
      description:
        "Submit one provider-only change. This leaves the CRM unread count, archive and message retention independent. Inspect an uncertain command before another write.",
      spec: mcpSpec({ hitlPolicy: "confirm_diff", openWorldHint: true }),
    })
    .input(nativeConversationSettingWrite.extend({ accountId }))
    .output(nativeConversationSettingAttemptResource)
    .errors({
      ...possibleErrorsOnFindingResource,
      ...possibleIdempotencyErrors,
    })
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      const scope = await conversationScopeForCaller(context)
      return await zaloAccountNativeSettingsService.mutate({
        ...input,
        ...(scope ? { scope } : {}),
        workspaceId: context.workspace.id,
        actor: context.member
          ? { type: "member", id: context.member.userId }
          : { type: "token", id: context.apiToken.id },
      })
    }),
  getNativeConversationSettingAttempt: api
    .route({
      method: "GET",
      path: `${path}/attempts/{commandId}`,
      tags,
      summary: "Get native Zalo setting outcome",
      description:
        "Inspect a retained write attempt for the same account and authorized conversation. This sends no provider write.",
    })
    .input(nativeConversationSettingAttempt.extend({ accountId }))
    .output(nativeConversationSettingAttemptResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      const scope = await conversationScopeForCaller(context)
      return await zaloAccountNativeSettingsService.attempt({
        ...input,
        ...(scope ? { scope } : {}),
        workspaceId: context.workspace.id,
      })
    }),
}
