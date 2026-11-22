import { isEnterpriseQcLicenseBypassEnabled } from "../enterprise/license/qc-bypass"
import {
  getLicenseStatus,
  isLicenseEntitled,
} from "../enterprise/license/service"
import { ChatbotXException } from "../errors"
import { isCloud, isEnterprise } from "../keys"

/**
 * Whether the current edition unlocks branding, email templates, and platform
 * help links. Normal enforcement requires a valid license or its 7-day grace
 * period. Temporary Enterprise QC bypass is controlled in
 * enterprise/license/qc-bypass.ts.
 */
export const hasEnterpriseFeatures = async (): Promise<boolean> => {
  if (!(isCloud() || isEnterprise())) {
    return false
  }

  if (isEnterpriseQcLicenseBypassEnabled()) {
    return true
  }

  const license = await getLicenseStatus()
  return isLicenseEntitled(license.state)
}

export const enterpriseFeatureRequiredException = () =>
  new ChatbotXException(
    "This feature requires an enterprise license",
    "enterpriseFeatureRequired",
    403,
  )

/**
 * Server-side guard for enterprise-only mutations and queries. Throws a 403
 * ChatbotXException when the deployment has no valid license, so it works in
 * server actions, oRPC handlers, and plain queries alike.
 */
export const assertEnterpriseFeatures = async (): Promise<void> => {
  if (!(await hasEnterpriseFeatures())) {
    throw enterpriseFeatureRequiredException()
  }
}
