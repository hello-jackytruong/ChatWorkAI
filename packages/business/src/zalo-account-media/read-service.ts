import {
  createMessageRepository,
  integrationZaloAccountGroupRepository,
  type MessageWithAttachments,
  zaloAccountMediaRepository as repository,
} from "@chatbotx.io/database/repositories"
import { uploader } from "@chatbotx.io/filesystem"
import { contactInboxService } from "../contact-inbox/service"
import { notFoundException, validationException } from "../errors"
import { buildZaloMessageResources } from "../media/zalo-account-capture"
import { zaloAccountService } from "../zalo-account/service"
import { safeMediaError } from "./policy"
import { zaloAccountMediaService } from "./service"
import type { MediaJoined, MediaScope } from "./types"

type ContentScope = MediaScope & {
  conversationId?: string
  ownerKind?: "account" | "group" | "contact" | "sticker"
  ownerId?: string
}
const httpSourcePattern = /^https?:/
const limitOf = (limit = 50) => Math.max(1, Math.min(50, limit))
const metadataSource = (
  detected: boolean,
  provider: boolean,
): "detected" | "provider" | "unknown" => {
  if (detected) {
    return "detected"
  }
  if (provider) {
    return "provider"
  }
  return "unknown"
}
const safe = ({ reference: r, asset: a }: MediaJoined) => ({
  referenceId: r.id,
  accountId: r.accountId,
  ownerKind: r.ownerKind,
  ownerId: r.ownerId,
  messageId: r.messageId,
  attachmentId: r.attachmentId,
  role: r.role,
  kind: a.kind,
  sourceRevision: r.sourceRevision,
  state: a.state,
  projection: r.projectionState,
  errorCode: a.errorCode ? safeMediaError(a.errorCode) : null,
  attempts: a.attempts,
  lastAttemptAt: a.lastAttemptAt ?? null,
  nextAttemptAt: a.nextAttemptAt ?? null,
  checksum: a.checksum ?? null,
  providerResourceId: a.providerResourceId ?? null,
  fileName: a.fileName,
  mimeType: a.mimeType,
  size: a.size,
  width: a.width ?? a.providerMetadata?.width ?? null,
  height: a.height ?? a.providerMetadata?.height ?? null,
  duration: a.duration,
  durationMs: a.duration ?? a.providerMetadata?.durationMs ?? null,
  durationSource: metadataSource(
    a.duration != null,
    a.providerMetadata?.durationMs != null,
  ),
  dimensionsSource: metadataSource(
    a.width != null && a.height != null,
    a.providerMetadata?.width != null || a.providerMetadata?.height != null,
  ),
})
const sameTime = (a: Date | null, b: Date) =>
  a !== null && new Date(a).getTime() === new Date(b).getTime()

export class ZaloAccountMediaReadService {
  private async currentRows(
    input: ContentScope & {
      referenceId?: string
      limit?: number
      cursor?: string
    },
  ) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Media reference not found")
    }
    if (!input.conversationId) {
      if (!(input.ownerKind && input.ownerId)) {
        throw notFoundException("Media owner not found")
      }
      let currentOwner = false
      if (input.ownerKind === "account") {
        currentOwner = input.ownerId === account.id
      }
      if (input.ownerKind === "group") {
        currentOwner = Boolean(
          await integrationZaloAccountGroupRepository.findByProviderId({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            providerGroupId: input.ownerId,
          }),
        )
      }
      if (input.ownerKind === "contact") {
        currentOwner = Boolean(
          await contactInboxService.findByUncached({
            where: {
              inboxId: account.inboxId,
              channel: "zaloAccount",
              sourceId: input.ownerId,
            },
          }),
        )
      }
      if (input.ownerKind === "sticker") {
        currentOwner = true
      }
      if (!currentOwner) {
        throw notFoundException("Media owner not found")
      }
      const rows = await repository.list({
        ...input,
        manageResources: true,
        limit: limitOf(input.limit),
      })
      return {
        rows: rows.filter(
          (row) =>
            row.reference.workspaceId === input.workspaceId &&
            row.reference.accountId === input.accountId &&
            row.reference.ownerKind === input.ownerKind &&
            row.reference.ownerId === input.ownerId &&
            (!input.referenceId || row.reference.id === input.referenceId),
        ),
        nextCursor:
          rows.length === limitOf(input.limit)
            ? rows.at(-1)?.reference.id
            : undefined,
      }
    }
    const rows = await repository.list({
      ...input,
      conversationIds: [input.conversationId],
      manageResources: false,
      limit: limitOf(input.limit),
    })
    const candidates = rows.filter(
      (row) =>
        row.reference.workspaceId === input.workspaceId &&
        row.reference.accountId === input.accountId &&
        row.reference.conversationId === input.conversationId &&
        row.reference.ownerKind === "message" &&
        row.reference.messageId &&
        row.reference.messageCreatedAt &&
        (!input.referenceId || row.reference.id === input.referenceId),
    )
    const repo = await createMessageRepository()
    const parents = await repo.findManyForTranslation(
      input.workspaceId,
      candidates.map((row) => ({
        id: row.reference.messageId as string,
        createdAt: row.reference.messageCreatedAt as Date,
      })),
    )
    const inboxes = await contactInboxService.findManyByIds({
      workspaceId: input.workspaceId,
      ids: [...new Set(parents.map((parent) => parent.contactInboxId))],
    })
    const visible = candidates.filter((row) =>
      parents.some(
        (parent) =>
          parent.id === row.reference.messageId &&
          sameTime(row.reference.messageCreatedAt, parent.createdAt) &&
          !parent.deletedAt &&
          parent.conversationId === input.conversationId &&
          inboxes.some(
            (inbox) =>
              inbox.id === parent.contactInboxId &&
              inbox.channel === "zaloAccount" &&
              inbox.inboxId === account.inboxId,
          ),
      ),
    )
    return {
      rows: visible,
      nextCursor:
        rows.length === limitOf(input.limit)
          ? rows.at(-1)?.reference.id
          : undefined,
    }
  }
  async list(input: ContentScope & { limit?: number; cursor?: string }) {
    const result = await this.currentRows(input)
    return { nextCursor: result.nextCursor, data: result.rows.map(safe) }
  }
  async get(input: ContentScope & { referenceId: string }) {
    const { rows } = await this.currentRows({ ...input, limit: 1 })
    if (!rows[0]) {
      throw notFoundException("Media reference not found")
    }
    return safe(rows[0])
  }
  async download(input: ContentScope & { referenceId: string }) {
    const { rows } = await this.currentRows({ ...input, limit: 1 })
    const row = rows[0]
    if (!row) {
      throw notFoundException("Media reference not found")
    }
    const prefix = `workspace/${input.workspaceId}/zalo-account/${input.accountId}/`
    if (
      row.asset.state !== "stored" ||
      row.asset.deletionPhase !== "active" ||
      !row.asset.objectKey?.startsWith(prefix) ||
      row.asset.objectKey.includes("..")
    ) {
      throw notFoundException("Media is not stored")
    }
    return {
      url: await uploader.getPresignedDownload(row.asset.objectKey, 300),
      expiresIn: 300 as const,
      mimeType: row.asset.mimeType,
      fileName: row.asset.fileName,
    }
  }
  async retry(
    input: ContentScope & {
      referenceId: string
      expectedSourceRevision: string
      readOnly?: boolean
    },
  ) {
    await this.get(input)
    return await zaloAccountMediaService.retry({
      ...input,
      conversationIds: input.conversationId
        ? [input.conversationId]
        : undefined,
      manageResources: !input.conversationId,
    })
  }

  async backfill(
    input: ContentScope & {
      from: Date
      to: Date
      dryRun: boolean
      limit?: number
      cursor?: { createdAt: Date; id: string }
    },
  ) {
    if (
      !input.conversationId ||
      input.from > input.to ||
      input.to.getTime() - input.from.getTime() > 31 * 86_400_000
    ) {
      throw validationException(
        "from",
        "Media window must be ordered and no longer than 31 days",
      )
    }
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    const repo = await createMessageRepository()
    const page = await repo.listByConversation({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sinceTime: input.from,
      pagination: {
        limit: Math.min(4, limitOf(input.limit)),
        cursor: input.cursor ?? { createdAt: input.to, id: "" },
      },
    })
    const inboxes = await contactInboxService.findManyByIds({
      workspaceId: input.workspaceId,
      ids: [...new Set(page.data.map((message) => message.contactInboxId))],
    })
    let eligible = 0,
      registered = 0
    for (const message of page.data) {
      if (
        message.deletedAt ||
        message.conversationId !== input.conversationId ||
        message.createdAt < input.from ||
        message.createdAt > input.to ||
        !inboxes.some(
          (inbox) =>
            inbox.id === message.contactInboxId &&
            inbox.channel === "zaloAccount" &&
            inbox.inboxId === account.inboxId,
        )
      ) {
        continue
      }
      const metadata = message.contentAttributes?.zaloAccount
      const attributes =
        typeof metadata === "object" && metadata !== null
          ? (metadata as Record<string, unknown>)
          : {}
      const group =
        typeof attributes.group === "object" && attributes.group !== null
          ? (attributes.group as Record<string, unknown>)
          : {}
      const parts = message.sourceId?.split(":") ?? []
      const stringOf = (value: unknown) =>
        typeof value === "string" ? value : undefined
      const threadId =
        stringOf(attributes.threadId) ?? stringOf(group.threadId) ?? parts[3]
      const providerMessageId =
        stringOf(attributes.providerMessageId) ??
        stringOf(group.providerMessageId) ??
        parts.at(-1)
      if (!threadId) {
        continue
      }
      const resources = buildZaloMessageResources({
        ...input,
        conversationId: input.conversationId,
        messageId: message.id,
        messageCreatedAt: message.createdAt,
        threadId,
        threadType: parts[2] === "group" ? "group" : "user",
        providerMessageId,
        attachments: message.attachments.filter((attachment) =>
          ["image", "file", "video", "audio"].includes(attachment.fileType),
        ),
        outgoing:
          message.messageType === "outgoing" &&
          message.attachments.some(
            (attachment) => !httpSourcePattern.test(attachment.originPath),
          ),
      })
      const bounded = resources.slice(0, 50 - eligible)
      eligible += bounded.length
      if (!input.dryRun && bounded.length) {
        const references = await zaloAccountMediaService.registerResources({
          ...input,
          resources: bounded,
        })
        registered += references.length
      }
      if (eligible >= 50) {
        break
      }
    }
    return {
      dryRun: input.dryRun,
      scanned: page.data.length,
      eligible,
      registered,
      nextCursor: page.nextCursor,
    }
  }
  async reconcile(
    input: ContentScope & {
      dryRun: true
      limit?: number
      cursor?: string
      objectCursor?: string
    },
  ) {
    const deadline = AbortSignal.timeout(15_000)
    const { rows, nextCursor } = await this.currentRows(input)
    const data: Array<{
      referenceId: string
      status: "present" | "missing" | "unknown"
    }> = []
    for (const row of rows) {
      if (row.asset.state !== "stored" || !row.asset.objectKey) {
        continue
      }
      let status: "present" | "missing" | "unknown" = "unknown"
      try {
        if (deadline.aborted) {
          throw new Error("Reconciliation deadline reached")
        }
        await uploader.headObject(row.asset.objectKey, {
          abortSignal: deadline,
        })
        status = "present"
      } catch (error) {
        const code =
          error && typeof error === "object" && "name" in error
            ? error.name
            : undefined
        if (code === "NotFound" || code === "NoSuchKey") {
          status = "missing"
        }
      }
      data.push({ referenceId: row.reference.id, status })
    }
    let objectScanStatus: "complete" | "unknown" = "unknown",
      unreferencedCandidates = 0,
      nextObjectCursor: string | undefined
    try {
      const prefix = `workspace/${input.workspaceId}/zalo-account/${input.accountId}/`
      if (deadline.aborted) {
        throw new Error("Reconciliation deadline reached")
      }
      const objects = await uploader.listObjects(
        prefix,
        {
          MaxKeys: 100,
          ContinuationToken: input.objectCursor,
        },
        { abortSignal: deadline },
      )
      const keys = (objects.Contents ?? [])
        .flatMap((item) => (item.Key?.startsWith(prefix) ? [item.Key] : []))
        .slice(0, 100)
      const known = await repository.findKnownObjectKeys({
        ...input,
        objectKeys: keys,
      })
      const knownSet = new Set(
        known.flatMap((row) =>
          [
            row.objectKey,
            row.candidateKey,
            ...(row.candidateKeys ?? []),
          ].filter((key): key is string => typeof key === "string"),
        ),
      )
      unreferencedCandidates = keys.filter((key) => !knownSet.has(key)).length
      nextObjectCursor = objects.NextContinuationToken
      objectScanStatus = "complete"
    } catch {
      /* A failed storage or database read proves no absence. */
    }
    return {
      dryRun: true as const,
      data,
      nextCursor,
      objectScanStatus,
      unreferencedCandidates,
      nextObjectCursor,
    }
  }

  async projectProfiles(input: {
    workspaceId: string
    owners: Array<{
      accountId: string
      ownerKind: "account" | "group" | "contact" | "member"
      ownerId: string
      sourceRevision?: string
    }>
  }) {
    const rows = await repository.listForProfiles(input)
    const result = new Map<string, { avatarUrl?: string; coverUrl?: string }>()
    for (const row of rows) {
      if (
        row.asset.state !== "stored" ||
        row.asset.deletionPhase !== "active" ||
        !row.asset.objectKey
      ) {
        continue
      }
      const prefix = `workspace/${input.workspaceId}/zalo-account/${row.reference.accountId}/`
      if (
        !row.asset.objectKey.startsWith(prefix) ||
        row.asset.objectKey.includes("..")
      ) {
        continue
      }
      const owner = input.owners.find(
        (item) =>
          item.accountId === row.reference.accountId &&
          item.ownerKind === row.reference.ownerKind &&
          item.ownerId === row.reference.ownerId,
      )
      if (
        !owner ||
        (owner.sourceRevision &&
          owner.sourceRevision !== row.reference.sourceRevision)
      ) {
        continue
      }
      const key = JSON.stringify([
        owner.accountId,
        owner.ownerKind,
        owner.ownerId,
      ])
      const existing = result.get(key) ?? {}
      const url = await uploader.getPresignedDownload(row.asset.objectKey, 300)
      if (row.reference.role === "avatar") {
        existing.avatarUrl = url
      }
      if (row.reference.role === "cover") {
        existing.coverUrl = url
      }
      result.set(key, existing)
    }
    return result
  }

  /** Caller already authorized these current Message rows. Query once per bounded page. */
  async projectMessages(input: {
    workspaceId: string
    messages: MessageWithAttachments[]
    inboxByContactInboxId: Map<
      string,
      { channel: string; inboxId: string | null }
    >
  }) {
    const rows = await repository.listForMessages({
      workspaceId: input.workspaceId,
      messageIds: input.messages.slice(0, 50).map((message) => message.id),
    })
    const result = new Map<
      string,
      Array<ReturnType<typeof safe> & { url: string | null }>
    >()
    for (const row of rows) {
      const message = input.messages.find(
        (value) =>
          value.id === row.reference.messageId &&
          value.conversationId === row.reference.conversationId &&
          sameTime(row.reference.messageCreatedAt, value.createdAt),
      )
      const binding = message
        ? input.inboxByContactInboxId.get(message.contactInboxId)
        : undefined
      if (
        !message ||
        message.deletedAt ||
        binding?.channel !== "zaloAccount" ||
        binding.inboxId !== row.accountInboxId
      ) {
        continue
      }
      const key = row.asset.objectKey
      const prefix = `workspace/${input.workspaceId}/zalo-account/${row.reference.accountId}/`
      const url =
        row.asset.state === "stored" &&
        row.asset.deletionPhase === "active" &&
        key?.startsWith(prefix) &&
        !key.includes("..")
          ? await uploader.getPresignedDownload(key, 300)
          : null
      const resources = result.get(message.id) ?? []
      resources.push({ ...safe(row), url })
      result.set(message.id, resources)
    }
    return result
  }
}
export const zaloAccountMediaReadService = new ZaloAccountMediaReadService()
