// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  hasEverBeenEnabled: vi.fn(),
  findTranslations: vi.fn(),
}))

vi.mock("@chatbotx.io/business", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inboxTranslationSettingsService: {
    hasEverBeenEnabled: mocks.hasEverBeenEnabled,
  },
  translationService: { findTranslations: mocks.findTranslations },
}))

const { withMessageTranslations } = await import(
  "@/features/translation/lib/message-translations"
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hasEverBeenEnabled.mockResolvedValue(true)
  mocks.findTranslations.mockResolvedValue([])
})

describe("withMessageTranslations", () => {
  test("a workspace that never enabled translation gets null and costs no query", async () => {
    mocks.hasEverBeenEnabled.mockResolvedValue(false)

    const result = await withMessageTranslations("w1", [{ id: "m1" }])

    expect(result).toEqual([{ id: "m1", translation: null }])
    expect(mocks.findTranslations).not.toHaveBeenCalled()
  })

  test("no messages means no work at all", async () => {
    await expect(withMessageTranslations("w1", [])).resolves.toEqual([])
    expect(mocks.hasEverBeenEnabled).not.toHaveBeenCalled()
  })

  test("loads every translation in one batch and attaches each to its message", async () => {
    mocks.findTranslations.mockResolvedValue([
      {
        messageId: "m1",
        direction: "inbound",
        status: "translated",
        displayText: "Xin chào",
        sourceLanguage: "es",
        targetLanguage: "vi",
        failureCode: null,
        // Columns the API must not expose are dropped by the resource mapping.
        sourceHash: "secret-hash",
        modelId: "openai/gpt-x",
      },
    ])

    const result = await withMessageTranslations("w1", [
      { id: "m1" },
      { id: "m2" },
    ])

    expect(mocks.findTranslations).toHaveBeenCalledTimes(1)
    expect(mocks.findTranslations).toHaveBeenCalledWith("w1", ["m1", "m2"])
    expect(result[0]?.translation).toEqual({
      direction: "inbound",
      status: "translated",
      displayText: "Xin chào",
      sourceLanguage: "es",
      targetLanguage: "vi",
      failureCode: null,
    })
    expect(result[1]?.translation).toBeNull()
  })
})
