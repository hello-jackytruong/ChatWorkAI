import {
  connectionRepository,
  integrationZaloAccountRepository,
} from "@chatbotx.io/database/repositories"
import { cacheConnections } from "@chatbotx.io/redis"
import type {
  ZaloAccountAuth,
  ZaloAccountRuntimeDiagnostics,
  ZaloAccountRuntimeOrder,
} from "@chatbotx.io/sdk"
import {
  isNewerZaloAccountRuntimeEvent,
  zaloAccountTransportKeys,
} from "@chatbotx.io/sdk"
import {
  connectionStateService,
  type PendingQuotaRelease,
} from "../connection/state-service"
import { encryptZaloAccountAuth, zaloAuthorizationFingerprint } from "./auth"

type RuntimeOwner = {
  deadlineAt?: number
  workspaceId: string
  accountId: string
  inboxId: string
  fenceToken: string
  epoch: number
}
const accountRef = (input: RuntimeOwner) => ({
  ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  workspaceId: input.workspaceId,
  id: input.accountId,
  inboxId: input.inboxId,
})

const runtimeTransitions = {
  connected: { event: "verify.ok", reason: undefined, lastError: null },
  closed: {
    event: "refresh.transient_failure",
    reason: "refresh_failed",
    lastError: "Zalo socket closed; reconnecting",
  },
  reauthorization_required: {
    event: "auth.revoked",
    reason: "token_revoked",
    lastError: "Zalo device authorization requires renewal",
  },
} as const

export const zaloAccountRuntimeStateService = {
  async claim(input: RuntimeOwner): Promise<boolean> {
    return await integrationZaloAccountRepository.withRuntimeAccount(
      accountRef(input),
      async (tx, account) => {
        const previous = account.operations?.diagnostics
        if (
          previous &&
          (BigInt(previous.fenceToken) > BigInt(input.fenceToken) ||
            (previous.fenceToken === input.fenceToken &&
              previous.epoch >= input.epoch))
        ) {
          return false
        }
        const fingerprint = await zaloAuthorizationFingerprint(
          account.encryptedAuth,
        )
        await integrationZaloAccountRepository.writeDiagnostics(
          account.id,
          {
            phase: "connecting",
            reconnectCount: 0,
            fenceToken: input.fenceToken,
            epoch: input.epoch,
            socketAttempt: 1,
            sequence: 0,
            lastLifecycleAt: new Date().toISOString(),
            ...(previous?.hold?.authFingerprint === fingerprint
              ? { hold: previous.hold, phase: "held", requiresAction: true }
              : {}),
          },
          tx,
        )
        return true
      },
    )
  },
  async hold(
    input: RuntimeOwner & {
      authFingerprint: string
      diagnostics: ZaloAccountRuntimeDiagnostics
      socketAttempt: number
      sequence: number
    },
  ): Promise<boolean> {
    return await integrationZaloAccountRepository.withRuntimeAccount(
      accountRef(input),
      async (tx, account) => {
        const fingerprint = await zaloAuthorizationFingerprint(
          account.encryptedAuth,
        )
        const previous = account.operations?.diagnostics
        const refresh = previous?.authorizationRefresh
        if (
          fingerprint !== input.authFingerprint &&
          !(
            refresh?.sourceFingerprint === input.authFingerprint &&
            refresh.currentFingerprint === fingerprint
          )
        ) {
          return false
        }
        if (
          previous &&
          !isNewerZaloAccountRuntimeEvent(
            { ...input, state: "closed", occurredAt: "" },
            { ...previous, state: "closed", occurredAt: "" },
          )
        ) {
          return false
        }
        await integrationZaloAccountRepository.writeDiagnostics(
          account.id,
          {
            ...input.diagnostics,
            fenceToken: input.fenceToken,
            epoch: input.epoch,
            socketAttempt: input.socketAttempt,
            sequence: input.sequence,
            hold: {
              authFingerprint: fingerprint,
              category: input.diagnostics.errorCategory ?? "unknown",
              heldAt: new Date().toISOString(),
            },
          },
          tx,
        )
        return true
      },
    )
  },
  async refreshAuthorization(
    input: RuntimeOwner & {
      auth: ZaloAccountAuth
      expectedCiphertextFingerprint: string
      socketAttempt: number
      sequence: number
    },
  ): Promise<boolean> {
    return await integrationZaloAccountRepository.withRuntimeAccount(
      accountRef(input),
      async (tx, account) => {
        if (
          account.zaloUid !== input.auth.zaloUid ||
          (await zaloAuthorizationFingerprint(account.encryptedAuth)) !==
            input.expectedCiphertextFingerprint
        ) {
          return false
        }
        const current = account.operations?.diagnostics
        if (
          !current ||
          current.fenceToken !== input.fenceToken ||
          current.epoch !== input.epoch ||
          current.socketAttempt !== input.socketAttempt ||
          current.sequence > input.sequence ||
          current.hold
        ) {
          return false
        }
        const encryptedAuth = await encryptZaloAccountAuth(
          input.workspaceId,
          input.inboxId,
          input.auth,
        )
        const redis = await cacheConnections.useExisting()
        const lease = await redis.get(
          zaloAccountTransportKeys.lease({
            workspaceId: input.workspaceId,
            runtime: { kind: "account", id: input.accountId },
          }),
        )
        if (!lease?.endsWith(`:${input.fenceToken}`)) {
          return false
        }
        await integrationZaloAccountRepository.replaceRuntimeAuthorization(
          account.id,
          encryptedAuth,
          tx,
        )
        await integrationZaloAccountRepository.writeDiagnostics(
          account.id,
          {
            ...current,
            authorizationRefresh: {
              sourceFingerprint: input.expectedCiphertextFingerprint,
              currentFingerprint:
                await zaloAuthorizationFingerprint(encryptedAuth),
            },
          },
          tx,
        )
        return true
      },
    )
  },
  async applyDiagnostics(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    order: ZaloAccountRuntimeOrder
    diagnostics: ZaloAccountRuntimeDiagnostics
  }): Promise<boolean> {
    if (!(input.order.socketAttempt && input.order.sequence)) {
      return false
    }
    return await integrationZaloAccountRepository.withDiagnosticFence({
      workspaceId: input.workspaceId,
      id: input.accountId,
      inboxId: input.inboxId,
      diagnostics: {
        ...input.diagnostics,
        fenceToken: input.order.fenceToken,
        epoch: input.order.epoch,
        socketAttempt: input.order.socketAttempt,
        sequence: input.order.sequence,
        lastLifecycleAt: input.order.occurredAt,
      },
    })
  },
  async apply(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    order: ZaloAccountRuntimeOrder
    diagnostics?: ZaloAccountRuntimeDiagnostics
  }): Promise<boolean> {
    const pendingRelease: { current: PendingQuotaRelease | null } = {
      current: null,
    }
    let eligible = false
    const accepted = await integrationZaloAccountRepository.withRuntimeFence(
      {
        workspaceId: input.workspaceId,
        id: input.accountId,
        inboxId: input.inboxId,
        order: input.order,
        ...(input.diagnostics &&
        input.order.socketAttempt &&
        input.order.sequence
          ? {
              diagnostics: {
                ...input.diagnostics,
                ...input.order,
                socketAttempt: input.order.socketAttempt,
                sequence: input.order.sequence,
                lastLifecycleAt: input.order.occurredAt,
              },
            }
          : {}),
      },
      async (tx) => {
        const connection = await connectionRepository.findByInboxId(
          { inboxId: input.inboxId },
          tx,
        )
        if (
          !connection ||
          connection.workspaceId !== input.workspaceId ||
          connection.provider !== "zaloAccount" ||
          !["connected", "degraded"].includes(connection.status)
        ) {
          return false
        }
        eligible = true
        const transition = runtimeTransitions[input.order.state]
        await connectionStateService.transition({
          connectionId: connection.id,
          event: transition.event,
          reason: transition.reason,
          values: { lastError: transition.lastError },
          tx,
          pendingRelease,
        })
      },
    )
    await connectionStateService.releasePendingQuota(pendingRelease.current)
    return accepted && eligible
  },
}
