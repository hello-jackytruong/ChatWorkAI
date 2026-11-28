import { z } from "zod"

export const nativeLabelSyncState = z.enum(["idle", "queued", "running"])

export const nativeLabelResource = z.strictObject({
  id: z.number().int().nonnegative(),
  text: z.string(),
  color: z.string().optional(),
  emoji: z.string(),
  offset: z.number().int(),
  tagId: z.string().optional(),
  tagName: z.string().optional(),
})

export const nativeLabelList = z.strictObject({
  available: z.boolean(),
  complete: z.boolean(),
  version: z.number().int().nonnegative().optional(),
  editEnabled: z.boolean(),
  lastSuccessAt: z.iso.datetime().optional(),
  reason: z.string().optional(),
  syncState: nativeLabelSyncState.optional(),
  labels: z.array(nativeLabelResource).max(1000),
})

export const nativeLabelEdit = z.strictObject({
  commandId: z
    .string()
    .min(1)
    .max(200)
    .describe("Stable command ID for editing the same selected label"),
  labelId: z
    .number()
    .int()
    .nonnegative()
    .describe("Native label ID from zaloAccounts.listNativeLabels"),
  patch: z
    .strictObject({
      text: z.string().trim().min(1).max(200).optional(),
      color: z
        .string()
        .regex(/^#[a-f0-9]{6}$/i)
        .optional(),
      emoji: z.string().max(50).optional(),
    })
    .refine((value) => Object.keys(value).length > 0)
    .describe("Only the label name, color or emoji fields to edit"),
})

export const nativeLabelEditResult = z.strictObject({
  outcome: z.enum(["confirmed", "conflict", "unknown", "unavailable"]),
  version: z.number().int().nonnegative().optional(),
  label: nativeLabelResource.optional(),
})
