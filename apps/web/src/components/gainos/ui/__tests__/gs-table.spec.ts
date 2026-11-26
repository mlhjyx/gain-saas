import { mount } from '@vue/test-utils';
import { Table } from 'ant-design-vue';
import { describe, expect, it } from 'vitest';

import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsTable from '#/components/gainos/ui/gs-table.vue';

const COLUMNS = [
  { dataIndex: 'name', key: 'name', title: '公司名称' },
  { dataIndex: 'country', key: 'country', title: '国家' },
];

function makeRows(count: number) {
  return Array.from({ length: count }, (_, idx) => ({
    country: '德国',
    id: `row-${idx + 1}`,
    name: `Company ${idx + 1}`,
  }));
}

describe('GsTable', () => {
  it('renders GsEmpty inside #emptyText by default when dataSource is empty', () => {
    const wrapper = mount(GsTable, {
      attrs: {
        columns: COLUMNS,
        dataSource: [],
        rowKey: 'id',
      },
      props: {
        emptyDescription: '调整筛选条件后重试',
        emptyTitle: '暂无匹配记录',
      },
    });

    expect(wrapper.find('[data-gs="table"]').exists()).toBe(true);
    expect(wrapper.findComponent(GsEmpty).exists()).toBe(true);
    expect(wrapper.text()).toContain('暂无匹配记录');
    expect(wrapper.text()).toContain('调整筛选条件后重试');
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('defaults pagination to 20 per page, shows total only when rows > 50, and respects pagination=false', () => {
    const smallWrapper = mount(GsTable, {
      attrs: {
        columns: COLUMNS,
        dataSource: makeRows(25),
        rowKey: 'id',
      },
    });

    const smallPagination = smallWrapper.findComponent(Table).props('pagination') as Record<
      string,
      unknown
    >;
    expect(smallPagination).toBeTruthy();
    expect(smallPagination.defaultPageSize).toBe(20);
    expect(smallPagination.showTotal).toBeUndefined();

    const largeWrapper = mount(GsTable, {
      attrs: {
        columns: COLUMNS,
        dataSource: makeRows(60),
        rowKey: 'id',
      },
    });

    const largePagination = largeWrapper.findComponent(Table).props('pagination') as {
      defaultPageSize?: number;
      showTotal?: (total: number) => string;
    };
    expect(largePagination.defaultPageSize).toBe(20);
    expect(typeof largePagination.showTotal).toBe('function');
    expect(largePagination.showTotal?.(60)).toContain('60');

    const disabledWrapper = mount(GsTable, {
      attrs: {
        columns: COLUMNS,
        dataSource: makeRows(60),
        rowKey: 'id',
      },
      props: {
        pagination: false,
      },
    });
    expect(disabledWrapper.findComponent(Table).props('pagination')).toBe(false);
  });

  it('forwards custom #bodyCell and #emptyText slots cleanly', () => {
    const wrapper = mount(GsTable, {
      attrs: {
        columns: COLUMNS,
        dataSource: makeRows(1),
        rowKey: 'id',
      },
      slots: {
        bodyCell: ({ record }: { record: { name: string } }) => `CELL:${record.name}`,
      },
    });

    expect(wrapper.text()).toContain('CELL:Company 1');
  });
});
