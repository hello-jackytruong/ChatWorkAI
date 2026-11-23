#!/usr/bin/env node
import type { Argv } from "yargs"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import packageJson from "../package.json"
import { registerToolCommands } from "./command-registration"
import { setConfig } from "./commands/config"
import type { ConfigOptions } from "./config"
import { getConfig } from "./config"
import { loadOpenApiSpecForCli } from "./openapi-loader"

const registerConfigCommand = (cli: ReturnType<typeof yargs>): void => {
  cli.command(
    "config",
    "Configuration commands",
    (configCli: Argv<ConfigOptions>) =>
      configCli
        .command(
          "set",
          "Set or update API key and API URL",
          (setCli: Argv<ConfigOptions>) =>
            setCli
              .option("apiKey", {
                describe: "ChatWorkAI API key",
                type: "string",
              })
              .option("apiUrl", {
                describe: "ChatWorkAI API URL",
                type: "string",
              })
              .option("allowSelfSignedCert", {
                describe: "Disable TLS cert validation (local dev only)",
                type: "boolean",
              }),
          (argv) => {
            setConfig(argv as Parameters<typeof setConfig>[0] & ConfigOptions)
          },
        )
        .demandCommand(1, "You need at least one action"),
  )
}

const main = async (): Promise<void> => {
  const cli = yargs(hideBin(process.argv))
    .scriptName("chatbotx")
    .usage("$0 <group> <action> [options]")
    .option("apiKey", {
      describe: "ChatWorkAI API key (global)",
      type: "string",
      global: true,
    })
    .option("apiUrl", {
      describe: "ChatWorkAI API URL (global)",
      type: "string",
      global: true,
    })
    .option("allowSelfSignedCert", {
      describe: "Disable TLS cert validation (local dev only)",
      type: "boolean",
      global: true,
    })
    .option("refresh-spec", {
      describe: "Force refresh the cached OpenAPI spec",
      type: "boolean",
      global: true,
      default: false,
    })

  registerConfigCommand(cli)

  // Read flags directly from process.argv to avoid a second yargs instance
  // that would intercept --help and exit before commands are registered.
  const rawArgs = process.argv.slice(2)
  const readFlag = (name: string): string | undefined => {
    const idx = rawArgs.indexOf(`--${name}`)
    return idx !== -1 && idx + 1 < rawArgs.length ? rawArgs[idx + 1] : undefined
  }
  const configOverrides: ConfigOptions = {
    apiKey: readFlag("apiKey"),
    apiUrl: readFlag("apiUrl"),
  }
  const forceRefresh = rawArgs.includes("--refresh-spec")

  let config: { apiKey: string; apiUrl: string }
  try {
    config = getConfig(configOverrides)
  } catch {
    // Config not set yet — only config command will work
    await cli
      .demandCommand(1, "You need at least one command")
      .help()
      .alias("h", "help")
      .version(packageJson.version)
      .alias("v", "version")
      .parseAsync()
    return
  }

  const tools = await loadOpenApiSpecForCli(config.apiUrl, forceRefresh)
  registerToolCommands(cli, tools, config)

  await cli
    .demandCommand(1, "You need at least one command")
    .help()
    .alias("h", "help")
    .version(packageJson.version)
    .alias("v", "version")
    .parseAsync()
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown CLI error"
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
