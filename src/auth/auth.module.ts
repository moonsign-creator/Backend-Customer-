import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpProvider } from './otp.provider';

@Module({ controllers: [AuthController], providers: [AuthService, OtpProvider] })
export class AuthModule {}
