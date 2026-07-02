import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// Exported so any feature module can record audit rows by adding
// `imports: [AuditModule]` — same single-instance pattern as
// UsersModule / OtpModule.
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
