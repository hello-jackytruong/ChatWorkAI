import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"
export const zaloAccountMediaRelations = defineRelationsPart(schema, (r) => ({
  zaloAccountMediaAssetModel: {
    references: r.many.zaloAccountMediaReferenceModel({
      from: r.zaloAccountMediaAssetModel.id,
      to: r.zaloAccountMediaReferenceModel.assetId,
    }),
  },
  zaloAccountMediaReferenceModel: {
    asset: r.one.zaloAccountMediaAssetModel({
      from: r.zaloAccountMediaReferenceModel.assetId,
      to: r.zaloAccountMediaAssetModel.id,
    }),
  },
}))
