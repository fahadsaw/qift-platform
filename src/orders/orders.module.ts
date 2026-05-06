import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';

// OrdersService injects UsersService for the fast-delivery
// `canDeliverFast` city-match check. We import UsersModule (which
// exports UsersService) rather than re-registering the provider — the
// previous "register UsersService here too" pattern broke after
// UsersService gained a BlocksService dependency in the
// prod-foundation PR: BlocksService wasn't visible inside this
// module's scope, so Nest crashed at boot trying to instantiate the
// duplicate UsersService. Importing UsersModule shares the AppModule
// instance and its full dependency graph.
//
// ProductsModule is imported (not provider-listed) for the same
// reason — share-don't-duplicate.
@Module({
  imports: [ProductsModule, UsersModule],
  controllers: [OrdersController],
  providers: [OrdersService, PrismaService],
  exports: [OrdersService],
})
export class OrdersModule {}
