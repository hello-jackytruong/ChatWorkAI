import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reconnect: vi.fn(),
  cancel: vi.fn(),
  first: vi.fn(),
  error: vi.fn(),
  firstOptions: {} as {
    onSuccess?: (result: { data?: unknown }) => void
    onError?: (result: { error: { serverError?: string } }) => void
  },
  getSession: vi.fn(),
  selectTarget: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  push: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))
vi.mock("../src/features/inboxes/provider/inbox-hook", () => ({
  useInvalidateInboxes: () => mocks.invalidate,
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (_action: unknown, options: typeof mocks.firstOptions) => {
    mocks.firstOptions = options
    return { execute: mocks.first, isPending: false }
  },
}))
vi.mock(
  "../src/features/zalo-accounts/actions/start-first-connect.action",
  () => ({
    startFirstZaloAccountConnectAction: vi.fn(),
  }),
)
vi.mock("../src/lib/orpc/query", () => {
  const mutation = (mutationFn: unknown) => ({
    mutationOptions: (options: object) => ({ mutationFn, ...options }),
  })
  return {
    orpc: {
      connectionsAPI: {
        createConnectionAPI: mutation(mocks.create),
        reconnectConnectionAPI: mutation(mocks.reconnect),
      },
      connectSessionsAPI: {
        connectSessionTargetsAPI: mutation(mocks.selectTarget),
        cancelConnectSessionAPI: mutation(mocks.cancel),
        getConnectSessionAPI: {
          queryOptions: ({ input, ...options }: { input: { id: string } }) => ({
            queryKey: ["session", input.id],
            queryFn: mocks.getSession,
            ...options,
          }),
        },
      },
    },
  }
})

import { ZaloAccountConnect } from "../src/features/zalo-accounts/components/zalo-account-connect"

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient
beforeEach(() => {
  vi.resetAllMocks()
  mocks.invalidate.mockResolvedValue(undefined)
  const session = { id: "s", status: "pending", nextAction: null, targets: [] }
  mocks.create.mockResolvedValue({ session })
  mocks.reconnect.mockResolvedValue({ session })
  mocks.cancel.mockResolvedValue({ ...session, status: "cancelled" })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})
async function waitUntil(assertion: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      assertion()
    },
    { timeout: 5000 },
  )
}
it("closes the QR dialog and reports success when target completion replaces an awaiting-selection poll", async () => {
  mocks.getSession.mockResolvedValue({
    id: "s",
    status: "awaiting_selection",
    targets: [{ id: "target", selectable: true }],
    nextAction: null,
  })
  mocks.selectTarget.mockResolvedValue({
    session: { id: "s", status: "completed", targets: [], nextAction: null },
  })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <ZaloAccountConnect autoOpen workspaceId="w" />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    )
  })
  await act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === messages.actions.connect,
    )
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  await waitUntil(() =>
    expect(document.querySelector('[role="dialog"]')).toBeNull(),
  )
  expect(mocks.selectTarget).toHaveBeenCalled()
  expect(mocks.success).toHaveBeenCalledTimes(1)
  expect(mocks.push).toHaveBeenCalledWith(
    "/space/w/settings/channels/zaloAccount",
  )
})

it("allows retrying target connection after a transient completion failure", async () => {
  mocks.getSession.mockResolvedValue({
    id: "s",
    status: "awaiting_selection",
    targets: [{ id: "target", selectable: true }],
    nextAction: null,
  })
  mocks.selectTarget
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValue({
      session: { id: "s", status: "completed", targets: [], nextAction: null },
    })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <ZaloAccountConnect autoOpen workspaceId="w" />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    )
  })
  await act(async () => {
    Array.from(document.querySelectorAll("button"))
      .find((item) => item.textContent === messages.actions.connect)
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  await waitUntil(() =>
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (item) => item.textContent === messages.actions.retry,
      ),
    ).toBe(true),
  )
  expect(mocks.selectTarget).toHaveBeenCalledTimes(1)
  await act(async () => {
    const retry = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === messages.actions.retry,
    )
    expect(retry).toBeDefined()
    retry?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  await waitUntil(() =>
    expect(document.querySelector('[role="dialog"]')).toBeNull(),
  )
  expect(mocks.selectTarget).toHaveBeenCalledTimes(2)
  expect(mocks.success).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

function renderConnect(
  props: { workspaceId?: string; connectionId?: string } = { workspaceId: "w" },
) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <ZaloAccountConnect autoOpen {...props} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
}
async function clickButton(label: string) {
  await act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === label,
    )
    expect(button).toBeDefined()
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}
it("cancels an unfinished QR session when the dialog closes", async () => {
  mocks.getSession.mockResolvedValue({
    id: "s",
    status: "pending",
    nextAction: null,
    targets: [],
  })
  renderConnect()
  await clickButton(messages.actions.connect)
  await waitUntil(() => expect(mocks.getSession).toHaveBeenCalled())
  await clickButton(messages.actions.cancel)
  await waitUntil(() => expect(mocks.cancel).toHaveBeenCalled())
  expect(mocks.success).not.toHaveBeenCalled()
})
it("reconnects an existing account and lets an expired QR session start again", async () => {
  mocks.getSession.mockResolvedValue({
    id: "s",
    status: "expired",
    nextAction: null,
    targets: [],
  })
  renderConnect({ workspaceId: "w", connectionId: "c" })
  await clickButton(messages.channels.tokenRefreshErrorDialog.cta)
  await waitUntil(() =>
    expect(document.body.textContent).toContain(
      messages.zaloAccount.connectFailed,
    ),
  )
  await clickButton(messages.actions.retry)
  await waitUntil(() => expect(mocks.reconnect).toHaveBeenCalledTimes(2))
  expect(mocks.create).not.toHaveBeenCalled()
})
it.each([
  false,
  true,
])("reports a connection-start error (reconnect %s)", async (reconnect) => {
  mocks.create.mockRejectedValue(new Error("Could not create connection"))
  mocks.reconnect.mockRejectedValue(new Error("Could not reconnect"))
  renderConnect({
    workspaceId: "w",
    ...(reconnect ? { connectionId: "c" } : {}),
  })
  await clickButton(
    reconnect
      ? messages.channels.tokenRefreshErrorDialog.cta
      : messages.actions.connect,
  )
  await waitUntil(() => expect(mocks.error).toHaveBeenCalled())
  expect(mocks.success).not.toHaveBeenCalled()
})
it("starts the first workspace flow and completes its returned QR session", async () => {
  mocks.getSession.mockResolvedValue({
    id: "s",
    status: "completed",
    nextAction: null,
    targets: [],
  })
  renderConnect({})
  await clickButton(messages.actions.connect)
  expect(mocks.first).toHaveBeenCalled()
  act(() => {
    mocks.firstOptions.onSuccess?.({})
    mocks.firstOptions.onError?.({ error: {} })
    mocks.firstOptions.onError?.({
      error: { serverError: "First connection failed" },
    })
    mocks.firstOptions.onSuccess?.({
      data: {
        workspaceId: "w",
        session: { id: "s", status: "pending", nextAction: null, targets: [] },
      },
    })
  })
  await waitUntil(() => expect(mocks.success).toHaveBeenCalledTimes(1))
})
it("shows a retry when polling fails and resumes the same QR session", async () => {
  mocks.getSession
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({
      id: "s",
      status: "completed",
      nextAction: null,
      targets: [],
    })
  renderConnect()
  await clickButton(messages.actions.connect)
  await waitUntil(() =>
    expect(document.body.textContent).toContain(
      messages.zaloAccount.statusUnavailable,
    ),
  )
  await clickButton(messages.actions.retry)
  await waitUntil(() => expect(mocks.success).toHaveBeenCalledTimes(1))
  expect(mocks.create).toHaveBeenCalledTimes(1)
})
