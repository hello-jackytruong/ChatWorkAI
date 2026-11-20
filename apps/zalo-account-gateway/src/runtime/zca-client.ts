import {
  type ZaloAccountAuth,
  type ZaloAccountGroup,
  type ZaloAccountOutboundMessage,
  zaloAccountAuthSchema,
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
import { normalizeProviderMessage } from "./provider-message"

const normalizeQrImage = (image: string) =>
  image.startsWith("data:image/") ? image : `data:image/png;base64,${image}`

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
          handlers.onUnsupported(normalized.reason)
        }
      })
      api.listener.on("seen_messages", (messages) => {
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
      api.listener.start({ retryOnClose: false })
    },
    stop: () => api.listener.stop(),
  }),
  sendDirect: async (message) => {
    const attachments: Awaited<
      ReturnType<typeof downloadOutboundAttachment>
    >[] = []
    for (const attachment of message.attachments) {
      attachments.push(await downloadOutboundAttachment(attachment))
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
    const groupIds = Object.keys(allGroups.gridVerMap).slice(0, 1000)
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
    return groups
  },
  sendGroup: async (groupId, message) => {
    const attachments: Awaited<
      ReturnType<typeof downloadOutboundAttachment>
    >[] = []
    for (const attachment of message.attachments) {
      attachments.push(await downloadOutboundAttachment(attachment))
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
    zaloAccountLabelSnapshotSchema.parse(await api.getLabels()),
  updateLabels: async ({ labelData, version }) =>
    zaloAccountLabelSnapshotSchema.parse(
      await api.updateLabels({ labelData, version }),
    ),
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
