import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import { zaloAccountMediaReadService as service } from "@chatbotx.io/business/zalo-account-media"
import type { WorkspaceApiTokenScope } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import {
  assertConversationAccessForCaller,
  type MemberScopeContext,
} from "@/lib/public-api/member-scope"
import { assertTokenScope } from "@/lib/public-api/token-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const api = workspaceTokenAuthAPIForScope(["inbox", "channels"])
const scope = z
  .object({
    accountId: zodBigintAsString().describe(
      "Account ID returned by zaloAccounts.list",
    ),
    conversationId: zodBigintAsString()
      .optional()
      .describe(
        "Conversation ID returned by conversations.list; required for message content and exclusive with ownerKind/ownerId",
      ),
    ownerKind: z
      .enum(["account", "group", "contact", "sticker"])
      .optional()
      .describe(
        "Non-message resource owner type; requires channels management access and ownerId",
      ),
    ownerId: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Current account ID, providerGroupId from zaloAccounts.listGroups, provider UID from the ContactInbox sourceId in conversations.get, or sticker owner ID returned by listMedia",
      ),
  })
  .strict()
const reference = zodBigintAsString().describe(
  "Reference ID returned by zaloAccounts.listMedia",
)
const byId = scope.extend({ referenceId: reference })
const page = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(50)
    .describe("Maximum page size, from 1 to 50 references"),
  cursor: zodBigintAsString()
    .optional()
    .describe("Database reference cursor returned by the preceding media page"),
})
const resource = z.object({
  referenceId: z.string(),
  accountId: z.string(),
  ownerKind: z.string(),
  ownerId: z.string(),
  messageId: z.string().nullable(),
  attachmentId: z.string().nullable(),
  role: z.string(),
  kind: z.string(),
  sourceRevision: z.string(),
  state: z.string(),
  projection: z.string(),
  errorCode: z.string().nullable(),
  attempts: z.number(),
  lastAttemptAt: z.date().nullable(),
  nextAttemptAt: z.date().nullable(),
  checksum: z.string().nullable(),
  providerResourceId: z.string().nullable(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  durationMs: z.number().nullable(),
  durationSource: z.enum(["provider", "detected", "unknown"]),
  dimensionsSource: z.enum(["provider", "detected", "unknown"]),
})
const management = (
  context: MemberScopeContext & {
    apiToken?: { scopes: WorkspaceApiTokenScope[] | null }
  },
) => {
  assertTokenScope(context, "channels")
  if (
    context.member &&
    !hasWorkspacePermission(context.member.permissions, "superAdmin")
  ) {
    throw new ORPCError("FORBIDDEN")
  }
}
const authorize = async (
  context: MemberScopeContext & {
    apiToken?: { scopes: WorkspaceApiTokenScope[] | null }
  },
  input: { conversationId?: string; ownerKind?: string; ownerId?: string },
  requireContent = false,
) => {
  if (input.conversationId) {
    if (input.ownerKind || input.ownerId) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Choose conversationId or a non-message owner",
      })
    }
    assertTokenScope(context, "inbox")
    await assertConversationAccessForCaller(context, input.conversationId)
  } else {
    if (requireContent || !input.ownerKind || !input.ownerId) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Provide conversationId or ownerKind and ownerId",
      })
    }
    management(context)
  }
}
const path = "/v1/zalo-accounts/{accountId}/media"
export const zaloAccountMediaOperations = {
  listMedia: api
    .route({
      method: "GET",
      path,
      summary: "List archived Zalo media",
      description:
        "Message content requires inbox scope and conversation access. Non-message resource owners require channels management access. Returns safe storage status without source URLs or keys.",
      tags: ["Zalo Accounts"],
    })
    .input(scope.extend(page.shape))
    .output(
      z.object({ data: z.array(resource), nextCursor: z.string().optional() }),
    )
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await authorize(context, input)
      return await service.list({ ...input, workspaceId: context.workspace.id })
    }),
  getMedia: api
    .route({
      method: "GET",
      path: `${path}/{referenceId}`,
      summary: "Get archived Zalo media status",
      description:
        "Returns the exact reference after checking its current parent message or resource owner and account inbox. Get reference IDs from zaloAccounts.listMedia.",
      tags: ["Zalo Accounts"],
    })
    .input(byId)
    .output(resource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await authorize(context, input)
      return await service.get({ ...input, workspaceId: context.workspace.id })
    }),
  authorizeMediaDownload: api
    .route({
      method: "GET",
      path: `${path}/{referenceId}/download`,
      summary: "Authorize five-minute Zalo media download",
      description:
        "Checks the current message has not been deleted or recalled, or verifies the current non-message owner, before returning a signed URL. Stored originals remain readable when capture is disabled.",
      tags: ["Zalo Accounts"],
    })
    .input(byId)
    .output(
      z.object({
        url: z.string().url(),
        expiresIn: z.literal(300),
        mimeType: z.string().nullable(),
        fileName: z.string().nullable(),
      }),
    )
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await authorize(context, input)
      return await service.download({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),
  retryMedia: api
    .route({
      method: "POST",
      path: `${path}/{referenceId}/retry`,
      summary: "Retry eligible Zalo media capture",
      description:
        "Uses the sourceRevision from zaloAccounts.getMedia and schedules an eligible failed transfer through the durable media outbox. Stored or exhausted resources are not reset.",
      tags: ["Zalo Accounts"],
    })
    .input(
      byId.extend({
        expectedSourceRevision: z
          .string()
          .min(1)
          .max(1000)
          .describe("Current sourceRevision returned by zaloAccounts.getMedia"),
      }),
    )
    .output(z.object({ accepted: z.boolean(), state: z.string() }))
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      await authorize(context, input)
      return await service.retry({
        ...input,
        workspaceId: context.workspace.id,
        readOnly: false,
      })
    }),
  backfillMedia: api
    .route({
      method: "POST",
      path: `${path}/backfill`,
      summary: "Backfill one bounded page of persisted Zalo media",
      description:
        "Requires inbox and channels scopes. Reads existing conversation messages only; never fetches provider history. Use returned timestamp cursor to continue; window maximum 31 days. Defaults to dry-run.",
      tags: ["Zalo Accounts"],
    })
    .input(
      scope.extend({
        from: z.coerce
          .date()
          .describe(
            "Inclusive oldest persisted message timestamp, at most 31 days before to",
          ),
        to: z.coerce
          .date()
          .describe("Inclusive newest persisted message timestamp"),
        dryRun: z
          .boolean()
          .default(true)
          .describe(
            "When true, count eligible persisted resources without registering transfers",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(50)
          .describe("Maximum page size, from 1 to 50 references"),
        cursor: z
          .object({ createdAt: z.coerce.date(), id: z.string() })
          .optional()
          .describe(
            "Timestamp and message ID cursor returned by the previous backfill page",
          ),
      }),
    )
    .output(
      z.object({
        dryRun: z.boolean(),
        scanned: z.number(),
        eligible: z.number(),
        registered: z.number(),
        nextCursor: z
          .object({ createdAt: z.coerce.date(), id: z.string() })
          .nullable(),
      }),
    )
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      management(context)
      await authorize(context, input, true)
      return await service.backfill({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),
  reconcileMedia: api
    .route({
      method: "POST",
      path: `${path}/reconcile`,
      summary: "Inspect bounded Zalo media storage",
      description:
        "Dry-run only. Message inspection requires inbox and channels scopes; resource inspection requires channels management access. HEAD checks at most 50 references and lists 100 account-prefix objects. Outages are unknown and no object is deleted. Continue both cursors.",
      tags: ["Zalo Accounts"],
    })
    .input(
      scope.extend({
        ...page.shape,
        dryRun: z
          .literal(true)
          .default(true)
          .describe(
            "Required dry-run mode; reconciliation reports diagnostics and never deletes objects",
          ),
        objectCursor: z
          .string()
          .max(4096)
          .optional()
          .describe(
            "Account-prefix object continuation token returned by the preceding reconcile page",
          ),
      }),
    )
    .output(
      z.object({
        dryRun: z.literal(true),
        data: z.array(
          z.object({
            referenceId: z.string(),
            status: z.enum(["present", "missing", "unknown"]),
          }),
        ),
        nextCursor: z.string().optional(),
        objectScanStatus: z.enum(["complete", "unknown"]),
        unreferencedCandidates: z.number(),
        nextObjectCursor: z.string().optional(),
      }),
    )
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      management(context)
      await authorize(context, input)
      return await service.reconcile({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),
}
