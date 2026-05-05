import { Module } from '@nestjs/common';
import { WishesController } from './wishes.controller';
import { WishesService } from './wishes.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [WishesController],
  providers: [WishesService, PrismaService],
})
export class WishesModule {}
