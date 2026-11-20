import { channelTypes } from "@chatbotx.io/database/partials"
// biome-ignore lint/performance/noNamespaceImport: the schema barrel is indexed by model name to derive the per-channel matrix
import * as schema from "@chatbotx.io/database/schema"
import { beforeEach, expect, test, vi } from "vitest"
// Deep relative import on purpose: `@chatbotx.io/database` publishes no
// `./relations` subpath. See the same note in
// `inbox-with-integrations-relations.test.ts`, which pins these relation names
// to be exactly the set `InboxService.withIntegrations` eager-loads — so this
// matrix cannot silently shrink.
import { inboxRelations } from "../../database/src/relations/inbox"

/**
 * `disconnectWorkspaceInbox` switches on `inbox.channel` and deletes that
 * channel's integration row. It ends in a `default:` branch, so a channel with
 * no `case` compiles cleanly and silently leaks its `Integration*` row on
 * workspace deletion and trial-expiry teardown (`inboxService.disconnect` only
 * flips `Inbox.status`, it never deletes the inbox row, so nothing cascades).
 *
 * The matrix is derived from relations whose suffix is a current `ChannelType`.
 * Reserved provider relations must be explicitly allow-listed until they join
 * the channel cascade; their rows remain protected by database cascades.
 *
 * Not covered here, deliberately: `api`. `IntegrationApi` has an `inboxId` like
 * the others, but it has no `integration*` relation on `inboxModel` and is not
 * in `InboxService.withIntegrations`, so teardown never loads it and no `case`
 * could act on it. That is a pre-existing gap in the teardown itself, not
 * something a `case` here would fix.
 */

const listWithIntegrationsByWorkspaceMock = vi.fn()
const disconnectInboxMock = vi.fn()
const findByInboxIdMock = vi.fn()
const connectionTransitionMock = vi.fn()
const findZaloAccountByInboxIdMock = vi.fn()
const stopZaloAccountRuntimeMock = vi.fn()

vi.mock("@chatbotx.io/database/client", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  db: {},
  eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
  inArray: vi.fn((column: unknown, values: unknown) => ({
    inArray: [column, values],
  })),
  liftDecompressionLimit: vi.fn(),
  sql: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  coexistSyncRunRepository: {
    cancelActiveContactScanRuns: vi.fn(),
    lockIntegration: vi.fn(),
  },
  contactSyncRunRepository: { cancelForInbox: vi.fn() },
  connectionRepository: { findByInboxId: findByInboxIdMock },
  LIVE_RUN_STATUSES: [],
  PULL_CLAIMABLE_STATUSES: [],
}))

vi.mock("../src/connection/state-service", () => ({
  connectionStateService: { transition: connectionTransitionMock },
}))

vi.mock("@chatbotx.io/sequence-scheduler/dispatch-cancel", () => ({
  cancelPendingDispatchesForWorkspace: vi.fn().mockResolvedValue([]),
  removeDispatchesFromSchedule: vi.fn(),
}))

vi.mock("../src/base.service", () => ({
  BaseService: class {},
}))

vi.mock("../src/workspace-lifecycle/campaign-cleanup", () => ({
  cancelInFlightBroadcastsForWorkspace: vi.fn(),
  completeActiveSequenceEnrollmentsForWorkspace: vi.fn(),
}))

vi.mock("../src/workspace-lifecycle/smart-delay-cleanup", () => ({
  cancelSmartDelaysForWorkspace: vi.fn(),
}))

vi.mock("../src/inbox/service", () => ({
  inboxService: {
    disconnect: disconnectInboxMock,
    listWithIntegrationsByWorkspace: listWithIntegrationsByWorkspaceMock,
  },
}))

vi.mock("../src/coexist/service", () => ({
  coexistService: {
    tearDownForIntegration: vi.fn(),
  },
}))

vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findByInboxId: findZaloAccountByInboxIdMock },
}))

vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    stopAndWait: stopZaloAccountRuntimeMock,
  },
}))

vi.mock("../src/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

type RelationsPart = Record<string, { relations: Record<string, unknown> }>

const toChannel = (relation: string): string => {
  const suffix = relation.slice("integration".length)
  return `${suffix.charAt(0).toLowerCase()}${suffix.slice(1)}`
}

const reservedNonChannelIntegrationRelations = new Set<string>()

const integrationRelations = Object.keys(
  (inboxRelations as unknown as RelationsPart).inboxModel.relations,
).filter((relation) => relation.startsWith("integration"))

const channelsWithInboxIntegration = integrationRelations
  .filter((relation) => !reservedNonChannelIntegrationRelations.has(relation))
  .map((relation) => ({
    channel: toChannel(relation),
    modelName: `${relation}Model`,
    property: relation,
  }))
  .sort((a, b) => a.channel.localeCompare(b.channel))

const modelFor = (modelName: string): unknown =>
  (schema as unknown as Record<string, unknown>)[modelName]

beforeEach(() => {
  vi.clearAllMocks()
  listWithIntegrationsByWorkspaceMock.mockResolvedValue([])
  disconnectInboxMock.mockResolvedValue(undefined)
  findByInboxIdMock.mockResolvedValue(undefined)
  connectionTransitionMock.mockResolvedValue(undefined)
  findZaloAccountByInboxIdMock.mockImplementation(
    async ({ inboxId }: { inboxId: string }) =>
      inboxId === "inbox-zaloAccount"
        ? { id: "integration-zaloAccount" }
        : null,
  )
  stopZaloAccountRuntimeMock.mockResolvedValue({
    status: "applied",
    result: { status: "stopped" },
  })
})

test("the derived channel matrix is non-empty and only contains real channels", () => {
  expect(channelsWithInboxIntegration.length).toBeGreaterThan(0)

  for (const { channel, modelName } of channelsWithInboxIntegration) {
    expect(channelTypes.options, `${channel} is not a ChannelType`).toContain(
      channel,
    )
    expect(
      modelFor(modelName),
      `${modelName} is missing from the schema`,
    ).toBeDefined()
  }
})

test.each(
  channelsWithInboxIntegration,
)("disconnectWorkspaceChannels deletes the $channel integration row instead of falling through to default", async ({
  channel,
  modelName,
  property,
}) => {
  const deleteWhereMock = vi.fn().mockResolvedValue(undefined)
  const deleteMock = vi.fn(() => ({ where: deleteWhereMock }))
  const updateWhereMock = vi.fn().mockResolvedValue(undefined)
  const updateMock = vi.fn(() => ({
    set: vi.fn(() => ({ where: updateWhereMock })),
  }))
  const tx = { delete: deleteMock, update: updateMock }

  listWithIntegrationsByWorkspaceMock.mockResolvedValue([
    {
      id: `inbox-${channel}`,
      channel,
      workspaceId: "workspace-1",
      [property]: {
        id: `integration-${channel}`,
        auth: { tokens: { accessToken: "token" } },
        // Extra fields a few branches read before deleting; harmless
        // everywhere else, and keeping the stub uniform is what lets the
        // matrix stay derived instead of hand-written per channel.
        phoneNumberId: "phone-1",
        type: "facebook",
      },
    },
  ])

  const { workspaceLifecycleService } = await import(
    "../src/workspace-lifecycle/service"
  )

  await workspaceLifecycleService.disconnectWorkspaceChannels({
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    teardownLevel: "disconnect",
    tx: tx as never,
  })

  const deletedModels = deleteMock.mock.calls.map(([model]) => model)
  expect(
    deletedModels,
    `disconnectWorkspaceInbox has no "${channel}" case, so its ${modelName} rows survive workspace teardown`,
  ).toContain(modelFor(modelName))
  expect(disconnectInboxMock).toHaveBeenCalledWith(
    expect.objectContaining({ inboxId: `inbox-${channel}` }),
  )
})

test("zaloAccount teardown confirms runtime stop before mutating durable state", async () => {
  const deleteMock = vi.fn()
  listWithIntegrationsByWorkspaceMock.mockResolvedValue([
    {
      id: "inbox-zaloAccount",
      channel: "zaloAccount",
      workspaceId: "workspace-1",
    },
  ])
  findByInboxIdMock.mockResolvedValue({ id: "connection-1" })
  stopZaloAccountRuntimeMock.mockRejectedValue(new Error("stop timed out"))

  const { workspaceLifecycleService } = await import(
    "../src/workspace-lifecycle/service"
  )
  await expect(
    workspaceLifecycleService.disconnectWorkspaceChannels({
      workspaceId: "workspace-1",
      ownerId: "owner-1",
      teardownLevel: "disconnect",
      tx: { delete: deleteMock } as never,
    }),
  ).rejects.toThrow("stop timed out")

  expect(connectionTransitionMock).not.toHaveBeenCalled()
  expect(disconnectInboxMock).not.toHaveBeenCalled()
  expect(deleteMock).not.toHaveBeenCalled()
})
