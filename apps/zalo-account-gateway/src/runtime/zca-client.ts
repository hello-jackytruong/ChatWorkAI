import {
  type ZaloAccountAuth,
  type ZaloAccountGroup,
  type ZaloAccountMessageActivity,
  type ZaloAccountNativeOperation,
  ZaloAccountPreDispatchError,
  zaloAccountAuthSchema,
  zaloAccountFriendSyncSchema,
  zaloAccountLabelSnapshotSchema,
  zaloAccountNativeToolFamily,
} from "@chatbotx.io/sdk"
import {
  type Credentials,
  type LoginQRCallbackEvent,
  LoginQRCallbackEventType,
  Reactions,
  ThreadType,
  Zalo,
} from "zca-js"
import { runProviderAccountProfile } from "./account-profile"
import { runProviderConversationSettings } from "./conversation-settings"
import { readProviderGroupAdministration } from "./group-administration"
import { runProviderGroupManagement } from "./group-management"
import { readGroupMembers } from "./group-members"
import { createZaloAccountHistoryReader } from "./history-page"
import { runProviderNativeReplies } from "./native-replies"
import { assertOutboundUrl } from "./outbound-attachment"
import type {
  ZcaApiPort,
  ZcaClientFactory,
  ZcaClientPort,
  ZcaQrEvent,
} from "./ports"
import {
  normalizeZaloFriendEvent,
  runZaloContactOperation,
} from "./provider-contacts"
import { normalizeProviderGroupEvent } from "./provider-group-event"
import {
  normalizeProviderGroupActivity,
  normalizeProviderMessage,
} from "./provider-message"
import { normalizeZaloProfile, readProviderProfiles } from "./provider-profile"
import { normalizeProviderThreadEvent } from "./provider-thread-event"
import { sendOutbound } from "./send-outbound"
import { createStickerCatalogReader } from "./sticker-catalog"
import { createStickerResourceReader } from "./sticker-resource"

const positiveIntegerId = /^[1-9]\d*$/

const normalizeQrImage = (image: string) =>
  image.startsWith("data:image/") ? image : `data:image/png;base64,${image}`

const normalizeTimestampMs = (value: number): number => {
  if (value <= 0) {
    return Date.now()
  }
  return value < 1_000_000_000_000 ? value * 1000 : value
}

type NativeSdkPort = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  "undo" | "deleteMessage" | "deleteChat"
>

type ActivitySdkPort = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  "addReaction" | "sendSeenEvent" | "sendDeliveredEvent"
> & {
  listener: Pick<
    Awaited<ReturnType<Zalo["login"]>>["listener"],
    "requestOldReactions"
  >
}

const reactionIcons = {
  heart: Reactions.HEART,
  like: Reactions.LIKE,
  haha: Reactions.HAHA,
  wow: Reactions.WOW,
  sad: Reactions.CRY,
  angry: Reactions.ANGRY,
}

export const invokeMessageActivity = async (
  api: ActivitySdkPort,
  activity: ZaloAccountMessageActivity,
): Promise<void> => {
  const type =
    activity.threadType === "group" ? ThreadType.Group : ThreadType.User
  if (activity.operation === "requestReactionHistory") {
    api.listener.requestOldReactions(type)
    return
  }
  const { providerMessageId: msgId, providerClientMessageId: cliMsgId } =
    activity
  if (activity.operation === "setReaction") {
    // The pinned SDK parses both IDs as Number before serializing the request.
    if (
      [msgId, cliMsgId].some(
        (id) =>
          !(positiveIntegerId.test(id) && Number.isSafeInteger(Number(id))),
      )
    ) {
      throw new ZaloAccountPreDispatchError(
        "Zalo reaction requires exact numeric message IDs",
      )
    }
    await api.addReaction(
      activity.reaction === null
        ? Reactions.NONE
        : reactionIcons[activity.reaction],
      { data: { msgId, cliMsgId }, threadId: activity.threadId, type },
    )
    return
  }
  const message = {
    msgId,
    cliMsgId,
    uidFrom: activity.providerSenderId,
    idTo: activity.providerRecipientId,
    msgType: activity.msgType,
    st: activity.st,
    at: activity.at,
    cmd: activity.cmd,
    ts: activity.timestampMs,
  }
  if (activity.operation === "sendSeen") {
    await api.sendSeenEvent(message, type)
  } else {
    await api.sendDeliveredEvent(false, message, type)
  }
}

export const invokeNativeOperation = async (
  api: NativeSdkPort,
  input: ZaloAccountNativeOperation,
) => {
  const type = input.threadType === "group" ? ThreadType.Group : ThreadType.User
  if (input.operation === "undo") {
    return await api.undo(
      {
        msgId: input.providerMessageId,
        cliMsgId: input.providerClientMessageId,
      },
      input.threadId,
      type,
    )
  }
  if (input.operation === "deleteMessage") {
    return await api.deleteMessage(
      {
        data: {
          msgId: input.providerMessageId,
          cliMsgId: input.providerClientMessageId,
          uidFrom: input.providerOwnerId,
        },
        threadId: input.threadId,
        type,
      },
      true,
    )
  }
  return await api.deleteChat(
    {
      ownerId: input.providerOwnerId,
      cliMsgId: input.providerClientMessageId,
      globalMsgId: input.providerMessageId,
    },
    input.threadId,
    type,
  )
}

const safeCloseReason = (code: number) => {
  if (code === 3000) {
    return "duplicate_connection"
  }
  if (code === 3003) {
    return "kicked"
  }
  if (code === 1000) {
    return "manual"
  }
  if (code === 1006) {
    return "network"
  }
  return "unknown"
}

const adaptApi = (api: Awaited<ReturnType<Zalo["login"]>>): ZcaApiPort => {
  let socketStarted = false
  let socketClosed = false
  let closePromise: Promise<void> | undefined
  let confirmClose: (() => void) | undefined
  let historyReader:
    | ReturnType<typeof createZaloAccountHistoryReader>
    | undefined
  let historyNormalization:
    | Parameters<typeof createZaloAccountHistoryReader>[1]
    | undefined
  const onClosed = () => {
    socketClosed = true
    confirmClose?.()
  }
  // Keep the close observer until the SDK confirms the network close.
  api.listener.on("closed", onClosed)
  const getStickerResources = createStickerResourceReader((ids) =>
    api.getStickersDetail(ids),
  )
  return {
    messageActivity: (activity) => invokeMessageActivity(api, activity),
    nativeOperation: (input) => invokeNativeOperation(api, input),
    getStickerResources,
    getStickerCatalog: createStickerCatalogReader(api, getStickerResources),
    getGroupMembers: (groupId, query) => readGroupMembers(api, groupId, query),
    readGroupAdministration: (groupId, query, scope) =>
      readProviderGroupAdministration(api, groupId, query, scope),
    groupManagement: (groupId, operation, authorizeDispatch) =>
      runProviderGroupManagement(api, groupId, operation, authorizeDispatch),
    nativeTool: (thread, operation, authorizeDispatch) => {
      const family = zaloAccountNativeToolFamily(operation)
      if (family === "accountProfile") {
        return runProviderAccountProfile(api, operation, authorizeDispatch)
      }
      if (family === "nativeReplies") {
        return runProviderNativeReplies(api, operation, authorizeDispatch)
      }
      if (!thread) {
        throw new ZaloAccountPreDispatchError(
          "Native Zalo conversation is unavailable",
        )
      }
      return runProviderConversationSettings(
        api,
        thread,
        operation,
        authorizeDispatch,
      )
    },
    readProfiles: (query) => readProviderProfiles(api, query),
    contactOperation: (operation) =>
      runZaloContactOperation(api, operation, api.getOwnId()),
    fetchHistoryPage: (history, options) => {
      historyReader ??= createZaloAccountHistoryReader(
        api,
        historyNormalization ?? { ownUid: api.getOwnId() },
      )
      if (history.threadType === "group") {
        return historyReader.group({ ...options, groupId: history.threadId })
      }
      return historyReader.direct({
        ...options,
        cursor: history.cursor ?? null,
        ...(history.threadId ? { threadId: history.threadId } : {}),
      })
    },
    sendTyping: async (threadId, threadType) => {
      await api.sendTypingEvent(
        threadId,
        threadType === "group" ? ThreadType.Group : ThreadType.User,
      )
    },
    getOwnId: async () => api.getOwnId(),
    closeConnection: () => {
      if (!socketStarted || socketClosed) {
        api.listener.removeListener("closed", onClosed)
        return Promise.resolve()
      }
      if (closePromise) {
        return closePromise
      }
      closePromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Zalo Account socket close unconfirmed")),
          10_000,
        )
        timer.unref?.()
        confirmClose = () => {
          clearTimeout(timer)
          api.listener.removeListener("closed", onClosed)
          resolve()
        }
        api.listener.stop()
      })
      return closePromise
    },
    getAuthorization: (previous) =>
      zaloAccountAuthSchema.parse({
        ...previous,
        cookie: api.getCookie().serializeSync()?.cookies,
      }),
    listen: (handlers) => {
      if (handlers.ownUid) {
        historyNormalization = {
          ownUid: handlers.ownUid,
          ...(handlers.messageIntegrityEnabled === undefined
            ? {}
            : { messageIntegrityEnabled: handlers.messageIntegrityEnabled }),
        }
      }
      let started = false
      return {
        start: () => {
          if (started) {
            return
          }
          started = true
          for (const event of [
            "connected",
            "disconnected",
            "closed",
            "error",
            "message",
            "old_messages",
            "seen_messages",
            "delivered_messages",
            "typing",
            "reaction",
            "old_reactions",
            "undo",
            "friend_event",
            "group_event",
            "upload_attachment",
            "cipher_key",
          ] as const) {
            api.listener.on(event, () => handlers.onEvent?.())
          }
          api.listener.on("connected", () => handlers.onConnected?.())
          api.listener.on("disconnected", (code) =>
            handlers.onDisconnected?.(code, safeCloseReason(code)),
          )
          api.listener.on("closed", (code) =>
            handlers.onClosed(safeCloseReason(code), code),
          )
          api.listener.on("error", () => handlers.onError?.("unknown"))
          api.listener.on("message", (message) => {
            try {
              const normalized = normalizeProviderMessage(message, {
                ownUid: handlers.ownUid,
                messageIntegrityEnabled: handlers.messageIntegrityEnabled,
              })
              if (normalized.kind === "direct") {
                handlers.onDirectMessage(normalized.message)
              } else if (normalized.kind === "group") {
                handlers.onGroupMessage(normalized)
              } else {
                const activity = normalizeProviderGroupActivity(message)
                if (activity) {
                  handlers.onGroupMessage(activity)
                }
                handlers.onUnsupported(normalized.reason)
              }
            } catch {
              handlers.onUnsupported("invalid_fields")
            }
          })
          api.listener.on("seen_messages", (messages) => {
            if (handlers.onThreadEvent) {
              for (const message of messages) {
                for (const event of normalizeProviderThreadEvent(
                  "seen",
                  message,
                  handlers.ownUid,
                )) {
                  handlers.onThreadEvent(event)
                }
              }
              return
            }
            for (const message of messages) {
              if (message.type !== ThreadType.User) {
                continue
              }
              handlers.onDirectStatus({
                providerMessageId: String(message.data.msgId),
                threadId: String(message.threadId),
                status: "read",
                timestampMs: Date.now(),
              })
            }
          })
          api.listener.on("delivered_messages", (messages) => {
            if (handlers.onThreadEvent) {
              for (const message of messages) {
                for (const event of normalizeProviderThreadEvent(
                  "delivered",
                  message,
                  handlers.ownUid,
                )) {
                  handlers.onThreadEvent(event)
                }
              }
              return
            }
            for (const message of messages) {
              if (message.type !== ThreadType.User) {
                continue
              }
              const rawTimestamp = Number(message.data.mSTs)
              handlers.onDirectStatus({
                providerMessageId: String(message.data.msgId),
                threadId: String(message.threadId),
                status: "delivered",
                timestampMs: normalizeTimestampMs(rawTimestamp),
              })
            }
          })
          api.listener.on("undo", (undo) => {
            if (handlers.onThreadEvent) {
              for (const event of normalizeProviderThreadEvent("undo", undo)) {
                handlers.onThreadEvent(event)
              }
              return
            }
            if (undo.isGroup) {
              return
            }
            const providerMessageId =
              undo.data.content.globalMsgId || undo.data.content.cliMsgId
            if (!providerMessageId) {
              handlers.onUnsupported("undo_missing_message_id")
              return
            }
            handlers.onDirectUndo({
              providerMessageId: String(providerMessageId),
              threadId: String(undo.threadId),
              timestampMs: Number(undo.data.ts) || Date.now(),
            })
          })
          api.listener.on("typing", (typing) => {
            for (const event of normalizeProviderThreadEvent(
              "typing",
              typing,
              handlers.ownUid,
            )) {
              handlers.onThreadEvent?.(event)
            }
          })
          api.listener.on("reaction", (reaction) => {
            for (const event of normalizeProviderThreadEvent(
              "reaction",
              reaction,
              handlers.ownUid,
            )) {
              handlers.onThreadEvent?.(event)
            }
          })
          api.listener.on("old_reactions", (reactions) => {
            let remaining = 1000
            for (const reaction of reactions.slice(0, 1000)) {
              const events = normalizeProviderThreadEvent(
                "reaction",
                reaction,
                handlers.ownUid,
              ).slice(0, remaining)
              for (const event of events) {
                handlers.onThreadEvent?.(event)
              }
              remaining -= events.length
              if (remaining === 0) {
                break
              }
            }
          })
          api.listener.on("friend_event", (event) => {
            for (const activity of normalizeZaloFriendEvent(
              event,
              api.getOwnId(),
            )) {
              handlers.onFriendEvent?.(activity)
            }
          })
          api.listener.on("group_event", (event) => {
            if (handlers.onGroupEvent) {
              const normalized = normalizeProviderGroupEvent(
                event,
                handlers.ownUid ?? api.getOwnId(),
              )
              if (normalized) {
                handlers.onGroupEvent(normalized)
              }
            }
          })
          api.listener.start({ retryOnClose: false })
          socketStarted = true
        },
        stop: () => api.listener.stop(),
      }
    },
    sendDirect: (message, beforeDispatch) =>
      sendOutbound(
        api,
        message,
        message.recipientId,
        ThreadType.User,
        beforeDispatch,
      ),
    listGroups: async () => {
      const allGroups = await api.getAllGroups()
      const allIds = Object.keys(allGroups.gridVerMap)
      const groupIds = allIds.slice(0, 1000)
      const groups: ZaloAccountGroup[] = []
      for (let index = 0; index < groupIds.length; index += 50) {
        const chunk = groupIds.slice(index, index + 50)
        const details = await api.getGroupInfo(chunk)
        for (const providerGroupId of chunk) {
          const group = details.gridInfoMap[providerGroupId]
          if (!group) {
            continue
          }
          groups.push({
            providerGroupId,
            name: group.name,
            ...(group.fullAvt || group.avt
              ? { avatarUrl: group.fullAvt || group.avt }
              : {}),
            memberCount: group.totalMember,
            ...(group.version ? { providerVersion: group.version } : {}),
          })
        }
      }
      const complete = allIds.length <= 1000 && groups.length === allIds.length
      return {
        groups,
        complete,
        reportedTotal: allIds.length,
        ...(complete
          ? {}
          : {
              reason:
                allIds.length > 1000
                  ? ("truncated" as const)
                  : ("missing_details" as const),
            }),
      }
    },
    listFriends: async (cursor) => {
      const page = await api.getAllFriends(500, cursor)
      const friends = page
        .filter((friend) => friend.isFr === 1 && friend.isValid === 1)
        .map((friend) => ({
          uid: friend.userId,
          name: friend.displayName || friend.zaloName || friend.userId,
          profile: normalizeZaloProfile({
            uid: friend.userId,
            source: "getAllFriends",
            observedAt: Date.now(),
            data: friend,
          }),
          ...(friend.avatar?.startsWith("https://")
            ? { avatarUrl: friend.avatar }
            : {}),
        }))
      return zaloAccountFriendSyncSchema.parse({
        friends,
        complete: page.length < 500,
        ...(page.length >= 500 ? { nextCursor: cursor + 1 } : {}),
      })
    },
    sendGroup: (groupId, message, beforeDispatch) =>
      sendOutbound(api, message, groupId, ThreadType.Group, beforeDispatch),
    getLabels: async () =>
      zaloAccountLabelSnapshotSchema.parse({
        ...(await api.getLabels()),
        complete: true,
      }),
    updateLabels: async ({ labelData, version }) =>
      zaloAccountLabelSnapshotSchema.parse({
        ...(await api.updateLabels({ labelData, version })),
        complete: true,
      }),
  }
}

const qrEventOf = (event: LoginQRCallbackEvent): ZcaQrEvent | undefined => {
  if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
    event.actions.abort()
    return { type: "declined" }
  }
  if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
    return {
      type: "generated",
      imageDataUrl: normalizeQrImage(event.data.image),
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
    }
  }
  if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
    return { type: "expired", retry: event.actions.retry }
  }
  if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
    return {
      type: "scanned",
      displayName: event.data.display_name,
      ...(event.data.avatar ? { avatarUrl: event.data.avatar } : {}),
    }
  }
  if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
    const cookie = JSON.parse(JSON.stringify(event.data.cookie)) as unknown
    return {
      type: "credentials",
      auth: zaloAccountAuthSchema.parse({
        authType: "custom",
        cookie,
        imei: event.data.imei,
        userAgent: event.data.userAgent,
        // Filled with the verified getOwnId result by the runtime.
        zaloUid: "pending-verification",
      }),
    }
  }
  return
}

export class ZcaClient implements ZcaClientPort {
  private readonly controller = new AbortController()
  private readonly zalo: Zalo
  private loginPending = true
  private settlement: Promise<unknown> = Promise.resolve()
  private abortQr: (() => void) | undefined
  private qrAborted = false

  constructor(fetcher: typeof fetch = globalThis.fetch) {
    this.zalo = new Zalo({
      logging: false,
      selfListen: true,
      checkUpdate: false,
      polyfill: async (input, init) => {
        if (!this.loginPending) {
          // zca-js probes the uploaded clip URL before sending voice or video.
          if (init?.method === "HEAD") {
            await assertOutboundUrl(
              input instanceof Request ? input.url : String(input),
            )
            const response = await fetcher(input, {
              ...init,
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            })
            if (!response.ok || response.headers.has("location")) {
              throw new Error("Zalo Account clip storage probe failed")
            }
            return response
          }
          return fetcher(input, init)
        }
        const signals = [this.controller.signal]
        if (init?.signal) {
          signals.push(init.signal)
        }
        if (input instanceof Request) {
          signals.push(input.signal)
        }
        const signal = AbortSignal.any(signals)
        signal.throwIfAborted()
        return fetcher(input, { ...init, signal })
      },
    })
  }

  async cancel(): Promise<void> {
    this.controller.abort()
    this.abortQr?.()
    await this.settlement.catch(() => undefined)
  }

  loginQr(callback: (event: ZcaQrEvent) => void): Promise<ZcaApiPort> {
    return this.track(
      this.zalo.loginQR({}, (event) => {
        if (event.actions) {
          const abort = event.actions.abort
          this.abortQr = () => {
            if (this.qrAborted) {
              return
            }
            this.qrAborted = true
            abort()
          }
          if (this.controller.signal.aborted) {
            // Generated callback runs before the SDK installs its QR timeout.
            queueMicrotask(() => this.abortQr?.())
            return
          }
        }
        if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
          this.abortQr?.()
          callback({ type: "declined" })
          return
        }
        const adapted = qrEventOf(event)
        if (adapted) {
          callback(adapted)
        }
      }),
    )
  }

  login(auth: ZaloAccountAuth): Promise<ZcaApiPort> {
    const credentials = {
      cookie: JSON.parse(JSON.stringify(auth.cookie)),
      imei: auth.imei,
      userAgent: auth.userAgent,
    } as unknown as Credentials
    return this.track(this.zalo.login(credentials))
  }

  private track(login: ReturnType<Zalo["login"]>): Promise<ZcaApiPort> {
    const result = login
      .then((api) => adaptApi(api))
      .finally(() => {
        this.loginPending = false
        this.abortQr = undefined
      })
    this.settlement = result
    return result
  }
}

export const zcaClientFactory: ZcaClientFactory = {
  create: () => new ZcaClient(),
}
