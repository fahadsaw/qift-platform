import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  ProductsService,
  type CreateProductInput,
  type UpdateProductInput,
} from './products.service';

type AuthedRequest = { user?: { userId: string; qiftUsername: string } };

// List + detail are public (storefront browsing). Mutations require a
// JWT and re-check store ownership in the service layer.
@Controller('products')
export class ProductsController {
  constructor(private service: ProductsService) {}

  // GET /products?storeId=...&includeUnavailable=true
  // The flag is a string ("true"/"false") because of how Express parses
  // query params; we coerce here. Default = false so the public storefront
  // never accidentally surfaces an out-of-stock product.
  @Get()
  list(
    @Query('storeId') storeId: string,
    @Query('includeUnavailable') includeUnavailable?: string,
  ) {
    return this.service.list(storeId ?? '', {
      includeUnavailable: includeUnavailable === 'true',
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() body: CreateProductInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user!.userId, body);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @Body() body: UpdateProductInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.update(req.user!.userId, id, body);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.remove(req.user!.userId, id);
  }
}
