import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrdersService, type CreateOrderInput } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private service: OrdersService) {}

  @Post()
  create(@Body() body: CreateOrderInput, @Req() req: AuthedRequest) {
    // userId from the body is intentionally ignored — sender is the JWT viewer.
    return this.service.create(body, req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.findOne(id, req.user.userId);
  }
}
