import type {
  ZaloAccountMediaAsset,
  ZaloAccountMediaReference,
} from "@chatbotx.io/database/types"
export type MediaScope = { workspaceId: string; accountId: string }
export type MediaSource =
  | { type: "provider_url"; url: string }
  | { type: "storage_key"; key: string }
export type RegisterMediaResource = {
  ownerKind: ZaloAccountMediaReference["ownerKind"]
  ownerId: string
  role: ZaloAccountMediaReference["role"]
  kind: ZaloAccountMediaAsset["kind"]
  sourceRevision: string
  source?: MediaSource
  conversationId?: string
  messageId?: string
  messageCreatedAt?: Date
  attachmentId?: string
  providerMessageId?: string
  providerResourceId?: string
  priority?: number
  attachmentCreatedAt?: Date
  slot?: string
  name?: string
  mimeType?: string
  width?: number
  height?: number
  durationMs?: number
  frameCount?: number
  fileName?: string
}
export type MediaLease = MediaScope & { assetId: string; leaseToken: string }
export type MediaAccess = {
  conversationIds?: string[]
  manageResources?: boolean
  readOnly?: boolean
}
export type MediaCompletion = MediaLease & {
  objectKey: string
  checksum: string
  mimeType: string
  size: number
  width?: number
  height?: number
  duration?: number
}
export type MediaJoined = {
  reference: ZaloAccountMediaReference
  asset: ZaloAccountMediaAsset
}
