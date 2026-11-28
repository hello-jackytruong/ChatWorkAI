import { zaloAccountAlbumSchema } from "@chatbotx.io/sdk"
import {
  asNonEmptyString,
  asObject,
  parseObject,
  providerNumber,
} from "./provider-content"

const consistentValue = <T>(
  sources: Record<string, unknown>[],
  key: string,
  normalize: (input: unknown) => T | undefined,
): T | undefined => {
  let result: T | undefined
  for (const source of sources) {
    if (source[key] === undefined) {
      continue
    }
    const value = normalize(source[key])
    if (value === undefined || (result !== undefined && result !== value)) {
      return
    }
    result = value
  }
  return result
}

export const readProviderAlbum = (
  data: Record<string, unknown> | undefined,
  photo: Record<string, unknown>,
) => {
  const extension = parseObject(asObject(data?.propertyExt)?.ext)
  const params = parseObject(photo.params) ?? parseObject(photo.param)
  const sources = [data, photo, params, extension].flatMap((source) =>
    source
      ? [
          source,
          parseObject(source.groupMediaMsg),
          parseObject(parseObject(source.extMsgProp)?.groupMediaMsg),
        ].filter(
          (entry): entry is Record<string, unknown> => entry !== undefined,
        )
      : [],
  )
  const layoutId = consistentValue(sources, "groupLayoutId", (value) =>
    asNonEmptyString(value, 200),
  )
  const index = consistentValue(sources, "idInGroup", (value) =>
    providerNumber(value, 0),
  )
  const itemCount = consistentValue(sources, "totalItemInGroup", (value) =>
    providerNumber(value, 2),
  )
  const parsed = zaloAccountAlbumSchema.safeParse({
    layoutId,
    index,
    itemCount,
  })
  return parsed.success ? parsed.data : undefined
}
