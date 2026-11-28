import { beforeEach, describe, expect, test, vi } from "vitest"
import { resolveZaloForward } from "../src/zalo-account/resolve-forward"

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  project: vi.fn(),
}))
vi.mock("../src/zalo-account/message-recall.service", () => ({
  zaloAccountMessageRecallService: { resolveTarget: mocks.resolve },
}))
vi.mock("../src/message/list-for-conversation", () => ({
  withResolvedAttachmentUrls: mocks.project,
}))
vi.mock("../src/zalo-account/group.service", () => ({
  zaloAccountGroupService: { get: vi.fn() },
}))

const scope = {
  workspaceId: "1",
  accountId: "2",
  conversationId: "3",
  messageId: "4",
  messageCreatedAt: "2026-11-28T07:30:00Z",
}

describe("copying archived Zalo Account attachments", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.resolve.mockResolvedValue({
      message: { attachments: [{ id: "image-id" }] },
      target: { providerMessageId: "source" },
    })
  })

  test("copies a visible archived GIF without requiring a legacy filename", async () => {
    mocks.project.mockResolvedValue({
      text: "Caption",
      attachments: [
        {
          fileType: "gif",
          name: null,
          mimeType: "image/gif",
          size: 1024,
          url: "https://storage.example.test/archive",
        },
      ],
    })
    await expect(resolveZaloForward(scope)).resolves.toMatchObject({
      kind: "media",
      caption: "Caption",
      attachments: [
        {
          kind: "image",
          mimeType: "image/gif",
          url: "https://storage.example.test/archive",
        },
      ],
    })
  })

  test("refuses to copy when recall projection removed the archive reference", async () => {
    mocks.project.mockResolvedValue({ text: null, attachments: [] })
    await expect(resolveZaloForward(scope)).rejects.toThrow(
      "files are unavailable",
    )
  })
})
