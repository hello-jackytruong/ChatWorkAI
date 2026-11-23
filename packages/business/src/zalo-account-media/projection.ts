import {
  createMessageRepository,
  zaloAccountMediaRepository as repository,
} from "@chatbotx.io/database/repositories"
import { uploader } from "@chatbotx.io/filesystem"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import { publishWorkspaceRealtimeEvent } from "../platform/realtime-broadcast"
import { withBlockedOwnerGuard } from "../workspace-lifecycle/with-blocked-owner-guard"
import type { MediaScope } from "./types"

/** Shard path writes use origin CAS; the main-store revision remains retryable until both stores agree. */
export async function applyZaloAccountMediaProjection(
  input: MediaScope & { assetId: string },
) {
  return (
    (await withBlockedOwnerGuard(input.workspaceId, async () => {
      const asset = await repository.byId(input)
      if (
        asset?.state !== "stored" ||
        !asset.objectKey ||
        asset.deletionPhase !== "active"
      ) {
        return { applied: 0, pending: 0 }
      }
      const refs = await repository.assetReferences({
        ...input,
        pendingOnly: true,
      })
      const messageRepository = await createMessageRepository()
      let applied = 0
      let pending = 0
      for (const ref of refs) {
        if (ref.ownerKind !== "message" || ref.projectionState === "applied") {
          continue
        }
        if (!(ref.messageId && ref.messageCreatedAt && ref.conversationId)) {
          pending++
          continue
        }
        try {
          const parent = await messageRepository.findById({
            workspaceId: input.workspaceId,
            id: ref.messageId,
            createdAt: ref.messageCreatedAt,
            conversationId: ref.conversationId,
            primaryAndFailOnError: true,
          })
          if (parent && !parent.deletedAt && !ref.attachmentId) {
            const marked = await repository.markProjected({
              ...input,
              referenceId: ref.id,
              sourceRevision: ref.sourceRevision,
            })
            if (marked.length) {
              applied++
            } else {
              pending++
            }
            continue
          }
          const attachment = parent?.attachments.find(
            (item) => item.id === ref.attachmentId,
          )
          if (!(parent && attachment) || parent.deletedAt) {
            pending++
            continue
          }
          const current = await repository.currentReference({
            ...input,
            referenceId: ref.id,
            sourceRevision: ref.sourceRevision,
          })
          if (!current) {
            continue
          }
          const preview =
            ref.role === "preview" ||
            ref.role === "thumbnail" ||
            ref.role === "poster"
          const fields = preview
            ? {
                originPath: attachment.originPath,
                mimeType: attachment.mimeType,
                size: attachment.size,
                thumbnailPath: asset.objectKey,
              }
            : {
                originPath: asset.objectKey,
                mimeType: asset.mimeType ?? attachment.mimeType,
                size: asset.size ?? attachment.size,
                width: asset.width ?? undefined,
                height: asset.height ?? undefined,
              }
          const count = await messageRepository.updateAttachment({
            workspaceId: input.workspaceId,
            id: attachment.id,
            createdAt: attachment.createdAt,
            expectedOriginPath: attachment.originPath,
            fields,
          })
          if (!count) {
            pending++
            continue
          }
          if (
            ref.role === "original" &&
            asset.objectKey.startsWith(
              `workspace/${input.workspaceId}/zalo-account/${input.accountId}/`,
            )
          ) {
            const owner = await repository.currentOwnerRoute({
              ...input,
              conversationId: ref.conversationId,
              contactInboxId: parent.contactInboxId,
            })
            const currentParent = await messageRepository.findById({
              workspaceId: input.workspaceId,
              id: ref.messageId,
              createdAt: ref.messageCreatedAt,
              conversationId: ref.conversationId,
              primaryAndFailOnError: true,
            })
            if (owner && currentParent && !currentParent.deletedAt) {
              const url = await uploader.getPresignedDownload(
                asset.objectKey,
                300,
              )
              await publishWorkspaceRealtimeEvent(input.workspaceId, {
                eventType: RealtimeEventType.messageUpdated,
                route: routeForConversation(owner, owner.inboxId),
                data: {
                  messageId: ref.messageId,
                  attachmentId: attachment.id,
                  newText: currentParent.text ?? "",
                  newAttachmentPublicUrl: url,
                  newAttachmentMimeType: asset.mimeType ?? attachment.mimeType,
                  newAttachmentSize: asset.size ?? attachment.size,
                  newAttachmentWidth: asset.width ?? undefined,
                  newAttachmentHeight: asset.height ?? undefined,
                },
              })
            }
          }
          const marked = await repository.markProjected({
            ...input,
            referenceId: ref.id,
            sourceRevision: ref.sourceRevision,
          })
          if (marked.length) {
            applied++
          } else {
            pending++
          }
        } catch {
          pending++
        }
      }
      return { applied, pending }
    })) ?? { applied: 0, pending: 0 }
  )
}
