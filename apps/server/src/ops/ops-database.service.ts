import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { OpsPg, type ProbeResult } from '@gain-saas/ops-pg';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/** 运营域引擎库连接(app/owner 双池);未配置时运营域整体 503。 */
@Injectable()
export class OpsDatabase {
  private client?: OpsPg;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.OPS_APP_DATABASE_URL) {
      this.client = new OpsPg({
        APP_DATABASE_URL: config.OPS_APP_DATABASE_URL,
        OWNER_DATABASE_URL: config.OPS_OWNER_DATABASE_URL,
      });
    }
  }

  get db(): OpsPg {
    if (!this.client) {
      throw new ServiceUnavailableException({
        error: { code: 'OPS_NOT_CONFIGURED', message: '未配置 OPS_APP_DATABASE_URL,运营域不可用' },
      });
    }
    return this.client;
  }

  async ready(): Promise<ProbeResult> {
    const db = this.db;
    return db.probe ?? db.start();
  }

  async writable(): Promise<OpsPg> {
    const db = this.db;
    const probe = await this.ready();
    if (!probe.ok) {
      throw new ServiceUnavailableException({
        error: { code: 'OPS_SCHEMA_DRIFT', message: `运营域 schema 漂移:${probe.missing.join(';')}` },
      });
    }
    db.assertWritable();
    return db;
  }
}
