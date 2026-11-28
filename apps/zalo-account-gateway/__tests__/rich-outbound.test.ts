import { EventEmitter } from "node:events"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  assertPublicUrl: vi.fn(),
  login: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  assertPublicUrl: mocks.assertPublicUrl,
}))
vi.mock("zca-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("zca-js")>()),
  Zalo: class {
    login = mocks.login
  },
}))

import { ZaloAccountPool } from "../src/runtime/zalo-account-pool"
import { zcaClientFactory } from "../src/runtime/zca-client"

const auth = {
  authType: "custom" as const,
  cookie: [{ key: "zpw", value: "test" }],
  imei: "imei",
  userAgent: "agent",
  zaloUid: "uid",
}
const recipient = { recipientId: "peer", attachments: [] }
const photo = {
  kind: "image" as const,
  url: "https://files.example.test/photo.jpg",
}
const document = {
  kind: "file" as const,
  url: "https://files.example.test/policy.pdf",
}
const providerVideoUrl = "https://cdn.example.test/native.mp4"
const providerPosterUrl = "https://cdn.example.test/native.jpg"
const providerVoiceUrl = "https://cdn.example.test/native.m4a"

const sendResult = (messageId: string | null, attachments: string[] = []) => ({
  message: messageId === null ? null : { msgId: messageId },
  attachment: attachments.map((msgId) => ({ msgId })),
})

const start = async (overrides = {}) => {
  const sdk = {
    listener: new EventEmitter(),
    sendMessage: vi.fn().mockResolvedValue(sendResult("text")),
    sendVideo: vi.fn().mockResolvedValue({ msgId: 123 }),
    sendVoice: vi.fn().mockResolvedValue({ msgId: "voice" }),
    sendLink: vi.fn().mockResolvedValue({ msgId: "link" }),
    sendCard: vi.fn().mockResolvedValue({ msgId: 555 }),
    sendBankCard: vi.fn().mockResolvedValue(""),
    uploadAttachment: vi
      .fn()
      .mockImplementation((source: { filename: string }) => {
        if (source.filename.endsWith(".mp4")) {
          return Promise.resolve([
            { fileType: "video", fileUrl: providerVideoUrl },
          ])
        }
        if (source.filename.endsWith(".m4a")) {
          return Promise.resolve([
            { fileType: "others", fileUrl: providerVoiceUrl },
          ])
        }
        return Promise.resolve([
          { fileType: "image", normalUrl: providerPosterUrl },
        ])
      }),
    forwardMessage: vi
      .fn()
      .mockResolvedValue({ success: [{ msgId: "forwarded" }], fail: [] }),
    ...overrides,
  }
  mocks.login.mockResolvedValue(sdk)
  return { client: await zcaClientFactory.create().login(auth), sdk }
}

const stubFiles = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input)
    let mimeType = "application/pdf"
    if (url.endsWith("jpg")) {
      mimeType = "image/jpeg"
    } else if (url.endsWith("mp4")) {
      mimeType = "video/mp4"
    } else if (url.endsWith("m4a")) {
      mimeType = "audio/mp4"
    }
    return Promise.resolve(
      new Response(Uint8Array.of(1, 2, 3), {
        headers: { "content-type": mimeType, "content-length": "3" },
      }),
    )
  })

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.assertPublicUrl.mockReset()
  mocks.assertPublicUrl.mockResolvedValue(undefined)
})

it("keeps the legacy Inbox caption and single image in one provider call", async () => {
  stubFiles()
  const { client, sdk } = await start({
    sendMessage: vi.fn().mockResolvedValue(sendResult(null, ["image"])),
  })

  await expect(
    client.sendDirect({ ...recipient, text: "caption", attachments: [photo] }),
  ).resolves.toEqual({ messageIds: ["image"], sentCount: 1 })
  expect(sdk.sendMessage).toHaveBeenCalledExactlyOnceWith(
    { msg: "caption", attachments: [expect.any(Object)] },
    "peer",
    0,
  )
})

it("preserves every confirmed caption and album ID for group sends", async () => {
  stubFiles()
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce(sendResult("caption"))
    .mockResolvedValueOnce(sendResult(null, ["first-photo"]))
    .mockResolvedValueOnce(sendResult(null, ["document"]))
  const { client } = await start({ sendMessage })
  const message = {
    ...recipient,
    content: {
      kind: "media" as const,
      caption: "caption",
      attachments: [photo, document],
    },
  }

  await expect(client.sendGroup("group", message)).resolves.toEqual({
    messageIds: ["caption", "first-photo", "document"],
    sentCount: 3,
  })
  expect(sendMessage).toHaveBeenNthCalledWith(1, { msg: "caption" }, "group", 1)
  expect(sendMessage).toHaveBeenNthCalledWith(
    2,
    {
      msg: "",
      attachments: [expect.objectContaining({ filename: "attachment.jpg" })],
    },
    "group",
    1,
  )
  expect(sendMessage).toHaveBeenNthCalledWith(
    3,
    {
      msg: "",
      attachments: [expect.objectContaining({ filename: "attachment.pdf" })],
    },
    "group",
    1,
  )
})

it("preserves confirmed part IDs and stops sending after a later provider timeout", async () => {
  stubFiles()
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce(sendResult(null, ["first-photo"]))
    .mockRejectedValueOnce(new Error("provider timeout"))
  const { client } = await start({ sendMessage })
  const message = {
    ...recipient,
    content: { kind: "media" as const, attachments: [photo, document, photo] },
  }

  await expect(client.sendDirect(message)).resolves.toEqual({
    delivery: "partial",
    remainingUnknown: true,
    messageIds: ["first-photo"],
    sentCount: 1,
  })
  expect(sendMessage).toHaveBeenCalledTimes(2)
})

it("reports confirmed parts when group policy denies the next provider call", async () => {
  stubFiles()
  const sendMessage = vi
    .fn()
    .mockResolvedValue(sendResult(null, ["first-photo"]))
  const { client } = await start({ sendMessage })
  const admit = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("group locked"))
  const message = {
    ...recipient,
    content: { kind: "media" as const, attachments: [photo, document] },
  }

  await expect(client.sendGroup("group", message, admit)).resolves.toEqual({
    delivery: "partial",
    remainingUnknown: false,
    messageIds: ["first-photo"],
    sentCount: 1,
  })
  expect(admit).toHaveBeenCalledTimes(2)
  expect(sendMessage).toHaveBeenCalledOnce()
})

it("finishes attachment preparation before admission and sends nothing on rejection", async () => {
  const fetch = stubFiles()
  const { client, sdk } = await start()
  const admit = vi.fn(() => {
    expect(fetch).toHaveBeenCalledTimes(2)
    throw new Error("policy changed")
  })
  const message = {
    ...recipient,
    content: { kind: "media" as const, attachments: [photo, document] },
  }

  await expect(client.sendDirect(message, admit)).rejects.toThrow(
    "policy changed",
  )
  expect(admit).toHaveBeenCalledOnce()
  expect(sdk.sendMessage).not.toHaveBeenCalled()
})

it.each([
  "deadline",
  "allowlist",
] as const)("rechecks the %s after download and before provider admission", async (check) => {
  const startedAt = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt)
  const listener = new EventEmitter()
  Object.assign(listener, {
    start: () => listener.emit("connected"),
    stop: () => listener.emit("closed", 1000, "mock close"),
  })
  const { sdk } = await start({
    listener,
    getOwnId: vi.fn().mockResolvedValue(auth.zaloUid),
  })
  let enabled = true
  const admitDirectSend = vi.fn().mockResolvedValue(undefined)
  const pool = new ZaloAccountPool({
    clientFactory: zcaClientFactory,
    eventSink: {
      publishAuthorization: vi.fn().mockResolvedValue(undefined),
      publishDirectMessage: vi.fn().mockResolvedValue(undefined),
      publishDirectStatus: vi.fn().mockResolvedValue(undefined),
      publishDirectUndo: vi.fn().mockResolvedValue(undefined),
      publishGroupActivity: vi.fn().mockResolvedValue(undefined),
      publishLifecycle: vi.fn().mockResolvedValue(undefined),
    },
    lease: {
      acquire: vi.fn().mockResolvedValue({
        ownerId: "gateway",
        fenceToken: "1",
      }),
      renew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    },
    ownerId: "gateway",
    leaseRenewMs: 10_000,
    leaseTtlMs: 30_000,
    secretPort: {
      load: vi.fn().mockResolvedValue({ auth, zaloUid: auth.zaloUid }),
    },
    richSendEnabled: () => enabled,
    admitDirectSend,
  })
  const command = {
    workspaceId: "workspace",
    inboxId: "inbox",
    runtime: { kind: "account" as const, id: "account" },
  }
  await pool.reconnect(command)
  try {
    const deadlineAt = startedAt + 1000
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      if (check === "deadline") {
        clock.mockReturnValue(deadlineAt)
      } else {
        enabled = false
      }
      return Promise.resolve(
        new Response(Uint8Array.of(1, 2, 3), {
          headers: { "content-type": "image/jpeg" },
        }),
      )
    })

    await expect(
      pool.sendDirect({
        ...command,
        deadlineAt,
        message: {
          ...recipient,
          content: { kind: "media", attachments: [photo] },
        },
      }),
    ).rejects.toThrow(check === "deadline" ? "deadline expired" : "disabled")
    expect(fetch).toHaveBeenCalledOnce()
    expect(admitDirectSend).not.toHaveBeenCalled()
    expect(sdk.sendMessage).not.toHaveBeenCalled()
  } finally {
    await pool.shutdown()
  }
})

it("uploads the video and poster and dispatches their provider URLs with the caption", async () => {
  stubFiles()
  const { client, sdk } = await start()
  const video = {
    kind: "video" as const,
    url: "https://files.example.test/clip.mp4",
    thumbnailUrl: photo.url,
    caption: "clip",
    durationMs: 3000,
  }
  const message = { ...recipient, content: video }

  await expect(client.sendDirect(message)).resolves.toEqual({
    messageIds: ["123"],
    sentCount: 1,
  })
  expect(sdk.sendVideo).toHaveBeenCalledExactlyOnceWith(
    {
      videoUrl: providerVideoUrl,
      thumbnailUrl: providerPosterUrl,
      msg: video.caption,
      duration: 3000,
    },
    "peer",
    0,
  )
  expect(sdk.uploadAttachment).toHaveBeenCalledTimes(2)
  expect(sdk.sendMessage).not.toHaveBeenCalled()
})

it("uploads audio and dispatches its provider URL as native group voice", async () => {
  stubFiles()
  const { client, sdk } = await start()
  const voiceUrl = "https://files.example.test/clip.m4a"
  const message = {
    ...recipient,
    content: { kind: "voice" as const, url: voiceUrl },
  }

  await expect(client.sendGroup("group", message)).resolves.toEqual({
    messageIds: ["voice"],
    sentCount: 1,
  })
  expect(sdk.sendVoice).toHaveBeenCalledExactlyOnceWith(
    { voiceUrl: providerVoiceUrl },
    "group",
    1,
  )
})

it("never dispatches a native video when the poster upload fails", async () => {
  stubFiles()
  const uploadAttachment = vi
    .fn()
    .mockResolvedValueOnce([{ fileType: "video", fileUrl: providerVideoUrl }])
    .mockRejectedValueOnce(new Error("provider poster upload failed"))
  const { client, sdk } = await start({ uploadAttachment })
  const message = {
    ...recipient,
    content: {
      kind: "video" as const,
      url: "https://files.example.test/clip.mp4",
      thumbnailUrl: photo.url,
    },
  }

  await expect(client.sendDirect(message)).rejects.toMatchObject({
    errorInfo: { code: "preparation_failed", phase: "preparation" },
  })
  expect(sdk.sendVideo).not.toHaveBeenCalled()
})

it("maps a styled direct reply and retains the provider ID", async () => {
  const { client, sdk } = await start()
  const message = {
    ...recipient,
    content: {
      kind: "text" as const,
      text: "bold reply",
      styles: [{ start: 0, len: 4, st: "b" as const }],
      urgency: 2 as const,
    },
    quote: {
      providerMessageId: "quoted",
      clientMessageId: "client-quote",
      senderId: "sender",
      timestampMs: 1_763_000_000_000,
      msgType: "webchat",
      text: "question",
    },
  }

  await expect(client.sendDirect(message)).resolves.toEqual({
    messageIds: ["text"],
    sentCount: 1,
  })
  expect(sdk.sendMessage).toHaveBeenCalledExactlyOnceWith(
    {
      msg: "bold reply",
      styles: message.content.styles,
      urgency: 2,
      quote: expect.objectContaining({
        msgId: "quoted",
        cliMsgId: "client-quote",
        uidFrom: "sender",
      }),
    },
    "peer",
    0,
  )
})

it("records a successful bank-card ACK without inventing a provider ID", async () => {
  const { client, sdk } = await start()
  const message = {
    ...recipient,
    content: {
      kind: "bankCard" as const,
      bankBin: "970416",
      accountNumber: "0123456789",
      accountName: "Sample Holder",
    },
  }

  await expect(client.sendDirect(message)).resolves.toEqual({
    delivery: "accepted_without_id",
    messageIds: [],
    sentCount: 1,
  })
  expect(sdk.sendBankCard).toHaveBeenCalledExactlyOnceWith(
    {
      binBank: 970_416,
      numAccBank: "0123456789",
      nameAccBank: "Sample Holder",
    },
    "peer",
    0,
  )
})
