import { zaloAccountNativeAccountToolsService } from "@chatbotx.io/business/zalo-account/native-account-tools"
import {
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountNativeToolFamily,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  nativeAccountToolAttemptResource,
  nativeAccountToolReadResource,
  nativeAccountToolWrite,
} from "../schema/native-account-tools"
import { workspaceForNativeAccount } from "./native-account-profile"

const accountId = zodBigintAsString().describe(
  "Account ID from zaloAccounts.list",
)
const api = workspaceTokenAuthAPIForScope("channels")
const tags = ["Zalo Accounts"]
const path = "/v1/zalo-accounts/{accountId}/native-replies"

export const zaloAccountNativeReplyProcedures = {
  readNativeReplies: api
    .route({
      method: "GET",
      path,
      tags,
      summary: "Read native Zalo reply settings",
      description:
        "Read one bounded page of Zalo quick messages or Zalo Business auto-replies. Continue using nextOffset and expectedVersion from the preceding page.",
    })
    .input(
      z.strictObject({
        accountId,
        kind: z
          .enum(["readQuickMessages", "readAutoReplies"])
          .describe("Native reply resource to read"),
        offset: z
          .number()
          .int()
          .min(0)
          .max(999)
          .optional()
          .describe("Offset from nextOffset on the preceding page"),
        expectedVersion: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Snapshot version from the preceding page"),
      }),
    )
    .output(nativeAccountToolReadResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input: { accountId: id, ...operation } }) =>
        await zaloAccountNativeAccountToolsService.read({
          workspaceId: workspaceForNativeAccount(context),
          accountId: id,
          operation,
        }),
    ),
  updateNativeReplies: api
    .route({
      method: "PATCH",
      path,
      tags,
      summary: "Update native Zalo reply settings",
      description:
        "Add, edit or delete a quick message, or delete the selected Zalo Business auto-reply. Send the current snapshot version and reuse the original command ID to inspect uncertain writes.",
      spec: mcpSpec({
        hitlPolicy: "confirm_destructive",
        destructiveHint: true,
        openWorldHint: true,
      }),
    })
    .input(
      nativeAccountToolWrite
        .safeExtend({ accountId })
        .refine(
          ({ operation }) =>
            zaloAccountNativeToolFamily(operation) === "nativeReplies",
        ),
    )
    .output(nativeAccountToolAttemptResource)
    .errors({
      ...possibleErrorsOnFindingResource,
      ...possibleIdempotencyErrors,
    })
    .handler(
      async ({ context, input }) =>
        await zaloAccountNativeAccountToolsService.mutate({
          workspaceId: workspaceForNativeAccount(context),
          ...input,
          actor: context.member
            ? { type: "member", id: context.member.userId }
            : { type: "token", id: context.apiToken.id },
        }),
    ),
  getNativeReplyAttempt: api
    .route({
      method: "GET",
      path: `${path}/attempts/{commandId}`,
      tags,
      summary: "Get native Zalo reply change outcome",
      description:
        "Inspect the stored outcome for the original command ID in the selected Zalo account.",
    })
    .input(
      z.strictObject({
        accountId,
        commandId: zaloAccountGroupManagementCommandIdSchema.describe(
          "Original command ID from the native reply change",
        ),
      }),
    )
    .output(nativeAccountToolAttemptResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountNativeAccountToolsService.attempt({
          workspaceId: workspaceForNativeAccount(context),
          ...input,
          family: "nativeReplies",
        }),
    ),
}
