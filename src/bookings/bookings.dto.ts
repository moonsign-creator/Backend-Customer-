import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Mode, Service } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class CreateBookingDto {
  @ApiProperty() @IsUUID() profileId: string;
  @ApiProperty({ enum: Mode }) @IsEnum(Mode) mode: Mode;
  @ApiProperty({ example: '2026-11-28T10:30:00.000Z', description: 'Start of an hourly IST block from GET /bookings/slots' })
  @IsDateString()
  slotStart: string;
  @ApiPropertyOptional({ description: '"Consult again" with the same astrologer' }) @IsOptional() @IsUUID() practitionerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) category?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(300, { each: true }) questions?: string[];
  @ApiPropertyOptional({ description: 'Free text / voice-to-text note' }) @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class RescheduleDto {
  @ApiProperty() @IsDateString() slotStart: string;
}

export class RateDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) rating: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) feedback?: string;
}

export class SlotsQuery {
  @ApiPropertyOptional({ enum: Service, default: 'astrology' }) @IsOptional() @IsEnum(Service) service?: Service;
  @ApiPropertyOptional() @IsOptional() @IsUUID() practitionerId?: string;
}
