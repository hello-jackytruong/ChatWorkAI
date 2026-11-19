import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  settings: { value: undefined as Record<string, unknown> | undefined },
  translation: {
    value: {
      effective: true,
      workspaceLanguage: "vi",
    } as Record<string, unknown>,
  },
  retry: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  useLocale: () => "en",
}))
vi.mock("@/features/translation/hooks/use-translation-settings", () => ({
  useTranslationSettings: () => ({ data: mocks.settings.value }),
  useInvalidateTranslation: () => vi.fn(),
}))
vi.mock("@/features/translation/hooks/use-conversation-translation", () => ({
  useConversationTranslation: () => mocks.translation.value,
}))
vi.mock("@/features/translation/hooks/use-retry-translation", () => ({
  useRetryTranslation: () => mocks.retry,
}))
// Tooltips and menus need a full UI provider tree: render their content inline.
vi.mock("@chatbotx.io/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <i>{children}</i>,
}))

const { ConversationLanguageBadge } = await import(
  "@/features/translation/components/conversation-language-badge"
)
const { MessageTranslation } = await import(
  "@/features/translation/components/message-translation"
)
const { TranslatedMessage } = await import(
  "@/features/translation/components/translated-message"
)
const { useTranslationUiStore } = await import(
  "@/features/translation/store/translation-ui-store"
)

const NOW = new Date("2026-11-19T00:00:00.000Z")

describe("translation components", () => {
  let container: HTMLDivElement
  let root: Root

  const render = (node: ReactNode) => {
    act(() => {
      root.render(node)
    })
  }
  const text = () => container.textContent ?? ""

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.clearAllMocks()
    mocks.settings.value = {
      enabled: true,
      workspaceLanguage: "vi",
    }
    mocks.translation.value = { effective: true, workspaceLanguage: "vi" }
    useTranslationUiStore.setState({
      entries: {},
      showAllOriginals: {},
      originalOverrides: {},
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  describe("ConversationLanguageBadge", () => {
    const conversation = (translation: Record<string, unknown>) => ({
      additionalAttributes: { translation },
    })

    test("shows the customer's language code with its name", () => {
      render(
        <ConversationLanguageBadge
          conversation={conversation({ language: "es" })}
        />,
      )

      expect(text()).toContain("ES")
      expect(text()).toContain("tooltip:")
    })

    test.each([
      [
        "translation is off for the workspace",
        () => {
          mocks.settings.value = { enabled: false, workspaceLanguage: "vi" }
        },
        { language: "es" },
      ],
      [
        "settings have not loaded",
        () => {
          mocks.settings.value = undefined
        },
        { language: "es" },
      ],
      ["the language is the workspace's", () => undefined, { language: "vi" }],
      ["the language is not known", () => undefined, {}],
      [
        "the conversation turned translation off",
        () => undefined,
        { language: "es", enabledOverride: false },
      ],
    ])("renders nothing when %s", (_name, arrange, translation) => {
      arrange()

      render(
        <ConversationLanguageBadge conversation={conversation(translation)} />,
      )

      expect(container.innerHTML).toBe("")
    })

    test("a conversation with no attributes at all renders nothing", () => {
      render(
        <ConversationLanguageBadge
          conversation={{ additionalAttributes: null }}
        />,
      )

      expect(container.innerHTML).toBe("")
    })
  })

  describe("MessageTranslation", () => {
    const onRetry = vi.fn()
    const onRequestAgain = vi.fn()
    const click = () => {
      act(() => {
        container.querySelector("button")?.click()
      })
    }

    test("a translated inbound bubble labels the original with its language", () => {
      render(
        <MessageTranslation
          expanded
          onRequestAgain={onRequestAgain}
          onRetry={onRetry}
          view={{
            kind: "translated",
            direction: "inbound",
            mainText: "Tôi muốn đổi size",
            secondaryText: "Quiero cambiar la talla",
            languageCode: "es",
          }}
        />,
      )

      expect(text()).toContain("original:Spanish")
      expect(text()).toContain("Quiero cambiar la talla")
      expect(container.querySelector("pre")?.getAttribute("dir")).toBe("auto")
    })

    test("a translated outbound bubble says what was sent", () => {
      render(
        <MessageTranslation
          expanded
          onRequestAgain={onRequestAgain}
          onRetry={onRetry}
          view={{
            kind: "translated",
            direction: "outbound",
            mainText: "agent",
            secondaryText: "Sí, le cambio a talla M",
            languageCode: "es",
          }}
        />,
      )

      expect(text()).toContain("sent:Spanish")
    })

    test("a collapsed translated bubble shows no original block", () => {
      render(
        <MessageTranslation
          expanded={false}
          onRequestAgain={onRequestAgain}
          onRetry={onRetry}
          view={{
            kind: "translated",
            direction: "inbound",
            mainText: "Tôi muốn đổi size",
            secondaryText: "Quiero cambiar la talla",
            languageCode: "es",
          }}
        />,
      )

      expect(text()).toBe("")
    })

    test("translating shows a spinner label and no button", () => {
      render(
        <MessageTranslation
          expanded={false}
          onRequestAgain={onRequestAgain}
          onRetry={onRetry}
          view={{ kind: "pending" }}
        />,
      )

      expect(text()).toContain("translating")
      expect(container.querySelector("button")).toBeNull()
    })

    test("still waiting is neutral and offers 'request again', not retry", () => {
      render(
        <MessageTranslation
          expanded={false}
          onRequestAgain={onRequestAgain}
          onRetry={onRetry}
          view={{ kind: "waiting" }}
        />,
      )

      expect(text()).toContain("stillWaiting")
      click()
      expect(onRequestAgain).toHaveBeenCalledTimes(1)
      expect(onRetry).not.toHaveBeenCalled()
    })

    test("a failure offers retry", () => {
      render(
        <MessageTranslation
          expanded={false}
          onRequestAgain={onRequestAgain}
          onRetry={onRetry}
          view={{ kind: "failed" }}
        />,
      )

      expect(text()).toContain("failed")
      click()
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
  })

  describe("TranslatedMessage", () => {
    const inbound = (overrides: Record<string, unknown> = {}) =>
      ({
        id: "m1",
        conversationId: "c1",
        messageType: "incoming",
        type: "message",
        contentType: "text",
        text: "Quiero cambiar la talla",
        deletedAt: null,
        createdAt: NOW,
        translation: undefined,
        ...overrides,
      }) as never
    const translated = {
      direction: "inbound",
      status: "translated",
      displayText: "Tôi muốn đổi size",
      sourceLanguage: "es",
      targetLanguage: "vi",
      failureCode: null,
    }

    test("with translation off the bubble gets nothing: it renders as before", () => {
      mocks.translation.value = { effective: false, workspaceLanguage: "vi" }
      const received: unknown[] = []

      render(
        <TranslatedMessage message={inbound({ translation: translated })}>
          {(translation) => {
            received.push(translation)
            return <span>bubble</span>
          }}
        </TranslatedMessage>,
      )

      expect(received).toEqual([undefined])
      expect(text()).toBe("bubble")
    })

    const bubble = (
      translation:
        | {
            footer?: ReactNode
            inlineAction?: ReactNode
          }
        | undefined,
    ) => (
      <div>
        {translation?.inlineAction}
        {translation?.footer}
      </div>
    )

    test("a translated message hands the bubble its main text, a toggle and a collapsed footer", () => {
      const received: { mainText?: string }[] = []

      render(
        <TranslatedMessage message={inbound({ translation: translated })}>
          {(translation) => {
            received.push(translation as { mainText?: string })
            return bubble(translation)
          }}
        </TranslatedMessage>,
      )

      expect(received[0]?.mainText).toBe("Tôi muốn đổi size")
      const toggle = container.querySelector("button")
      expect(toggle?.getAttribute("aria-expanded")).toBe("false")
      expect(toggle?.getAttribute("aria-label")).toBe("translatedFrom:Spanish")
      expect(text()).not.toContain("Quiero cambiar la talla")
    })

    test("the toggle opens and closes the original of that message", () => {
      render(
        <TranslatedMessage message={inbound({ translation: translated })}>
          {bubble}
        </TranslatedMessage>,
      )

      act(() => {
        container.querySelector("button")?.click()
      })
      expect(text()).toContain("original:Spanish")
      expect(text()).toContain("Quiero cambiar la talla")
      expect(
        container.querySelector("button")?.getAttribute("aria-label"),
      ).toBe("hideOriginal")

      act(() => {
        container.querySelector("button")?.click()
      })
      expect(text()).not.toContain("Quiero cambiar la talla")
    })

    test("'show original text' on the conversation opens every message, and one can still be closed", () => {
      useTranslationUiStore.setState({ showAllOriginals: { c1: true } })

      render(
        <TranslatedMessage message={inbound({ translation: translated })}>
          {bubble}
        </TranslatedMessage>,
      )
      expect(text()).toContain("Quiero cambiar la talla")

      act(() => {
        container.querySelector("button")?.click()
      })
      expect(text()).not.toContain("Quiero cambiar la talla")
    })

    test("another conversation's setting does not open this one", () => {
      useTranslationUiStore.setState({ showAllOriginals: { other: true } })

      render(
        <TranslatedMessage message={inbound({ translation: translated })}>
          {bubble}
        </TranslatedMessage>,
      )

      expect(text()).not.toContain("Quiero cambiar la talla")
    })

    test("a message being translated shows the translating footer", () => {
      useTranslationUiStore.setState({
        entries: { m1: { requestedAt: 1, signature: "s", state: "pending" } },
      })

      render(
        <TranslatedMessage message={inbound()}>
          {(translation) => <div>{translation?.footer}</div>}
        </TranslatedMessage>,
      )

      expect(text()).toContain("translating")
    })

    test("'request again' asks without retryFailed, 'retry' with it", () => {
      useTranslationUiStore.setState({
        entries: { m1: { requestedAt: 1, signature: "s", state: "waiting" } },
      })

      render(
        <TranslatedMessage message={inbound()}>
          {(translation) => <div>{translation?.footer}</div>}
        </TranslatedMessage>,
      )
      act(() => {
        container.querySelector("button")?.click()
      })

      expect(mocks.retry).toHaveBeenCalledWith(
        expect.objectContaining({ id: "m1" }),
        false,
      )
    })
  })
})
