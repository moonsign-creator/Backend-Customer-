import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Minimal Razorpay client (Orders API + signature checks).
 * Without keys it runs a mock gateway so the app's success / failure / delayed
 * flows can be exercised in development.
 */
@Injectable()
export class RazorpayClient {
  constructor(private readonly config: ConfigService) {}

  get keyId() {
    return this.config.get<string>('RAZORPAY_KEY_ID') || '';
  }
  get isMock() {
    return !this.keyId;
  }

  async createOrder(amountInr: number, receipt: string): Promise<{ id: string; amount: number; currency: string }> {
    if (this.isMock) return { id: `order_mock_${randomBytes(8).toString('hex')}`, amount: amountInr * 100, currency: 'INR' };
    const auth = Buffer.from(`${this.keyId}:${this.config.getOrThrow('RAZORPAY_KEY_SECRET')}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: amountInr * 100, currency: 'INR', receipt }),
    });
    if (!res.ok) throw new Error(`Razorpay order failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ id: string; amount: number; currency: string }>;
  }

  /** Checkout callback signature: HMAC_SHA256(order_id|payment_id, key_secret). */
  verifyPayment(orderId: string, paymentId: string, signature: string) {
    if (this.isMock) return signature === 'mock_success';
    const expected = createHmac('sha256', this.config.getOrThrow('RAZORPAY_KEY_SECRET')).update(`${orderId}|${paymentId}`).digest('hex');
    return safeEq(expected, signature);
  }

  verifyWebhook(rawBody: Buffer, signature: string) {
    const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    if (!secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEq(expected, signature);
  }
}

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b || '');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
