import {
  zaloAccountMessageOperationsService,
  zaloAccountMessageRecallService,
} from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import {
  assertConversationAccessForCaller,
  conversationScopeForCaller,
} from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  zaloMessageCommand,
  zaloMessageScope,
  zaloMessageTarget,
  zaloNativeOutcome,
  zaloSavedAttachment,
  zaloSavedContent,
} from "../schema/message-operations"

const api = workspaceTokenAuthAPIForScope("inbox")
const prefix = "/v1/zalo-accounts/{accountId}/conversations/{conversationId}"
const errors = {
  ...possibleErrorsOnFindingResource,
  ...possibleErrorsOnMutatingResource,
  ...possibleIdempotencyErrors,
}
const targetOf = (
  workspaceId: string,
  input: z.infer<typeof zaloMessageTarget>,
) => ({
  workspaceId,
  accountId: input.accountId,
  conversationId: input.conversationId,
  messageId: input.messageId,
  messageCreatedAt: input.createdAt,
})

export const zaloAccountMessageOperations = {
  getMessageCapabilities: api
    .route({
      method: "GET",
      path: `${prefix}/messages/{messageId}/capabilities`,
      summary: "Get Zalo message operation capabilities",
      description:
        "Check native availability and own-message recall eligibility without fetching original content. Use messages.list for messageId and createdAt.",
      tags: ["Zalo Accounts"],
    })
    .input(zaloMessageTarget)
    .output(z.object({ enabled: z.boolean(), canRecall: z.boolean() }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageOperationsService.getCapabilities({
        ...targetOf(context.workspace.id, input),
        scope: await conversationScopeForCaller(context),
      })
    }),
  getSavedMessageContent: api
    .route({
      method: "GET",
      path: `${prefix}/messages/{messageId}/saved-content`,
      summary: "Review retained Zalo message content",
      description:
        "Read original text and saved attachment availability after recall or local hide. Use messages.list for messageId and createdAt. Requires conversation access; unavailable provider media is never fetched.",
      tags: ["Zalo Accounts"],
    })
    .input(zaloMessageTarget)
    .output(zaloSavedContent)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageRecallService.getSavedContent({
        ...targetOf(context.workspace.id, input),
        scope: await conversationScopeForCaller(context),
        actorUserId: context.user?.id,
      })
    }),
  getSavedMessageAttachment: api
    .route({
      method: "GET",
      path: `${prefix}/messages/{messageId}/saved-content/attachments/{attachmentId}`,
      summary: "Get authorized saved Zalo attachment",
      description:
        "Issue a short-lived URL only for an already archived attachment. Get attachmentId from getSavedMessageContent; use messages.list for createdAt. Audit records URL issuance, not completed download.",
      tags: ["Zalo Accounts"],
    })
    .input(
      zaloMessageTarget.extend({
        attachmentId: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Opaque attachment ID from getSavedMessageContent, including media:<referenceId> for archived resources",
          ),
      }),
    )
    .output(zaloSavedAttachment)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageRecallService.getSavedAttachment({
        ...targetOf(context.workspace.id, input),
        scope: await conversationScopeForCaller(context),
        attachmentId: input.attachmentId,
        actorUserId: context.user?.id,
      })
    }),
  hideMessageLocally: api
    .route({
      method: "POST",
      path: `${prefix}/messages/{messageId}/hide-locally`,
      summary: "Hide Zalo message locally",
      description:
        "Hide only this local message while retaining original content. Does not call Zalo or hide replies. Use messages.list for messageId and createdAt.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_diff" }),
    })
    .input(zaloMessageCommand)
    .output(z.object({ success: z.boolean() }))
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      await zaloAccountMessageRecallService.hideLocally({
        ...targetOf(context.workspace.id, input),
        scope: await conversationScopeForCaller(context),
        actorUserId: context.user?.id,
      })
      return { success: true }
    }),
  recallMessage: api
    .route({
      method: "POST",
      path: `${prefix}/messages/{messageId}/recall`,
      summary: "Recall own Zalo message",
      description:
        "Recall a verified own message on Zalo. Native operations remain disabled until live provider proof. Use messages.list for messageId and createdAt. Inspect unknown outcomes; never resend them automatically.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_diff", openWorldHint: true }),
    })
    .input(zaloMessageCommand)
    .output(zaloNativeOutcome)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageOperationsService.recall({
        ...targetOf(context.workspace.id, input),
        scope: await conversationScopeForCaller(context),
        commandId: input.commandId,
      })
    }),
  deleteMessageOnZalo: api
    .route({
      method: "POST",
      path: `${prefix}/messages/{messageId}/delete-on-zalo`,
      summary: "Delete Zalo message only on my side",
      description:
        "Delete on the connected account side using explicit onlyMe=true. Preserve local content and tracking. This is distinct from recalling for everyone. Use messages.list for messageId and createdAt.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_diff", openWorldHint: true }),
    })
    .input(zaloMessageCommand)
    .output(zaloNativeOutcome)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageOperationsService.deleteOnZalo({
        ...targetOf(context.workspace.id, input),
        scope: await conversationScopeForCaller(context),
        commandId: input.commandId,
      })
    }),
  deleteChatOnZalo: api
    .route({
      method: "POST",
      path: `${prefix}/delete-on-zalo`,
      summary: "Clear Zalo history only on my side",
      description:
        "Clear provider history backwards through the selected persisted boundary. Newer messages and all locally retained history remain. Use messages.list for boundaryMessageId/boundaryCreatedAt. Unknown attempts must only be inspected.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_diff", openWorldHint: true }),
    })
    .input(
      zaloMessageScope.extend({
        boundaryMessageId: zodBigintAsString().describe(
          "Boundary message ID from messages.list",
        ),
        boundaryCreatedAt: z.coerce
          .date()
          .describe("Boundary message createdAt from messages.list"),
        commandId: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Stable caller request ID; inspect unknown native attempts instead of replaying",
          ),
      }),
    )
    .output(zaloNativeOutcome)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageOperationsService.deleteChatOnZalo({
        ...input,
        workspaceId: context.workspace.id,
        scope: await conversationScopeForCaller(context),
      })
    }),
  getMessageOperation: api
    .route({
      method: "GET",
      path: `${prefix}/message-operations/{attemptId}`,
      summary: "Inspect Zalo native operation outcome",
      description:
        "Read a durable operation ID returned by recallMessage, deleteMessageOnZalo or deleteChatOnZalo. Works when native dispatch is disabled; never automatically replay pending or unknown operations.",
      tags: ["Zalo Accounts"],
    })
    .input(
      zaloMessageScope.extend({
        attemptId: zodBigintAsString().describe(
          "Operation ID returned by a native Zalo operation",
        ),
      }),
    )
    .output(zaloNativeOutcome)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageOperationsService.getOperation({
        ...input,
        operationId: input.attemptId,
        workspaceId: context.workspace.id,
        scope: await conversationScopeForCaller(context),
      })
    }),
}
