import { Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Relation } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';

export class CreateProfileDto {
  @ApiProperty({ example: 'Rahul Verma' })
  @IsString()
  @Length(2, 80)
  name: string;

  @ApiProperty({ enum: Relation })
  @IsEnum(Relation)
  relation: Relation;

  @ApiProperty({ example: '1990-08-14' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dob: string;

  @ApiProperty({ example: '06:45', description: '24h time of birth' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  tob: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tobApproximate?: boolean;

  @ApiProperty({ example: 'Lucknow, Uttar Pradesh' })
  @IsString()
  @Length(2, 120)
  place: string;
}
export class UpdateProfileDto extends PartialType(CreateProfileDto) {}

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.profile.findMany({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  }

  /** Throws unless the profile belongs to the user. */
  async own(userId: string, id: string) {
    const p = await this.prisma.profile.findFirst({ where: { id, userId, deletedAt: null } });
    if (!p) throw new NotFoundException('Profile not found');
    return p;
  }
}

@ApiTags('profiles')
@ApiBearerAuth()
@Controller('profiles')
class ProfilesController {
  constructor(private readonly prisma: PrismaService, private readonly svc: ProfilesService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.sub);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateProfileDto) {
    return this.prisma.profile.create({ data: { ...dto, userId: u.sub } });
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.own(u.sub, id);
  }

  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProfileDto) {
    await this.svc.own(u.sub, id);
    return this.prisma.profile.update({ where: { id }, data: dto });
  }

  /** Soft delete so past bookings and history keep their profile. */
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.own(u.sub, id);
    await this.prisma.profile.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }
}

@Module({ controllers: [ProfilesController], providers: [ProfilesService], exports: [ProfilesService] })
export class ProfilesModule {}
