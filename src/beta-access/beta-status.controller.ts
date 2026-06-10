import { Controller, Get } from '@nestjs/common';
import { BetaAccessService } from './beta-access.service';

// PUBLIC gate-status probe (PR 8 — beta onboarding UX).
//
// GET /beta/status → { gateEnabled: boolean }
//
// Unauthenticated on purpose: the register page reads this on mount
// to surface the invite-code field as REQUIRED before the user fills
// the whole form and burns an OTP — previously a gated visitor only
// learned about the gate from the 403 at the very end of the flow.
//
// This reveals nothing sensitive. The gate state is already publicly
// observable (any registration attempt without a code returns
// beta_required when the gate is on), and the response carries no
// codes, no allowlist data, no counts — just the boolean. The
// admin-only management surface stays on /admin/beta/* behind the
// triple guard.
@Controller('beta')
export class BetaStatusController {
  constructor(private beta: BetaAccessService) {}

  @Get('status')
  status(): { gateEnabled: boolean } {
    return this.beta.getStatus();
  }
}
