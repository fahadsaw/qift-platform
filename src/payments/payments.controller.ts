import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private service: PaymentsService) {}

  @Post('mock/confirm')
  confirmMock(@Body() body: { orderId?: string }, @Req() req: AuthedRequest) {
    return this.service.confirmMock(body.orderId ?? '', req.user.userId);
  }
}
