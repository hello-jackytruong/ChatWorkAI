import { createId } from "@chatbotx.io/utils"
import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  inArray,
  ne,
  or,
  sql,
} from "../../client"
import {
  contactInboxModel,
  contactModel,
  conversationModel,
  integrationZaloAccountGroupModel,
} from "../../schema"
import { workspaceRepository } from "../workspace"

type GroupRow = typeof integrationZaloAccountGroupModel.$inferSelect

const scope = (input: { workspaceId: string; accountId: string }) =>
  and(
    eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountGroupModel.accountId, input.accountId),
  )

export const integrationZaloAccountGroupRepository = {
  async canAccessInbox(input: {
    workspaceId: string
    accountId: string
    id: string
    restrictToAssignedUserId?: string
    restrictToTeamIds?: string[]
  }) {
    const scopes = [
      input.restrictToAssignedUserId
        ? eq(conversationModel.assignedUserId, input.restrictToAssignedUserId)
        : undefined,
      input.restrictToTeamIds?.length
        ? inArray(
            conversationModel.assignedInboxTeamId,
            input.restrictToTeamIds,
          )
        : undefined,
    ].filter((value) => value !== undefined)
    const [row] = await db
      .select({ id: integrationZaloAccountGroupModel.id })
      .from(integrationZaloAccountGroupModel)
      .innerJoin(
        conversationModel,
        eq(
          conversationModel.id,
          integrationZaloAccountGroupModel.conversationId,
        ),
      )
      .where(
        and(
          scope(input),
          eq(integrationZaloAccountGroupModel.id, input.id),
          eq(conversationModel.workspaceId, input.workspaceId),
          scopes.length ? or(...scopes) : undefined,
        ),
      )
      .limit(1)
    return !!row
  },
  async findByAnchor(
    input: {
      workspaceId: string
      contactInboxId: string
      conversationId: string
    },
    tx: DatabaseClient = db,
  ) {
    return await tx.query.integrationZaloAccountGroupModel.findFirst({
      where: input,
    })
  },
  async findByProviderId(
    input: { workspaceId: string; accountId: string; providerGroupId: string },
    tx: DatabaseClient = db,
  ) {
    return await tx.query.integrationZaloAccountGroupModel.findFirst({
      where: input,
    })
  },

  async updateInboxPolicy(
    input: {
      workspaceId: string
      accountId: string
      inboxId: string
      id: string
      receiveEnabled?: boolean
      sendEnabled?: boolean
      automationMode?: "disabled" | "mentionOnly" | "all"
    },
    tx: DatabaseClient,
  ) {
    if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
      throw new Error("Workspace is being purged")
    }
    const [group] = await tx
      .select()
      .from(integrationZaloAccountGroupModel)
      .where(
        and(scope(input), eq(integrationZaloAccountGroupModel.id, input.id)),
      )
      .limit(1)
      .for("update")
    if (!group?.accessible) {
      return null
    }
    let contactInboxId = group.contactInboxId
    let conversationId = group.conversationId
    if (
      (input.receiveEnabled || input.sendEnabled) &&
      !(contactInboxId && conversationId)
    ) {
      const sourceId = `za:group:${encodeURIComponent(group.providerGroupId)}`
      const existing = await tx.query.contactInboxModel.findFirst({
        where: { inboxId: input.inboxId, sourceId },
        with: { contact: true },
      })
      let contactId: string
      if (existing) {
        if (
          existing.contact.kind !== "channelGroup" ||
          existing.contact.workspaceId !== input.workspaceId
        ) {
          throw new Error("Zalo group anchor identity conflict")
        }
        contactInboxId = existing.id
        contactId = existing.contactId
      } else {
        contactId = createId()
        contactInboxId = createId()
        await tx.insert(contactModel).values({
          id: contactId,
          workspaceId: input.workspaceId,
          kind: "channelGroup",
          firstName: group.name,
          avatar: group.avatarUrl,
        })
        await tx.insert(contactInboxModel).values({
          id: contactInboxId,
          originalContactId: contactId,
          contactId,
          contactKind: "channelGroup",
          inboxId: input.inboxId,
          sourceId,
          channel: "zaloAccount",
          source: "direct",
        })
      }
      const existingConversation = await tx.query.conversationModel.findFirst({
        where: { workspaceId: input.workspaceId, contactId, sourceId },
      })
      conversationId = existingConversation?.id ?? createId()
      if (!existingConversation) {
        await tx.insert(conversationModel).values({
          id: conversationId,
          workspaceId: input.workspaceId,
          contactId,
          sourceId,
          botEnabled: false,
          additionalAttributes: {
            audience: {
              kind: "zaloAccountGroup",
              accountId: input.accountId,
              groupId: group.id,
              providerGroupId: group.providerGroupId,
              memberCount: group.memberCount,
            },
          },
        })
      }
    }
    const [updated] = await tx
      .update(integrationZaloAccountGroupModel)
      .set({
        ...(input.receiveEnabled === undefined
          ? {}
          : { receiveEnabled: input.receiveEnabled }),
        ...(input.sendEnabled === undefined
          ? {}
          : { sendEnabled: input.sendEnabled }),
        ...(input.automationMode === undefined
          ? {}
          : { automationMode: input.automationMode }),
        contactInboxId,
        conversationId,
        policyEpoch: sql`${integrationZaloAccountGroupModel.policyEpoch} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(scope(input), eq(integrationZaloAccountGroupModel.id, group.id)),
      )
      .returning()
    return updated ?? null
  },
  async list(
    input: { workspaceId: string; accountId: string },
    tx: DatabaseClient = db,
  ): Promise<GroupRow[]> {
    return await tx
      .select()
      .from(integrationZaloAccountGroupModel)
      .where(scope(input))
      .orderBy(asc(integrationZaloAccountGroupModel.name))
  },

  async find(
    input: { workspaceId: string; accountId: string; id: string },
    tx: DatabaseClient = db,
  ): Promise<GroupRow | null> {
    const [row] = await tx
      .select()
      .from(integrationZaloAccountGroupModel)
      .where(
        and(scope(input), eq(integrationZaloAccountGroupModel.id, input.id)),
      )
      .limit(1)
    return row ?? null
  },

  async upsert(
    input: {
      id: string
      workspaceId: string
      accountId: string
      providerGroupId: string
      name: string
      avatarUrl: string | null
      memberCount: number
      providerVersion: string | null
      syncRunId: string
      syncedAt: Date
    },
    tx: DatabaseClient = db,
  ): Promise<GroupRow> {
    const [row] = await tx
      .insert(integrationZaloAccountGroupModel)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerGroupId: input.providerGroupId,
        name: input.name,
        avatarUrl: input.avatarUrl,
        memberCount: input.memberCount,
        providerVersion: input.providerVersion,
        sendEnabled: false,
        accessible: true,
        lastSyncRunId: input.syncRunId,
        lastSyncedAt: input.syncedAt,
        inaccessibleAt: null,
      })
      .onConflictDoUpdate({
        target: [
          integrationZaloAccountGroupModel.accountId,
          integrationZaloAccountGroupModel.providerGroupId,
        ],
        set: {
          name: input.name,
          avatarUrl: input.avatarUrl,
          memberCount: input.memberCount,
          providerVersion: input.providerVersion,
          accessible: true,
          lastSyncRunId: input.syncRunId,
          lastSyncedAt: input.syncedAt,
          inaccessibleAt: null,
          updatedAt: input.syncedAt,
        },
      })
      .returning()
    if (!row) {
      throw new Error("Unable to upsert Zalo Account group")
    }
    if (row.contactInboxId) {
      const anchor = await tx.query.contactInboxModel.findFirst({
        where: { id: row.contactInboxId, contactKind: "channelGroup" },
        columns: { contactId: true },
      })
      if (anchor) {
        await tx
          .update(contactModel)
          .set({
            firstName: input.name,
            avatar: input.avatarUrl,
            updatedAt: input.syncedAt,
          })
          .where(
            and(
              eq(contactModel.id, anchor.contactId),
              eq(contactModel.workspaceId, input.workspaceId),
              eq(contactModel.kind, "channelGroup"),
            ),
          )
      }
    }
    if (row.conversationId) {
      const audience = {
        kind: "zaloAccountGroup",
        accountId: input.accountId,
        groupId: row.id,
        providerGroupId: row.providerGroupId,
        memberCount: input.memberCount,
      }
      await tx
        .update(conversationModel)
        .set({
          additionalAttributes: sql`jsonb_set(coalesce(${conversationModel.additionalAttributes}, '{}'::jsonb), '{audience}', ${JSON.stringify(audience)}::jsonb)`,
        })
        .where(
          and(
            eq(conversationModel.id, row.conversationId),
            eq(conversationModel.workspaceId, input.workspaceId),
          ),
        )
    }
    return row
  },

  async finishCompleteSync(
    input: {
      workspaceId: string
      accountId: string
      syncRunId: string
      syncedAt: Date
    },
    tx: DatabaseClient = db,
  ): Promise<void> {
    await tx
      .update(integrationZaloAccountGroupModel)
      .set({
        accessible: false,
        sendEnabled: false,
        receiveEnabled: false,
        automationMode: "disabled",
        policyEpoch: sql`${integrationZaloAccountGroupModel.policyEpoch} + 1`,
        inaccessibleAt: input.syncedAt,
        updatedAt: input.syncedAt,
      })
      .where(
        and(
          scope(input),
          ne(integrationZaloAccountGroupModel.lastSyncRunId, input.syncRunId),
        ),
      )
  },

  async updatePolicy(
    input: {
      workspaceId: string
      accountId: string
      id: string
      sendEnabled: boolean
    },
    tx: DatabaseClient = db,
  ): Promise<GroupRow | null> {
    const [row] = await tx
      .update(integrationZaloAccountGroupModel)
      .set({ sendEnabled: input.sendEnabled, updatedAt: new Date() })
      .where(
        and(
          scope(input),
          eq(integrationZaloAccountGroupModel.id, input.id),
          eq(integrationZaloAccountGroupModel.accessible, true),
        ),
      )
      .returning()
    return row ?? null
  },
}
