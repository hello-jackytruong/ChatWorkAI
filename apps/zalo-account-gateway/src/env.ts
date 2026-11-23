import { isZaloAccountNativeOperationsEnabled } from "@chatbotx.io/business/zalo-account/native-operation-policy"
import { z } from "zod"

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true")

const gatewayEnvSchema = z
  .object({
    enabled: booleanString,
    nativeMessageOperationsEnabled: z.boolean().default(false),
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
    if (value.enabled && !value.ownerId) {
      context.addIssue({
        code: "custom",
        message:
          "ZALO_ACCOUNT_GATEWAY_OWNER_ID is required when the gateway is enabled",
        path: ["ownerId"],
      })
    }
  })

export const resolveGatewayEnv = (
  runtimeEnv: NodeJS.ProcessEnv = process.env,
) =>
  gatewayEnvSchema.parse({
    enabled: runtimeEnv.ZALO_ACCOUNT_GATEWAY_ENABLED,
    nativeMessageOperationsEnabled: isZaloAccountNativeOperationsEnabled(
      runtimeEnv.ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED,
    ),
    host: runtimeEnv.ZALO_ACCOUNT_GATEWAY_HOST,
    port: runtimeEnv.ZALO_ACCOUNT_GATEWAY_PORT,
    redisUrl: runtimeEnv.REDIS_URL,
    leaseTtlMs: runtimeEnv.ZALO_ACCOUNT_LEASE_TTL_MS,
    leaseRenewMs: runtimeEnv.ZALO_ACCOUNT_LEASE_RENEW_MS,
    ownerId: runtimeEnv.ZALO_ACCOUNT_GATEWAY_OWNER_ID,
  })
