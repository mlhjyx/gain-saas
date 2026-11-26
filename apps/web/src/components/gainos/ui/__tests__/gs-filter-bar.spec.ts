import { mount } from '@vue/test-utils';
import { Input } from 'ant-design-vue';
import { describe, expect, it } from 'vitest';

import GsFilterBar from '#/components/gainos/ui/gs-filter-bar.vue';

describe('GsFilterBar', () => {
  it('wraps prefixed search Input inside a plain div to prevent Cascade Layer width collapse and uses @container', () => {
    const wrapper = mount(GsFilterBar, {
      props: {
        search: '',
        searchPlaceholder: '搜索公司或域名',
      },
      slots: {
        actions: '<button type="button" class="filter-action-btn">导出</button>',
        filters: '<div class="custom-filter-slot">状态筛选</div>',
      },
    });

    expect(wrapper.attributes('data-gs')).toBe('filter-bar');
    expect(wrapper.classes()).toContain('@container');

    const searchHost = wrapper.find('[data-gs="filter-bar-search"]');
    expect(searchHost.exists()).toBe(true);
    expect(searchHost.element.tagName).toBe('DIV');
    expect(searchHost.classes().some((cls) => cls.includes('w-'))).toBe(true);

    const inputComp = searchHost.findComponent(Input);
    expect(inputComp.exists()).toBe(true);
    // Input must carry prefix slot and NOT have width utility classes directly on ant-input-affix-wrapper
    expect(searchHost.find('.ant-input-prefix').exists()).toBe(true);
    expect(searchHost.find('.ant-input-affix-wrapper').classes().some((cls) => cls.startsWith('w-'))).toBe(false);

    expect(wrapper.find('.custom-filter-slot').exists()).toBe(true);
    expect(wrapper.find('.filter-action-btn').exists()).toBe(true);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('syncs v-model:search and clears search + emits reset when reset button is clicked', async () => {
    const wrapper = mount(GsFilterBar, {
      props: {
        hasActiveFilters: true,
        resetLabel: '重置筛选',
        search: 'solar',
      },
    });

    const resetBtn = wrapper.find('[data-gs="filter-bar-reset"]');
    expect(resetBtn.exists()).toBe(true);
    expect(resetBtn.text()).toContain('重置筛选');

    await resetBtn.trigger('click');

    expect(wrapper.emitted('update:search')?.[0]).toEqual(['']);
    expect(wrapper.emitted('reset')).toHaveLength(1);
  });

  it('hides reset button when no filters are active and supports searchable=false', () => {
    const wrapper = mount(GsFilterBar, {
      props: {
        hasActiveFilters: false,
        search: '',
        searchable: false,
      },
    });

    expect(wrapper.find('[data-gs="filter-bar-search"]').exists()).toBe(false);
    expect(wrapper.find('[data-gs="filter-bar-reset"]').exists()).toBe(false);
  });
});
