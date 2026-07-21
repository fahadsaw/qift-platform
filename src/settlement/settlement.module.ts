// Settlement Engine Foundation module (Track C PR 1).
// Consumers arrive with later PRs (receipts, execution, ops screens);
// the foundation registers the engine so SETTLE-1/2's RBAC-guarded
// surfaces can inject it. PrismaModule is @Global — not re-imported.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FinancialLedgerModule } from '../financial/financial-ledger.module';
import { SettlementEngineService } from './settlement-engine.service';
import { SettlementReceiptsService } from './settlement-receipts.service';
import { SettlementEligibilityService } from './settlement-eligibility.service';
import { SETTLEMENT_CLOCK, SystemSettlementClock } from './settlement-clock';

@Module({
  imports: [AuditModule, FinancialLedgerModule],
  providers: [
    SettlementEngineService,
    SettlementReceiptsService,
    SettlementEligibilityService,
    // Rule 2: the ONLY binding of real system time into settlement.
    { provide: SETTLEMENT_CLOCK, useClass: SystemSettlementClock },
  ],
  exports: [
    SettlementEngineService,
    SettlementReceiptsService,
    SettlementEligibilityService,
  ],
})
export class SettlementModule {}
