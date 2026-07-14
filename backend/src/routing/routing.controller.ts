import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { TransferPoint } from '@prisma/client';
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { RoutingService } from './routing.service';

class RouteDto {
  @IsInt()
  toUserId!: number;
}

class BulkRouteDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  queueIds!: number[];

  @IsInt()
  toUserId!: number;
}

class NoteDto {
  @IsOptional()
  @IsString()
  note?: string;
}

class ReasonDto {
  @IsString()
  @MinLength(2)
  reason!: string;
}

class CloseDto extends NoteDto {
  @IsIn(['CLOSED_WON', 'CLOSED_LOST'])
  outcome!: 'CLOSED_WON' | 'CLOSED_LOST';
}

@Controller('routing')
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @RequirePermission('request_transfer')
  @Post('leads/:id/request-transfer')
  requestTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NoteDto,
    @Ip() ip: string,
  ) {
    return this.routing.requestTransfer(user, id, dto.note, ip);
  }

  @RequirePermission('close_deal')
  @Post('leads/:id/close')
  close(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CloseDto,
    @Ip() ip: string,
  ) {
    return this.routing.closeLead(user, id, dto.outcome, dto.note, ip);
  }

  @RequirePermission('send_back')
  @Post('leads/:id/send-back')
  sendBack(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReasonDto,
    @Ip() ip: string,
  ) {
    return this.routing.sendBack(user, id, dto.reason, ip);
  }

  @RequirePermission('route_leads')
  @Get('queue')
  queue() {
    return this.routing.queue();
  }

  @RequirePermission('route_leads')
  @Get('recipients')
  recipients(@Query('transferPoint') transferPoint: TransferPoint) {
    return this.routing.eligibleRecipients(transferPoint);
  }

  @RequirePermission('route_leads')
  @Post('queue/:id/route')
  route(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RouteDto,
    @Ip() ip: string,
  ) {
    return this.routing.route(user, id, dto.toUserId, ip);
  }

  @RequirePermission('route_leads')
  @Post('queue/bulk-route')
  bulkRoute(@CurrentUser() user: AuthUser, @Body() dto: BulkRouteDto, @Ip() ip: string) {
    return this.routing.bulkRoute(user, dto.queueIds, dto.toUserId, ip);
  }

  @RequirePermission('route_leads')
  @Post('leads/:id/reopen')
  reopen(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReasonDto,
    @Ip() ip: string,
  ) {
    return this.routing.reopen(user, id, dto.reason, ip);
  }
}
