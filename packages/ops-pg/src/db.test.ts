import { describe, expect, it } from 'vitest';
import { diffSchema, OPS_WRITES, WriteNotAllowedError } from './index.js';

describe('diffSchema(fail-closed 探针核心)', () => {
  it('齐全时无缺失', () => {
    const missing = diffSchema(
      [{ table_name: 'workspace', column_name: 'id' }, { table_name: 'workspace', column_name: 'name' }],
      { workspace: ['id', 'name'] },
    );
    expect(missing).toEqual([]);
  });

  it('缺表、缺列分别报出', () => {
    const missing = diffSchema([{ table_name: 'workspace', column_name: 'id' }], {
      workspace: ['id', 'name'],
      data_provider: ['id'],
    });
    expect(missing).toEqual(['workspace 缺列 name', '缺表 data_provider']);
  });
});

describe('写语句白名单', () => {
  it('未登记的写操作直接拒绝(fail-closed)', () => {
    expect(() => OPS_WRITES.get('monitored_source.truncate_all')).toThrow(WriteNotAllowedError);
  });

  it('中台迁移的 5 条白名单全部登记', () => {
    const ids = OPS_WRITES.list().map((e) => e.id);
    expect(ids).toEqual([
      'monitored_source.upsert',
      'monitored_source.acquire_now',
      'monitored_source.status',
      'monitored_source.delete',
      'data_provider.status',
    ]);
  });
});
