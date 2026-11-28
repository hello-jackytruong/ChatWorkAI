import {
  zaloAccountFriendImportRepository,
  zaloAccountSendAttemptRepository,
} from "@chatbotx.io/database/repositories"
import { cacheConnections } from "@chatbotx.io/redis"
import {
  type ZaloAccountContactMutation,
  type ZaloAccountContactOperation,
  type ZaloAccountContactResult,
  type ZaloAccountPresence,
  zaloAccountContactMutationSchema,
  zaloAccountContactOperationSchema,
  zaloAccountPresenceSchema,
  zaloAccountProfileSchema,
} from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { z } from "zod"
import { conversationService } from "../conversation/service"
import {
  conflictException,
  notFoundException,
  validationException,
} from "../errors"
import { quotaEnforcementService } from "../quota-enforcement/service"
import { zaloAccountFriendActivityService } from "./friend-activity.service"
import { zaloAccountFriendSyncService } from "./friend-sync.service"
import { isZaloAccountContactOperationsEnabled } from "./native-operation-policy"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

const CLAIM_TTL_MS = 24 * 60 * 60_000
const SELECTION_TTL_MS = 5 * 60_000
const PRESENCE_TTL_MS = 30_000
const WAIT_MS = 6000
const MAX_FUTURE_PRESENCE_MS = 60_000
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/
const selectionSchema = z.strictObject({
  uid: zaloAccountProfileSchema.shape.uid,
  name: z.string().max(200).optional(),
})
const RATE_CAPS = { lookup: 20, list: 20, presence: 20, write: 10 }
const RATE_SCRIPT = `
local total = redis.call('INCRBY', KEYS[1], ARGV[1])
if total == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], 60000) end
return total
`
const SETTLE_CLAIM_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
end
return nil
`
const RELEASE_PRESENCE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

type Scope = { workspaceId: string; accountId: string }
type WithCommand = Scope & { commandId: string }
type LookupOperation = Extract<
  ZaloAccountContactOperation,
  { kind: "lookupPhone" | "lookupPhones" | "lookupUsername" }
>
type PresenceOperation =
  | Extract<ZaloAccountContactOperation, { kind: "onlines" }>
  | { kind: "lastOnline"; uid: string }
export type ZaloAccountContactListKind =
  | "incomingRequests"
  | "sentRequests"
  | "recommendations"
  | "closeFriends"
  | "aliases"
type Redis = Awaited<ReturnType<typeof cacheConnections.useExisting>>
type Account = { id: string; inboxId: string; zaloUid: string }
type MutationStatus = "applied" | "failed" | "unknown"
type Contact = NonNullable<ZaloAccountContactResult["contacts"]>[number]

function scopedKey(scope: Scope, kind: string, value: string): string {
  return `zalo-account:contacts:${kind}:${scope.workspaceId}:${scope.accountId}:${value}`
}

async function requireAccount(scope: Scope): Promise<Account> {
  if (!isZaloAccountContactOperationsEnabled(scope.accountId)) {
    throw notFoundException("Zalo Account contacts are unavailable")
  }
  const account = await zaloAccountService.findById({
    workspaceId: scope.workspaceId,
    id: scope.accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account not found")
  }
  return account
}

async function reserveCapacity(
  redis: Redis,
  scope: Scope,
  kind: keyof typeof RATE_CAPS,
  cost = 1,
) {
  const total = Number(
    await redis.eval(RATE_SCRIPT, 1, scopedKey(scope, "rate", kind), cost),
  )
  if (!Number.isFinite(total) || total > RATE_CAPS[kind]) {
    throw validationException(
      "operation",
      "Zalo Account contact request limit reached",
    )
  }
}

async function selections(
  redis: Redis,
  scope: Scope,
  account: Account,
  rows: Contact[],
) {
  const byUid = new Map<string, Contact>()
  for (const contact of rows) {
    if (
      contact.uid !== account.zaloUid &&
      contact.uid !== "0" &&
      !byUid.has(contact.uid)
    ) {
      byUid.set(contact.uid, contact)
    }
  }
  return await Promise.all(
    [...byUid.values()].map(async ({ uid, name, alias, request }) => {
      const selectionToken = crypto.randomUUID()
      if (
        !(await redis.set(
          scopedKey(scope, "selection", selectionToken),
          JSON.stringify({ uid, ...(name ? { name } : {}) }),
          "PX",
          SELECTION_TTL_MS,
          "NX",
        ))
      ) {
        throw validationException(
          "operation",
          "Zalo Account contact selection is unavailable",
        )
      }
      return {
        uid,
        ...(name ? { name } : {}),
        ...(alias ? { alias } : {}),
        ...(request ? { request } : {}),
        selectionToken,
      }
    }),
  )
}

async function contactForSelection(
  redis: Redis,
  scope: Scope,
  selectionToken: string,
): Promise<z.infer<typeof selectionSchema>> {
  const stored = TOKEN_PATTERN.test(selectionToken)
    ? await redis.get(scopedKey(scope, "selection", selectionToken))
    : null
  if (stored) {
    try {
      const data: unknown = stored.startsWith("{")
        ? JSON.parse(stored)
        : { uid: stored }
      const parsed = selectionSchema.safeParse(data)
      if (parsed.success && parsed.data.uid !== "0") {
        return parsed.data
      }
    } catch {
      // A stale or malformed selection cannot authorize an Inbox operation.
    }
  }
  throw notFoundException("Zalo Account contact selection not found or expired")
}

async function knownDirectContact(scope: Scope, account: Account, uid: string) {
  if (!uid || uid === account.zaloUid) {
    return null
  }
  const contact = await zaloAccountSendAttemptRepository.directTarget({
    workspaceId: scope.workspaceId,
    inboxId: account.inboxId,
    providerUid: uid,
  })
  return contact?.channel === "zaloAccount" ? contact : null
}

async function requirePeer(
  redis: Redis,
  input: Scope & { selectionToken?: string },
  account: Account,
  uid: string,
) {
  const allowed = input.selectionToken
    ? (await contactForSelection(redis, input, input.selectionToken)).uid ===
      uid
    : Boolean(await knownDirectContact(input, account, uid))
  if (!allowed || uid === account.zaloUid) {
    throw notFoundException("Zalo Account contact not found")
  }
}

async function operationId(
  input: WithCommand,
  operation: ZaloAccountContactOperation,
) {
  return `zalo-contacts-${await sha256Hex(JSON.stringify([input.workspaceId, input.accountId, input.commandId, operation]))}`
}

async function dispatchContact(
  input: WithCommand,
  account: Account,
  operation: ZaloAccountContactOperation,
) {
  return await zaloAccountCommandTransportService.contactOperationAndWait({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    inboxId: account.inboxId,
    commandId: await operationId(input, operation),
    contactOperation: operation,
    ttlMs: WAIT_MS,
    waitTimeoutMs: WAIT_MS,
  })
}

async function readContactResult(
  input: WithCommand,
  account: Account,
  operation: ZaloAccountContactOperation,
) {
  const outcome = await dispatchContact(input, account, operation)
  if (outcome.status !== "applied" || !outcome.result.contactsResult) {
    throw validationException(
      "operation",
      "Zalo Account contact data is unavailable",
    )
  }
  return outcome.result.contactsResult
}

function readClaim(raw: string, fingerprint: string): MutationStatus {
  const [current, status] = raw.split(":", 2)
  if (current !== fingerprint) {
    throw conflictException(
      "This command ID was already used for another contact operation",
      "idempotencyKeyConflict",
    )
  }
  return status === "applied" || status === "failed" ? status : "unknown"
}

async function mutateOnce(
  input: WithCommand & { selectionToken?: string },
  account: Account,
  redis: Redis,
  operation: ZaloAccountContactMutation,
): Promise<MutationStatus> {
  const key = scopedKey(input, "write", await sha256Hex(input.commandId))
  const fingerprint = await sha256Hex(JSON.stringify(operation))
  const pending = `${fingerprint}:pending:${crypto.randomUUID()}`
  const prior = await redis.get(key)
  if (prior) {
    return readClaim(prior, fingerprint)
  }
  await requirePeer(redis, input, account, operation.uid)
  await reserveCapacity(redis, input, "write")
  if (!(await redis.set(key, pending, "PX", CLAIM_TTL_MS, "NX"))) {
    const concurrent = await redis.get(key)
    return concurrent ? readClaim(concurrent, fingerprint) : "unknown"
  }
  let status: MutationStatus = "unknown"
  try {
    const outcome = await dispatchContact(input, account, operation)
    if (outcome.status === "applied") {
      status =
        outcome.result.contactsResult?.accepted === true ? "applied" : "unknown"
    } else if (
      outcome.status === "failed" ||
      outcome.status === "rejected_stale"
    ) {
      status = "failed"
    }
  } catch {
    // The provider may have applied the write before the transport failed.
  }
  try {
    await redis.eval(
      SETTLE_CLAIM_SCRIPT,
      1,
      key,
      pending,
      `${fingerprint}:${status}`,
    )
  } catch {
    // A pending claim still prevents dispatch on retry.
  }
  return status
}

const unknownPresence = (uid: string): ZaloAccountPresence => ({
  uid,
  status: "unknown",
})

function projectPresence(input: ZaloAccountPresence): ZaloAccountPresence {
  const { uid, status, lastOnlineMs } = input
  return {
    uid,
    status,
    ...((status === "online" || status === "offline") &&
    lastOnlineMs &&
    lastOnlineMs <= Date.now() + MAX_FUTURE_PRESENCE_MS
      ? { lastOnlineMs }
      : {}),
  }
}

async function readCachedPresence(redis: Redis, key: string) {
  const raw = await redis.get(key)
  try {
    if (raw) {
      const parsed = zaloAccountPresenceSchema.safeParse(
        JSON.parse(raw) as unknown,
      )
      if (parsed.success) {
        return projectPresence(parsed.data)
      }
    }
  } catch {
    return
  }
}

async function cachedPresence(
  input: WithCommand,
  account: Account,
  redis: Redis,
  operation: PresenceOperation,
) {
  const bulk = operation.kind === "onlines"
  const uids = bulk ? [...new Set(operation.uids)] : [operation.uid]
  const byUid = new Map<string, ZaloAccountPresence>()
  const pending: { uid: string; key: string; detailKey: string }[] = []
  await Promise.all(
    uids.map(async (uid) => {
      if (bulk && !(await knownDirectContact(input, account, uid))) {
        return
      }
      const hashedUid = await sha256Hex(uid)
      const detailKey = scopedKey(input, "presence-detail", hashedUid)
      const key = bulk
        ? scopedKey(input, "presence-bulk", hashedUid)
        : detailKey
      const cached =
        (await readCachedPresence(redis, detailKey)) ??
        (bulk ? await readCachedPresence(redis, key) : undefined)
      if (cached?.uid === uid) {
        byUid.set(uid, cached)
      } else {
        pending.push({ uid, key, detailKey })
      }
    }),
  )
  if (pending.length) {
    // Coalesce overlapping panel opens in this account. Missing samples remain unknown.
    const key = scopedKey(input, "presence-flight", "active")
    const lease = crypto.randomUUID()
    const admitted = await redis.set(key, lease, "PX", WAIT_MS * 2, "NX")
    if (admitted) {
      try {
        await reserveCapacity(redis, input, "presence")
        const request = bulk
          ? {
              kind: "onlines" as const,
              uids: pending.map(({ uid }) => uid).sort(),
            }
          : operation
        const result = await readContactResult(input, account, request).catch(
          () => null,
        )
        const observed = new Map(result?.presence?.map((row) => [row.uid, row]))
        await Promise.all(
          pending.map(async ({ uid, key: cacheKey, detailKey }) => {
            const latest = bulk
              ? await readCachedPresence(redis, detailKey)
              : undefined
            const row = observed.get(uid)
            const projected =
              latest ?? (row ? projectPresence(row) : unknownPresence(uid))
            byUid.set(uid, projected)
            if (result && !latest) {
              await redis.set(
                cacheKey,
                JSON.stringify(projected),
                "PX",
                PRESENCE_TTL_MS,
              )
            }
          }),
        )
      } finally {
        await redis
          .eval(RELEASE_PRESENCE_SCRIPT, 1, key, lease)
          .catch(() => undefined)
      }
    }
  }
  return { presence: uids.map((uid) => byUid.get(uid) ?? unknownPresence(uid)) }
}

export const zaloAccountContactOperationsService = {
  async lookup(input: WithCommand & { operation: LookupOperation }) {
    const account = await requireAccount(input)
    const operation = zaloAccountContactOperationSchema.parse(input.operation)
    if (
      !(
        operation.kind === "lookupPhone" ||
        operation.kind === "lookupPhones" ||
        operation.kind === "lookupUsername"
      )
    ) {
      throw validationException("operation", "Select a Zalo Account lookup")
    }
    const redis = await cacheConnections.useExisting()
    await reserveCapacity(
      redis,
      input,
      "lookup",
      operation.kind === "lookupPhones" ? operation.phones.length : 1,
    )
    const result = await readContactResult(input, account, operation)
    return {
      contacts: await selections(redis, input, account, result.contacts ?? []),
    }
  },

  async list(input: WithCommand & { kind: ZaloAccountContactListKind }) {
    const account = await requireAccount(input)
    const redis = await cacheConnections.useExisting()
    await reserveCapacity(redis, input, "list")
    const result =
      input.kind === "incomingRequests"
        ? await zaloAccountFriendActivityService.listIncoming(input)
        : await readContactResult(input, account, { kind: input.kind })
    return {
      contacts: await selections(redis, input, account, result.contacts ?? []),
      complete: false,
    }
  },

  async openConversation(input: Scope & { selectionToken: string }) {
    const account = await requireAccount(input)
    const redis = await cacheConnections.useExisting()
    const selected = await contactForSelection(
      redis,
      input,
      input.selectionToken,
    )
    if (selected.uid === account.zaloUid) {
      throw notFoundException("Zalo Account contact not found")
    }
    const scope = { workspaceId: input.workspaceId, accountId: input.accountId }
    const existing = await knownDirectContact(scope, account, selected.uid)
    const imported = existing
      ? undefined
      : await zaloAccountFriendImportRepository.importSelected(
          { ...scope, inboxId: account.inboxId, ...selected },
          {
            userIdsForOwner: (ownerId) =>
              quotaEnforcementService.contactCounterUserIds(ownerId),
            countContact: (tx, userIds) =>
              quotaEnforcementService.incrementImportedContacts(
                {
                  workspaceId: scope.workspaceId,
                  userIds,
                  count: 1,
                },
                tx,
              ),
          },
        )
    if (imported?.created) {
      // Recovery also drains this outbox after a process crash or Redis outage.
      await zaloAccountFriendSyncService
        .recoverCaches(scope)
        .catch(() => undefined)
    }
    const contact = existing ?? imported
    if (!contact) {
      throw notFoundException("Zalo Account contact not found")
    }
    const conversation = await conversationService.findOrCreate({
      workspaceId: input.workspaceId,
      contactId: contact.contactId,
      sourceId: null,
    })
    return { conversationId: conversation.id, contactInboxId: contact.id }
  },

  async requestStatus(
    input: WithCommand & { uid: string; selectionToken?: string },
  ) {
    const account = await requireAccount(input)
    const redis = await cacheConnections.useExisting()
    const operation = zaloAccountContactOperationSchema.parse({
      kind: "requestStatus",
      uid: input.uid,
    })
    await requirePeer(redis, input, account, input.uid)
    await reserveCapacity(redis, input, "list")
    const result = await readContactResult(input, account, operation)
    return { requestStatus: result.requestStatus ?? null }
  },

  async presence(
    input: WithCommand & {
      operation: PresenceOperation
      selectionToken?: string
    },
  ) {
    const account = await requireAccount(input)
    const redis = await cacheConnections.useExisting()
    const operation = zaloAccountContactOperationSchema.parse(input.operation)
    if (operation.kind === "onlines") {
      return await cachedPresence(input, account, redis, operation)
    }
    if (operation.kind !== "lastOnline") {
      throw validationException(
        "operation",
        "Select a Zalo Account presence query",
      )
    }
    await requirePeer(redis, input, account, operation.uid)
    return await cachedPresence(input, account, redis, {
      kind: "lastOnline",
      uid: operation.uid,
    })
  },

  async mutate(
    input: WithCommand & {
      operation: ZaloAccountContactMutation
      selectionToken?: string
    },
  ) {
    const account = await requireAccount(input)
    const redis = await cacheConnections.useExisting()
    const operation = zaloAccountContactMutationSchema.parse(input.operation)
    return { status: await mutateOnce(input, account, redis, operation) }
  },
}
