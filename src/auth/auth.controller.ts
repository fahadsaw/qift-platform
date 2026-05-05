import { Controller, Post, Body } from '@nestjs/common';
import {
  AuthService,
  type LoginInput,
  type RegisterInput,
} from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private service: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterInput) {
    return this.service.register(body);
  }

  @Post('login')
  login(@Body() body: LoginInput) {
    return this.service.login(body);
  }
}
