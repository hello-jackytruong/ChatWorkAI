import { pathToFileURL } from "node:url"
import {
  isZaloAccountRichSendEnabled,
  takeDirectSendCapacity,
  zaloAccountGroupService,
  zaloAccountLabelService,
  zaloAccountSendAttemptService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountMessageOperationsService } from "@chatbotx.io/business/zalo-account/native-operations"
import { zaloAccountRuntimeStateService } from "@chatbotx.io/business/zalo-account/runtime-state"
import { getChildLogger } from "@chatbotx.io/logger"
import { createRedisConnection } from "@chatbotx.io/redis"
import type { ZaloAccountCommandEnvelope } from "@chatbotx.io/sdk"
import { zaloAccountTransportKeys } from "@chatbotx.io/sdk"
import { resolveGatewayEnv } from "./env"
import { RedisAccountLeaseStore } from "./runtime/account-lease-store"
import type { RuntimeEventSink } from "./runtime/ports"
import { reconcileActiveAccounts } from "./runtime/reconcile-active-accounts"
import { ZaloAccountPool } from "./runtime/zalo-account-pool"
import { zcaClientFactory } from "./runtime/zca-client"
import { createGatewayServer } from "./server"
import { ZaloAccountCommandExecutor } from "./transport/command-executor"
import { FencedEventPublisher } from "./transport/fenced-event-publisher"
import { ZaloAccountProviderAdmission } from "./transport/provider-admission"
import { RedisCommandConsumer } from "./transport/redis-command-consumer"
import { RedisCommandStateStore } from "./transport/redis-command-state-store"

const logger = getChildLogger("zalo-account-gateway")

const disabledEventSink: RuntimeEventSink = {
  publishAuthorization: () => Promise.resolve(),
  publishDirectMessage: () => Promise.resolve(),
  publishDirectStatus: () => Promise.resolve(),
  publishDirectUndo: () => Promise.resolve(),
  publishGroupActivity: () => Promise.resolve(),
  publishLifecycle: () => Promise.resolve(),
}

export const main = async (): Promise<void> => {
  const env = resolveGatewayEnv()
  const redis = createRedisConnection(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    commandTimeout: 10_000,
    enableOfflineQueue: false,
  })
  let shuttingDown = false
  let transportFailed = false
  let consumerLoop: Promise<void> | undefined
  const ownerId = env.ownerId ?? "gateway-disabled"
  const leaseStore = new RedisAccountLeaseStore(redis)
  const eventSink = env.enabled
    ? new FencedEventPublisher({
        messageIntegrityEnabled: env.messageIntegrityEnabled,
        appendPort: leaseStore,
        eventStreamKey: zaloAccountTransportKeys.eventStream,
        maxLen: 100_000,
        ownerId,
        resolveGroupReceivePolicy: (input) =>
          zaloAccountGroupService.resolveReceivePolicy(input),
      })
    : disabledEventSink
  const pool = new ZaloAccountPool({
    messageIntegrityEnabled: env.messageIntegrityEnabled,
    richSendEnabled: (accountId) => isZaloAccountRichSendEnabled(accountId),
    admitDirectSend: takeDirectSendCapacity,
    onLeaseLost: () => scheduleRecovery(0),
    claim: (input) => zaloAccountRuntimeStateService.claim(input),
    hold: (input) => zaloAccountRuntimeStateService.hold(input),
    onGroupSendResult: (input) => zaloAccountSendAttemptService.confirm(input),
    admitLabelMutation: (input) => zaloAccountLabelService.admitMutation(input),
    admitGroupSend: (input) => zaloAccountGroupService.admitSend(input),
    clientFactory: zcaClientFactory,
    eventSink,
    lease: leaseStore,
    leaseRenewMs: env.leaseRenewMs,
    leaseTtlMs: env.leaseTtlMs,
    ownerId,
    secretPort: {
      load: (input) => zaloAccountService.loadRuntimeAccount(input),
    },
  })
  const createConsumer = () =>
    env.enabled
      ? new RedisCommandConsumer({
          executor: new ZaloAccountCommandExecutor({
            admission: new ZaloAccountProviderAdmission(),
            nativeEnabled: env.nativeMessageOperationsEnabled,
            nativeOperations: {
              claimDispatch: (command) =>
                zaloAccountMessageOperationsService.gatewayClaim(command),
              settle: (command, status, providerStatus) =>
                zaloAccountMessageOperationsService.gatewaySettle(
                  command,
                  status,
                  providerStatus,
                ),
              outcome: (command) =>
                zaloAccountMessageOperationsService.gatewayOutcome(command),
            },
            ownerId,
            ownsTarget: async (command: ZaloAccountCommandEnvelope) => {
              if (command.kind === "start_qr" || !command.target) {
                return true
              }
              return await leaseStore.isOwned(
                {
                  workspaceId: command.route.workspaceId,
                  runtime:
                    command.route.kind === "account"
                      ? { kind: "account", id: command.route.accountId }
                      : {
                          kind: "connect_session",
                          id: command.route.sessionId,
                        },
                },
                {
                  ownerId: command.target.ownerId,
                  fenceToken: command.target.fenceToken,
                },
              )
            },
            pool,
            stateStore: new RedisCommandStateStore(redis),
          }),
          logger,
          ownerId,
          redis,
        })
      : undefined
  let consumer: ReturnType<typeof createConsumer>
  let recoveryTimer: NodeJS.Timeout | undefined
  let recoveryRun: Promise<void> | undefined
  let afterId: string | undefined

  const scheduleRecovery = (delay = 30_000) => {
    if (shuttingDown || !env.enabled) {
      return
    }
    if (recoveryRun) {
      return
    }
    if (recoveryTimer) {
      if (delay > 0) {
        return
      }
      clearTimeout(recoveryTimer)
    }
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined
      recoveryRun = recover().finally(() => {
        recoveryRun = undefined
        scheduleRecovery(30_000)
      })
    }, delay)
    recoveryTimer.unref?.()
  }
  const startConsumer = () => {
    if (consumerLoop || shuttingDown || redis.status !== "ready") {
      return
    }
    consumer = createConsumer()
    transportFailed = false
    consumerLoop = consumer
      ?.start()
      .catch(() => {
        transportFailed = true
        logger.error(
          { err: new Error("Zalo Account command consumer failed") },
          "Zalo Account command consumer failed",
        )
      })
      .finally(() => {
        consumerLoop = undefined
        scheduleRecovery()
      })
  }
  const recover = async () => {
    if (shuttingDown || redis.status !== "ready") {
      return
    }
    startConsumer()
    try {
      const result = await reconcileActiveAccounts({
        afterId,
        deadlineAt: Date.now() + 30_000,
        max: 50,
        listPage: (input) =>
          zaloAccountService.listActiveRuntimeAccounts(input),
        reconnect: (command) => pool.reconnect(command),
      })
      afterId = result.complete ? undefined : result.afterId
      logger.info(
        {
          scanned: result.scanned,
          restored: result.restored,
          failed: result.failed,
        },
        "Zalo Account runtimes reconciled",
      )
    } catch {
      logger.warn("Zalo Account recovery deferred")
    }
  }
  const server = createGatewayServer({
    isReady: () =>
      env.enabled &&
      !shuttingDown &&
      !transportFailed &&
      redis.status === "ready" &&
      consumer?.isReady() === true &&
      pool.isMessageReady(),
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(env.port, env.host, () => {
      server.off("error", onError)
      resolve()
    })
  })

  if (env.enabled) {
    redis.on("ready", () => {
      startConsumer()
      scheduleRecovery(0)
    })
    await redis.connect()
    startConsumer()
    scheduleRecovery(0)
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    if (recoveryTimer) {
      clearTimeout(recoveryTimer)
    }
    recoveryTimer = undefined
    logger.info({ signal }, "Zalo Account gateway shutting down")
    consumer?.stop()
    const shutdownWork = async () => {
      let firstError: unknown
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      } catch (error) {
        firstError = error
      }
      try {
        await consumerLoop
      } catch (error) {
        firstError ??= error
      }
      try {
        await pool.shutdown()
        await recoveryRun
      } catch (error) {
        firstError ??= error
      }
      try {
        if (redis.status !== "end") {
          await redis.quit()
        }
      } catch (error) {
        firstError ??= error
      }
      if (firstError) {
        throw firstError
      }
    }

    let deadline: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        shutdownWork(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Zalo Account gateway shutdown timed out")),
            30_000,
          )
        }),
      ])
    } catch (error) {
      server.closeAllConnections()
      redis.disconnect()
      throw error
    } finally {
      if (deadline) {
        clearTimeout(deadline)
      }
    }
  }
  process.once("SIGINT", async () => {
    await shutdown("SIGINT").catch((error: unknown) => {
      logger.error({ err: error }, "Zalo Account gateway shutdown failed")
      process.exitCode = 1
    })
  })
  process.once("SIGTERM", async () => {
    await shutdown("SIGTERM").catch((error: unknown) => {
      logger.error({ err: error }, "Zalo Account gateway shutdown failed")
      process.exitCode = 1
    })
  })

  logger.info(
    { enabled: env.enabled, host: env.host, port: env.port },
    "Zalo Account gateway listening",
  )
}

const entrypointPath = process.argv[1]
if (
  entrypointPath &&
  import.meta.url === pathToFileURL(entrypointPath).toString()
) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, "Zalo Account gateway failed to start")
    process.exit(1)
  })
}
