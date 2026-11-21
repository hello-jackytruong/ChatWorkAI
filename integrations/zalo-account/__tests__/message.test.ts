import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendDirectAndWait: vi.fn(),
  sendByProviderId: vi.fn(),
}))

vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountSendAttemptService: {
    send: async (input, dispatch) => await dispatch(input.commandId),
  },
  zaloAccountGroupService: { sendByProviderId: mocks.sendByProviderId },
  zaloAccountCommandTransportService: {
    sendDirectAndWait: mocks.sendDirectAndWait,
  },
}))

import { receiveMessage, sendFlowStep, sendMessage } from "../src/message"

const ctx = {
  auth: { authType: "none" as const },
  integrationDetail: {
    accountId: "account-1",
    inboxId: "inbox-1",
    workspaceId: "workspace-1",
    zaloUid: "self-1",
  },
} as never

const payload = {
  providerMessageId: "message-7",
  clientMessageId: "client-7",
  threadId: "peer-1",
  threadType: "user" as const,
  senderId: "peer-1",
  recipientId: "self-1",
  senderName: "Customer",
  timestampMs: 1_763_596_800_000,
  msgType: "webchat",
  isSelf: false,
  text: "hello",
  attachments: [],
}

describe("Zalo Account message adapter", () => {
  beforeEach(() => {
    mocks.sendDirectAndWait.mockReset()
  })
  it("routes reserved group anchors through group policy instead of direct UID sending", async () => {
    mocks.sendByProviderId.mockResolvedValue({
      messageIds: ["m1"],
      sentCount: 1,
    })
    const result = await sendMessage({
      ctx,
      data: {
        groupAudience: {
          kind: "zaloAccountGroup",
          workspaceId: "workspace-1",
          accountId: "account-1",
          groupId: "local-g1",
          providerGroupId: "g1",
          conversationId: "conv1",
          contactInboxId: "ci1",
          origin: "inbox",
          accountPolicyEpoch: 1,
          groupPolicyEpoch: 2,
        },
        contact: { id: "c1", sourceId: "za:group:g1" },
        message: {
          id: "msg1",
          clientId: "cmd1",
          workspaceId: "workspace-1",
          conversationId: "conv1",
          contentType: "text",
          messageType: "outgoing",
          text: "hello",
          attachments: [],
        },
      },
    })
    expect(result).toMatchObject({ messageIds: ["za:account-1:group:g1:m1"] })
    expect(mocks.sendByProviderId).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        accountId: "account-1",
        providerGroupId: "g1",
        commandId: "cmd1",
      }),
    )
    expect(mocks.sendDirectAndWait).not.toHaveBeenCalled()
  })

  it("scopes message identity by account and maps the inbound peer", async () => {
    const result = await receiveMessage({
      ctx,
      data: {
        integrationType: "zaloAccount",
        integrationIdentifier: "account-1",
        payload,
      },
    })

    expect(result).toMatchObject({
      message: {
        sourceId: "za:account-1:user:peer-1:message-7",
        messageType: "incoming",
        text: "hello",
      },
      contact: { sourceId: "peer-1", firstName: "Customer" },
    })
  })

  it("maps an own echo to the remote peer instead of the connected account", async () => {
    const result = await receiveMessage({
      ctx,
      data: {
        integrationType: "zaloAccount",
        integrationIdentifier: "account-1",
        payload: {
          ...payload,
          isSelf: true,
          senderId: "self-1",
          recipientId: "peer-1",
        },
      },
    })

    expect(result).toMatchObject({
      message: { messageType: "outgoing" },
      contact: { sourceId: "peer-1" },
    })
  })

  it("uses the persisted client id as the single transport command id", async () => {
    mocks.sendDirectAndWait.mockResolvedValue({
      messageIds: ["provider-9"],
      sentCount: 1,
    })

    await expect(
      sendMessage({
        ctx,
        data: {
          contact: { id: "contact-1", sourceId: "peer-1" },
          message: {
            id: "message-1",
            clientId: "client-1",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            contentType: "text",
            messageType: "outgoing",
            text: "hello",
            attachments: [],
          },
        },
      }),
    ).resolves.toEqual({
      messageIds: ["za:account-1:user:peer-1:provider-9"],
      sentCount: 1,
    })

    expect(mocks.sendDirectAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        commandId: "client-1",
        message: expect.objectContaining({ recipientId: "peer-1" }),
      }),
    )
  })

  it("uses the persisted flow message id as the transport command id", async () => {
    mocks.sendDirectAndWait.mockResolvedValue({
      messageIds: ["provider-flow-1"],
      sentCount: 1,
    })

    await expect(
      sendFlowStep({
        ctx,
        data: {
          contact: { id: "contact-1", sourceId: "peer-1" },
          flowId: "flow-1",
          idempotencyKey: "stored-message-1",
          step: {
            id: "step-1",
            stepType: "sendText",
            text: "flow hello",
            buttons: [],
          },
        },
      }),
    ).resolves.toMatchObject({
      messageIds: ["za:account-1:user:peer-1:provider-flow-1"],
    })

    expect(mocks.sendDirectAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "stored-message-1" }),
    )
  })
})
