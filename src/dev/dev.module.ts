import { Body, Controller, ForbiddenException, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { Public } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

class PractitionerTokenDto {
  @ApiProperty({ example: 'a1', description: 'Practitioner code from the seed (a1..a3, t1..t3)' })
  @IsString()
  code: string;
}
class ReportStatusDto {
  @ApiProperty({ enum: ['in_preparation', 'ready'] }) @IsIn(['in_preparation', 'ready']) status: 'in_preparation' | 'ready';
}

/**
 * Development helpers standing in for the practitioner web app and admin site,
 * which are separate projects. Disabled when NODE_ENV=production.
 */
@ApiTags('dev (non-production only)')
@Public()
@Controller('dev')
class DevController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  private guard() {
    if (this.config.get('NODE_ENV') === 'production') throw new ForbiddenException();
  }

  @Post('practitioner-token')
  async practitionerToken(@Body() dto: PractitionerTokenDto) {
    this.guard();
    const p = await this.prisma.practitioner.findUnique({ where: { code: dto.code } });
    if (!p) throw new NotFoundException();
    const accessToken = await this.jwt.signAsync({ sub: p.id, role: 'practitioner' }, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '12h' });
    return { practitioner: p, accessToken };
  }

  @Post('reports/:id/status')
  async reportStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportStatusDto) {
    this.guard();
    const o = await this.prisma.reportOrder.update({
      where: { id },
      data: { status: dto.status, fileUrl: dto.status === 'ready' ? `https://example.com/reports/${id}.pdf` : undefined },
      include: { reportType: true, profile: true },
    });
    if (dto.status === 'ready') await this.notifications.notify(o.userId, 'report', 'report_ready', { report: o.reportType.name, name: o.profile.name }, { reportOrderId: id });
    return o;
  }
}

@Module({ controllers: [DevController] })
export class DevModule {}
