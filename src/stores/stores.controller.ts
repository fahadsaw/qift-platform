import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  StoresService,
  type CreateStoreInput,
  type UpdateStoreInput,
} from './stores.service';

type AuthedRequest = { user?: { userId: string; qiftUsername: string } };

// Two route shapes:
//   - List + detail are public (anyone can browse the storefront).
//   - Create + update + listMine require a valid JWT.
// Each handler enforces the right gate inline so we don't accidentally
// inherit a wrong default at controller scope.
@Controller('stores')
export class StoresController {
  constructor(private service: StoresService) {}

  @Get()
  list() {
    return this.service.list();
  }

  // Stores owned by the JWT viewer. Comes BEFORE the :id route so Nest
  // doesn't try to bind "me" as the id param.
  @Get('me')
  @UseGuards(JwtAuthGuard)
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user!.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() body: CreateStoreInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user!.userId, body);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @Body() body: UpdateStoreInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.update(req.user!.userId, id, body);
  }
}
