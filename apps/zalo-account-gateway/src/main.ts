import { pathToFileURL } from "node:url"
import { zaloAccountService } from "@chatbotx.io/business/zalo-account"
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
  })
  let shuttingDown = false
  let transportFailed = false
  let consumerLoop: Promise<void> | undefined
  const ownerId = env.ownerId ?? "gateway-disabled"
  const leaseStore = new RedisAccountLeaseStore(redis)
  const eventSink = env.enabled
    ? new FencedEventPublisher({
        appendPort: leaseStore,
        eventStreamKey: zaloAccountTransportKeys.eventStream,
        maxLen: 100_000,
        ownerId,
      })
    : disabledEventSink
  const pool = new ZaloAccountPool({
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
  const consumer = env.enabled
    ? new RedisCommandConsumer({
        executor: new ZaloAccountCommandExecutor({
          admission: new ZaloAccountProviderAdmission(),
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
  const server = createGatewayServer({
    isReady: () =>
      env.enabled &&
      !shuttingDown &&
      !transportFailed &&
      redis.status === "ready" &&
      consumer?.isReady() === true,
  })
  if (env.enabled) {
    await redis.connect()
    const restored = await reconcileActiveAccounts({
      listPage: (input) => zaloAccountService.listActiveRuntimeAccounts(input),
      reconnect: (command) => pool.reconnect(command),
    })
    logger.info({ restored }, "Zalo Account active runtimes reconciled")
    consumerLoop = consumer?.start().catch((error: unknown) => {
      transportFailed = true
      logger.error({ err: error }, "Zalo Account command consumer failed")
    })
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(env.port, env.host, () => {
      server.off("error", onError)
      resolve()
    })
  })

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
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
