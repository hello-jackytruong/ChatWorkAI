import { expect, it } from "vitest"
import { resolveGatewayEnv } from "../src/env"

it("starts enabled with message features on and a stable process owner identity without configuration", () => {
  const config = resolveGatewayEnv({})
  expect(config).toMatchObject({
    enabled: true,
    nativeMessageOperationsEnabled: true,
    messageIntegrityEnabled: true,
    ownerId: expect.any(String),
  })
  expect(config.ownerId).not.toBe("")
  expect(resolveGatewayEnv({}).ownerId).toBe(config.ownerId)
})

it("honors explicit emergency overrides and a supplied gateway owner", () => {
  expect(
    resolveGatewayEnv({
      ZALO_ACCOUNT_GATEWAY_ENABLED: "false",
      ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED: "false",
      ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED: "false",
      ZALO_ACCOUNT_GATEWAY_OWNER_ID: "gateway-explicit",
    }),
  ).toMatchObject({
    enabled: false,
    nativeMessageOperationsEnabled: false,
    messageIntegrityEnabled: false,
    ownerId: "gateway-explicit",
  })
})
