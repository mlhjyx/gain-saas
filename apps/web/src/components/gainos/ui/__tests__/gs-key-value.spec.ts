import { h } from 'vue';

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import GsKeyValue from '#/components/gainos/ui/gs-key-value.vue';

describe('GsKeyValue', () => {
  it('renders structured key-value pairs with — placeholder for empty values and tabular-nums for numeric items', () => {
    const wrapper = mount(GsKeyValue, {
      props: {
        items: [
          { key: 'name', label: '公司名称', value: 'Alpen Solar GmbH' },
          { key: 'employees', label: '员工规模', numeric: true, value: 120 },
          { key: 'website', label: '官网地址', value: '' },
          { key: 'notes', label: '备注', value: null },
        ],
      },
    });

    expect(wrapper.attributes('data-gs')).toBe('key-value');
    expect(wrapper.element.tagName).toBe('DL');

    const dts = wrapper.findAll('dt').map((el) => el.text());
    expect(dts).toEqual(['公司名称', '员工规模', '官网地址', '备注']);

    const dds = wrapper.findAll('dd');
    expect(dds[0]!.text()).toContain('Alpen Solar GmbH');
    expect(dds[1]!.text()).toContain('120');
    expect(dds[1]!.classes()).toContain('tabular-nums');
    expect(dds[2]!.text()).toContain('—');
    expect(dds[3]!.text()).toContain('—');
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('emits copy event with item and value for non-empty copyable fields and hides copy on empty values', async () => {
    const items = [
      { copyable: true, key: 'domain', label: '域名', value: 'alpen-solar.at' },
      { copyable: true, key: 'emptyField', label: '空字段', value: undefined },
    ];
    const wrapper = mount(GsKeyValue, {
      props: {
        copyLabel: '复制',
        items,
      },
    });

    const copyButtons = wrapper.findAll('[data-gs="key-value-copy"]');
    expect(copyButtons).toHaveLength(1);

    await copyButtons[0]!.trigger('click');
    expect(wrapper.emitted('copy')?.[0]).toEqual([
      { item: items[0], value: 'alpen-solar.at' },
    ]);
  });

  it('supports compact layout and custom value slot', () => {
    const wrapper = mount(GsKeyValue, {
      props: {
        items: [{ key: 'status', label: '状态', value: '有效' }],
        layout: 'compact',
      },
      slots: {
        value: ({ displayValue }: { displayValue: string }) =>
          h('span', { class: 'custom-val' }, `状态:${displayValue}`),
      },
    });

    expect(wrapper.attributes('data-gs-layout')).toBe('compact');
    expect(wrapper.classes()).toContain('@container');
    expect(wrapper.find('.custom-val').text()).toBe('状态:有效');
  });
});
