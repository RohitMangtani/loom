import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const HIVE_DIR = join(HOME, ".hive");
const VAPID_PATH = join(HIVE_DIR, "vapid.json");
const SUBS_PATH = join(HIVE_DIR, "push-subs.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoredSub {
  sub: PushSubscription;
  addedAt: number;
  label?: string;
}

export class WebPushManager {
  private vapid: VapidKeys;
  private subs: StoredSub[] = [];

  constructor() {
    this.vapid = this.loadOrGenerateVapid();
    this.subs = this.loadSubs();

    webpush.setVapidDetails(
      "https://github.com/RohitMangtani/hive",
      this.vapid.publicKey,
      this.vapid.privateKey,
    );

    console.log(
      `  Web Push: ${this.subs.length} subscription(s), VAPID key ready`,
    );
  }

  getPublicKey(): string {
    return this.vapid.publicKey;
  }

  addSubscription(sub: PushSubscription, label?: string): void {
    // Deduplicate by endpoint
    this.subs = this.subs.filter((s) => s.sub.endpoint !== sub.endpoint);
    this.subs.push({ sub, addedAt: Date.now(), label });
    this.saveSubs();
    console.log(
      `[web-push] Subscription added (${label || "unknown"}) — total: ${this.subs.length}`,
    );
  }

  removeSubscription(endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.sub.endpoint !== endpoint);
    if (this.subs.length < before) {
      this.saveSubs();
      return true;
    }
    return false;
  }

  getSubscriptionCount(): number {
    return this.subs.length;
  }

  async sendToAll(
    title: string,
    body: string,
    options?: { tag?: string; data?: Record<string, unknown> },
  ): Promise<{ sent: number; failed: number }> {
    if (this.subs.length === 0) return { sent: 0, failed: 0 };

    const payload = JSON.stringify({
      title,
      body,
      tag: options?.tag,
      data: options?.data,
    });

    let sent = 0;
    let failed = 0;
    const expired: string[] = [];

    await Promise.allSettled(
      this.subs.map(async ({ sub }) => {
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Subscription expired or unsubscribed — remove it
            expired.push(sub.endpoint);
          }
          failed++;
        }
      }),
    );

    if (expired.length > 0) {
      this.subs = this.subs.filter((s) => !expired.includes(s.sub.endpoint));
      this.saveSubs();
      console.log(`[web-push] Pruned ${expired.length} expired subscription(s)`);
    }

    return { sent, failed };
  }

  private loadOrGenerateVapid(): VapidKeys {
    if (!existsSync(HIVE_DIR)) mkdirSync(HIVE_DIR, { recursive: true });

    if (existsSync(VAPID_PATH)) {
      try {
        return JSON.parse(readFileSync(VAPID_PATH, "utf-8"));
      } catch {
        // Corrupted — regenerate
      }
    }

    const keys = webpush.generateVAPIDKeys();
    const vapid: VapidKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    writeFileSync(VAPID_PATH, JSON.stringify(vapid, null, 2) + "\n");
    console.log(`  Generated new VAPID keys → ${VAPID_PATH}`);
    return vapid;
  }

  private loadSubs(): StoredSub[] {
    try {
      if (existsSync(SUBS_PATH)) {
        return JSON.parse(readFileSync(SUBS_PATH, "utf-8"));
      }
    } catch {
      /* corrupted — start fresh */
    }
    return [];
  }

  private saveSubs(): void {
    try {
      writeFileSync(SUBS_PATH, JSON.stringify(this.subs, null, 2) + "\n");
    } catch {
      /* non-critical */
    }
  }
}
