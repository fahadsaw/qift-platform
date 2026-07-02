import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Global provider of the single application-wide PrismaService.
//
// Declared @Global() and imported exactly once (in AppModule), so every
// feature module resolves the SAME PrismaService instance without
// listing it in its own `providers`. Previously each module registered
// PrismaService locally, which — because a Nest provider is instantiated
// once per module scope — created one PrismaClient (and one connection
// pool) per module. Centralising it here collapses ~28 clients to one.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
