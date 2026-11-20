import { notFoundException } from "@chatbotx.io/business/errors"
import {
  zaloAccountGroupService,
  zaloAccountLabelService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountAttachmentSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { toZaloAccountResource } from "../lib/to-resource"
import {
  zaloAccountGroupResource,
  zaloAccountResource,
} from "../schema/resource"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("channels")

const groupScopeInput = z.object({
  accountId: zodBigintAsString().describe(
    "Personal Zalo account id returned by zaloAccounts.list",
  ),
})

const commandIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("Stable caller-generated id used to deduplicate this operation")

const groupIdSchema = zodBigintAsString().describe(
  "Group resource id returned by zaloAccounts.listGroups",
)

const writeErrors = {
  ...possibleErrorsOnFindingResource,
  ...possibleIdempotencyErrors,
}

export const zaloAccountsPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/zalo-accounts",
      summary: "List connected personal Zalo accounts",
      description:
        "Returns safe account and Inbox routing metadata only. To connect, reconnect, disconnect, or poll a QR session use connections.create, connections.reconnect, connections.disconnect, and connectSessions.get with provider zaloAccount.",
      tags: ["Zalo Accounts"],
    })
    .input(z.object({}).strict())
    .output(z.object({ data: z.array(zaloAccountResource) }))
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context }) => ({
      data: (
        await zaloAccountService.listByWorkspace({
          workspaceId: context.workspace.id,
        })
      ).map(toZaloAccountResource),
    })),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{id}",
      summary: "Get connected personal Zalo account metadata",
      description:
        "Returns safe profile and Inbox routing metadata. Get account ids from zaloAccounts.list.",
      tags: ["Zalo Accounts"],
    })
    .input(
      z.object({
        id: zodBigintAsString().describe(
          "Personal Zalo account id returned by zaloAccounts.list",
        ),
      }),
    )
    .output(zaloAccountResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const account = await zaloAccountService.findById({
        workspaceId: context.workspace.id,
        id: input.id,
      })
      if (!account) {
        throw notFoundException("Zalo Account not found")
      }
      return toZaloAccountResource(account)
    }),

  listGroups: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/groups",
      summary: "List personal Zalo groups",
      description:
        "Returns the synchronized groups and their explicit sending policy for one connected personal account.",
      tags: ["Zalo Accounts"],
    })
    .input(groupScopeInput)
    .output(z.object({ data: z.array(zaloAccountGroupResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      data: await zaloAccountGroupService.list({
        workspaceId: context.workspace.id,
        accountId: input.accountId,
      }),
    })),

  getGroup: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/groups/{id}",
      summary: "Get personal Zalo group",
      description:
        "Returns one synchronized group after proving that it belongs to the selected connected personal account.",
      tags: ["Zalo Accounts"],
    })
    .input(groupScopeInput.extend({ id: groupIdSchema }))
    .output(zaloAccountGroupResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupService.get({
          workspaceId: context.workspace.id,
          accountId: input.accountId,
          id: input.id,
        }),
    ),

  syncGroups: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/groups/sync",
      summary: "Sync personal Zalo groups",
      description:
        "Refreshes provider group metadata while preserving each group's existing disabled-by-default sending policy.",
      tags: ["Zalo Accounts"],
    })
    .input(groupScopeInput.extend({ commandId: commandIdSchema }))
    .output(z.object({ data: z.array(zaloAccountGroupResource) }))
    .errors(writeErrors)
    .handler(async ({ context, input }) => ({
      data: await zaloAccountGroupService.sync({
        workspaceId: context.workspace.id,
        accountId: input.accountId,
        commandId: input.commandId,
      }),
    })),

  syncLabels: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/labels/sync",
      summary: "Sync native personal Zalo labels into tags",
      description:
        "Maps provider-native labels and direct-contact assignments into account-scoped channel tag mappings.",
      tags: ["Zalo Accounts"],
    })
    .input(groupScopeInput.extend({ commandId: commandIdSchema }))
    .output(
      z.object({
        version: z.number().int().nonnegative(),
        labelCount: z.number().int().nonnegative(),
        destructiveDiffApplied: z.boolean(),
      }),
    )
    .errors(writeErrors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountLabelService.sync({
          workspaceId: context.workspace.id,
          accountId: input.accountId,
          commandId: input.commandId,
        }),
    ),

  updateGroupPolicy: workspaceTokenAuthAPI
    .route({
      method: "PATCH",
      path: "/v1/zalo-accounts/{accountId}/groups/{id}/policy",
      summary: "Enable or disable personal Zalo group sending",
      description:
        "Changes the explicit sending gate for one synchronized group; inaccessible groups remain unsendable.",
      tags: ["Zalo Accounts"],
    })
    .input(
      groupScopeInput.extend({
        id: groupIdSchema,
        sendEnabled: z
          .boolean()
          .describe("Whether outbound messages are allowed for this group"),
      }),
    )
    .output(zaloAccountGroupResource)
    .errors(writeErrors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupService.updatePolicy({
          workspaceId: context.workspace.id,
          accountId: input.accountId,
          id: input.id,
          sendEnabled: input.sendEnabled,
        }),
    ),

  sendGroupMessage: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/groups/{id}/messages",
      summary: "Send message to enabled personal Zalo group",
      description:
        "Sends exactly one text or supported attachment after verifying that the group's sending policy is enabled.",
      tags: ["Zalo Accounts"],
    })
    .input(
      groupScopeInput
        .extend({
          id: groupIdSchema,
          commandId: commandIdSchema,
          text: z
            .string()
            .trim()
            .min(1)
            .max(20_000)
            .optional()
            .describe("Text to send; mutually exclusive with attachment"),
          attachment: zaloAccountAttachmentSchema
            .optional()
            .describe("Image or file to send; mutually exclusive with text"),
        })
        .superRefine((input, context) => {
          if (Boolean(input.text) === Boolean(input.attachment)) {
            context.addIssue({
              code: "custom",
              message: "Provide exactly one of text or attachment",
            })
          }
        }),
    )
    .output(
      z.object({
        messageIds: z.array(z.string()),
        sentCount: z.number().int().nonnegative(),
      }),
    )
    .errors(writeErrors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupService.send({
          workspaceId: context.workspace.id,
          accountId: input.accountId,
          groupId: input.id,
          commandId: input.commandId,
          message: {
            ...(input.text ? { text: input.text } : {}),
            attachments: input.attachment ? [input.attachment] : [],
            quote: undefined,
          },
        }),
    ),
}
