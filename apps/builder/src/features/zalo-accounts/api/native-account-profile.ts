import { notFoundException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
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
import type { MemberScopeContext } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  nativeAccountToolAttemptResource,
  nativeAccountToolReadResource,
  nativeAccountToolWrite,
} from "../schema/native-account-tools"

const accountId = zodBigintAsString().describe(
  "Account ID from zaloAccounts.list",
)
const api = workspaceTokenAuthAPIForScope("channels")
const tags = ["Zalo Accounts"]
const path = "/v1/zalo-accounts/{accountId}/native-profile"

export function workspaceForNativeAccount(context: MemberScopeContext) {
  if (
    context.member &&
    !hasWorkspacePermission(context.member.permissions, "superAdmin")
  ) {
    throw notFoundException("Native Zalo account settings are unavailable")
  }
  return context.workspace.id
}

const readKind = z.enum([
  "readOwnProfile",
  "readOwnBusiness",
  "readOwnQr",
  "listOwnAvatars",
  "readOwnSettings",
])
const profileAttempt = z.strictObject({
  accountId,
  commandId: zaloAccountGroupManagementCommandIdSchema.describe(
    "Original command ID from the profile update",
  ),
})

export const zaloAccountNativeProfileOperations = {
  readNativeAccountProfile: api
    .route({
      method: "GET",
      path,
      tags,
      summary: "Read native Zalo account profile resources",
      description:
        "Read only the selected account's own profile, business package, profile QR, avatar page or allowlisted settings. Profile QR is independent of login.",
    })
    .input(
      z.strictObject({
        accountId,
        kind: readKind.describe(
          "One explicitly requested own-account resource",
        ),
        page: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Avatar page starting at one"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum avatar records per page"),
      }),
    )
    .output(nativeAccountToolReadResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountNativeAccountToolsService.read({
          workspaceId: workspaceForNativeAccount(context),
          accountId: input.accountId,
          operation:
            input.kind === "listOwnAvatars"
              ? { kind: input.kind, page: input.page, limit: input.limit }
              : { kind: input.kind },
        }),
    ),
  updateNativeAccountProfile: api
    .route({
      method: "PATCH",
      path,
      tags,
      summary: "Update native Zalo account profile resources",
      description:
        "Submit one edit to the selected account's own profile, avatar or allowlisted settings. Inspect uncertain attempts by their original command ID.",
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
            zaloAccountNativeToolFamily(operation) === "accountProfile",
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
  getNativeAccountProfileAttempt: api
    .route({
      method: "GET",
      path: `${path}/attempts/{commandId}`,
      tags,
      summary: "Get native Zalo account profile outcome",
      description:
        "Read the same account's stored profile operation result by command ID. Profile details and images are not stored in the attempt.",
    })
    .input(profileAttempt)
    .output(nativeAccountToolAttemptResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountNativeAccountToolsService.attempt({
          workspaceId: workspaceForNativeAccount(context),
          ...input,
          family: "accountProfile",
        }),
    ),
}
