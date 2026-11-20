import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const integrationZaloAccountRelations = defineRelationsPart(
  schema,
  (r) => ({
    integrationZaloAccountModel: {
      workspace: r.one.workspaceModel({
        from: r.integrationZaloAccountModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      inbox: r.one.inboxModel({
        from: r.integrationZaloAccountModel.inboxId,
        to: r.inboxModel.id,
        optional: false,
      }),
      groups: r.many.integrationZaloAccountGroupModel({
        from: r.integrationZaloAccountModel.id,
        to: r.integrationZaloAccountGroupModel.accountId,
      }),
    },
    integrationZaloAccountGroupModel: {
      workspace: r.one.workspaceModel({
        from: r.integrationZaloAccountGroupModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.integrationZaloAccountGroupModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
    },
  }),
)
