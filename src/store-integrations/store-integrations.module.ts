import { Module } from '@nestjs/common';
import { StoreIntegrationsController } from './store-integrations.controller';
import { StoreIntegrationsService } from './store-integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [StoresModule],
  controllers: [StoreIntegrationsController],
  providers: [StoreIntegrationsService, PrismaService],
})
export class StoreIntegrationsModule {}
