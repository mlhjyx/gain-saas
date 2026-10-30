import type {
  RevocationBacklogProbe,
  RevocationConsumerFact,
  TemporalScheduleFact,
  TemporalScheduleProbe,
} from './platform-facts.service.js';

/**
 * 未接入时的占位探针：返回 null 表示「事实不可用」，控制器据此返回 503。
 * 真实探针（Temporal 平台集群 + 引擎库）在 P3c/P5 接入，需要平台客户端证书与撤销库。
 */
export class UnavailableTemporalScheduleProbe implements TemporalScheduleProbe {
  async read(_now: number): Promise<TemporalScheduleFact[] | null> {
    return null;
  }
}

export class UnavailableRevocationBacklogProbe implements RevocationBacklogProbe {
  async read(_now: number): Promise<RevocationConsumerFact[] | null> {
    return null;
  }
}
