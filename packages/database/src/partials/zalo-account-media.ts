import { z } from "zod"
export const zaloAccountMediaStates = z.enum([
  "pending",
  "downloading",
  "stored",
  "failed",
  "expired",
])
export const zaloAccountMediaOwnerKinds = z.enum([
  "message",
  "account",
  "contact",
  "member",
  "group",
  "sticker",
  "quickMessage",
])
export const zaloAccountMediaRoles = z.enum([
  "original",
  "thumbnail",
  "poster",
  "preview",
  "card_image",
  "avatar",
  "cover",
  "sticker",
  "sprite",
])
export const zaloAccountMediaKinds = z.enum([
  "image",
  "file",
  "video",
  "audio",
  "gif",
  "sticker",
])
export const zaloAccountMediaDeletionPhases = z.enum([
  "active",
  "closing",
  "deleting",
  "confirmed",
])
export const zaloAccountMediaProjectionStates = z.enum([
  "pending",
  "applied",
  "failed",
])
