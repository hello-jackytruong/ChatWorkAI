import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act, type ComponentProps, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"
import { ConversationAction } from "../src/features/conversations/conversation-action"
import type { ListConversationItemResource } from "../src/features/conversations/schema/resource"

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  inspect: vi.fn(),
  crmUnread: vi.fn(),
  crmUpdate: vi.fn(),
}))

vi.mock(
  "../src/features/zalo-accounts/actions/native-conversation-settings.action",
  () => ({
    getZaloNativeConversationSettingsAction: mocks.get,
    setZaloNativeConversationSettingAction: mocks.set,
    getZaloNativeConversationSettingAttemptAction: mocks.inspect,
  }),
)
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "1" }))
vi.mock("../src/features/chat/store/chat-store-provider", () => ({
  useChatStore: (select: (state: object) => unknown) =>
    select({ updateConversation: mocks.crmUpdate }),
}))
vi.mock(
  "../src/features/conversations/hooks/use-mark-conversation-unread",
  () => ({
    useMarkConversationUnread: () => ({
      markAsUnread: mocks.crmUnread,
      isPending: false,
    }),
  }),
)
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: vi.fn() }),
}))
vi.mock(
  "../src/features/conversations/actions/archive-conversation.action",
  () => ({ archiveConversationAction: vi.fn() }),
)
vi.mock(
  "../src/features/conversations/actions/unarchive-conversation.action",
  () => ({ unarchiveConversationAction: vi.fn() }),
)
vi.mock(
  "../src/features/conversations/actions/follow-conversation.action",
  () => ({ followConversationAction: vi.fn() }),
)
vi.mock(
  "../src/features/conversations/actions/unfollow-conversation.action",
  () => ({ unfollowConversationAction: vi.fn() }),
)
vi.mock("../src/features/contacts/actions/block-contact.action", () => ({
  blockContactAction: vi.fn(),
}))
vi.mock("../src/features/contacts/actions/unblock-contact.action", () => ({
  unblockContactAction: vi.fn(),
}))
vi.mock("../src/features/contacts/components/remove-contact-dialog", () => ({
  default: () => null,
}))
vi.mock(
  "../src/features/zalo-accounts/components/zalo-account-delete-chat-dialog",
  () => ({ ZaloAccountDeleteChatDialog: () => null }),
)
vi.mock("@chatbotx.io/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => render,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
}))

const session = {
  settings: {
    pinned: false,
    muteSeconds: 0,
    unread: false,
    autoDeleteMs: 0,
    hidden: false,
  },
  complete: false,
  writeEnabled: true,
}
const groupAudience = {
  kind: "zaloAccountGroup",
  accountId: "8",
  groupId: "9",
  providerGroupId: "123",
}
let root: Root
let host: HTMLDivElement
let client: QueryClient

beforeEach(() => {
  vi.resetAllMocks()
  if (typeof globalThis.PointerEvent === "undefined") {
    vi.stubGlobal("PointerEvent", MouseEvent)
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient()
  mocks.get.mockResolvedValue({ data: session })
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
  vi.unstubAllGlobals()
})

function render(channel = "zaloAccount", group = false, conversationId = "3") {
  const conversation = {
    id: conversationId,
    contactId: "5",
    contactInboxes: [{ id: "4", sourceId: "123", channel }],
    messages: [],
    ...(group
      ? {
          sourceId: "za:group:123",
          additionalAttributes: { audience: groupAudience },
        }
      : {}),
  } as unknown as ListConversationItemResource
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <ConversationAction conversation={conversation} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
}

async function click(label: string) {
  await act(async () => {
    const button = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="switch"]'),
    ).find(
      (element) =>
        (element.getAttribute("aria-label") ?? element.textContent) === label,
    )
    expect(button).toBeDefined()
    button?.click()
    await Promise.resolve()
  })
}

async function select(label: string, value: string) {
  const control = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  )
  expect(control).not.toBeNull()
  await act(async () => {
    if (control) {
      control.value = value
      control.dispatchEvent(new Event("change", { bubbles: true }))
    }
    await Promise.resolve()
  })
}

async function waitForText(label: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(document.body.textContent).toContain(label)
  })
}

it("keeps CRM menus intact and never reads native settings for Zalo OA or Messenger", async () => {
  for (const channel of ["zalo", "messenger"]) {
    render(channel)
    expect(document.body.textContent).not.toContain("Settings on Zalo")
    await click(messages.actions.markAsUnread)
  }
  expect(mocks.crmUnread).toHaveBeenCalledTimes(2)
  expect(mocks.get).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
})

it("reads a fresh direct thread only when opened and sends mute seconds and retention milliseconds", async () => {
  mocks.set.mockImplementation(
    (
      _workspace,
      _account,
      input: { commandId: string; operation: { kind: string } },
    ) =>
      Promise.resolve({
        data: {
          commandId: input.commandId,
          status: "confirmed",
          operation: input.operation.kind,
          result: { kind: input.operation.kind, outcome: "confirmed" },
        },
      }),
  )
  render()
  expect(mocks.get).not.toHaveBeenCalled()
  await click("Settings on Zalo")
  await waitForText("Some settings are unavailable.")
  expect(mocks.get).toHaveBeenCalledExactlyOnceWith("1", null, {
    conversationId: "3",
    contactInboxId: "4",
  })
  expect(document.body.textContent).toContain("Unknown")
  expect(document.body.querySelector('input[type="password"]')).toBeNull()
  await select("Mute on Zalo", "3600")
  await click("Apply mute on Zalo")
  await waitForText("Zalo confirmed the change.")
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
  expect(mocks.set).toHaveBeenNthCalledWith(1, "1", null, {
    conversationId: "3",
    contactInboxId: "4",
    commandId: expect.any(String),
    operation: { kind: "setMute", durationSeconds: 3600 },
  })
  await select("Auto-delete on Zalo", "86400000")
  await click("Apply auto-delete on Zalo")
  expect(mocks.set).toHaveBeenNthCalledWith(2, "1", null, {
    conversationId: "3",
    contactInboxId: "4",
    commandId: expect.any(String),
    operation: { kind: "setAutoDelete", ttlMs: 86_400_000 },
  })
  expect(mocks.crmUnread).not.toHaveBeenCalled()
  expect(mocks.crmUpdate).not.toHaveBeenCalled()
})

it("uses the selected group's account and inspects unknown writes with the same command ID", async () => {
  mocks.set.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          commandId: input.commandId,
          operation: "setUnread",
          status: "unknown",
        },
      }),
  )
  mocks.inspect.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          commandId: input.commandId,
          operation: "setUnread",
          status: "unknown",
        },
      }),
  )
  render("zaloAccount", true)
  expect(mocks.get).not.toHaveBeenCalled()
  await click("Settings on Zalo")
  await waitForText("Some settings are unavailable.")
  expect(mocks.get).toHaveBeenCalledExactlyOnceWith("1", "8", {
    conversationId: "3",
    contactInboxId: "4",
  })
  await click("Unread on Zalo")
  await waitForText("Zalo has not confirmed the change.")
  const input = mocks.set.mock.calls[0]?.[2]
  expect(input).toEqual({
    conversationId: "3",
    contactInboxId: "4",
    commandId: expect.any(String),
    operation: { kind: "setUnread", enabled: true },
  })
  await click("Inspect outcome")
  expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith("1", "8", {
    conversationId: "3",
    contactInboxId: "4",
    commandId: input.commandId,
  })
  expect(mocks.set).toHaveBeenCalledTimes(1)
  expect(mocks.crmUnread).not.toHaveBeenCalled()
})

it("drops the prior thread result and requires an explicit reopen on return", async () => {
  let settle: ((value: { data: typeof session }) => void) | undefined
  mocks.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  )
  render("zaloAccount", true)
  await click("Settings on Zalo")
  expect(settle).toBeDefined()
  render("messenger", false, "31")
  await act(async () => {
    settle?.({ data: session })
    await Promise.resolve()
  })
  expect(document.body.textContent).not.toContain(
    "Some settings are unavailable.",
  )
  render("zaloAccount", true)
  expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).not.toContain(
    "Some settings are unavailable.",
  )
  await click("Settings on Zalo")
  await waitForText("Some settings are unavailable.")
  expect(mocks.get).toHaveBeenCalledTimes(2)
})
