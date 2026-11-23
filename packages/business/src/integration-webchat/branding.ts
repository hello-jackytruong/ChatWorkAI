import type { DatabaseClient } from "@chatbotx.io/database/client"
import type { WebchatPersistentMenu } from "@chatbotx.io/database/partials"
import { isCommunity } from "../keys"
import {
  BRANDING_TITLE,
  buildBrandingUrl,
  ensureBrandingMenuEntry,
} from "../platform/branding"
import { resolveWorkspaceAppUrl } from "../platform/settings"

/**
 * Community deployments keep exactly one "Built with" entry, last, on every
 * webchat persistent menu. The workspace app URL is only resolved on a
 * community deployment with a menu payload.
 */
export const brandWebchatMenus = async ({
  persistentMenus,
  workspaceId,
  tx,
}: {
  persistentMenus: WebchatPersistentMenu[] | undefined
  workspaceId: string
  tx?: DatabaseClient
}): Promise<WebchatPersistentMenu[] | undefined> => {
  if (!(isCommunity() && persistentMenus)) {
    return persistentMenus
  }

  const brandingUrl = buildBrandingUrl(
    await resolveWorkspaceAppUrl({ workspaceId, tx }),
    "webchat",
    true,
  )
  const isBrandingMenu = (menu: WebchatPersistentMenu) =>
    menu.type === "url" &&
    (menu.label === BRANDING_TITLE ||
      menu.label === "⚡ Built with chatbotx.io" ||
      menu.url === brandingUrl)
  const brandingMenuCount = persistentMenus.filter(isBrandingMenu).length
  const lastMenu = persistentMenus.at(-1)
  if (
    brandingMenuCount === 1 &&
    lastMenu?.type === "url" &&
    lastMenu.label === BRANDING_TITLE &&
    lastMenu.url === brandingUrl
  ) {
    return persistentMenus
  }

  const menus = persistentMenus.filter((menu) => !isBrandingMenu(menu))
  return ensureBrandingMenuEntry(menus, {
    label: BRANDING_TITLE,
    url: brandingUrl,
  })
}
