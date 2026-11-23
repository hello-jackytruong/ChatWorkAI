import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  groups: vi.fn(),
  changed: undefined as
    | ((event: { data: { accountId: string } }) => void)
    | undefined,
}))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({
    getZaloAccountStatusAction: mocks.status,
    getZaloAccountOperationsAction: mocks.groups,
  }),
)
vi.mock("../src/features/realtime/use-workspace-realtime-events", () => ({
  useWorkspaceRealtimeEvents: (handlers: {
    zaloAccountStatusChanged: typeof mocks.changed
  }) => {
    mocks.changed = handlers.zaloAccountStatusChanged
  },
}))

import { useZaloAccountOperations } from "../src/features/zalo-accounts/queries/use-account-operations"

import {
  useZaloAccountStatus,
  useZaloAccountStatusUpdates,
} from "../src/features/zalo-accounts/queries/use-account-status"

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
let client: QueryClient
const Probe = ({ id }: { id: string }) => {
  const query = useZaloAccountStatus("w", id)
  return <span>{query.data?.status ?? "pending"}</span>
}
const Screen = ({ count }: { count: number }) => {
  useZaloAccountStatusUpdates("w")
  return Array.from({ length: count }, (_, index) => String(index)).map(
    (id) => <Probe id={id} key={id} />,
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  focusManager.setFocused(true)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.status.mockImplementation((_workspaceId, accountId) =>
    Promise.resolve({ data: { accountId, status: "connected" } }),
  )
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  focusManager.setFocused(true)
  vi.useRealTimers()
})

it.each([
  1, 100,
])("polls %s visible accounts using status only and pauses in the background", async (count) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={count} />
      </QueryClientProvider>,
    ),
  )
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(mocks.status).toHaveBeenCalledTimes(count)
  expect(mocks.groups).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(mocks.status).toHaveBeenCalledTimes(count * 2)
  focusManager.setFocused(false)
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.status).toHaveBeenCalledTimes(count * 2)
})

it("coalesces repeated IDs, ignores unmounted accounts, and clears the one invalidation timer", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={2} />
      </QueryClientProvider>,
    ),
  )
  await act(async () => vi.advanceTimersByTimeAsync(1))
  mocks.status.mockClear()
  await act(async () => {
    for (let index = 0; index < 100; index += 1) {
      mocks.changed?.({ data: { accountId: "1" } })
    }
    mocks.changed?.({ data: { accountId: "not-mounted" } })
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(mocks.status).toHaveBeenCalledTimes(1)
  expect(mocks.status).toHaveBeenCalledWith("w", "1")
  mocks.changed?.({ data: { accountId: "1" } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <div />
      </QueryClientProvider>,
    ),
  )
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(mocks.status).toHaveBeenCalledTimes(1)
})

it("marks hidden realtime updates stale without a background refetch", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={2} />
      </QueryClientProvider>,
    ),
  )
  await act(async () => vi.advanceTimersByTimeAsync(1))
  mocks.status.mockClear()
  focusManager.setFocused(false)
  await act(async () => {
    mocks.changed?.({ data: { accountId: "1" } })
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  expect(
    client.getQueryState(["zalo-account-status", "w", "1"])?.isInvalidated,
  ).toBe(true)
  await act(async () => {
    focusManager.setFocused(true)
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(
    mocks.status.mock.calls.filter((call) => call[1] === "1"),
  ).toHaveLength(1)
})

const OperationsProbe = () => {
  const query = useZaloAccountOperations("w", "0")
  return <span>{query.data?.groups.length}</span>
}
it("invalidates cached full operations but refetches groups only while its panel is mounted", async () => {
  mocks.groups.mockResolvedValue({
    data: { status: { status: "connected" }, groups: [] },
  })
  const key = ["zalo-account-operations", "w", "0"]
  client.setQueryData(key, { status: { status: "connected" }, groups: [] })
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={1} />
      </QueryClientProvider>,
    ),
  )
  await act(async () => {
    mocks.changed?.({ data: { accountId: "0" } })
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(mocks.groups).not.toHaveBeenCalled()
  expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={1} />
        <OperationsProbe />
      </QueryClientProvider>,
    ),
  )
  expect(mocks.groups).toHaveBeenCalledTimes(1)
  await act(async () => {
    mocks.changed?.({ data: { accountId: "0" } })
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(mocks.groups).toHaveBeenCalledTimes(2)
  focusManager.setFocused(false)
  await act(async () => {
    mocks.changed?.({ data: { accountId: "0" } })
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.groups).toHaveBeenCalledTimes(2)
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={1} />
      </QueryClientProvider>,
    ),
  )
  focusManager.setFocused(true)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(mocks.groups).toHaveBeenCalledTimes(2)
})
it("does not refetch if the tab hides during the realtime coalescing window", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Screen count={1} />
      </QueryClientProvider>,
    ),
  )
  mocks.status.mockClear()
  await act(async () => {
    mocks.changed?.({ data: { accountId: "0" } })
    focusManager.setFocused(false)
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  expect(
    client.getQueryState(["zalo-account-status", "w", "0"])?.isInvalidated,
  ).toBe(true)
})
