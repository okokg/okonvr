/**
 * Dahua RPC2 client — two-phase MD5 authentication.
 * Reverse-engineered from NVR5216-EI web GUI.
 * Used for SmdDataFinder (smart motion detection event archive).
 */

import crypto from 'crypto';

export interface DahuaRpcConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SmdEvent {
  channel: number;
  startTime: string;  // "2026-03-26 04:01:37"
  endTime: string;
  type: 'human' | 'vehicle';
}

export class DahuaRpc {
  private base: string;
  private username: string;
  private password: string;
  private session: string | null = null;
  private seq = 0;

  constructor(config: DahuaRpcConfig) {
    this.base = `http://${config.host}:${config.port || 80}`;
    this.username = config.username;
    this.password = config.password;
  }

  private async rpc(method: string, params?: any, url?: string): Promise<any> {
    this.seq++;
    const data: any = { method, id: this.seq };
    if (params) data.params = params;
    if (this.session) data.session = this.session;

    const res = await fetch(url || `${this.base}/RPC2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    return res.json();
  }

  /** Two-phase MD5 login. Returns true on success. */
  async login(): Promise<boolean> {
    try {
      // Phase 1: get realm + random
      const r1 = await this.rpc('global.login', {
        userName: this.username,
        password: '',
        clientType: 'Web3.0',
      }, `${this.base}/RPC2_Login`);

      if (!r1.session) return false;
      this.session = r1.session;

      const realm = r1.params?.realm;
      const random = r1.params?.random;
      if (!realm || !random) return false;

      // Phase 2: MD5 hash
      const pwdHash = crypto.createHash('md5')
        .update(`${this.username}:${realm}:${this.password}`)
        .digest('hex').toUpperCase();
      const passHash = crypto.createHash('md5')
        .update(`${this.username}:${random}:${pwdHash}`)
        .digest('hex').toUpperCase();

      const r2 = await this.rpc('global.login', {
        userName: this.username,
        password: passHash,
        clientType: 'Web3.0',
        authorityType: 'Default',
      }, `${this.base}/RPC2_Login`);

      if (!r2.result) {
        this.session = null;
        return false;
      }
      // Session may change after second login
      if (r2.session) this.session = r2.session;
      return true;
    } catch (e: any) {
      console.error(`[dahua-rpc] Login failed: ${e.message}`);
      this.session = null;
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.session) await this.rpc('global.logout');
    } catch {} finally {
      this.session = null;
    }
  }

  /**
   * Query SMD (Smart Motion Detection) events from NVR archive.
   * Uses SmdDataFinder singleton API.
   *
   * @param channel - 0-based channel index, or -1 for all channels
   * @param date - "YYYY-MM-DD"
   * @returns Array of SmdEvent
   */
  async querySmdEvents(channel: number, date: string): Promise<SmdEvent[]> {
    if (!this.session) {
      const ok = await this.login();
      if (!ok) throw new Error('RPC2 login failed');
    }

    try {
      // startFind
      const r1 = await this.rpc('SmdDataFinder.startFind', {
        Condition: {
          StartTime: `${date} 00:00:00`,
          EndTime: `${date} 23:59:59`,
          Order: 'ascOrder',
          SmdType: ['smdTypeHuman', 'smdTypeVehicle'],
          Channel: channel,
        },
      });

      if (!r1.result) {
        // Session expired? Try re-login once
        if (r1.error?.code === 287637505) {
          this.session = null;
          const ok = await this.login();
          if (!ok) throw new Error('Re-login failed');
          return this.querySmdEvents(channel, date);
        }
        throw new Error(`startFind failed: ${JSON.stringify(r1.error)}`);
      }

      const token = r1.params?.Token;
      const totalCount = r1.params?.Count || 0;

      if (totalCount === 0) {
        await this.rpc('SmdDataFinder.stopFind', { Token: token });
        return [];
      }

      // doFind (paginate)
      const events: SmdEvent[] = [];
      let offset = 0;
      const PAGE = 100;

      while (offset < totalCount) {
        const r2 = await this.rpc('SmdDataFinder.doFind', {
          Token: token,
          Offset: offset,
          Count: PAGE,
        });

        const items = r2.params?.SmdInfo || [];
        if (items.length === 0) break;

        for (const item of items) {
          const rawType: string = item.Type || '';
          events.push({
            channel: item.Channel,
            startTime: item.StartTime,
            endTime: item.EndTime,
            type: rawType.includes('Human') ? 'human' : 'vehicle',
          });
        }
        offset += items.length;
      }

      // stopFind
      await this.rpc('SmdDataFinder.stopFind', { Token: token });

      return events;
    } catch (e: any) {
      // Try to stop any active finder
      try { await this.rpc('SmdDataFinder.stopFind', { Token: 0 }); } catch {}
      throw e;
    }
  }
}
