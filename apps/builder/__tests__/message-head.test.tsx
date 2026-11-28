import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  activeConversationId: "conversation",
  conversations: [
    {
      id: "conversation",
      contact: {
        fullName: "Taylor Finch",
        avatar: "https://example.com/avatar.jpg",
      },
      contactInboxes: [{ id: "inbox", channel: "messenger" }],
    },
  ],
}))

vi.mock("@/features/chat/store/chat-store-provider", () => ({
  useChatStore: (select: (value: typeof state) => unknown) => select(state),
}))
vi.mock("@/features/contacts/utils", () => ({
  useAvatarUrl: (contact: { avatar?: string }) => contact.avatar || undefined,
}))
vi.mock("@/features/conversations/actions/enable-bot.action", () => ({
  enableBotAction: vi.fn(),
}))
vi.mock(
  "@/features/conversations/components/thread-control-pass-button",
  () => ({
    ThreadControlPassButton: () => null,
  }),
)
vi.mock(
  "@/features/conversations/components/thread-control-release-button",
  () => ({
    ThreadControlReleaseButton: () => null,
  }),
)
vi.mock(
  "@/features/conversations/components/update-conversation-assignee",
  () => ({
    UpdateConversationAssignee: () => null,
  }),
)
vi.mock("@/features/conversations/conversation-action", () => ({
  ConversationAction: () => <button type="button">Actions</button>,
}))
vi.mock(
  "@/features/integration-whatsapp/calling/voip/use-outbound-call-mode",
  () => ({
    useOutboundCallMode: () => ({}),
  }),
)
vi.mock(
  "@/features/integration-whatsapp/calling/voip/whatsapp-voip-call-button",
  () => ({
    WhatsappVoipCallButton: () => null,
  }),
)
vi.mock(
  "@/features/integration-whatsapp/calling/voip/whatsapp-voip-call-context",
  () => ({
    useOptionalWhatsappVoipCallContext: () => undefined,
  }),
)
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "workspace" }))
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: vi.fn(), isExecuting: false }),
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("@chatbotx.io/ui/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src?: string }) =>
    src && <span data-src={src} data-testid="avatar" />,
  AvatarFallback: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}))

const { default: MessageHead } = await import(
  "@/features/messages/message-head"
)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

test("shows the Messenger contact's avatar beside the name", () => {
  render(<MessageHead />)
  const avatar = container.querySelector('[data-testid="avatar"]')
  expect(avatar?.getAttribute("data-src")).toBe(
    "https://example.com/avatar.jpg",
  )
  expect(avatar?.parentElement?.nextElementSibling?.textContent).toBe(
    "Taylor Finch",
  )
})

test("renders the Zalo library slot before other conversation actions", () => {
  state.conversations[0].contactInboxes[0].channel = "zaloAccount"
  try {
    const register = vi.fn<(node: HTMLDivElement | null) => void>()
    render(<MessageHead timelineSlotRef={register} />)
    const slot = register.mock.calls.find(
      ([node]) => node instanceof HTMLElement,
    )?.[0]
    expect(slot).toBeInstanceOf(HTMLElement)
    expect(slot?.nextElementSibling?.textContent).toBe("Actions")
  } finally {
    state.conversations[0].contactInboxes[0].channel = "messenger"
  }
})
