import { zaloAccountRuntimeStatusSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const zaloAccountResource = z
  .object({
    id: z.string(),
    inboxId: z.string(),
    zaloUid: z.string(),
    name: z.string(),
    groupMessagingEnabled: z.boolean(),
    avatarUrl: z.string().nullable(),
    sessionVerifiedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export type ZaloAccountResource = z.infer<typeof zaloAccountResource>

export const zaloAccountGroupResource = z
  .object({
    id: zodBigintAsString(),
    workspaceId: zodBigintAsString(),
    accountId: zodBigintAsString(),
    providerGroupId: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
    memberCount: z.number().int(),
    providerVersion: z.string().nullable(),
    sendEnabled: z.boolean(),
    receiveEnabled: z.boolean(),
    automationMode: z.enum(["disabled", "mentionOnly", "all"]),
    contactInboxId: z.string().nullable(),
    conversationId: z.string().nullable(),
    accessible: z.boolean(),
    lastSyncRunId: z.string(),
    lastSyncedAt: z.date(),
    inaccessibleAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .omit({ workspaceId: true })

export type ZaloAccountGroupResource = z.infer<typeof zaloAccountGroupResource>

const syncStatus = z.object({
  complete: z.boolean(),
  count: z.number().int().nonnegative(),
  completedAt: z.string().nullable(),
})
export const zaloAccountStatusResource = z.object({
  runtime: zaloAccountRuntimeStatusSchema.nullable().optional(),
  accountId: z.string(),
  groupMessagingEnabled: z.boolean(),
  status: z.string(),
  reason: z.string().nullable(),
  gatewayAvailable: z.boolean(),
  capabilities: z.object({
    text: z.boolean(),
    image: z.boolean(),
    file: z.boolean(),
    typing: z.boolean(),
    reactions: z.boolean(),
    revoke: z.boolean(),
    delete: z.boolean(),
  }),
  groups: syncStatus.extend({ reason: z.string().nullable() }),
  friends: syncStatus.extend({
    nextCursor: z.number().int().nullable(),
    reason: z.string().nullable(),
  }),
  labels: z.object({
    complete: z.boolean(),
    version: z.number().int(),
    paused: z.boolean(),
    completedAt: z.string().nullable(),
    reason: z.string().nullable(),
  }),
})
export type ZaloAccountStatusResource = z.infer<
  typeof zaloAccountStatusResource
>
