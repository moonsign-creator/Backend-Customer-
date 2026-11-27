import { Body, Controller, Get, Headers, HttpCode, Module, Param, Post, Query, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Request } from 'express';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { PaymentsService } from './payments.service';
import { RazorpayClient } from './razorpay.client';
import { WalletService } from './wallet.service';

class TopupDto {
  @ApiProperty({ example: 500 })
  @IsInt()
  @Min(1)
  amount: number;
}

class VerifyDto {
  @ApiProperty() @IsString() orderId: string;
  @ApiProperty() @IsString() paymentId: string;
  @ApiProperty({ description: 'razorpay_signature. In mock mode: mock_success | mock_failure | mock_pending' })
  @IsString()
  signature: string;
  @ApiPropertyOptional({ example: 'upi' }) @IsOptional() @IsString() method?: string;
}

@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
class WalletController {
  constructor(private readonly wallet: WalletService, private readonly payments: PaymentsService) {}

  @Get()
  summary(@CurrentUser() u: AuthUser) {
    return this.wallet.available(u.sub);
  }

  @Get('transactions')
  txns(@CurrentUser() u: AuthUser, @Query('cursor') cursor?: string) {
    return this.wallet.transactions(u.sub, cursor);
  }

  /** Step 1: create a Razorpay order; the app opens Checkout with it. */
  @Post('topups')
  topup(@CurrentUser() u: AuthUser, @Body() dto: TopupDto) {
    return this.payments.createTopup(u.sub, dto.amount);
  }

  /** Step 2: app sends Checkout's result. Returns success / failed / pending. */
  @Post('topups/verify')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Body() dto: VerifyDto) {
    return this.payments.verify(u.sub, dto.orderId, dto.paymentId, dto.signature, dto.method);
  }

  /** Poll while a payment is pending (delayed confirmation). */
  @Get('topups/:orderId')
  status(@CurrentUser() u: AuthUser, @Param('orderId') orderId: string) {
    return this.payments.status(u.sub, orderId);
  }
}

@ApiTags('webhooks')
@Public()
@Controller('webhooks')
class WebhooksController {
  constructor(private readonly payments: PaymentsService, private readonly rzp: RazorpayClient) {}

  @Post('razorpay')
  @HttpCode(200)
  async razorpay(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') sig: string) {
    if (!req.rawBody || !this.rzp.verifyWebhook(req.rawBody, sig)) throw new UnauthorizedException('Bad signature');
    await this.payments.handleWebhook(req.body);
    return { ok: true };
  }
}

@Module({
  controllers: [WalletController, WebhooksController],
  providers: [WalletService, PaymentsService, RazorpayClient],
  exports: [WalletService],
})
export class WalletModule {}
