import { isEnterprise } from "../../keys"

// TODO: Re-enable license enforcement after the license API is ready and
// production QC is complete: set this to false, then rebuild and redeploy.
// This temporarily bypasses Enterprise startup, feature/limit checks and refresh.
const ENTERPRISE_QC_LICENSE_BYPASS_ENABLED = true

export const isEnterpriseQcLicenseBypassEnabled = (): boolean =>
  ENTERPRISE_QC_LICENSE_BYPASS_ENABLED && isEnterprise()
