import type { Argv } from "yargs"
import { collectCliParams, registerActionArgs } from "./command-args"
import { executeDynamicCommand } from "./dynamic-executor"
import type { DynamicTool } from "./openapi-loader"

type Config = { apiKey: string; apiUrl: string }
type Group = {
  root?: DynamicTool
  actions: Record<string, DynamicTool>
  subgroups: Record<string, Record<string, DynamicTool>>
}

const registerTool = (
  cli: Argv,
  name: string,
  tool: DynamicTool,
  config: Config,
): void => {
  const positionals = tool.pathParamNames.map((param) => `<${param}>`).join(" ")
  cli.command(
    positionals ? `${name} ${positionals}` : name,
    tool.description,
    (actionCli: Argv) => registerActionArgs(actionCli, tool),
    async (argv) => {
      await executeDynamicCommand(
        tool,
        collectCliParams(tool, argv as Record<string, unknown>),
        config,
      )
    },
  )
}

export const registerToolCommands = (
  cli: Argv,
  tools: DynamicTool[],
  config: Config,
): void => {
  const groups: Record<string, Group> = {}
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.commandName)) {
      process.stderr.write(
        `Warning: duplicate command name "${tool.commandName}" — skipping\n`,
      )
      continue
    }
    seen.add(tool.commandName)
    const [name, ...parts] = tool.commandName.split(":")
    groups[name] ??= { actions: {}, subgroups: {} }
    const group = groups[name]
    if (parts.length === 0) {
      group.root = tool
    } else if (parts.length === 2) {
      const [subgroup, action] = parts
      group.subgroups[subgroup] ??= {}
      const actions = group.subgroups[subgroup]
      actions[action] = tool
    } else {
      group.actions[parts.join(":")] = tool
    }
  }
  const registerActions = (
    target: Argv,
    actions: Record<string, DynamicTool>,
  ): void => {
    for (const [name, tool] of Object.entries(actions)) {
      registerTool(target, name, tool, config)
    }
  }
  for (const [name, group] of Object.entries(groups)) {
    if (group.root) {
      if (
        Object.keys(group.actions).length ||
        Object.keys(group.subgroups).length
      ) {
        throw new Error(
          `Command "${name}" cannot be both an operation and a command group`,
        )
      }
      registerTool(cli, name, group.root, config)
      continue
    }
    cli.command(name, `${name} commands`, (groupCli: Argv) => {
      registerActions(groupCli, group.actions)
      for (const [subgroup, actions] of Object.entries(group.subgroups)) {
        groupCli.command(
          subgroup,
          `${subgroup} commands`,
          (subgroupCli: Argv) => {
            registerActions(subgroupCli, actions)
            return subgroupCli.demandCommand(1, "You need at least one action")
          },
        )
      }
      return groupCli.demandCommand(1, "You need at least one action")
    })
  }
}
