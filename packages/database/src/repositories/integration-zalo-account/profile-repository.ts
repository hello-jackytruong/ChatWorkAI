import {
  type ZaloAccountProfile,
  zaloAccountProfileSchema,
} from "@chatbotx.io/sdk"
import {
  and,
  type DatabaseClient,
  db,
  eq,
  gte,
  inArray,
  sql,
} from "../../client"
import type { ZaloAccountFriendActivity } from "../../partials/zalo-account-friend-activity"
import {
  integrationZaloAccountModel,
  zaloAccountUserProfileModel as profile,
} from "../../schema"
import { workspaceRepository } from "../workspace"
import { appendZaloAccountFriendActivity } from "./friend-activity-evidence"
import {
  mergeZaloAccountProfileEvidence,
  type ProfileObservation,
} from "./profile-evidence"

type Scope = { workspaceId: string; accountId: string }
type InboxScope = Scope & { inboxId: string }
type Observation = Scope &
  ProfileObservation & {
    inboxId: string
    profiles: readonly ZaloAccountProfile[]
  }
const scoped = (input: Scope) =>
  and(
    eq(profile.workspaceId, input.workspaceId),
    eq(profile.accountId, input.accountId),
  )

async function lockProfileAccount(input: InboxScope, tx: DatabaseClient) {
  if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
    throw new Error("Workspace is being purged")
  }
  const [account] = await tx
    .select({
      id: integrationZaloAccountModel.id,
      zaloUid: integrationZaloAccountModel.zaloUid,
    })
    .from(integrationZaloAccountModel)
    .where(
      and(
        eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountModel.id, input.accountId),
        eq(integrationZaloAccountModel.inboxId, input.inboxId),
      ),
    )
    .limit(1)
    .for("share")
  if (!account) {
    return null
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["zalo-profiles", input.workspaceId, input.accountId])}, 0))`,
  )
  return account
}

async function observe(input: Observation, tx: DatabaseClient) {
  if (!(await lockProfileAccount(input, tx))) {
    return []
  }
  const candidates = new Map(
    input.profiles.map((entry) => {
      const snapshot = zaloAccountProfileSchema.parse(entry)
      return [snapshot.uid, snapshot] as const
    }),
  )
  const rows = await tx
    .select()
    .from(profile)
    .where(
      and(scoped(input), inArray(profile.providerUid, [...candidates.keys()])),
    )
  const current = new Map(rows.map((row) => [row.providerUid, row]))
  return await tx
    .insert(profile)
    .values(
      [...candidates].map(([providerUid, snapshot]) => ({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerUid,
        ...mergeZaloAccountProfileEvidence(current.get(providerUid), snapshot, {
          ...input,
          observedAt: new Date(
            Math.max(0, Math.min(input.observedAt.getTime(), Date.now())),
          ),
        }),
      })),
    )
    .onConflictDoUpdate({
      target: [profile.workspaceId, profile.accountId, profile.providerUid],
      set: {
        fields: sql`excluded.fields`,
        visibleFields: sql`excluded."visibleFields"`,
        observedAt: sql`excluded."observedAt"`,
        detailObservedAt: sql`excluded."detailObservedAt"`,
        largeAvatarObservedAt: sql`excluded."largeAvatarObservedAt"`,
      },
    })
    .returning()
}

export const zaloAccountUserProfileRepository = {
  async recordFriendActivity(
    input: InboxScope & { event: ZaloAccountFriendActivity },
  ) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      const account = await lockProfileAccount(input, tx)
      const { event } = input
      if (!account || event.uid === account.zaloUid) {
        return
      }
      const scope = and(scoped(input), eq(profile.providerUid, event.uid))
      const [row] = await tx
        .select({
          friendActivity: profile.friendActivity,
        })
        .from(profile)
        .where(scope)
        .limit(1)
      const friendActivity = appendZaloAccountFriendActivity(
        row?.friendActivity ?? undefined,
        event,
      )
      if (friendActivity === row?.friendActivity) {
        return
      }
      const incomingFriendRequestAt = friendActivity.incomingAt
        ? new Date(friendActivity.incomingAt)
        : null
      if (row) {
        await tx
          .update(profile)
          .set({ friendActivity, incomingFriendRequestAt })
          .where(scope)
        return
      }
      await tx.insert(profile).values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerUid: event.uid,
        fields: {},
        visibleFields: [],
        observedAt: new Date(event.occurredAt),
        friendActivity,
        incomingFriendRequestAt,
      })
    })
  },
  async listIncoming(input: Scope & { since: Date; limit: number }) {
    return await db
      .select({
        uid: profile.providerUid,
        name: sql<string | null>`CASE
        WHEN ${profile.visibleFields} ? 'displayName' THEN ${profile.fields} #>> '{displayName,value}'
        WHEN ${profile.visibleFields} ? 'zaloName' THEN ${profile.fields} #>> '{zaloName,value}'
      END`,
      })
      .from(profile)
      .where(
        and(scoped(input), gte(profile.incomingFriendRequestAt, input.since)),
      )
      .orderBy(
        sql`${profile.incomingFriendRequestAt} DESC NULLS LAST`,
        sql`${profile.id} DESC NULLS LAST`,
      )
      .limit(input.limit)
  },
  async find(input: Scope & { providerUid: string }) {
    return (
      (
        await db
          .select()
          .from(profile)
          .where(and(scoped(input), eq(profile.providerUid, input.providerUid)))
          .limit(1)
      )[0] ?? null
    )
  },
  async observe(input: Observation, tx?: DatabaseClient) {
    if (!input.profiles.length) {
      return []
    }
    if (
      input.profiles.length > 100 ||
      !Number.isFinite(input.observedAt.getTime())
    ) {
      throw new Error("Invalid Zalo Account profile observation batch")
    }
    if (tx) {
      return await observe(input, tx)
    }
    return await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await transaction.execute(sql`SET LOCAL statement_timeout = '10s'`)
      return await observe(input, transaction)
    })
  },
}
