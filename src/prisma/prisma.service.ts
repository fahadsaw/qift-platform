import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// The single, application-wide Prisma client. Provided once by the
// global PrismaModule and injected everywhere, so the process holds
// exactly one PrismaClient — and therefore one connection pool —
// instead of one per feature module.
//
// Connection stays lazy (PrismaClient connects on first query), so boot
// behaviour is unchanged. Only the graceful-shutdown path is added.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  // Close the pool cleanly on shutdown. Paired with
  // app.enableShutdownHooks() in main.ts so this also fires on SIGTERM
  // (e.g. a Railway redeploy), not only on an explicit app.close().
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
