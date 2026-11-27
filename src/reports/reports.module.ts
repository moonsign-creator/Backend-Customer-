import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfilesModule, ProfilesService } from '../profiles/profiles.module';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';

class OrderReportDto {
  @ApiProperty() @IsString() reportTypeId: string;
  @ApiProperty() @IsUUID() profileId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) questions?: string;
}

/** UC-09: one-time and monthly reports, paid from the wallet. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly profiles: ProfilesService,
    private readonly notifications: NotificationsService,
  ) {}

  async order(userId: string, dto: OrderReportDto) {
    const rt = await this.prisma.reportType.findFirst({ where: { id: dto.reportTypeId, active: true } });
    if (!rt) throw new NotFoundException('Report type not found');
    const profile = await this.profiles.own(userId, dto.profileId);
    const { available } = await this.wallet.available(userId);
    if (available < rt.price) {
      throw new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: `Please add money. This report costs ₹${rt.price}.`, required: rt.price, available, shortBy: rt.price - available });
    }
    const order = await this.prisma.$transaction(async (tx) => {
      const o = await tx.reportOrder.create({ data: { userId, profileId: profile.id, reportTypeId: rt.id, questions: dto.questions ?? '', amount: rt.price } });
      await this.wallet.debit({ userId, amount: rt.price, reason: 'report', label: `${rt.name}${rt.billing === 'monthly' ? ' (monthly)' : ''}`, reference: `report:${o.id}` }, tx);
      return o;
    });
    await this.notifications.notify(userId, 'report', 'report_ordered', { report: rt.name, name: profile.name }, { reportOrderId: order.id });
    return this.get(userId, order.id);
  }

  list(userId: string) {
    return this.prisma.reportOrder.findMany({
      where: { userId },
      include: { reportType: true, profile: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(userId: string, id: string) {
    const o = await this.prisma.reportOrder.findFirst({ where: { id, userId }, include: { reportType: true, profile: { select: { id: true, name: true } } } });
    if (!o) throw new NotFoundException('Report not found');
    return o;
  }
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.sub);
  }

  @Post()
  order(@CurrentUser() u: AuthUser, @Body() dto: OrderReportDto) {
    return this.svc.order(u.sub, dto);
  }

  /** Status, and `fileUrl` to read/download once ready. */
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(u.sub, id);
  }
}

@Module({ imports: [ProfilesModule, WalletModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
