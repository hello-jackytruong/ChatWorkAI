import {
  type ConnectSessionActor,
  connectSessionService,
} from "@chatbotx.io/business/connect-session"
import {
  connectionCredentialsRejectedException,
  connectionProviderUnavailableException,
  connectionStateMismatchException,
  connectionWrongStrategyException,
  toPublicErrorMessage,
} from "@chatbotx.io/business/errors"
import { dispatchStagedInstalls } from "@chatbotx.io/business/template-install-dispatch"
import {
  compensateWorkspaceQuotaConsumption,
  type WorkspaceQuotaConsumption,
} from "@chatbotx.io/business/workspace"
import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import type {
  ConnectSessionPurpose,
  IntegrationType,
} from "@chatbotx.io/database/partials"
import { connectionRepository } from "@chatbotx.io/database/repositories"
import type { ConnectSessionModel } from "@chatbotx.io/database/types"
import type { AuthValue, ConnectSessionNextAction } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { connectSessionNextActionSchema } from "@chatbotx.io/utils/connection"
import { continueAuthorization } from "./connect-session-flow"
import {
  providerFailureStatus,
  resolveAdapter,
  toConnectionProviderError,
} from "./internal"
import { logger } from "./logger"

const actorRefOf = (actor: ConnectSessionActor): ConnectSessionActor =>
  actor.actorUserId === undefined
    ? { actorTokenId: actor.actorTokenId }
    : { actorUserId: actor.actorUserId }

type StartDeviceSessionTarget =
  | { workspaceId: string; createWorkspace?: never }
  | {
      workspaceId?: never
      createWorkspace: (
        tx: DatabaseClient,
        quotaConsumption: WorkspaceQuotaConsumption,
      ) => Promise<{ id: string }>
    }

const requireDeviceSession = async (input: {
  sessionId: string
  workspaceId: string
  provider: IntegrationType
}): Promise<ConnectSessionModel> => {
  const session = await connectSessionService.findByIdForWorkspace({
    id: input.sessionId,
    workspaceId: input.workspaceId,
  })
  if (!session || session.provider !== input.provider) {
    throw connectionStateMismatchException()
  }
  const adapter = resolveAdapter(input.provider)
  if (adapter.provider.strategy !== "qr_device") {
    throw connectionWrongStrategyException(input.provider)
  }
  return session
}

export const startDeviceSession = async (
  input: {
    provider: IntegrationType
    purpose: Extract<ConnectSessionPurpose, "connect" | "reconnect">
    targetConnectionId?: string | null
  } & StartDeviceSessionTarget &
    ConnectSessionActor,
): Promise<{
  session: ConnectSessionModel
  nextAction: ConnectSessionNextAction
}> => {
  const adapter = resolveAdapter(input.provider)
  if (adapter.provider.strategy !== "qr_device") {
    throw connectionWrongStrategyException(input.provider)
  }
  const verifyTargetOwnership = async (workspaceId: string) => {
    if (!input.targetConnectionId) {
      return
    }
    const target = await connectionRepository.findByIdForWorkspace({
      id: input.targetConnectionId,
      workspaceId,
    })
    if (!target) {
      throw connectionStateMismatchException()
    }
  }

  const sessionId = createId()
  const createSession = async (workspaceId: string, tx?: DatabaseClient) => {
    await verifyTargetOwnership(workspaceId)
    return await connectSessionService.create(
      {
        id: sessionId,
        workspaceId,
        provider: input.provider,
        purpose: input.purpose,
        initialStep: "device_start",
        targetConnectionId: input.targetConnectionId ?? null,
        nextAction: () => ({ type: "wait" }),
        ...actorRefOf(input),
      },
      tx,
    )
  }
  let created: Awaited<ReturnType<typeof createSession>>
  if (input.createWorkspace) {
    const quotaConsumption: WorkspaceQuotaConsumption = { consumed: false }
    try {
      created = await db.transaction(async (tx) => {
        const workspace = await input.createWorkspace(tx, quotaConsumption)
        return await createSession(workspace.id, tx)
      })
    } catch (error) {
      await compensateWorkspaceQuotaConsumption(quotaConsumption)
      throw error
    }
    await dispatchStagedInstalls(created.session.workspaceId)
  } else {
    created = await createSession(input.workspaceId)
  }

  try {
    await adapter.provider.startDeviceAuthorization({
      sessionId: created.session.id,
      workspaceId: created.session.workspaceId,
      purpose: input.purpose,
      targetConnectionId: input.targetConnectionId ?? null,
    })
  } catch (err) {
    const providerError = toConnectionProviderError(err)
    logger.warn(
      {
        err: providerError,
        sessionId: created.session.id,
        provider: input.provider,
      },
      "connection device authorization dispatch failed",
    )
    await connectSessionService.fail({
      id: created.session.id,
      workspaceId: created.session.workspaceId,
      errorCode: "provider_error",
      statuses: ["pending"],
    })
    const retryStatus = providerFailureStatus(providerError)
    if (retryStatus) {
      throw connectionProviderUnavailableException(retryStatus)
    }
    throw connectionCredentialsRejectedException(
      toPublicErrorMessage(
        providerError,
        "Unable to start device authorization.",
      ),
    )
  }

  if (!created.session.nextAction) {
    throw new Error("Device connect session was created without a wait action")
  }
  return { session: created.session, nextAction: created.session.nextAction }
}

export const cancelDeviceSession = async (input: {
  sessionId: string
  workspaceId: string
}): Promise<ConnectSessionModel> => {
  const session = await connectSessionService.findByIdForWorkspace({
    id: input.sessionId,
    workspaceId: input.workspaceId,
  })
  if (!session) {
    throw connectionStateMismatchException()
  }
  const adapter = resolveAdapter(session.provider)
  if (adapter.provider.strategy === "qr_device") {
    await adapter.provider.cancelDeviceAuthorization?.({
      sessionId: session.id,
      workspaceId: session.workspaceId,
    })
  }
  return await connectSessionService.cancel({
    id: session.id,
    workspaceId: session.workspaceId,
  })
}

export const publishDeviceQr = async (input: {
  sessionId: string
  workspaceId: string
  provider: IntegrationType
  imageDataUrl: string
  expiresAt: string
}): Promise<ConnectSessionModel> => {
  await requireDeviceSession(input)
  const nextAction = connectSessionNextActionSchema.parse({
    type: "show_qr",
    imageDataUrl: input.imageDataUrl,
    expiresAt: input.expiresAt,
  })
  return await connectSessionService.advanceStep({
    id: input.sessionId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    statuses: ["pending"],
    expectedSteps: ["device_start", "qr_ready"],
    step: "qr_ready",
    nextAction,
  })
}

export const markDeviceQrScanned = async (input: {
  sessionId: string
  workspaceId: string
  provider: IntegrationType
}): Promise<ConnectSessionModel> => {
  await requireDeviceSession(input)
  return await connectSessionService.advanceStep({
    id: input.sessionId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    statuses: ["pending"],
    expectedSteps: ["qr_ready"],
    step: "qr_scanned",
    nextAction: { type: "wait" },
  })
}

export const completeDeviceAuthorization = async (input: {
  sessionId: string
  workspaceId: string
  provider: IntegrationType
  auth: AuthValue
}): Promise<ConnectSessionModel> => {
  let session = await requireDeviceSession(input)
  if (
    session.status === "awaiting_selection" ||
    session.status === "completed"
  ) {
    return session
  }
  if (session.status === "authorized") {
    return session
  }
  if (session.status === "pending") {
    await connectSessionService.advanceStep({
      id: session.id,
      workspaceId: session.workspaceId,
      provider: input.provider,
      statuses: ["pending"],
      expectedSteps: ["qr_ready", "qr_scanned"],
      step: "authorization_received",
      nextAction: { type: "wait" },
    })
    session = await connectSessionService.claimAuthorization({
      id: session.id,
      workspaceId: session.workspaceId,
    })
  }
  if (session.status !== "authorized") {
    throw connectionStateMismatchException()
  }

  const adapter = resolveAdapter(input.provider)
  let health: Awaited<ReturnType<typeof adapter.provider.verify>>
  try {
    health = await adapter.provider.verify({ auth: input.auth })
  } catch (err) {
    const providerError = toConnectionProviderError(err)
    await connectSessionService.fail({
      id: session.id,
      workspaceId: session.workspaceId,
      errorCode: "provider_error",
      statuses: ["authorized"],
    })
    const retryStatus = providerFailureStatus(providerError)
    if (retryStatus) {
      throw connectionProviderUnavailableException(retryStatus)
    }
    throw connectionCredentialsRejectedException(
      toPublicErrorMessage(
        providerError,
        "The provider rejected the device authorization.",
      ),
    )
  }
  if (!health.ok) {
    await connectSessionService.fail({
      id: session.id,
      workspaceId: session.workspaceId,
      errorCode: "provider_error",
      statuses: ["authorized"],
    })
    throw connectionCredentialsRejectedException(
      "The provider rejected the device authorization.",
    )
  }
  return await continueAuthorization(session, input.auth)
}

/**
 * Completes a device session whose provider runtime already authenticated the
 * session and verified its identity. This path is intentionally capability
 * gated so an ordinary QR provider cannot bypass `provider.verify`.
 */
export const completeTrustedDeviceAuthorization = async (input: {
  sessionId: string
  workspaceId: string
  provider: IntegrationType
  auth: AuthValue
  trustedProfile?: { displayName: string; avatarUrl?: string }
}): Promise<ConnectSessionModel> => {
  let session = await requireDeviceSession(input)
  const adapter = resolveAdapter(input.provider)
  if (
    adapter.provider.strategy !== "qr_device" ||
    adapter.provider.acceptsTrustedDeviceAuthorization !== true
  ) {
    throw connectionWrongStrategyException(input.provider)
  }
  if (
    session.status === "awaiting_selection" ||
    session.status === "completed" ||
    session.status === "authorized"
  ) {
    return session
  }
  if (session.status === "pending") {
    await connectSessionService.advanceStep({
      id: session.id,
      workspaceId: session.workspaceId,
      provider: input.provider,
      statuses: ["pending"],
      expectedSteps: ["qr_ready", "qr_scanned"],
      step: "authorization_received",
      nextAction: { type: "wait" },
    })
    session = await connectSessionService.claimAuthorization({
      id: session.id,
      workspaceId: session.workspaceId,
    })
  }
  if (session.status !== "authorized") {
    throw connectionStateMismatchException()
  }
  return input.provider === "zaloAccount" && input.trustedProfile
    ? await continueAuthorization(session, input.auth, input.trustedProfile)
    : await continueAuthorization(session, input.auth)
}
