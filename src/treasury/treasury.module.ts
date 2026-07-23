// Treasury module (Lane 2 PR 1) — three-way reconciliation surface.
// READ-ONLY over money: no ledger producer lives here.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FinancialLedgerModule } from '../financial/financial-ledger.module';
import { SettlementModule } from '../settlement/settlement.module';
import { TreasuryReconciliationService } from './treasury-reconciliation.service';
import { TreasuryInternalTransferService } from './treasury-internal-transfer.service';

@Module({
  // SettlementModule is imported ONLY for the SETTLEMENT_CLOCK token —
  // one system-time binding site platform-wide (RULE 2).
  imports: [AuditModule, FinancialLedgerModule, SettlementModule],
  providers: [TreasuryReconciliationService, TreasuryInternalTransferService],
  exports: [TreasuryReconciliationService, TreasuryInternalTransferService],
})
export class TreasuryModule {}
