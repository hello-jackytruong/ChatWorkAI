import z from "zod"

export const zaloAccountNativeOperations = z.enum([
  "undo",
  "deleteMessage",
  "deleteChat",
])
export const zaloAccountNativeOperationStatuses = z.enum([
  "pending",
  "dispatched",
  "applied",
  "failed",
  "unknown",
])
export type ZaloAccountNativeOperation = z.infer<
  typeof zaloAccountNativeOperations
>
export type ZaloAccountNativeOperationStatus = z.infer<
  typeof zaloAccountNativeOperationStatuses
>
export type ZaloAccountRecallScanCursor = {
  shardId: string
  rangeStart: string
  rangeEnd: string
  afterId?: string
  afterCreatedAt?: string
}
export type ZaloAccountLifecycle = {
  version: 1
  lifecycleRevision: number
  recallId: string
  recalled: boolean
  placeholder: boolean
  originalObserved: boolean
  localHiddenAt: string | null
  providerDeletedForMeAt: string | null
}
