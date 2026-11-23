import type {
  ZaloAccountAuth,
  ZaloAccountAuthorizationEvent,
  ZaloAccountDirectMessage,
  ZaloAccountDirectStatus,
  ZaloAccountDirectUndo,
  ZaloAccountFriendSync,
  ZaloAccountGroup,
  ZaloAccountGroupActivity,
  ZaloAccountGroupMessage,
  ZaloAccountGroupSync,
  ZaloAccountLabel,
  ZaloAccountLabelSnapshot,
  ZaloAccountLifecycleEvent,
  ZaloAccountNativeOperation,
  ZaloAccountOutboundMessage,
  ZaloAccountRuntimeDiagnostics,
  ZaloAccountRuntimeRef,
  ZaloAccountStickerResource,
  ZaloAccountThreadEvent,
} from "@chatbotx.io/sdk"

export type AccountLease = { ownerId: string; fenceToken: string }

export type AccountRuntimeScope = {
  workspaceId: string
  runtime: ZaloAccountRuntimeRef
}

export type AccountLeasePort = {
  writeSnapshot?: (
    scope: AccountRuntimeScope,
    lease: AccountLease,
    serialized: string,
    ttlMs: number,
  ) => Promise<boolean>
  acquire: (
    scope: AccountRuntimeScope,
    ownerId: string,
    ttlMs: number,
  ) => Promise<AccountLease | null>
  renew: (
    scope: AccountRuntimeScope,
    lease: AccountLease,
    ttlMs: number,
  ) => Promise<boolean>
  release: (scope: AccountRuntimeScope, lease: AccountLease) => Promise<boolean>
}

export type RuntimeEventSink = {
  publishThreadEvent?: (
    event: ZaloAccountThreadEvent,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ) => Promise<void>
  publishGroupMessage?: (
    message: ZaloAccountGroupMessage,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ) => Promise<void>
  publishLifecycle: (
    event: ZaloAccountLifecycleEvent,
    context: RuntimeEventContext,
  ) => Promise<void>
  publishAuthorization: (
    event: ZaloAccountAuthorizationEvent,
    context: RuntimeEventContext,
  ) => Promise<void>
  publishDirectMessage: (
    message: ZaloAccountDirectMessage,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ) => Promise<void>
  publishDirectStatus: (
    status: ZaloAccountDirectStatus,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ) => Promise<void>
  publishDirectUndo: (
    undo: ZaloAccountDirectUndo,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ) => Promise<void>
  publishGroupActivity: (
    activity: ZaloAccountGroupActivity,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ) => Promise<void>
}

export type RuntimeEventContext = {
  workspaceId: string
  accountId?: string
  inboxId?: string
  commandId: string
}

export type ZcaQrEvent =
  | { type: "generated"; imageDataUrl: string; expiresAt: string }
  | {
      type: "scanned"
      displayName: string
      avatarUrl?: string
    }
  | { type: "expired"; retry: () => unknown }
  | { type: "declined" }
  | { type: "credentials"; auth: ZaloAccountAuth }

export type ZcaListenerPort = { start: () => void; stop: () => void }

export type ZcaListenerHandlers = {
  onEvent?: () => void
  onThreadEvent?: (event: ZaloAccountThreadEvent) => void
  onConnected?: () => void
  onDisconnected?: (code: number, reason: string) => void
  onError?: (category: "network" | "timeout" | "unknown") => void
  onClosed: (reason: string, code?: number) => void
  onDirectMessage: (message: ZaloAccountDirectMessage) => void
  onDirectStatus: (status: ZaloAccountDirectStatus) => void
  onDirectUndo: (undo: ZaloAccountDirectUndo) => void
  onGroupMessage: (input: {
    threadId: string
    providerMessageId: string
    message?: ZaloAccountGroupMessage
  }) => void
  onUnsupported: (reason: string) => void
}

export type ZcaApiPort = {
  nativeOperation?: (
    operation: ZaloAccountNativeOperation,
  ) => Promise<{ status: number }>
  closeConnection?: () => Promise<void>
  getAuthorization?: (previous: ZaloAccountAuth) => ZaloAccountAuth

  getStickerResources?: (
    stickerIds: string[],
  ) => Promise<ZaloAccountStickerResource[]>
  listFriends?: (cursor: number) => Promise<ZaloAccountFriendSync>
  sendTyping?: (threadId: string, threadType: "user" | "group") => Promise<void>
  getOwnId: () => Promise<string>
  listen: (handlers: ZcaListenerHandlers) => ZcaListenerPort
  sendDirect: (message: ZaloAccountOutboundMessage) => Promise<{
    messageIds: string[]
    sentCount: number
  }>
  listGroups: () => Promise<ZaloAccountGroup[] | ZaloAccountGroupSync>
  sendGroup: (
    groupId: string,
    message: ZaloAccountOutboundMessage,
  ) => Promise<{ messageIds: string[]; sentCount: number }>
  getLabels: () => Promise<ZaloAccountLabelSnapshot>
  updateLabels: (input: {
    labelData: ZaloAccountLabel[]
    version: number
  }) => Promise<ZaloAccountLabelSnapshot>
}

export type ZcaClientPort = {
  cancel?: () => Promise<void>
  loginQr: (callback: (event: ZcaQrEvent) => void) => Promise<ZcaApiPort>
  login: (auth: ZaloAccountAuth) => Promise<ZcaApiPort>
}

export class LocalAuthCapacityError extends Error {}

export type ZcaClientFactory = { create: () => ZcaClientPort }

export type AccountSecretPort = {
  load: (input: {
    workspaceId: string
    accountId: string
    inboxId?: string
    deadlineAt?: number
  }) => Promise<{
    auth: ZaloAccountAuth
    zaloUid: string
    authFingerprint?: string
  }>
}

export type RuntimeOwnership = {
  deadlineAt?: number
  workspaceId: string
  accountId: string
  inboxId: string
  fenceToken: string
  epoch: number
}
export type RuntimeOwnershipHooks = {
  onLeaseLost?: () => void
  claim?: (input: RuntimeOwnership) => Promise<boolean>
  hold?: (
    input: RuntimeOwnership & {
      authFingerprint: string
      socketAttempt: number
      sequence: number
      diagnostics: ZaloAccountRuntimeDiagnostics
    },
  ) => Promise<boolean>
}

export type RuntimeCommand = {
  deadlineAt?: number
  workspaceId: string
  runtime: ZaloAccountRuntimeRef
  inboxId?: string
  commandId?: string
}

export type RuntimeCommandResult = {
  status:
    | "started"
    | "coalesced"
    | "owned_elsewhere"
    | "reauthorization_required"
    | "stopped"
}

export type RuntimeSendResult = {
  status: "sent"
  messageIds: string[]
  sentCount: number
}
