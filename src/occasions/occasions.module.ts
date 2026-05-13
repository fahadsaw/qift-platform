import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksModule } from '../blocks/blocks.module';
import { OccasionsService } from './occasions.service';
import {
  OccasionsController,
  UserOccasionsController,
} from './occasions.controller';

@Module({
  imports: [BlocksModule],
  controllers: [OccasionsController, UserOccasionsController],
  providers: [OccasionsService, PrismaService],
  exports: [OccasionsService],
})
export class OccasionsModule {}
