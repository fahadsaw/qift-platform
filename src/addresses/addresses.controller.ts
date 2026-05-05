import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AddressesService, type AddressInput } from './addresses.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Every address route requires a valid JWT and ownership is enforced in the
// service layer. We expose `me` as a convenience for the logged-in viewer
// so the UI doesn't have to thread its own userId through.
@Controller('addresses')
@UseGuards(JwtAuthGuard)
export class AddressesController {
  constructor(private service: AddressesService) {}

  @Post()
  create(@Body() body: AddressInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user.userId, body);
  }

  @Get('me')
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user.userId);
  }

  @Get(':userId')
  findByUser(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.service.findByUser(req.user.userId, userId);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: AddressInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.update(req.user.userId, id, body);
  }

  @Patch(':id/default')
  setDefault(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.setDefault(req.user.userId, id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.remove(req.user.userId, id);
  }
}
