import type { UploadedFile } from "@chatbotx.io/filesystem"
import {
  type ZaloAccountDispatchContent,
  type ZaloAccountRichContent,
  type ZaloAccountSendMention,
  zaloAccountSendContentSchema,
} from "@chatbotx.io/sdk"
import { validationException } from "../errors"
import { getPublicFileUrl } from "../utils"

export type ZaloAccountComposerUpload =
  | {
      type: "media"
      caption?: string
      mediaFileIds?: string[]
      files?: File[]
      mentions?: ZaloAccountSendMention[]
    }
  | { type: "voice"; mediaFileId?: string; file?: File; durationMs?: number }
  | {
      type: "video"
      mediaFileId: string
      posterMediaFileId: string
      caption?: string
      durationMs?: number
      width?: number
      height?: number
    }

export function selectedZaloMedia(
  upload: ZaloAccountComposerUpload | undefined,
): {
  ids: string[]
  files: File[]
} {
  switch (upload?.type) {
    case "media":
      return { ids: upload.mediaFileIds ?? [], files: upload.files ?? [] }
    case "video":
      return { ids: [upload.mediaFileId, upload.posterMediaFileId], files: [] }
    case "voice":
      return {
        ids: upload.mediaFileId ? [upload.mediaFileId] : [],
        files: upload.file ? [upload.file] : [],
      }
    default:
      return { ids: [], files: [] }
  }
}

export const withPreparedZaloMedia = (
  content: ZaloAccountDispatchContent | undefined,
  upload: ZaloAccountComposerUpload | undefined,
  files: Array<
    Pick<UploadedFile, "originPath" | "mimeType" | "size"> & {
      fileType: UploadedFile["fileType"] | "gif"
      name: string | null
    }
  >,
  storageUrl: string,
): ZaloAccountDispatchContent | undefined => {
  if (content?.kind === "voice" || content?.kind === "video") {
    const [primary, poster] = files
    if (!primary) {
      return content
    }
    if (content.kind === "voice" && primary.fileType === "audio") {
      return {
        ...content,
        url: getPublicFileUrl(primary.originPath, storageUrl),
      }
    }
    if (
      content.kind === "video" &&
      primary.fileType === "video" &&
      poster?.fileType === "image"
    ) {
      return {
        ...content,
        url: getPublicFileUrl(primary.originPath, storageUrl),
        thumbnailUrl: getPublicFileUrl(poster.originPath, storageUrl),
      }
    }
    throw validationException(
      "content",
      "The Zalo media and poster types do not match the message",
    )
  }
  if (upload?.type === "voice" || upload?.type === "video") {
    const [primary, poster] = files
    if (upload.type === "voice" && primary?.fileType === "audio" && !poster) {
      return zaloAccountSendContentSchema.parse({
        kind: "voice",
        url: getPublicFileUrl(primary.originPath, storageUrl),
      })
    }
    if (
      upload.type === "video" &&
      primary?.fileType === "video" &&
      poster?.fileType === "image"
    ) {
      return zaloAccountSendContentSchema.parse({
        kind: "video",
        url: getPublicFileUrl(primary.originPath, storageUrl),
        thumbnailUrl: getPublicFileUrl(poster.originPath, storageUrl),
        caption: upload.caption,
        durationMs: upload.durationMs,
        width: upload.width,
        height: upload.height,
      })
    }
    throw validationException(
      "content",
      "The Zalo media and poster types do not match the message",
    )
  }
  if (upload?.type === "media" || (content?.kind === "media" && files.length)) {
    return zaloAccountSendContentSchema.parse({
      ...(content?.kind === "media"
        ? content
        : {
            kind: "media",
            caption: upload?.type === "media" ? upload.caption : undefined,
            mentions: upload?.type === "media" ? upload.mentions : undefined,
          }),
      attachments: files.map(
        ({ originPath, name, mimeType, size, fileType }) => {
          if (!["image", "gif", "file"].includes(fileType)) {
            throw validationException(
              "content",
              "Use a dedicated voice or video message for this file",
            )
          }
          return {
            kind: fileType === "file" ? "file" : "image",
            name: name ?? undefined,
            mimeType,
            size,
            url: getPublicFileUrl(originPath, storageUrl),
          }
        },
      ),
    })
  }
  return content
}

export const zaloRichText = (
  content: ZaloAccountDispatchContent | undefined,
) => {
  switch (content?.kind) {
    case "text":
    case "forward":
      return content.text
    case "link":
      return content.text ?? content.url
    case "media":
    case "video":
      return content.caption
    default:
      return
  }
}

export const outgoingPresentation = (
  content: ZaloAccountDispatchContent,
): ZaloAccountRichContent | undefined => {
  switch (content.kind) {
    case "sticker":
      return content
    case "link":
      return { kind: "link", url: content.url }
    case "contactCard":
      return {
        kind: "contact",
        userId: content.userId,
        phone: content.phoneNumber,
      }
    case "bankCard":
      return {
        kind: "bank",
        accountName: content.accountName,
        accountNumber: content.accountNumber,
      }
    case "text":
    case "media":
      return content.styles?.length
        ? {
            kind: "styledText",
            spans: content.styles.map(({ start, len, st }) => ({
              offset: start,
              length: len,
              style: st,
            })),
          }
        : undefined
    default:
      return
  }
}
