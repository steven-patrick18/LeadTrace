import { Body, Controller, Post } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { SearchService } from './search.service';

class SearchDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  zip?: string;
}

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @RequirePermission('search_providers')
  @Post()
  searchPerson(@Body() dto: SearchDto, @CurrentUser() user: AuthUser) {
    return this.search.searchPerson(dto, user.id);
  }
}
