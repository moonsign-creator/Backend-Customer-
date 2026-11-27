import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RazorpayClient } from './razorpay.client';
import { WalletService } from './wallet.service';

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet' };

/** UC-02 wallet top-up via Razorpay. Money is credited only once, by order id. */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger('Payments');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
    private readonly rzp: RazorpayClient,
    private readonly notifications: NotificationsService,
  ) {}

  async createTopup(userId: string, amount: number) {
    const s = await this.settings.get();
    if (!Number.isInteger(amount) || amount < s.minTopup) throw new BadRequestException(`Minimum top-up is ₹${s.minTopup}`);
    if (amount > 100_000) throw new BadRequestException('Maximum top-up is ₹1,00,000');
    const order = await this.rzp.createOrder(amount, `topup_${userId.slice(0, 8)}_${Date.now()}`);
    const p = await this.prisma.payment.create({ data: { userId, amount, providerOrderId: order.id } });
    return { paymentId: p.id, orderId: order.id, amount, amountPaise: order.amount, currency: 'INR', keyId: this.rzp.keyId || null, mock: this.rzp.isMock };
  }

  /**
   * Called by the app after Razorpay Checkout returns. If the signature checks
   * out the wallet is credited at once; otherwise the webhook may still confirm
   * it later (the app's "delayed confirmation" state).
   */
  async verify(userId: string, orderId: string, paymentId: string, signature: string, method?: string) {
    const p = await this.prisma.payment.findFirst({ where: { providerOrderId: orderId, userId } });
    if (!p) throw new NotFoundException('Payment not found');
    if (p.status === 'paid') return this.status(userId, orderId);
    if (this.rzp.isMock && signature === 'mock_failure') {
      await this.markFailed(orderId, 'Declined by bank (mock)');
      return this.status(userId, orderId);
    }
    if (this.rzp.isMock && signature === 'mock_pending') return this.status(userId, orderId);
    if (!this.rzp.verifyPayment(orderId, paymentId, signature)) throw new BadRequestException('Payment signature mismatch');
    await this.markPaid(orderId, paymentId, method);
    return this.status(userId, orderId);
  }

  async status(userId: string, orderId: string) {
    const p = await this.prisma.payment.findFirst({ where: { providerOrderId: orderId, userId } });
    if (!p) throw new NotFoundException('Payment not found');
    const w = await this.wallet.getWallet(userId);
    const state = p.status === 'paid' ? 'success' : p.status === 'failed' ? 'failed' : 'pending';
    return { orderId, amount: p.amount, status: state, failureReason: p.failureReason, balance: w.balance };
  }

  async handleWebhook(event: { event: string; payload?: { payment?: { entity?: Record<string, unknown> } } }) {
    const ent = event.payload?.payment?.entity ?? {};
    const orderId = ent.order_id as string | undefined;
    if (!orderId) return;
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      await this.markPaid(orderId, ent.id as string, ent.method as string);
    } else if (event.event === 'payment.failed') {
      await this.markFailed(orderId, (ent.error_description as string) || 'Payment failed');
    }
  }

  private async markPaid(orderId: string, providerPayId: string, method?: string) {
    const label = METHOD_LABEL[method ?? ''] ?? method ?? 'Razorpay';
    const done = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.findUnique({ where: { providerOrderId: orderId } });
      if (!p || p.status === 'paid') return null;
      await tx.payment.update({ where: { id: p.id }, data: { status: 'paid', providerPayId, method: label } });
      await this.wallet.credit({ userId: p.userId, amount: p.amount, reason: 'topup', label: `Added via ${label}`, method: label, reference: `topup:${orderId}` }, tx);
      return p;
    });
    if (done) {
      this.log.log(`Top-up ₹${done.amount} credited for ${done.userId}`);
      await this.notifications.notify(done.userId, 'wallet', 'money_added', { amount: done.amount });
    }
  }

  private async markFailed(orderId: string, reason: string) {
    const p = await this.prisma.payment.findUnique({ where: { providerOrderId: orderId } });
    if (!p || p.status !== 'created') return;
    await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'failed', failureReason: reason } });
    await this.notifications.notify(p.userId, 'wallet', 'payment_failed', { amount: p.amount });
  }
}
