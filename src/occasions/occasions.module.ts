import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { OccasionsService } from './occasions.service';
import {
  OccasionsController,
  UserOccasionsController,
} from './occasions.controller';

@Module({
  imports: [BlocksModule],
  controllers: [OccasionsController, UserOccasionsController],
  providers: [OccasionsService],
  exports: [OccasionsService],
})
export class OccasionsModule {}
