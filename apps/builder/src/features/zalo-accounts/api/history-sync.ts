import {
  isZaloAccountHistorySyncEnabled,
  zaloAccountHistorySyncService,
} from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  possibleErrorsOnFindingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const accountApi = workspaceTokenAuthAPIForScope("channels")
const inboxApi = workspaceTokenAuthAPIForScope("inbox")
const accountPath = "/v1/zalo-accounts/{accountId}/history-sync"
const conversationPath =
  "/v1/zalo-accounts/{accountId}/conversations/{conversationId}/history-sync"

const accountInput = z.strictObject({
  accountId: zodBigintAsString().describe("Account ID from zaloAccounts.list"),
})
const conversationInput = accountInput.extend({
  conversationId: zodBigintAsString().describe(
    "Conversation ID from conversations.list",
  ),
  contactInboxId: zodBigintAsString().describe(
    "Zalo ContactInbox ID from conversations.get",
  ),
})
const commandId = z
  .string()
  .min(1)
  .max(200)
  .describe("Stable caller-generated request identifier")
const runId = zodBigintAsString().describe(
  "History run ID returned by the corresponding start operation",
)
const runOutput = z.strictObject({
  runId,
  status: z.enum(["pending", "running", "partial", "complete", "failed"]),
  pages: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  mediaQueued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  error: z.string().optional(),
  canResume: z.boolean(),
  conversationId: zodBigintAsString().optional(),
})
const statusOutput = z.strictObject({
  enabled: z.boolean(),
  run: runOutput.nullable(),
})
const writeErrors = {
  ...possibleErrorsOnFindingResource,
  ...possibleIdempotencyErrors,
}

export const zaloAccountHistorySyncOperations = {
  getHistorySyncStatus: accountApi
    .route({
      method: "GET",
      path: accountPath,
      summary: "Read personal Zalo account history sync status",
      description:
        "Returns the latest account-wide direct-history progress, or null when this scope has no retained run.",
      tags: ["Zalo Accounts"],
    })
    .input(accountInput)
    .output(statusOutput)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      enabled: isZaloAccountHistorySyncEnabled(),
      run: await zaloAccountHistorySyncService.status({
        ...input,
        workspaceId: context.workspace.id,
      }),
    })),

  startHistorySync: accountApi
    .route({
      method: "POST",
      path: accountPath,
      summary: "Start personal Zalo account history sync",
      description:
        "Imports one bounded page of provider history for existing direct conversations. Continue with resumeHistorySync when canResume is true.",
      tags: ["Zalo Accounts"],
    })
    .input(accountInput.extend({ commandId }))
    .output(runOutput)
    .errors(writeErrors)
    .handler(({ context, input }) =>
      zaloAccountHistorySyncService.start({
        ...input,
        workspaceId: context.workspace.id,
      }),
    ),

  resumeHistorySync: accountApi
    .route({
      method: "POST",
      path: `${accountPath}/{runId}/resume`,
      summary: "Resume personal Zalo account history sync",
      description:
        "Advances one page from the retained account-wide checkpoint. A completed run describes the provider data available to that run.",
      tags: ["Zalo Accounts"],
    })
    .input(accountInput.extend({ runId, commandId }))
    .output(runOutput)
    .errors(writeErrors)
    .handler(({ context, input }) =>
      zaloAccountHistorySyncService.resume({
        ...input,
        workspaceId: context.workspace.id,
      }),
    ),

  getConversationHistorySyncStatus: inboxApi
    .route({
      method: "GET",
      path: conversationPath,
      summary: "Read personal Zalo conversation history sync status",
      description:
        "Returns progress only for the requested conversation and its Zalo ContactInbox.",
      tags: ["Zalo Accounts"],
    })
    .input(conversationInput)
    .output(statusOutput)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return {
        enabled: isZaloAccountHistorySyncEnabled(),
        run: await zaloAccountHistorySyncService.status({
          ...input,
          workspaceId: context.workspace.id,
        }),
      }
    }),

  startConversationHistorySync: inboxApi
    .route({
      method: "POST",
      path: conversationPath,
      summary: "Start personal Zalo conversation history sync",
      description:
        "Imports one direct-history page or the available group history window for a conversation the caller can access.",
      tags: ["Zalo Accounts"],
    })
    .input(conversationInput.extend({ commandId }))
    .output(runOutput)
    .errors(writeErrors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountHistorySyncService.start({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),

  resumeConversationHistorySync: inboxApi
    .route({
      method: "POST",
      path: `${conversationPath}/{runId}/resume`,
      summary: "Resume personal Zalo conversation history sync",
      description:
        "Advances a retained conversation checkpoint when canResume is true.",
      tags: ["Zalo Accounts"],
    })
    .input(conversationInput.extend({ runId, commandId }))
    .output(runOutput)
    .errors(writeErrors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountHistorySyncService.resume({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),
}
