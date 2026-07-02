import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { GiftsModule } from '../gifts/gifts.module';
import { FinancialLedgerModule } from '../financial/financial-ledger.module';

@Module({
  // FinancialLedgerModule supplies FinancialLedgerService so the paid-
  // order path can post append-only ledger entries (PR 3).
  imports: [GiftsModule, FinancialLedgerModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
