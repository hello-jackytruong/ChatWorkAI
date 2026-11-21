import {
  type ZaloAccountAttachment,
  type ZaloAccountAuth,
  type ZaloAccountGroup,
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  zaloAccountAuthSchema,
  zaloAccountFriendSyncSchema,
  zaloAccountLabelSnapshotSchema,
} from "@chatbotx.io/sdk"
import {
  type Credentials,
  type LoginQRCallbackEvent,
  LoginQRCallbackEventType,
  ThreadType,
  Zalo,
} from "zca-js"
import { downloadOutboundAttachment } from "./outbound-attachment"
import type {
  ZcaApiPort,
  ZcaClientFactory,
  ZcaClientPort,
  ZcaQrEvent,
} from "./ports"
import {
  normalizeProviderGroupActivity,
  normalizeProviderMessage,
} from "./provider-message"
import { normalizeProviderThreadEvent } from "./provider-thread-event"

const normalizeQrImage = (image: string) =>
  image.startsWith("data:image/") ? image : `data:image/png;base64,${image}`

const prepareOutboundAttachment = async (attachment: ZaloAccountAttachment) => {
  try {
    return await downloadOutboundAttachment(attachment)
  } catch (error) {
    throw new ZaloAccountPreDispatchError(
      error instanceof Error
        ? error.message
        : "Zalo Account attachment preparation failed",
    )
  }
}

const normalizeTimestampMs = (value: number): number => {
  if (value <= 0) {
    return Date.now()
  }
  return value < 1_000_000_000_000 ? value * 1000 : value
}

const quoteOf = (quote: ZaloAccountOutboundMessage["quote"]) =>
  quote
    ? {
        content: quote.text ?? "",
        msgType: quote.msgType,
        propertyExt: undefined,
        uidFrom: quote.senderId,
        msgId: quote.providerMessageId,
        cliMsgId: quote.clientMessageId ?? quote.providerMessageId,
        ts: String(quote.timestampMs),
        ttl: 0,
      }
    : undefined

const adaptApi = (api: Awaited<ReturnType<Zalo["login"]>>): ZcaApiPort => ({
  sendTyping: async (threadId, threadType) => {
    await api.sendTypingEvent(
      threadId,
      threadType === "group" ? ThreadType.Group : ThreadType.User,
    )
  },
  getOwnId: async () => api.getOwnId(),
  listen: (handlers) => ({
    start: () => {
      api.listener.on("closed", (_code, reason) => handlers.onClosed(reason))
      api.listener.on("message", (message) => {
        const normalized = normalizeProviderMessage(message)
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
      })
      api.listener.on("seen_messages", (messages) => {
        if (handlers.onThreadEvent) {
          for (const message of messages) {
            for (const event of normalizeProviderThreadEvent("seen", message)) {
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
        for (const event of normalizeProviderThreadEvent("typing", typing)) {
          handlers.onThreadEvent?.(event)
        }
      })
      api.listener.on("reaction", (reaction) => {
        for (const event of normalizeProviderThreadEvent(
          "reaction",
          reaction,
        )) {
          handlers.onThreadEvent?.(event)
        }
      })
      api.listener.on("old_reactions", (reactions) => {
        for (const reaction of reactions.slice(0, 1000)) {
          for (const event of normalizeProviderThreadEvent(
            "reaction",
            reaction,
          )) {
            handlers.onThreadEvent?.(event)
          }
        }
      })
      api.listener.start({ retryOnClose: false })
    },
    stop: () => api.listener.stop(),
  }),
  sendDirect: async (message) => {
    const attachments: Awaited<
      ReturnType<typeof downloadOutboundAttachment>
    >[] = []
    for (const attachment of message.attachments) {
      attachments.push(await prepareOutboundAttachment(attachment))
    }
    const result = await api.sendMessage(
      {
        msg: message.text ?? "",
        ...(attachments.length ? { attachments } : {}),
        ...(message.quote ? { quote: quoteOf(message.quote) } : {}),
      },
      message.recipientId,
      ThreadType.User,
    )
    const messageIds = [
      ...(result.message ? [String(result.message.msgId)] : []),
      ...result.attachment.map((item) => String(item.msgId)),
    ]
    return { messageIds, sentCount: messageIds.length }
  },
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
  sendGroup: async (groupId, message) => {
    const attachments: Awaited<
      ReturnType<typeof downloadOutboundAttachment>
    >[] = []
    for (const attachment of message.attachments) {
      attachments.push(await prepareOutboundAttachment(attachment))
    }
    const result = await api.sendMessage(
      {
        msg: message.text ?? "",
        ...(attachments.length ? { attachments } : {}),
        ...(message.quote ? { quote: quoteOf(message.quote) } : {}),
      },
      groupId,
      ThreadType.Group,
    )
    const messageIds = [
      ...(result.message ? [String(result.message.msgId)] : []),
      ...result.attachment.map((item) => String(item.msgId)),
    ]
    return { messageIds, sentCount: messageIds.length }
  },
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
})

const qrEventOf = (event: LoginQRCallbackEvent): ZcaQrEvent | undefined => {
  if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
    return {
      type: "generated",
      imageDataUrl: normalizeQrImage(event.data.image),
      expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
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

class ZcaClient implements ZcaClientPort {
  private readonly zalo = new Zalo({ logging: false, selfListen: true })

  async loginQr(callback: (event: ZcaQrEvent) => void): Promise<ZcaApiPort> {
    const api = await this.zalo.loginQR({}, (event) => {
      const adapted = qrEventOf(event)
      if (adapted) {
        callback(adapted)
      }
    })
    return adaptApi(api)
  }

  async login(auth: ZaloAccountAuth): Promise<ZcaApiPort> {
    const credentials = {
      cookie: auth.cookie,
      imei: auth.imei,
      userAgent: auth.userAgent,
    } as unknown as Credentials
    return adaptApi(await this.zalo.login(credentials))
  }
}

export const zcaClientFactory: ZcaClientFactory = {
  create: () => new ZcaClient(),
}
