import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({ example: '9876543210', description: '10-digit Indian mobile number' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit mobile number' })
  phone: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @ApiProperty({ example: '123456' })
  @Length(6, 6)
  code: string;

  @ApiProperty({ required: false, enum: ['en', 'hi'] })
  @IsOptional()
  @IsIn(['en', 'hi'])
  lang?: 'en' | 'hi';
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken: string;
}
