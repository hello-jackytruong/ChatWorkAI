import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"
import { ZaloAccountManage } from "../src/features/zalo-accounts/components/zalo-account-manage"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  inspect: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("../src/features/inboxes/provider/inbox-hook", () => ({
  useInvalidateInboxes: () => vi.fn(),
}))
vi.mock("../src/features/inboxes/components/add-channel-button", () => ({
  AddChannelButton: () => null,
}))
vi.mock(
  "../src/features/inboxes/components/inbox-mark-read-on-outbound-switch",
  () => ({ InboxMarkReadOnOutboundSwitch: () => null }),
)
vi.mock("../src/features/realtime/use-workspace-realtime-events", () => ({
  useWorkspaceRealtimeEvents: vi.fn(),
}))
vi.mock(
  "../src/features/zalo-accounts/components/zalo-account-connect",
  () => ({
    ZaloAccountConnect: ({ children }: { children: ReactNode }) => children,
  }),
)
vi.mock(
  "../src/features/zalo-accounts/components/zalo-history-sync-controls",
  () => ({ ZaloHistorySyncControls: () => null }),
)
vi.mock(
  "../src/features/zalo-accounts/components/zalo-account-native-profile",
  () => ({ ZaloAccountNativeProfile: () => null }),
)
vi.mock(
  "../src/features/zalo-accounts/components/zalo-account-contacts",
  () => ({ ZaloAccountContacts: () => null }),
)
vi.mock(
  "../src/features/zalo-accounts/components/zalo-account-native-labels",
  () => ({ ZaloAccountNativeLabels: () => null }),
)
vi.mock("../src/features/zalo-accounts/components/zalo-account-groups", () => ({
  ZaloAccountGroups: () => null,
}))
vi.mock("../src/features/zalo-accounts/queries/use-account-status", () => ({
  useZaloAccountStatus: () => ({}),
  useZaloAccountStatusUpdates: vi.fn(),
  zaloAccountStatusKey: vi.fn(),
}))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({
    getZaloAccountOperationsAction: vi.fn(),
    getZaloAccountStatusAction: vi.fn(),
  }),
)
vi.mock(
  "../src/features/media-library/components/media-library-trigger",
  () => ({ MediaLibraryTrigger: () => null }),
)
vi.mock("../src/lib/orpc/query", () => ({
  orpc: {
    connectionsAPI: {
      disconnectConnectionAPI: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
    },
  },
}))
vi.mock(
  "../src/features/zalo-accounts/actions/native-account-tools.action",
  () => ({
    readZaloNativeAccountToolAction: mocks.read,
    mutateZaloNativeAccountToolAction: mocks.mutate,
    getZaloNativeAccountToolAttemptAction: mocks.inspect,
  }),
)

const quickMessages = {
  version: "quick-v1",
  items: [
    {
      id: 7,
      keyword: "hello",
      title: "Welcome text",
      hasMedia: true,
      media: { url: "https://zalo.me/quick-preview.png" },
    },
  ],
}
const autoReplies = {
  version: "auto-v1",
  items: [
    {
      id: 15,
      content: "Native away reply",
      enabled: true,
      scope: 1,
      uids: [],
      startTime: 100,
      endTime: 200,
      recurrence: [],
    },
  ],
}
let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  client = new QueryClient()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  mocks.read.mockImplementation(
    (_workspace, _account, input: { operation: { kind: string } }) =>
      Promise.resolve({
        data: {
          kind: input.operation.kind,
          outcome: "confirmed",
          writeEnabled: true,
          ...(input.operation.kind === "readQuickMessages"
            ? { quickMessages }
            : { autoReplies }),
        },
      }),
  )
  mocks.mutate.mockImplementation(
    (
      _workspace,
      _account,
      input: { commandId: string; operation: { kind: string } },
    ) =>
      Promise.resolve({
        data: {
          commandId: input.commandId,
          operation: input.operation.kind,
          status: "confirmed",
          result: { kind: input.operation.kind, outcome: "confirmed" },
        },
      }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})

function render() {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <ZaloAccountManage
            accounts={[
              {
                id: "2",
                name: "Personal Zalo",
                inboxId: "3",
                groups: [],
                connection: { id: "4", status: "connected" },
              } as never,
            ]}
            canCreate
            workspaceId="1"
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
}

async function click(label: string) {
  await act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        (element.getAttribute("aria-label") ?? element.textContent) === label,
    )
    expect(button).toBeDefined()
    button?.click()
    await Promise.resolve()
  })
}

async function waitForText(text: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(document.body.textContent).toContain(text)
  })
}

function enter(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
  )
  if (!input) {
    throw new Error(`Missing field: ${label}`)
  }
  act(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function openReplies() {
  render()
  await click(messages.zaloAccount.configure)
  expect(mocks.read).not.toHaveBeenCalled()
  await click("Zalo replies")
  await waitForText("Welcome text")
}

it("loads only the selected reply view and keeps text when a native image cannot load", async () => {
  await openReplies()
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith("1", "2", {
    operation: { kind: "readQuickMessages" },
  })
  expect(document.body.textContent).not.toContain("Native away reply")
  const picture = document.querySelector('img[alt="Quick message image"]')
  expect(picture).not.toBeNull()
  await act(async () => {
    picture?.dispatchEvent(new Event("error"))
    await Promise.resolve()
  })
  await waitForText("Image preview unavailable.")
  expect(document.body.textContent).toContain("Welcome text")
  await click("Auto-replies")
  await waitForText("Native away reply")
  expect(mocks.read).toHaveBeenLastCalledWith("1", "2", {
    operation: { kind: "readAutoReplies" },
  })
  expect(mocks.read).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain(
    "An enabled Zalo auto-reply may duplicate a ChatbotX Flow or AI Agent reply.",
  )
})

it("saves a quick text edit without media changes and confirms explicit media removal", async () => {
  await openReplies()
  await click("Edit quick message hello")
  enter("Quick message text", "Updated greeting")
  await click(messages.actions.save)
  expect(mocks.mutate).toHaveBeenNthCalledWith(1, "1", "2", {
    commandId: expect.any(String),
    operation: {
      kind: "updateQuickMessage",
      expectedVersion: "quick-v1",
      id: 7,
      keyword: "hello",
      title: "Updated greeting",
    },
  })
  await waitForText("Zalo confirmed the change.")
  await click("Remove image from hello")
  await waitForText("Remove the image from hello?")
  expect(mocks.mutate).toHaveBeenCalledTimes(1)
  await click("Confirm image removal")
  expect(mocks.mutate).toHaveBeenNthCalledWith(2, "1", "2", {
    commandId: expect.any(String),
    confirmed: true,
    operation: {
      kind: "updateQuickMessage",
      expectedVersion: "quick-v1",
      id: 7,
      keyword: "hello",
      title: "Welcome text",
      mediaMode: "remove",
    },
  })
})

it("confirms an exact auto-reply deletion and inspects unknown outcomes with the original command ID", async () => {
  mocks.mutate.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          commandId: input.commandId,
          operation: "deleteAutoReply",
          status: "unknown",
        },
      }),
  )
  mocks.inspect.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          commandId: input.commandId,
          operation: "deleteAutoReply",
          status: "unknown",
        },
      }),
  )
  await openReplies()
  await click("Auto-replies")
  await waitForText("Native away reply")
  expect(document.body.textContent).toContain(
    "Creating and editing Zalo auto-replies is currently unavailable.",
  )
  await click("Delete auto-reply 15")
  await waitForText("Delete Zalo auto-reply 15?")
  expect(mocks.mutate).not.toHaveBeenCalled()
  await click("Confirm auto-reply deletion")
  await waitForText("Zalo has not confirmed the change.")
  const input = mocks.mutate.mock.calls[0]?.[2]
  expect(input).toEqual({
    commandId: expect.any(String),
    confirmed: true,
    operation: { kind: "deleteAutoReply", expectedVersion: "auto-v1", id: 15 },
  })
  await click("Inspect outcome")
  expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith("1", "2", {
    family: "nativeReplies",
    commandId: input.commandId,
  })
  expect(mocks.mutate).toHaveBeenCalledTimes(1)
})

it("uses the loaded snapshot version for quick-message pagination and text creation", async () => {
  mocks.read.mockImplementation(
    (
      _workspace,
      _account,
      input: { operation: { kind: string; offset?: number } },
    ) =>
      Promise.resolve({
        data: {
          kind: input.operation.kind,
          outcome: "confirmed",
          writeEnabled: true,
          quickMessages:
            input.operation.offset === undefined
              ? { ...quickMessages, nextOffset: 30 }
              : {
                  version: quickMessages.version,
                  items: [
                    {
                      id: 9,
                      keyword: "status",
                      title: "Opening hours",
                      hasMedia: false,
                    },
                  ],
                },
        },
      }),
  )
  await openReplies()
  await click(messages.actions.loadMore)
  await waitForText("Opening hours")
  expect(mocks.read).toHaveBeenLastCalledWith("1", "2", {
    operation: {
      kind: "readQuickMessages",
      offset: 30,
      expectedVersion: "quick-v1",
    },
  })
  await click("Add quick message")
  enter("Quick message keyword", "shipping")
  enter("Quick message text", "Your order is shipping.")
  await click(messages.actions.save)
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith("1", "2", {
    commandId: expect.any(String),
    operation: {
      kind: "addQuickMessage",
      expectedVersion: "quick-v1",
      keyword: "shipping",
      title: "Your order is shipping.",
    },
  })
  await waitForText("Zalo confirmed the change.")
})
