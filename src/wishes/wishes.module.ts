import { Module } from '@nestjs/common';
import { WishesController } from './wishes.controller';
import { WishesService } from './wishes.service';

@Module({
  controllers: [WishesController],
  providers: [WishesService],
})
export class WishesModule {}
