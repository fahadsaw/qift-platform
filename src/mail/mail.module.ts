import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

// Marked @Global so any module can inject MailService without an
// explicit import — keeps the wiring lightweight as more callers
// (orders, gifts, store, auth, password-reset, …) start sending
// transactional emails. Single shared instance means the lazy
// Resend client init runs once per process.
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
