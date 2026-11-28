import type { EncryptedData } from "@chatbotx.io/encryption"
import {
  and,
  asc,
  type DatabaseClient,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "../../client"
import { contactInboxModel } from "../../schema/contact-inbox"
import { conversationModel } from "../../schema/conversation"
import { inboxModel } from "../../schema/inbox"
import { integrationZaloAccountModel } from "../../schema/integration-zalo-account"
import { messageCleanupModel } from "../../schema/message-cleanup"
import {
  zaloAccountMediaAssetModel as asset,
  zaloAccountMediaReferenceModel as reference,
} from "../../schema/zalo-account-media"

type Scope = { workspaceId: string; accountId: string }
type Asset = typeof asset.$inferSelect

import { workspaceRepository } from "../workspace"

type Reference = typeof reference.$inferSelect
const assetScope = (s: Scope) =>
  and(eq(asset.workspaceId, s.workspaceId), eq(asset.accountId, s.accountId))
const numericRevisionPattern = /^\d+$/
const referenceScope = (s: Scope) =>
  and(
    eq(reference.workspaceId, s.workspaceId),
    eq(reference.accountId, s.accountId),
  )
export const zaloAccountMediaRepository = {
  async currentOwnerRoute(
    input: Scope & { conversationId: string; contactInboxId: string },
  ) {
    const [route] = await db
      .select({
        assignedUserId: conversationModel.assignedUserId,
        assignedInboxTeamId: conversationModel.assignedInboxTeamId,
        inboxId: integrationZaloAccountModel.inboxId,
      })
      .from(conversationModel)
      .innerJoin(
        contactInboxModel,
        and(
          eq(contactInboxModel.id, input.contactInboxId),
          eq(contactInboxModel.contactId, conversationModel.contactId),
          eq(contactInboxModel.channel, "zaloAccount"),
        ),
      )
      .innerJoin(
        integrationZaloAccountModel,
        and(
          eq(
            integrationZaloAccountModel.workspaceId,
            conversationModel.workspaceId,
          ),
          eq(integrationZaloAccountModel.inboxId, contactInboxModel.inboxId),
          eq(integrationZaloAccountModel.id, input.accountId),
        ),
      )
      .where(
        and(
          eq(conversationModel.workspaceId, input.workspaceId),
          eq(conversationModel.id, input.conversationId),
        ),
      )
      .limit(1)
    return route
  },

  async deferCandidateVerification(
    input: Scope & {
      assetId: string
      leaseToken: string
      nextAttemptAt?: Date
    },
  ) {
    return (
      (
        await db
          .update(asset)
          .set({
            nextAttemptAt:
              input.nextAttemptAt ?? new Date(Date.now() + 300_000),
          })
          .where(
            and(
              assetScope(input),
              eq(asset.id, input.assetId),
              eq(asset.leaseToken, input.leaseToken),
            ),
          )
          .returning({ id: asset.id })
      ).length > 0
    )
  },
  async deletedContactScopes(limit = 50) {
    return await db
      .select({
        workspaceId: messageCleanupModel.workspaceId,
        accountId: integrationZaloAccountModel.id,
        conversationIds: sql<
          string[]
        >`COALESCE((SELECT jsonb_agg(c."conversationId"::text) FROM (SELECT DISTINCT r."conversationId" FROM ${reference} r WHERE r."workspaceId" = ${messageCleanupModel.workspaceId} AND r."accountId" = ${integrationZaloAccountModel.id} AND r."ownerKind" = 'message' AND r."conversationId"::text IN (SELECT jsonb_array_elements_text(${messageCleanupModel.conversationIds})) LIMIT 100) c), '[]'::jsonb)`,
        sourceId: messageCleanupModel.sourceId,
      })
      .from(messageCleanupModel)
      .innerJoin(
        inboxModel,
        and(
          eq(inboxModel.id, messageCleanupModel.inboxId),
          eq(inboxModel.workspaceId, messageCleanupModel.workspaceId),
        ),
      )
      .innerJoin(
        integrationZaloAccountModel,
        and(
          eq(integrationZaloAccountModel.inboxId, messageCleanupModel.inboxId),
          eq(
            integrationZaloAccountModel.workspaceId,
            messageCleanupModel.workspaceId,
          ),
        ),
      )
      .where(
        and(
          eq(inboxModel.channel, "zaloAccount"),
          eq(messageCleanupModel.status, "pending"),
          sql`NOT EXISTS (SELECT 1 FROM ${contactInboxModel} ci WHERE ci."inboxId" = ${messageCleanupModel.inboxId} AND ci."sourceId" = ${messageCleanupModel.sourceId})`,
          sql`EXISTS (SELECT 1 FROM ${reference} r WHERE r."workspaceId" = ${messageCleanupModel.workspaceId} AND r."accountId" = ${integrationZaloAccountModel.id} AND ((r."ownerKind" = 'message' AND ${messageCleanupModel.conversationIds} @> jsonb_build_array(r."conversationId"::text)) OR (r."ownerKind" = 'contact' AND r."ownerId" = ${messageCleanupModel.sourceId})))`,
        ),
      )
      .orderBy(asc(messageCleanupModel.id))
      .limit(Math.max(1, Math.min(50, limit)))
  },
  async orphanCandidates(limit = 50) {
    return await db
      .select()
      .from(asset)
      .where(
        and(
          sql`${asset.identity} <> '__account_closing__'`,
          inArray(asset.deletionPhase, ["active", "closing", "deleting"]),
          or(
            sql`${asset.deletionPhase} <> 'active'`,
            isNull(asset.closingAt),
            lte(asset.closingAt, new Date(Date.now() - 86_400_000)),
          ),
          isNull(asset.leaseToken),
          or(
            isNull(asset.candidateKey),
            sql`${asset.remoteSettledAt} IS NOT NULL`,
          ),
          sql`NOT EXISTS (SELECT 1 FROM ${reference} r WHERE r."assetId" = ${asset.id})`,
        ),
      )
      .orderBy(asc(asset.closingAt), asc(asset.id))
      .limit(Math.max(1, Math.min(50, limit)))
  },
  async releaseConversationOwners(
    input: Scope & {
      conversationIds: string[]
      contactOwnerIds: string[]
      limit?: number
    },
    tx: DatabaseClient = db,
  ) {
    if (
      input.conversationIds.length > 100 ||
      input.contactOwnerIds.length > 100
    ) {
      throw new Error("Media owner page exceeded")
    }
    const condition = and(
      referenceScope(input),
      or(
        input.conversationIds.length
          ? and(
              eq(reference.ownerKind, "message"),
              inArray(reference.conversationId, input.conversationIds),
            )
          : sql`false`,
        input.contactOwnerIds.length
          ? and(
              eq(reference.ownerKind, "contact"),
              inArray(reference.ownerId, input.contactOwnerIds),
            )
          : sql`false`,
      ),
    )
    const rows = await tx
      .select({ id: reference.id })
      .from(reference)
      .where(condition)
      .limit(Math.max(1, Math.min(100, input.limit ?? 100)))
      .for("update")
    if (rows.length) {
      await tx.delete(reference).where(
        and(
          referenceScope(input),
          inArray(
            reference.id,
            rows.map((row) => row.id),
          ),
        ),
      )
    }
    const [remaining] = await tx
      .select({ id: reference.id })
      .from(reference)
      .where(condition)
      .limit(1)
    return { released: rows.length, remaining: Boolean(remaining) }
  },
  async admitOrphan(
    input: Scope & { assetId: string; now?: Date },
    tx: DatabaseClient = db,
  ) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.accountId}:media`}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(asset)
      .where(and(assetScope(input), eq(asset.id, input.assetId)))
      .limit(1)
      .for("update")
    if (
      !row ||
      row.identity === "__account_closing__" ||
      row.deletionPhase !== "active" ||
      row.leaseToken ||
      (row.candidateKey && !row.remoteSettledAt)
    ) {
      return null
    }
    const [live] = await tx
      .select({ id: reference.id })
      .from(reference)
      .where(and(referenceScope(input), eq(reference.assetId, row.id)))
      .limit(1)
    if (live) {
      return null
    }
    const now = input.now ?? new Date()
    if (!row.closingAt) {
      await tx.update(asset).set({ closingAt: now }).where(eq(asset.id, row.id))
      return null
    }
    if (now.getTime() - row.closingAt.getTime() < 86_400_000) {
      return null
    }
    const [candidate] = await tx
      .update(asset)
      .set({ deletionPhase: "closing" })
      .where(eq(asset.id, row.id))
      .returning()
    return candidate ?? null
  },
  async lockAccount(input: Scope, tx: DatabaseClient) {
    // Registration takes the workspace fence first; completion must use the same order.
    if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
      throw new Error("Workspace is closing")
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.accountId}:media`}, 0))`,
    )
  },
  async adoptVerifiedCandidate(
    input: Scope & {
      assetId: string
      leaseToken: string
      objectKey: string
      checksum: string
      size: number
      mimeType: string
    },
    tx: DatabaseClient = db,
  ) {
    const [row] = await tx
      .update(asset)
      .set({
        state: "stored",
        objectKey: input.objectKey,
        checksum: input.checksum,
        size: input.size,
        mimeType: input.mimeType,
        // HEAD proves usable bytes, but an older PUT may still finish later.
        // Retain its token until the transport itself confirms settlement.
        remoteSettledAt: null,
        nextAttemptAt: null,
        errorCode: null,
      })
      .where(
        and(
          assetScope(input),
          eq(asset.id, input.assetId),
          eq(asset.leaseToken, input.leaseToken),
          eq(asset.candidateKey, input.objectKey),
          eq(asset.deletionPhase, "active"),
          inArray(asset.state, ["downloading", "failed"]),
          lte(asset.leaseExpiresAt, new Date()),
          sql`EXISTS (SELECT 1 FROM "ZaloAccountMediaReference" r WHERE r."assetId" = ${asset.id} AND r."workspaceId" = ${asset.workspaceId} AND r."accountId" = ${asset.accountId})`,
        ),
      )
      .returning()
    return row ?? null
  },
  async projectionDue(limit = 50) {
    return await db
      .selectDistinct({
        workspaceId: asset.workspaceId,
        accountId: asset.accountId,
        assetId: asset.id,
      })
      .from(reference)
      .innerJoin(
        asset,
        and(
          eq(asset.id, reference.assetId),
          eq(asset.workspaceId, reference.workspaceId),
          eq(asset.accountId, reference.accountId),
        ),
      )
      .where(
        and(
          eq(reference.ownerKind, "message"),
          inArray(reference.projectionState, ["pending", "failed"]),
          eq(asset.state, "stored"),
          eq(asset.deletionPhase, "active"),
        ),
      )
      .orderBy(asc(asset.id))
      .limit(Math.max(1, Math.min(50, limit)))
  },
  async currentReference(
    input: Scope & {
      referenceId: string
      assetId: string
      sourceRevision: string
    },
  ) {
    const [row] = await db
      .select()
      .from(reference)
      .where(
        and(
          referenceScope(input),
          eq(reference.id, input.referenceId),
          eq(reference.assetId, input.assetId),
          eq(reference.sourceRevision, input.sourceRevision),
        ),
      )
      .limit(1)
    return row ?? null
  },
  async rotationPage(input: { cursor?: string; limit: number }) {
    return await db
      .select({
        id: asset.id,
        workspaceId: asset.workspaceId,
        accountId: asset.accountId,
        encryptedSource: asset.encryptedSource,
      })
      .from(asset)
      .where(input.cursor ? gt(asset.id, input.cursor) : undefined)
      .orderBy(asc(asset.id))
      .limit(Math.max(1, Math.min(50, input.limit)))
  },
  async replaceEncryptedSource(
    input: Scope & {
      assetId: string
      expected: EncryptedData
      replacement: EncryptedData
    },
  ) {
    return (
      (
        await db
          .update(asset)
          .set({ encryptedSource: input.replacement })
          .where(
            and(
              assetScope(input),
              eq(asset.id, input.assetId),
              sql`${asset.encryptedSource} = ${JSON.stringify(input.expected)}::jsonb`,
            ),
          )
          .returning({ id: asset.id })
      ).length > 0
    )
  },
  async expiredLeases(limit = 50) {
    return await db
      .select()
      .from(asset)
      .where(
        and(
          inArray(asset.state, ["downloading", "failed"]),
          sql`${asset.leaseToken} IS NOT NULL`,
          lte(asset.leaseExpiresAt, new Date()),
          or(isNull(asset.nextAttemptAt), lte(asset.nextAttemptAt, new Date())),
        ),
      )
      .orderBy(
        sql`${asset.nextAttemptAt} ASC NULLS FIRST`,
        asc(asset.leaseExpiresAt),
        asc(asset.id),
      )
      .limit(Math.max(1, Math.min(50, limit)))
  },
  async recoverUnstarted(limit = 50, tx: DatabaseClient = db) {
    const rows = await tx
      .select({ id: asset.id })
      .from(asset)
      .where(
        and(
          eq(asset.state, "downloading"),
          eq(asset.deletionPhase, "active"),
          lte(asset.leaseExpiresAt, new Date()),
          isNull(asset.candidateKey),
          sql`${asset.candidateKeys} = '[]'::jsonb`,
        ),
      )
      .limit(Math.max(1, Math.min(50, limit)))
      .for("update", { skipLocked: true })
    if (!rows.length) {
      return 0
    }
    return (
      await tx
        .update(asset)
        .set({
          state: sql`CASE WHEN ${asset.attempts} < 5 THEN 'pending'::"zaloAccountMediaState" ELSE 'failed'::"zaloAccountMediaState" END`,
          errorCode: "lease_lost",
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: sql`CASE WHEN ${asset.attempts} < 5 THEN now() ELSE NULL END`,
          remoteSettledAt: new Date(),
        })
        .where(
          inArray(
            asset.id,
            rows.map((row) => row.id),
          ),
        )
        .returning()
    ).length
  },
  async workspaceScopes(input: { workspaceId: string; limit?: number }) {
    return await db
      .selectDistinct({
        workspaceId: asset.workspaceId,
        accountId: asset.accountId,
      })
      .from(asset)
      .where(eq(asset.workspaceId, input.workspaceId))
      .orderBy(asc(asset.accountId))
      .limit(Math.max(1, Math.min(50, input.limit ?? 50)))
  },
  async workspaceRemaining(input: { workspaceId: string }) {
    const [row] = await db
      .select({ id: asset.id })
      .from(asset)
      .where(eq(asset.workspaceId, input.workspaceId))
      .limit(1)
    return Boolean(row)
  },
  async drainConfirmed(
    input: { workspaceId: string; limit?: number },
    tx: DatabaseClient = db,
  ) {
    const rows = await tx
      .select({ id: asset.id })
      .from(asset)
      .where(
        and(
          eq(asset.workspaceId, input.workspaceId),
          eq(asset.deletionPhase, "confirmed"),
        ),
      )
      .limit(Math.max(1, Math.min(100, input.limit ?? 100)))
      .for("update", { skipLocked: true })
    if (!rows.length) {
      return 0
    }
    const ids = rows.map((row) => row.id)
    await tx
      .delete(reference)
      .where(
        and(
          eq(reference.workspaceId, input.workspaceId),
          inArray(reference.assetId, ids),
        ),
      )
    return (
      await tx
        .delete(asset)
        .where(
          and(eq(asset.workspaceId, input.workspaceId), inArray(asset.id, ids)),
        )
        .returning({ id: asset.id })
    ).length
  },
  async canCompensate(
    input: Scope & { assetId: string; leaseToken: string; objectKey: string },
  ) {
    const [row] = await db
      .select({ id: asset.id })
      .from(asset)
      .where(
        and(
          assetScope(input),
          eq(asset.id, input.assetId),
          eq(asset.leaseToken, input.leaseToken),
          eq(asset.candidateKey, input.objectKey),
          isNull(asset.objectKey),
        ),
      )
      .limit(1)
    return Boolean(row)
  },
  async reserveCandidate(
    input: Scope & { assetId: string; leaseToken: string; objectKey: string },
  ) {
    return (
      (
        await db
          .update(asset)
          .set({
            candidateKey: input.objectKey,
            candidateKeys: sql`CASE WHEN ${asset.candidateKeys} @> ${JSON.stringify([input.objectKey])}::jsonb THEN ${asset.candidateKeys} ELSE ${asset.candidateKeys} || ${JSON.stringify([input.objectKey])}::jsonb END`,
          })
          .where(
            and(
              assetScope(input),
              eq(asset.id, input.assetId),
              eq(asset.leaseToken, input.leaseToken),
              eq(asset.deletionPhase, "active"),
              eq(asset.state, "downloading"),
              gt(asset.leaseExpiresAt, new Date()),
            ),
          )
          .returning()
      ).length > 0
    )
  },
  async listDeletionScopes(limit = 50) {
    return await db
      .selectDistinct({
        workspaceId: asset.workspaceId,
        accountId: asset.accountId,
      })
      .from(asset)
      .where(
        and(
          eq(asset.identity, "__account_closing__"),
          inArray(asset.deletionPhase, ["closing", "deleting"]),
        ),
      )
      .orderBy(asc(asset.workspaceId), asc(asset.accountId))
      .limit(Math.max(1, Math.min(50, limit)))
  },
  async findKnownObjectKeys(input: Scope & { objectKeys: string[] }) {
    if (input.objectKeys.length > 100) {
      throw new Error("Media reconcile page exceeded")
    }
    if (!input.objectKeys.length) {
      return []
    }
    return await db
      .select({
        id: asset.id,
        objectKey: asset.objectKey,
        candidateKey: asset.candidateKey,
        candidateKeys: asset.candidateKeys,
        leaseToken: asset.leaseToken,
        deletionPhase: asset.deletionPhase,
      })
      .from(asset)
      .where(
        and(
          assetScope(input),
          or(
            inArray(asset.objectKey, input.objectKeys),
            inArray(asset.candidateKey, input.objectKeys),
            sql`${asset.candidateKeys} ?| array[${sql.join(
              input.objectKeys.map((key) => sql`${key}`),
              sql`, `,
            )}]`,
          ),
        ),
      )
      .limit(100)
  },
  async isProtectedAttachment(input: {
    workspaceId: string
    attachmentId: string
  }) {
    const [row] = await db
      .select({ id: reference.id })
      .from(reference)
      .where(
        and(
          eq(reference.workspaceId, input.workspaceId),
          eq(reference.attachmentId, input.attachmentId),
        ),
      )
      .limit(1)
    return Boolean(row)
  },
  async byId(input: Scope & { assetId: string }, tx: DatabaseClient = db) {
    const [row] = await tx
      .select()
      .from(asset)
      .where(and(assetScope(input), eq(asset.id, input.assetId)))
      .limit(1)
    return row ?? null
  },
  async assetReferences(
    input: Scope & { assetId: string; pendingOnly?: boolean },
    tx: DatabaseClient = db,
  ) {
    return await tx
      .select()
      .from(reference)
      .where(
        and(
          referenceScope(input),
          eq(reference.assetId, input.assetId),
          input.pendingOnly
            ? inArray(reference.projectionState, ["pending", "failed"])
            : undefined,
        ),
      )
      .limit(50)
  },
  async listForMessages(input: { workspaceId: string; messageIds: string[] }) {
    if (input.messageIds.length > 50) {
      throw new Error("Media projection limit exceeded")
    }
    if (!input.messageIds.length) {
      return []
    }
    return await db
      .select({
        reference,
        asset,
        accountInboxId: integrationZaloAccountModel.inboxId,
      })
      .from(reference)
      .innerJoin(
        asset,
        and(
          eq(asset.id, reference.assetId),
          eq(asset.workspaceId, reference.workspaceId),
          eq(asset.accountId, reference.accountId),
        ),
      )
      .innerJoin(
        integrationZaloAccountModel,
        and(
          eq(integrationZaloAccountModel.id, reference.accountId),
          eq(integrationZaloAccountModel.workspaceId, reference.workspaceId),
        ),
      )
      .where(
        and(
          eq(reference.workspaceId, input.workspaceId),
          inArray(reference.messageId, input.messageIds),
        ),
      )
      .limit(600)
  },
  async settleRemote(
    input: Scope & { assetId: string; leaseToken: string; removed?: boolean },
  ) {
    return (
      (
        await db
          .update(asset)
          .set({
            leaseToken: null,
            leaseExpiresAt: null,
            remoteSettledAt: new Date(),
            state: sql`CASE WHEN ${asset.state} = 'downloading' THEN 'failed'::"zaloAccountMediaState" ELSE ${asset.state} END`,
            nextAttemptAt: sql`CASE WHEN ${asset.deletionPhase} = 'active' AND ${asset.state} IN ('downloading', 'failed') AND ${asset.attempts} < 5 THEN now() + interval '30 seconds' ELSE NULL END`,
            ...(input.removed ? { candidateKey: null } : {}),
          })
          .where(
            and(
              assetScope(input),
              eq(asset.id, input.assetId),
              eq(asset.leaseToken, input.leaseToken),
            ),
          )
          .returning()
      ).length > 0
    )
  },
  async listForProfiles(input: {
    workspaceId: string
    owners: Array<{ accountId: string; ownerKind: string; ownerId: string }>
  }) {
    if (!input.owners.length) {
      return []
    }
    if (input.owners.length > 50) {
      throw new Error("Media profile page limit exceeded")
    }
    return await db
      .select({
        reference,
        asset,
        accountInboxId: integrationZaloAccountModel.inboxId,
      })
      .from(reference)
      .innerJoin(
        asset,
        and(
          eq(asset.id, reference.assetId),
          eq(asset.workspaceId, reference.workspaceId),
          eq(asset.accountId, reference.accountId),
        ),
      )
      .innerJoin(
        integrationZaloAccountModel,
        and(
          eq(integrationZaloAccountModel.id, reference.accountId),
          eq(integrationZaloAccountModel.workspaceId, reference.workspaceId),
        ),
      )
      .where(
        and(
          eq(reference.workspaceId, input.workspaceId),
          or(
            ...input.owners.map((owner) =>
              and(
                eq(reference.accountId, owner.accountId),
                eq(reference.ownerKind, owner.ownerKind),
                eq(reference.ownerId, owner.ownerId),
              ),
            ),
          ),
          inArray(reference.role, ["avatar", "cover"]),
        ),
      )
      .limit(100)
  },
  async register(
    input: Scope & {
      identity: string
      asset: typeof asset.$inferInsert
      reference: typeof reference.$inferInsert
    },
    tx: DatabaseClient = db,
  ) {
    if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
      throw new Error("Workspace is closing")
    }
    // Same lock serializes registration with closing/deletion admission.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.accountId}:media`}, 0))`,
    )
    const [account] = await tx
      .select({ id: integrationZaloAccountModel.id })
      .from(integrationZaloAccountModel)
      .where(
        and(
          eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
          eq(integrationZaloAccountModel.id, input.accountId),
        ),
      )
      .limit(1)
    if (!account) {
      throw new Error("Media account not found")
    }
    const [closing] = await tx
      .select({ id: asset.id })
      .from(asset)
      .where(and(assetScope(input), eq(asset.identity, "__account_closing__")))
      .limit(1)
    if (closing) {
      throw new Error("Media account is closing")
    }
    const [latest] = await tx
      .select()
      .from(asset)
      .where(and(assetScope(input), eq(asset.identity, input.identity)))
      .orderBy(desc(asset.generation))
      .limit(1)
      .for("update")
    let current = latest?.deletionPhase === "active" ? latest : undefined
    if (!current) {
      ;[current] = await tx
        .insert(asset)
        .values({
          ...input.asset,
          generation: latest ? latest.generation + 1 : 1,
        })
        .returning()
    } else if (input.asset.encryptedSource && current.state !== "stored") {
      ;[current] = await tx
        .update(asset)
        .set({
          encryptedSource: input.asset.encryptedSource,
          sourceRevision: input.asset.sourceRevision,
          ...(current.errorCode === "source_missing"
            ? {
                state: "pending" as const,
                nextAttemptAt: new Date(),
                errorCode: null,
              }
            : {}),
        })
        .where(eq(asset.id, current.id))
        .returning()
    }
    if (current.closingAt) {
      await tx
        .update(asset)
        .set({ closingAt: null })
        .where(eq(asset.id, current.id))
    }
    const [existing] = await tx
      .select()
      .from(reference)
      .where(
        and(
          referenceScope(input),
          eq(reference.ownerKind, input.reference.ownerKind),
          eq(reference.ownerId, input.reference.ownerId),
          eq(reference.role, input.reference.role),
          eq(reference.slot, input.reference.slot),
        ),
      )
      .limit(1)
      .for("update")
    if (
      existing &&
      numericRevisionPattern.test(existing.sourceRevision) &&
      numericRevisionPattern.test(input.reference.sourceRevision) &&
      BigInt(existing.sourceRevision) > BigInt(input.reference.sourceRevision)
    ) {
      return existing
    }
    const values = {
      ...input.reference,
      assetId: current.id,
      aliases: [
        ...new Set([...(existing?.aliases ?? []), ...input.reference.aliases]),
      ],
      projectionState:
        existing?.assetId === current.id
          ? existing.projectionState
          : input.reference.projectionState,
    }
    const [result] = await tx
      .insert(reference)
      .values(values)
      .onConflictDoUpdate({
        target: [
          reference.workspaceId,
          reference.accountId,
          reference.ownerKind,
          reference.ownerId,
          reference.role,
          reference.slot,
        ],
        set: values,
      })
      .returning()
    return result
  },
  async claim(
    input: Scope & {
      assetId: string
      leaseToken: string
      now: Date
      leaseMs: number
      maxAttempts: number
    },
  ) {
    const [result] = await db
      .update(asset)
      .set({
        state: "downloading",
        leaseToken: input.leaseToken,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
        lastAttemptAt: input.now,
        attempts: sql`${asset.attempts} + 1`,
        errorCode: null,
        remoteSettledAt: null,
      })
      .where(
        and(
          assetScope(input),
          eq(asset.id, input.assetId),
          sql`EXISTS (SELECT 1 FROM "ZaloAccountMediaReference" r WHERE r."assetId" = ${asset.id} AND r."workspaceId" = ${asset.workspaceId} AND r."accountId" = ${asset.accountId})`,
          eq(asset.deletionPhase, "active"),
          sql`${asset.attempts} < ${input.maxAttempts}`,
          or(
            eq(asset.state, "pending"),
            and(eq(asset.state, "failed"), lte(asset.nextAttemptAt, input.now)),
          ),
          or(
            isNull(asset.leaseExpiresAt),
            lte(asset.leaseExpiresAt, input.now),
          ),
        ),
      )
      .returning()
    return result ?? null
  },
  async candidate(input: Scope & { assetId: string; leaseToken: string }) {
    const [result] = await db
      .select()
      .from(asset)
      .where(
        and(
          assetScope(input),
          eq(asset.id, input.assetId),
          eq(asset.leaseToken, input.leaseToken),
          eq(asset.state, "downloading"),
          eq(asset.deletionPhase, "active"),
          gt(asset.leaseExpiresAt, new Date()),
        ),
      )
      .limit(1)
    return result ?? null
  },
  async updateLease(
    input: Scope & { assetId: string; leaseToken: string },
    values: Partial<Asset>,
    tx: DatabaseClient = db,
  ) {
    const rows = await tx
      .update(asset)
      .set(values)
      .where(
        and(
          assetScope(input),
          eq(asset.id, input.assetId),
          eq(asset.leaseToken, input.leaseToken),
          eq(asset.state, "downloading"),
          eq(asset.deletionPhase, "active"),
          gt(asset.leaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: asset.id })
    return rows.length > 0
  },
  async due(limit: number) {
    return await db
      .select()
      .from(asset)
      .where(
        and(
          eq(asset.deletionPhase, "active"),
          isNull(asset.leaseToken),
          or(
            eq(asset.state, "pending"),
            and(
              eq(asset.state, "failed"),
              lte(asset.nextAttemptAt, new Date()),
            ),
          ),
        ),
      )
      .orderBy(
        sql`row_number() over (partition by ${asset.workspaceId}, ${asset.accountId} order by CASE WHEN ${asset.createdAt} < now() - interval '5 minutes' THEN 0 ELSE ${asset.priority} END, ${asset.createdAt})`,
        sql`CASE WHEN ${asset.createdAt} < now() - interval '5 minutes' THEN 0 ELSE ${asset.priority} END`,
        asc(asset.createdAt),
      )
      .limit(limit)
  },
  async list(
    input: Scope & {
      referenceId?: string
      ownerKind?: string
      ownerId?: string
      ownerIds?: string[]
      cursor?: string
      limit: number
      conversationIds?: string[]
      manageResources?: boolean
      attachmentIds?: string[]
      messageIds?: string[]
    },
  ) {
    const conditions = [referenceScope(input)]
    if (input.ownerKind) {
      conditions.push(eq(reference.ownerKind, input.ownerKind))
    }
    if (input.ownerId) {
      conditions.push(eq(reference.ownerId, input.ownerId))
    }
    if (input.ownerIds) {
      conditions.push(inArray(reference.ownerId, input.ownerIds))
    }
    if (input.referenceId) {
      conditions.push(eq(reference.id, input.referenceId))
    }
    if (input.cursor) {
      conditions.push(gt(reference.id, input.cursor))
    }
    if (input.attachmentIds) {
      conditions.push(inArray(reference.attachmentId, input.attachmentIds))
    }
    if (input.messageIds) {
      conditions.push(inArray(reference.messageId, input.messageIds))
    }
    if (!input.manageResources) {
      conditions.push(
        inArray(reference.conversationId, input.conversationIds ?? []),
      )
    } else if (input.conversationIds) {
      conditions.push(
        or(
          inArray(reference.conversationId, input.conversationIds),
          isNull(reference.conversationId),
        ),
      )
    }
    return await db
      .select({ reference, asset })
      .from(reference)
      .innerJoin(
        asset,
        and(
          eq(asset.id, reference.assetId),
          eq(asset.workspaceId, reference.workspaceId),
          eq(asset.accountId, reference.accountId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(reference.id))
      .limit(input.limit)
  },
  async retry(input: Scope & { assetId: string; sourceRevision: string }) {
    return (
      (
        await db
          .update(asset)
          .set({
            state: "pending",
            nextAttemptAt: new Date(),
            errorCode: null,
          })
          .where(
            and(
              assetScope(input),
              eq(asset.id, input.assetId),
              eq(asset.sourceRevision, input.sourceRevision),
              eq(asset.deletionPhase, "active"),
              inArray(asset.state, ["failed", "expired"]),
              isNull(asset.leaseToken),
              sql`${asset.attempts} < 5`,
            ),
          )
          .returning()
      ).length > 0
    )
  },
  async bindMessageAliases(
    input: Scope & {
      messageId: string
      preserveAttachmentIds?: boolean
      aliases: string[]
      attachmentId?: string
      conversationId?: string
      messageCreatedAt?: Date
    },
    tx: DatabaseClient = db,
  ) {
    const refs = await tx
      .select()
      .from(reference)
      .where(
        and(
          referenceScope(input),
          input.conversationId
            ? eq(reference.conversationId, input.conversationId)
            : undefined,
          or(
            eq(reference.messageId, input.messageId),
            input.conversationId && input.aliases.length
              ? inArray(reference.providerMessageId, input.aliases)
              : undefined,
            input.conversationId && input.aliases.length
              ? sql`${reference.aliases} ?| array[${sql.join(
                  input.aliases.map((alias) => sql`${alias}`),
                  sql`, `,
                )}]`
              : undefined,
          ),
        ),
      )
      .limit(301)
      .for("update")
    // Ten acknowledged provider messages can each carry twelve originals and
    // their previews. Never partially rebind before destructive shard merging.
    if (refs.length > 300) {
      throw new Error(
        "Media alias reconciliation exceeds bounded reference limit",
      )
    }
    for (const ref of refs) {
      const canonical = refs.find(
        (candidate) =>
          candidate.id !== ref.id &&
          candidate.messageId === input.messageId &&
          candidate.assetId === ref.assetId &&
          candidate.role === ref.role &&
          candidate.slot === ref.slot,
      )
      if (ref.messageId !== input.messageId && canonical) {
        canonical.aliases = [
          ...new Set([...canonical.aliases, ...ref.aliases, ...input.aliases]),
        ]
        await tx
          .update(reference)
          .set({
            aliases: [
              ...new Set([
                ...canonical.aliases,
                ...ref.aliases,
                ...input.aliases,
              ]),
            ],
          })
          .where(and(referenceScope(input), eq(reference.id, canonical.id)))
        await tx
          .delete(reference)
          .where(and(referenceScope(input), eq(reference.id, ref.id)))
        continue
      }
      await tx
        .update(reference)
        .set({
          aliases: [...new Set([...ref.aliases, ...input.aliases])],
          messageId: input.messageId,
          attachmentId:
            input.attachmentId ??
            (ref.messageId === input.messageId || input.preserveAttachmentIds
              ? ref.attachmentId
              : null),
          conversationId: input.conversationId ?? ref.conversationId,
          messageCreatedAt: input.messageCreatedAt ?? ref.messageCreatedAt,
        })
        .where(eq(reference.id, ref.id))
    }
    return refs.length
  },
  async markProjected(
    input: Scope & {
      referenceId: string
      assetId: string
      sourceRevision: string
    },
  ) {
    return await db
      .update(reference)
      .set({ projectionState: "applied" })
      .where(
        and(
          referenceScope(input),
          eq(reference.id, input.referenceId),
          eq(reference.assetId, input.assetId),
          eq(reference.sourceRevision, input.sourceRevision),
        ),
      )
      .returning()
  },
  async close(input: Scope, tx: DatabaseClient = db) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.accountId}:media`}, 0))`,
    )
    await tx
      .insert(asset)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        identity: "__account_closing__",
        generation: 1,
        kind: "file",
        role: "original",
        state: "failed",
        sourceRevision: "closing",
        priority: 0,
        attempts: 0,
        candidateKeys: [],
        deletionPhase: "closing",
        closingAt: new Date(),
      })
      .onConflictDoNothing()
    const ids = await tx
      .select({ id: asset.id })
      .from(asset)
      .where(and(assetScope(input), eq(asset.deletionPhase, "active")))
      .limit(100)
      .for("update")
    if (ids.length) {
      await tx
        .update(asset)
        .set({ deletionPhase: "closing", closingAt: new Date() })
        .where(
          inArray(
            asset.id,
            ids.map((x) => x.id),
          ),
        )
    }
    return ids.length
  },
  async releaseOwners(
    input: Scope & {
      ownerKind?: Reference["ownerKind"]
      ownerIds?: string[]
      sourceRevision?: string
    },
    tx: DatabaseClient = db,
  ) {
    const filters = [referenceScope(input)]
    if (input.ownerKind) {
      filters.push(eq(reference.ownerKind, input.ownerKind))
    }
    if (input.ownerIds) {
      filters.push(inArray(reference.ownerId, input.ownerIds))
    }
    if (input.sourceRevision !== undefined) {
      filters.push(eq(reference.sourceRevision, input.sourceRevision))
    }
    const rows = await tx
      .select({ id: reference.id })
      .from(reference)
      .where(and(...filters))
      .limit(100)
      .for("update")
    if (rows.length) {
      await tx.delete(reference).where(
        inArray(
          reference.id,
          rows.map((x) => x.id),
        ),
      )
    }
    return rows.length
  },
  async claimDeletion(
    input: Scope & { assetId: string; deletionToken: string },
    tx: DatabaseClient = db,
  ) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.accountId}:media`}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(asset)
      .where(and(assetScope(input), eq(asset.id, input.assetId)))
      .limit(1)
      .for("update")
    if (!row || row.leaseToken || (row.candidateKey && !row.remoteSettledAt)) {
      return null
    }
    const [live] = await tx
      .select({ id: reference.id })
      .from(reference)
      .where(eq(reference.assetId, row.id))
      .limit(1)
    if (live) {
      return null
    }
    const [result] = await tx
      .update(asset)
      .set({ deletionPhase: "deleting", deletionToken: input.deletionToken })
      .where(eq(asset.id, row.id))
      .returning()
    return result
  },
  async completeDeletion(
    input: Scope & { assetId: string; deletionToken: string },
  ) {
    return (
      (
        await db
          .update(asset)
          .set({
            deletionPhase: "confirmed",
            objectKey: null,
            candidateKey: null,
            candidateKeys: [],
          })
          .where(
            and(
              assetScope(input),
              eq(asset.id, input.assetId),
              eq(asset.deletionToken, input.deletionToken),
              eq(asset.deletionPhase, "deleting"),
            ),
          )
          .returning()
      ).length > 0
    )
  },
  async deletionPage(input: Scope) {
    return await db
      .select()
      .from(asset)
      .where(
        and(
          assetScope(input),
          inArray(asset.deletionPhase, ["closing", "deleting"]),
          isNull(asset.leaseToken),
          or(
            isNull(asset.candidateKey),
            sql`${asset.remoteSettledAt} IS NOT NULL`,
          ),
        ),
      )
      .orderBy(asc(asset.id))
      .limit(100)
  },
}
