import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const zaloAccountResource = z
  .object({
    id: z.string(),
    inboxId: z.string(),
    zaloUid: z.string(),
    name: z.string(),
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
    accessible: z.boolean(),
    lastSyncRunId: z.string(),
    lastSyncedAt: z.date(),
    inaccessibleAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .omit({ workspaceId: true })

export type ZaloAccountGroupResource = z.infer<typeof zaloAccountGroupResource>
