import { randomUUID } from "node:crypto"
import { isZaloAccountEnabledByDefault } from "@chatbotx.io/business/zalo-account/native-operation-policy"
import { z } from "zod"

const booleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true")

const processOwnerId = `gateway-${randomUUID()}`

const gatewayEnvSchema = z
  .object({
    enabled: booleanString,
    nativeMessageOperationsEnabled: z.boolean(),
    messageIntegrityEnabled: booleanString,
    host: z.string().min(1).default("0.0.0.0"),
    port: z.coerce.number().int().positive().default(3211),
    redisUrl: z.string().url().default("redis://localhost:6379"),
    leaseTtlMs: z.coerce.number().int().min(10_000).default(30_000),
    leaseRenewMs: z.coerce.number().int().min(1000).default(10_000),
    ownerId: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.leaseRenewMs * 2 >= value.leaseTtlMs) {
      context.addIssue({
        code: "custom",
        message: "Zalo Account lease renewal must be below half the TTL",
        path: ["leaseRenewMs"],
      })
    }
  })

export const resolveGatewayEnv = (
  runtimeEnv: NodeJS.ProcessEnv = process.env,
) => {
  const config = gatewayEnvSchema.parse({
    enabled: runtimeEnv.ZALO_ACCOUNT_GATEWAY_ENABLED,
    nativeMessageOperationsEnabled: isZaloAccountEnabledByDefault(
      runtimeEnv.ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED,
    ),
    messageIntegrityEnabled: runtimeEnv.ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED,
    host: runtimeEnv.ZALO_ACCOUNT_GATEWAY_HOST,
    port: runtimeEnv.ZALO_ACCOUNT_GATEWAY_PORT,
    redisUrl: runtimeEnv.REDIS_URL,
    leaseTtlMs: runtimeEnv.ZALO_ACCOUNT_LEASE_TTL_MS,
    leaseRenewMs: runtimeEnv.ZALO_ACCOUNT_LEASE_RENEW_MS,
    ownerId: runtimeEnv.ZALO_ACCOUNT_GATEWAY_OWNER_ID,
  })
  return config.enabled && !config.ownerId
    ? { ...config, ownerId: processOwnerId }
    : config
}
