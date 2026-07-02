import { Module } from '@nestjs/common';
import { FinancialLedgerService } from './financial-ledger.service';

// Financial ledger spine (PR 2). Provides + exports the append-only
// FinancialLedgerService so future producers (invoice / payout /
// settlement work) can inject it. PrismaService is supplied by the
// global PrismaModule. Registered in AppModule so the substrate is part
// of the app graph — but NO producer is wired in this PR (dark launch).
@Module({
  providers: [FinancialLedgerService],
  exports: [FinancialLedgerService],
})
export class FinancialLedgerModule {}
