import { Body, Controller, Post } from '@nestjs/common';
import {
  OtpService,
  type SendOtpInput,
  type VerifyOtpInput,
} from './otp.service';

// Public — these endpoints run during register/login before any JWT exists.
@Controller('otp')
export class OtpController {
  constructor(private service: OtpService) {}

  @Post('send')
  send(@Body() body: SendOtpInput) {
    return this.service.send(body);
  }

  @Post('verify')
  verify(@Body() body: VerifyOtpInput) {
    return this.service.verify(body);
  }
}
