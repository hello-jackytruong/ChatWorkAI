import {
  zaloAccountFriendSyncService,
  zaloAccountGroupService,
  zaloAccountGroupTagService,
  zaloAccountMessageStateService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountCanonicalSendService } from "@chatbotx.io/business/zalo-account/canonical-send"
import { zaloAccountAttachmentSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { zaloAccountErrors } from "../schema/errors"
import {
  zaloAccountGroupResource,
  zaloAccountStatusResource,
} from "../schema/resource"

const api = workspaceTokenAuthAPIForScope("channels")
const scope = z.object({
  accountId: zodBigintAsString().describe(
    "Personal account ID from zaloAccounts.list",
  ),
})
const commandId = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Stable caller ID; reuse with identical input to inspect a pending send. Never automatically replay unknown sends.",
  )
const errors = {
  ...possibleErrorsOnFindingResource,
  ...possibleIdempotencyErrors,
  ...zaloAccountErrors,
}
const readErrors = possibleErrorsOnFindingResource
const groupId = zodBigintAsString().describe(
  "Group resource ID returned by zaloAccounts.listGroups",
)
const contactInboxId = zodBigintAsString().describe(
  "Known direct ContactInbox ID belonging to this account, returned by conversations.get",
)
const providerUid = z
  .string()
  .regex(/^\d{1,200}$/)
  .describe(
    "Known provider UID from a direct ContactInbox sourceId; never a phone number or group ID",
  )
const policyFields = {
  receiveEnabled: z
    .boolean()
    .optional()
    .describe(
      "Persist incoming group messages when the account kill switch permits it",
    ),
  sendEnabled: z
    .boolean()
    .optional()
    .describe(
      "Allow outgoing group messages when the account kill switch permits it",
    ),
  automationMode: z
    .enum(["disabled", "mentionOnly", "all"])
    .optional()
    .describe(
      "Automation allowlist mode; mentionOnly matches the connected account UID",
    ),
}
const sent = z.object({
  messageIds: z.array(z.string()),
  sentCount: z.number().int().nonnegative(),
})

export const zaloAccountOperations = {
  getSendAttempt: api
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/send-attempts/{commandId}",
      summary: "Inspect durable Zalo send outcome",
      description:
        "Use the original caller commandId and one group resource, known direct ContactInbox, or known provider UID. Works after sending is disabled. pending and unknown must not be automatically replayed; applied returns confirmed provider IDs.",
      tags: ["Zalo Accounts"],
    })
    .input(
      scope
        .extend({
          commandId,
          groupId: groupId.optional(),
          contactInboxId: contactInboxId.optional(),
          providerUid: providerUid.optional(),
        })
        .refine(
          (input) =>
            [input.groupId, input.contactInboxId, input.providerUid].filter(
              Boolean,
            ).length === 1,
        ),
    )
    .output(
      z.object({
        commandId: z.string(),
        status: z.enum(["pending", "applied", "failed", "unknown"]),
        messageId: z.string().nullable(),
        messageCreatedAt: z.string().nullable(),
        messageIds: z.array(z.string()),
      }),
    )
    .errors(readErrors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountCanonicalSendService.getOutcome({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
  sendTyping: api
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/typing",
      summary: "Send ephemeral Zalo typing indicator",
      description:
        "Select one known group resource or direct ContactInbox. Best effort, throttled to once per thread per five seconds; group send policy still applies.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_outbound" }),
    })
    .input(
      scope
        .extend({
          commandId,
          groupId: groupId.optional(),
          contactInboxId: contactInboxId.optional(),
        })
        .refine(
          (input) => Boolean(input.groupId) !== Boolean(input.contactInboxId),
        ),
    )
    .output(z.object({ accepted: z.boolean() }))
    .errors(errors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountMessageStateService.sendTyping({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
  getStatus: api
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/status",
      summary: "Get safe personal Zalo connection and sync status",
      description:
        "Returns safe connection state, optional verified runtime socket state and freshness, group kill switch, capabilities and friend/group/label sync summaries. Runtime may be absent or null during rollout; socketOpen is null when unverified. Session credentials, operation tokens and gateway ownership are omitted.",
      tags: ["Zalo Accounts"],
    })
    .input(scope)
    .output(zaloAccountStatusResource)
    .errors(readErrors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountService.status({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
  setGroupMessaging: api
    .route({
      method: "PATCH",
      path: "/connections/zalo-account/{accountId}/group-messaging",
      summary: "Set account group messaging kill switch",
      description:
        "Defaults off. Disabling fences all queued group work while direct chats continue. Re-enabling does not replay stale jobs.",
      tags: ["Zalo Accounts"],
      spec: (current) => ({
        ...mcpSpec({ hitlPolicy: "confirm_diff" })(current),
        operationId: "zaloAccountSetGroupMessaging",
      }),
    })
    .input(
      scope.extend({
        enabled: z
          .boolean()
          .describe(
            "Allow selected groups to receive/send; false fences all queued group work",
          ),
      }),
    )
    .output(zaloAccountStatusResource)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await zaloAccountGroupService.setGroupMessaging({
        ...input,
        workspaceId: context.workspace.id,
      })
      return await zaloAccountService.status({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),
  setGroupPolicy: api
    .route({
      method: "PATCH",
      path: "/connections/zalo-account/{accountId}/groups/{groupId}/policy",
      summary: "Update receive, send, and automation for one Zalo group",
      description:
        "Receive and send independently provision the group's Inbox anchor. Automation defaults disabled; mentionOnly requires an explicit mention of the connected account. Inaccessible groups cannot be enabled.",
      tags: ["Zalo Accounts"],
      spec: (current) => ({
        ...mcpSpec({ hitlPolicy: "confirm_diff" })(current),
        operationId: "zaloAccountUpdateGroupPolicy",
      }),
    })
    .input(
      scope.extend({
        groupId: zodBigintAsString().describe(
          "Group resource ID from zaloAccounts.listGroups",
        ),
        ...policyFields,
      }),
    )
    .output(zaloAccountGroupResource)
    .errors(errors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupService.updateInboxPolicy({
          ...input,
          id: input.groupId,
          workspaceId: context.workspace.id,
        }),
    ),
  syncFriends: api
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/friends/sync",
      summary: "Import personal Zalo friends without activity or MAC",
      description:
        "Imports at most 500 provider entries per call in sequential transactions of 100. Follow nextCursor with a new commandId until complete. Missing friends are never deleted; group members are never imported.",
      tags: ["Zalo Accounts"],
    })
    .input(
      scope.extend({
        commandId,
        cursor: z
          .number()
          .int()
          .min(1)
          .max(9999)
          .optional()
          .describe(
            "Provider page returned as nextCursor by the preceding syncFriends call; omit to start",
          ),
      }),
    )
    .output(
      z.object({
        imported: z.number().int(),
        created: z.number().int(),
        complete: z.boolean(),
        nextCursor: z.number().int().optional(),
      }),
    )
    .errors(errors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountFriendSyncService.sync({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
  sendDirectMessage: api
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/messages",
      summary: "Send persisted personal Zalo direct message",
      description:
        "Select one known ContactInbox or provider UID. Supports one text or image/file and a same-thread reply. Creates the Inbox Message before chat-worker dispatch. A timeout remains pending or unknown; use getSendAttempt to inspect its outcome.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_outbound", openWorldHint: true }),
    })
    .input(
      scope
        .extend({
          commandId,
          contactInboxId: contactInboxId.optional(),
          providerUid: providerUid.optional(),
          text: z
            .string()
            .trim()
            .min(1)
            .max(20_000)
            .optional()
            .describe("Text to send, mutually exclusive with attachment"),
          attachment: zaloAccountAttachmentSchema
            .optional()
            .describe(
              "One image up to 10 MB or file up to 25 MB; mutually exclusive with text",
            ),
          replyToMessageId: zodBigintAsString()
            .optional()
            .describe("Same-thread Message ID returned by messages.list"),
          replyToMessageCreatedAt: z.coerce
            .date()
            .optional()
            .describe(
              "Original creation time of the reply target from messages.list",
            ),
        })
        .refine(
          (input) =>
            Boolean(input.text) !== Boolean(input.attachment) &&
            Boolean(input.contactInboxId) !== Boolean(input.providerUid),
          "Select one direct target and one text or attachment",
        ),
    )
    .output(sent)
    .errors(errors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountCanonicalSendService.send({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
  getMessageState: api
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/message-state",
      summary: "Get Zalo delivery and reaction counts",
      description:
        "Select one group resource or direct ContactInbox and at most 50 provider message IDs. Group read counts never mark customer activity.",
      tags: ["Zalo Accounts"],
    })
    .input(
      scope
        .extend({
          groupId: groupId.optional(),
          contactInboxId: contactInboxId.optional(),
          providerMessageIds: z
            .array(z.string().min(1).max(200))
            .max(50)
            .describe(
              "Provider message IDs from send results or Inbox Zalo content attributes, at most 50",
            ),
        })
        .refine(
          (input) => Boolean(input.groupId) !== Boolean(input.contactInboxId),
          "Select one thread",
        ),
    )
    .output(
      z.object({
        receipts: z.array(
          z.object({
            providerMessageId: z.string(),
            delivered: z.number(),
            seen: z.number(),
          }),
        ),
        reactions: z.array(
          z.object({
            providerMessageId: z.string(),
            key: z.string(),
            count: z.number(),
          }),
        ),
      }),
    )
    .errors(readErrors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountMessageStateService.get({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
  listGroupTags: api
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/groups/{groupId}/tags",
      summary: "List personal Zalo group tags",
      description:
        "Returns local tags on the account-scoped group Inbox anchor, including confirmed native-label mappings.",
      tags: ["Zalo Accounts"],
    })
    .input(scope.extend({ groupId }))
    .output(
      z.object({
        data: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    )
    .errors(readErrors)
    .handler(async ({ context, input }) => ({
      data: await zaloAccountGroupTagService.list({
        ...input,
        workspaceId: context.workspace.id,
      }),
    })),
  updateGroupTags: api
    .route({
      method: "PATCH",
      path: "/v1/zalo-accounts/{accountId}/groups/{groupId}/tags",
      summary: "Assign or remove personal Zalo group tags",
      description:
        "Uses quiet group tagging and native-label synchronization; emits no customer activity, lead events, or MAC.",
      tags: ["Zalo Accounts"],
    })
    .input(
      scope.extend({
        groupId,
        commandId,
        tagIds: z
          .array(zodBigintAsString())
          .max(50)
          .describe("Workspace tag IDs from tags.list, at most 50"),
        assigned: z
          .boolean()
          .describe("True to assign these tags; false to remove them"),
      }),
    )
    .output(
      z.object({
        data: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    )
    .errors(errors)
    .handler(async ({ context, input }) => {
      await zaloAccountGroupTagService.update({
        ...input,
        workspaceId: context.workspace.id,
      })
      return {
        data: await zaloAccountGroupTagService.list({
          ...input,
          workspaceId: context.workspace.id,
        }),
      }
    }),
}
