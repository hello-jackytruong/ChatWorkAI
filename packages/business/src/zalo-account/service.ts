import {
  connectionRepository,
  integrationZaloAccountRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountDiagnosticState } from "@chatbotx.io/database/schema"
import type { IntegrationZaloAccountPublicModel } from "@chatbotx.io/database/types"
import { cacheConnections } from "@chatbotx.io/redis"
import type {
  ZaloAccountAuth,
  ZaloAccountRuntimeSnapshot,
} from "@chatbotx.io/sdk"
import {
  zaloAccountRuntimeDiagnosticsSchema,
  zaloAccountRuntimeSnapshotSchema,
  zaloAccountRuntimeStatusSchema,
  zaloAccountTransportKeys,
} from "@chatbotx.io/sdk"
import {
  connectionIdentityMismatchException,
  notFoundException,
} from "../errors"
import {
  decryptZaloAccountAuth,
  encryptZaloAccountAuth,
  zaloAuthorizationFingerprint,
} from "./auth"

const GATEWAY_LEASE_PATTERN = /:\d+$/
const toPublic = (
  row: Awaited<
    ReturnType<
      typeof integrationZaloAccountRepository.findByInboxIdForWorkspace
    >
  >,
): IntegrationZaloAccountPublicModel | null => {
  if (!row) {
    return null
  }
  const metadata = {
    id: row.id,
    workspaceId: row.workspaceId,
    inboxId: row.inboxId,
    zaloUid: row.zaloUid,
    name: row.name,
    avatarUrl: row.avatarUrl,
    sessionVerifiedAt: row.sessionVerifiedAt,
    groupMessagingEnabled: row.groupMessagingEnabled,
    groupPolicyEpoch: row.groupPolicyEpoch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (!row.operations) {
    return { ...metadata, operations: null }
  }
  const { groups, labels, friends } = row.operations
  const operations = { groups, labels, friends }
  return { ...metadata, operations }
}

const runtimeProjection = (
  diagnostics: ZaloAccountDiagnosticState | undefined,
  lease: string | null,
  serialized: string | null,
  redisAvailable: boolean,
) => {
  if (!diagnostics) {
    return null
  }
  const safe = zaloAccountRuntimeDiagnosticsSchema
    .strip()
    .safeParse(diagnostics)
  if (!safe.success) {
    return null
  }
  let snapshot: ZaloAccountRuntimeSnapshot | null = null
  try {
    if (serialized && serialized.length <= 2048) {
      snapshot = zaloAccountRuntimeSnapshotSchema.parse(JSON.parse(serialized))
    }
  } catch {
    /* An invalid sample never proves a socket open. */
  }
  const matches =
    !!snapshot &&
    !!lease &&
    GATEWAY_LEASE_PATTERN.test(lease) &&
    lease.endsWith(`:${snapshot.fenceToken}`) &&
    diagnostics.fenceToken === snapshot.fenceToken &&
    diagnostics.epoch === snapshot.epoch &&
    diagnostics.socketAttempt === snapshot.socketAttempt &&
    diagnostics.sequence === snapshot.sequence
  const age = snapshot
    ? Date.now() - Date.parse(snapshot.sampledAt)
    : Number.POSITIVE_INFINITY
  const fresh = matches && age >= -5000 && age <= 60_000
  let socketOpen: boolean | null = null
  if (fresh && snapshot) {
    socketOpen = snapshot.socketOpen
  } else if (redisAvailable && !lease) {
    socketOpen = false
  }
  let freshness: "fresh" | "stale" | "unknown" = "unknown"
  if (fresh) {
    freshness = "fresh"
  } else if (matches && age > 60_000) {
    freshness = "stale"
  }
  return zaloAccountRuntimeStatusSchema.parse({
    ...safe.data,
    socketOpen,
    freshness,
    sampledAt: matches ? (snapshot?.sampledAt ?? null) : null,
    lastEventAt: matches ? (snapshot?.lastEventAt ?? null) : null,
  })
}

export const zaloAccountService = {
  async status(input: { workspaceId: string; accountId: string }) {
    const account = await integrationZaloAccountRepository.findByIdForWorkspace(
      {
        workspaceId: input.workspaceId,
        id: input.accountId,
      },
    )
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    const connection = await connectionRepository.findByInboxId({
      inboxId: account.inboxId,
    })
    if (
      connection &&
      (connection.workspaceId !== input.workspaceId ||
        connection.provider !== "zaloAccount")
    ) {
      throw notFoundException("Zalo Account connection not found")
    }
    const { groups, labels, friends } = account.operations ?? {}
    let gatewayAvailable = false
    let lease: string | null = null
    let snapshot: string | null = null
    let redisAvailable = false
    try {
      const client = await cacheConnections.useExisting()
      const scope = {
        workspaceId: input.workspaceId,
        runtime: { kind: "account" as const, id: account.id },
      }
      const values = await client.mget(
        zaloAccountTransportKeys.lease(scope),
        zaloAccountTransportKeys.snapshot(scope),
      )
      lease = values[0] ?? null
      snapshot = values[1] ?? null
      redisAvailable = true
      gatewayAvailable = !!lease && GATEWAY_LEASE_PATTERN.test(lease)
    } catch {
      gatewayAvailable = false
    }
    return {
      accountId: account.id,
      runtime: runtimeProjection(
        account.operations?.diagnostics,
        lease,
        snapshot,
        redisAvailable,
      ),
      groupMessagingEnabled: account.groupMessagingEnabled,
      gatewayAvailable,
      status: connection?.status ?? "disconnected",
      reason: connection?.statusReason ?? null,
      capabilities: {
        text: true,
        image: true,
        file: true,
        typing: true,
        reactions: false,
        revoke: false,
        delete: false,
      },
      groups: {
        complete: groups?.complete ?? false,
        count: groups?.count ?? 0,
        completedAt: groups?.completedAt ?? null,
        reason: groups?.reason ?? null,
      },
      friends: {
        complete: friends?.complete ?? false,
        count: friends?.count ?? 0,
        completedAt: friends?.completedAt ?? null,
        reason: friends?.reason ?? null,
        nextCursor: friends && !friends.complete ? friends.cursor : null,
      },
      labels: {
        complete: labels?.complete ?? false,
        version: labels?.version ?? 0,
        paused: labels?.paused ?? false,
        completedAt: labels?.lastSyncedAt ?? null,
        reason: labels?.reason ?? null,
      },
    }
  },
  async listByWorkspace(input: {
    workspaceId: string
  }): Promise<IntegrationZaloAccountPublicModel[]> {
    const rows = await integrationZaloAccountRepository.listByWorkspace(input)
    return rows.flatMap((row) => {
      const metadata = toPublic(row)
      return metadata ? [metadata] : []
    })
  },

  async findById(input: {
    workspaceId: string
    id: string
  }): Promise<IntegrationZaloAccountPublicModel | null> {
    return toPublic(
      await integrationZaloAccountRepository.findByIdForWorkspace(input),
    )
  },

  async listActiveRuntimeAccounts(input: {
    afterId?: string
    limit: number
  }): Promise<
    Array<{ id: string; workspaceId: string; inboxId: string; skip?: boolean }>
  > {
    const rows =
      await integrationZaloAccountRepository.listActiveRuntimeAccounts(input)
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        inboxId: row.inboxId,
        ...(row.diagnostics?.hold &&
        row.diagnostics.hold.authFingerprint ===
          (await zaloAuthorizationFingerprint(row.encryptedAuth))
          ? { skip: true }
          : {}),
      })),
    )
  },

  async findByInboxId(input: {
    workspaceId: string
    inboxId: string
  }): Promise<IntegrationZaloAccountPublicModel | null> {
    return toPublic(
      await integrationZaloAccountRepository.findByInboxIdForWorkspace(input),
    )
  },

  async findByUid(input: {
    workspaceId: string
    zaloUid: string
  }): Promise<IntegrationZaloAccountPublicModel | null> {
    return toPublic(
      await integrationZaloAccountRepository.findByUidForWorkspace(input),
    )
  },

  /** Internal runtime-only secret access; never expose this result through app/API projections. */
  async loadAuthorizationForRuntime(input: {
    workspaceId: string
    inboxId: string
  }): Promise<ZaloAccountAuth> {
    const row =
      await integrationZaloAccountRepository.findByInboxIdForWorkspace(input)
    if (!row) {
      throw notFoundException("Zalo Account connection not found")
    }
    return await decryptZaloAccountAuth(row)
  },

  /** Gateway-only account lookup with validated decrypted authorization. */
  async loadRuntimeAccount(input: {
    workspaceId: string
    accountId: string
    inboxId?: string
    deadlineAt?: number
  }): Promise<{
    auth: ZaloAccountAuth
    zaloUid: string
    authFingerprint: string
  }> {
    const row = input.inboxId
      ? await integrationZaloAccountRepository.withRuntimeAccount(
          {
            workspaceId: input.workspaceId,
            id: input.accountId,
            inboxId: input.inboxId,
            deadlineAt: input.deadlineAt,
          },
          (_tx, account) => Promise.resolve(account),
        )
      : await integrationZaloAccountRepository.findByIdForWorkspace({
          workspaceId: input.workspaceId,
          id: input.accountId,
        })
    if (!row) {
      throw notFoundException("Zalo Account connection not found")
    }
    if (!input.inboxId) {
      const connection = await connectionRepository.findByInboxId({
        inboxId: row.inboxId,
      })
      if (
        !connection ||
        connection.workspaceId !== input.workspaceId ||
        connection.provider !== "zaloAccount" ||
        !["connected", "degraded"].includes(connection.status)
      ) {
        throw new Error("Zalo Account is not eligible for automatic login")
      }
    }
    const authFingerprint = await zaloAuthorizationFingerprint(
      row.encryptedAuth,
    )
    if (
      row.operations?.diagnostics?.hold?.authFingerprint === authFingerprint
    ) {
      throw new Error("Zalo Account requires manual recovery")
    }
    return {
      auth: await decryptZaloAccountAuth(row),
      zaloUid: row.zaloUid,
      authFingerprint,
    }
  },

  async saveAuthorization(input: {
    workspaceId: string
    inboxId: string
    auth: ZaloAccountAuth
    name: string
    avatarUrl: string | null
    sessionVerifiedAt: Date
  }): Promise<IntegrationZaloAccountPublicModel> {
    const existing =
      await integrationZaloAccountRepository.findByInboxIdForWorkspace({
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
      })
    if (!existing) {
      throw notFoundException("Zalo Account connection not found")
    }
    if (existing.zaloUid !== input.auth.zaloUid) {
      throw connectionIdentityMismatchException()
    }
    const encryptedAuth = await encryptZaloAccountAuth(
      input.workspaceId,
      input.inboxId,
      input.auth,
    )
    const row =
      await integrationZaloAccountRepository.updateAuthorizationAndProfile({
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
        encryptedAuth,
        name: input.name,
        avatarUrl: input.avatarUrl,
        sessionVerifiedAt: input.sessionVerifiedAt,
      })
    const metadata = toPublic(row)
    if (!metadata) {
      throw notFoundException("Zalo Account connection not found")
    }
    return metadata
  },
}
