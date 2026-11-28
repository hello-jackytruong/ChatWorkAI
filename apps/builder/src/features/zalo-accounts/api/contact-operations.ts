import { notFoundException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import { zaloAccountContactOperationsService } from "@chatbotx.io/business/zalo-account"
import {
  zaloAccountContactMutationSchema,
  zaloAccountPresenceSchema,
  zaloAccountProfileSchema,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import {
  assertConversationAccessForCaller,
  type MemberScopeContext,
} from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const api = workspaceTokenAuthAPIForScope("channels")
const path = "/v1/zalo-accounts/{accountId}/contacts"
const account = z.strictObject({
  accountId: zodBigintAsString().describe("Account ID from zaloAccounts.list"),
})
const commandId = z
  .string()
  .min(1)
  .max(200)
  .describe("Stable caller-generated request ID")
const selectionToken = z
  .string()
  .uuid()
  .describe(
    "Short-lived selection token from contacts lookup or relationship list",
  )
const uid = zaloAccountProfileSchema.shape.uid.describe(
  "Zalo user identifier observed in this account",
)
const phone = z
  .string()
  .regex(/^\+?\d{7,15}$/)
  .describe("Normalized phone number, with an optional leading plus")
const select = z.strictObject({
  uid,
  name: z.string().optional(),
  alias: z.string().optional(),
  request: z.enum(["incoming", "outgoing"]).optional(),
  selectionToken,
})
const contacts = z.array(select).max(50)
const lookup = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lookupPhone"), phone }),
  z.strictObject({
    kind: z.literal("lookupPhones"),
    phones: z.array(phone).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal("lookupUsername"),
    username: z.string().trim().min(1).max(100),
  }),
])
const presence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lastOnline"), uid }),
  z.strictObject({
    kind: z.literal("onlines"),
    uids: z.array(uid).min(1).max(20),
  }),
])
const writeErrors = {
  ...possibleErrorsOnFindingResource,
  ...possibleIdempotencyErrors,
}
const privateRead = mcpSpec({ hitlPolicy: "none", readOnlyHint: true })

function accountWorkspace(context: MemberScopeContext) {
  if (
    context.member &&
    !hasWorkspacePermission(context.member.permissions, "superAdmin")
  ) {
    throw notFoundException("Zalo Account contacts are unavailable")
  }
  return context.workspace.id
}

export const zaloAccountContactOperations = {
  lookupContacts: api
    .route({
      method: "POST",
      path: `${path}/lookup`,
      summary: "Find contacts with this personal Zalo account",
      description:
        "Performs a deliberate lookup by username or up to 10 phone numbers. Results include a short-lived selection token for a subsequent contact operation.",
      spec: privateRead,
      tags: ["Zalo Accounts"],
    })
    .input(
      account.extend({
        commandId,
        operation: lookup.describe("Select a username or phone lookup"),
      }),
    )
    .output(z.strictObject({ contacts }))
    .errors(writeErrors)
    .handler(({ context, input }) =>
      zaloAccountContactOperationsService.lookup({
        ...input,
        workspaceId: accountWorkspace(context),
      }),
    ),

  listContactRelationships: api
    .route({
      method: "GET",
      path: `${path}/relationships`,
      summary: "List observed Zalo contact relationships",
      description:
        "Lists incoming requests observed by this account, sent requests, recommendations, close friends, or aliases. Incoming requests are based on retained events and may be incomplete.",
      tags: ["Zalo Accounts"],
    })
    .input(
      account.extend({
        commandId,
        kind: z
          .enum([
            "incomingRequests",
            "sentRequests",
            "recommendations",
            "closeFriends",
            "aliases",
          ])
          .describe("Relationship subset to read for this account"),
      }),
    )
    .output(z.strictObject({ contacts, complete: z.boolean() }))
    .errors(possibleErrorsOnFindingResource)
    .handler(({ context, input }) =>
      zaloAccountContactOperationsService.list({
        ...input,
        workspaceId: accountWorkspace(context),
      }),
    ),

  openContactConversation: api
    .route({
      method: "POST",
      path: `${path}/open-conversation`,
      summary: "Open selected Zalo conversation",
      description:
        "Opens a direct Inbox conversation for a verified Zalo selection and creates the contact if needed. This operation sends no messages.",
      tags: ["Zalo Accounts"],
    })
    .input(account.extend({ selectionToken }))
    .output(
      z.strictObject({
        conversationId: zodBigintAsString(),
        contactInboxId: zodBigintAsString(),
      }),
    )
    .errors(writeErrors)
    .handler(async ({ context, input }) => {
      const conversation =
        await zaloAccountContactOperationsService.openConversation({
          ...input,
          workspaceId: accountWorkspace(context),
        })
      await assertConversationAccessForCaller(
        context,
        conversation.conversationId,
      )
      return conversation
    }),

  getFriendRequestStatus: api
    .route({
      method: "POST",
      path: `${path}/friend-request-status`,
      summary: "Get Zalo friend request status",
      description:
        "Use this read to inspect an uncertain friend request before attempting another operation. A missing field indicates that Zalo did not provide it.",
      spec: privateRead,
      tags: ["Zalo Accounts"],
    })
    .input(
      account.extend({
        uid,
        commandId,
        selectionToken: selectionToken.optional(),
      }),
    )
    .output(
      z.strictObject({
        requestStatus: z
          .strictObject({
            isFriend: z.boolean().optional(),
            sent: z.boolean().optional(),
            received: z.boolean().optional(),
          })
          .nullable(),
      }),
    )
    .errors(writeErrors)
    .handler(({ context, input }) =>
      zaloAccountContactOperationsService.requestStatus({
        ...input,
        workspaceId: accountWorkspace(context),
      }),
    ),

  getContactPresence: api
    .route({
      method: "POST",
      path: `${path}/presence`,
      summary: "Check visible personal Zalo contact presence",
      description:
        "Fetches presence on demand for one selected contact or up to 20 known peers. Unknown means no fresh provider evidence, and hidden results omit timestamps.",
      spec: privateRead,
      tags: ["Zalo Accounts"],
    })
    .input(
      account.extend({
        commandId,
        operation: presence.describe(
          "Read one contact or a bounded set of known peers",
        ),
        selectionToken: selectionToken.optional(),
      }),
    )
    .output(
      z.strictObject({ presence: z.array(zaloAccountPresenceSchema).max(20) }),
    )
    .errors(writeErrors)
    .handler(({ context, input }) =>
      zaloAccountContactOperationsService.presence({
        ...input,
        workspaceId: accountWorkspace(context),
      }),
    ),

  mutateContactRelationship: api
    .route({
      method: "POST",
      path: `${path}/relationship-actions`,
      summary: "Change Zalo contact relationship",
      description:
        "May send a provider invitation or change a relationship, block, or alias. Use the original command ID to inspect a missed response. If status is unknown, inspect provider state before considering a new command. Command IDs are retained for 24 hours.",
      spec: mcpSpec({ hitlPolicy: "confirm_outbound", openWorldHint: true }),
      tags: ["Zalo Accounts"],
    })
    .input(
      account.extend({
        commandId,
        operation: zaloAccountContactMutationSchema.describe(
          "Explicit relationship action and selected peer",
        ),
        selectionToken: selectionToken.optional(),
      }),
    )
    .output(
      z.strictObject({ status: z.enum(["applied", "failed", "unknown"]) }),
    )
    .errors(writeErrors)
    .handler(({ context, input }) =>
      zaloAccountContactOperationsService.mutate({
        ...input,
        workspaceId: accountWorkspace(context),
      }),
    ),
}
