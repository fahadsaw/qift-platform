import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { UsersModule } from './users/users.module';
import { SocialAccountsModule } from './social-accounts/social-accounts.module';
import { AddressesModule } from './addresses/addresses.module';
import { GiftsModule } from './gifts/gifts.module';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { OtpModule } from './otp/otp.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StoreModule } from './store/store.module';
import { StoresModule } from './stores/stores.module';
import { ProductsModule } from './products/products.module';
import { StoreIntegrationsModule } from './store-integrations/store-integrations.module';
import { PushModule } from './push/push.module';
import { FollowsModule } from './follows/follows.module';
import { WishesModule } from './wishes/wishes.module';
import { BlocksModule } from './blocks/blocks.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    UsersModule,
    SocialAccountsModule,
    AddressesModule,
    GiftsModule,
    AuthModule,
    OrdersModule,
    PaymentsModule,
    OtpModule,
    NotificationsModule,
    StoreModule,
    StoresModule,
    ProductsModule,
    StoreIntegrationsModule,
    PushModule,
    FollowsModule,
    WishesModule,
    BlocksModule,
    ReportsModule,
  ],
  // UsersController + UsersService now live inside UsersModule —
  // imported above. Registering them here would create a duplicate
  // controller binding and a duplicate service instance. AppController
  // (the / and /health routes) stays here because there's no
  // dedicated module for it.
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
