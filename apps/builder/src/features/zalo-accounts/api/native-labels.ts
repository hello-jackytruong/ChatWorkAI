import { notFoundException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import {
  zaloAccountLabelService,
  zaloAccountNativeLabelQueueService,
} from "@chatbotx.io/business/zalo-account"
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
  nativeLabelEdit,
  nativeLabelEditResult,
  nativeLabelList,
  nativeLabelSyncState,
} from "../schema/native-labels"

const accountId = zodBigintAsString().describe(
  "Account ID from zaloAccounts.list",
)
const path = "/v1/zalo-accounts/{accountId}/labels"
const api = workspaceTokenAuthAPIForScope("channels")
const tags = ["Zalo Accounts"]

function workspaceForLabels(context: MemberScopeContext) {
  if (
    context.member &&
    !hasWorkspacePermission(context.member.permissions, "superAdmin")
  ) {
    throw notFoundException("Zalo Account native labels are unavailable")
  }
  return context.workspace.id
}

export const zaloAccountNativeLabelOperations = {
  listNativeLabels: api
    .route({
      path,
      method: "GET",
      summary: "List native Zalo Account labels",
      tags,
      description:
        "Read one account's provider labels, mapped CRM tags and reconciliation status. This does not return conversation assignments.",
    })
    .input(z.strictObject({ accountId }))
    .output(nativeLabelList)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountNativeLabelQueueService.list({
          workspaceId: workspaceForLabels(context),
          accountId: input.accountId,
        }),
    ),
  queueNativeLabelSync: api
    .route({
      path: `${path}/queue-sync`,
      method: "POST",
      summary: "Queue native Zalo label reconciliation",
      tags,
      description:
        "Queue the account label sync and return its current queue state. Use the label list to check the last successful reconciliation.",
    })
    .input(z.strictObject({ accountId }))
    .output(z.strictObject({ state: nativeLabelSyncState }))
    .errors({
      ...possibleErrorsOnFindingResource,
      ...possibleIdempotencyErrors,
    })
    .handler(
      async ({ context, input }) =>
        await zaloAccountNativeLabelQueueService.queue({
          workspaceId: workspaceForLabels(context),
          accountId: input.accountId,
        }),
    ),
  updateNativeLabel: api
    .route({
      path: `${path}/{labelId}/definition`,
      method: "PATCH",
      summary: "Update native Zalo label definition",
      tags,
      description:
        "Edit existing label fields against the current provider document. Unrelated labels and conversation assignments are preserved.",
      spec: mcpSpec({ hitlPolicy: "confirm_diff", openWorldHint: true }),
    })
    .input(nativeLabelEdit.extend({ accountId }))
    .output(nativeLabelEditResult)
    .errors({
      ...possibleErrorsOnFindingResource,
      ...possibleIdempotencyErrors,
    })
    .handler(
      async ({ context, input }) =>
        await zaloAccountLabelService.updateDefinition({
          workspaceId: workspaceForLabels(context),
          ...input,
        }),
    ),
}
