import { Body, Controller, Get, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export const TICKET_CATEGORIES = ['Billing', 'Session', 'Booking', 'Reports', 'App', 'Other'];

class CreateTicketDto {
  @ApiProperty() @IsString() @Length(3, 120) subject: string;
  @ApiProperty({ enum: TICKET_CATEGORIES }) @IsIn(TICKET_CATEGORIES) category: string;
  @ApiProperty() @IsString() @Length(5, 4000) message: string;
}

@ApiTags('support')
@ApiBearerAuth()
@Controller('support/tickets')
class SupportController {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.prisma.supportTicket.findMany({ where: { userId: u.sub }, orderBy: { createdAt: 'desc' } });
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateTicketDto) {
    const t = await this.prisma.supportTicket.create({ data: { ...dto, userId: u.sub } });
    await this.notifications.notify(u.sub, 'support', 'ticket_created', { subject: dto.subject }, { ticketId: t.id });
    return t;
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const t = await this.prisma.supportTicket.findFirst({ where: { id, userId: u.sub } });
    if (!t) throw new NotFoundException('Ticket not found');
    return t;
  }
}

@Module({ controllers: [SupportController] })
export class SupportModule {}
