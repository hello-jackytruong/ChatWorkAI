import { beforeEach, expect, test, vi } from "vitest"
import yargs from "yargs"
import { registerToolCommands } from "../src/command-registration"
import { executeDynamicCommand } from "../src/dynamic-executor"
import type { DynamicTool } from "../src/openapi-loader"

vi.mock("../src/dynamic-executor", () => ({ executeDynamicCommand: vi.fn() }))

const config = { apiKey: "test", apiUrl: "https://example.com" }
const tool = (commandName: string, pathParamNames: string[]): DynamicTool => ({
  baseUrl: config.apiUrl,
  bodyParamNames: ["enabled"],
  commandName,
  description: "Update policy",
  inputSchema: { type: "object", properties: {}, required: ["enabled"] },
  method: "PATCH",
  pathParamNames,
  pathTemplate: "/v1/connections/zalo-account/{accountId}/group-messaging",
  queryParamNames: [],
})

beforeEach(() => vi.clearAllMocks())

test.each([
  ["zalo-account-set-group-messaging", ["accountId"], ["account-1"]],
  [
    "zalo-account-update-group-policy",
    ["accountId", "groupId"],
    ["account-1", "group-1"],
  ],
  [
    "zalo-accounts:group:update",
    ["accountId", "groupId"],
    ["account-1", "group-1"],
  ],
] as const)("executes %s with its positional identifiers", async (name, paths, ids) => {
  const operation = tool(name, [...paths])
  const cli = yargs([...name.split(":"), ...ids, "--enabled", "true"])
    .exitProcess(false)
    .strict()
  registerToolCommands(cli, [operation], config)
  await cli.parseAsync()
  expect(executeDynamicCommand).toHaveBeenCalledExactlyOnceWith(
    operation,
    {
      ...Object.fromEntries(paths.map((path, i) => [path, ids[i]])),
      enabled: "true",
    },
    config,
  )
})
