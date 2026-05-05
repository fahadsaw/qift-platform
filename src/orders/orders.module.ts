import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { ProductsModule } from '../products/products.module';

// UsersService is registered here (in addition to AppModule) so we can
// inject it into OrdersService for the fast-delivery `canDeliverFast`
// check. ProductsModule is imported (not provider-listed) so its
// instance is shared with the rest of the app.
@Module({
  imports: [ProductsModule],
  controllers: [OrdersController],
  providers: [OrdersService, PrismaService, UsersService],
  exports: [OrdersService],
})
export class OrdersModule {}
