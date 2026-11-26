import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsStat from '#/components/gainos/ui/gs-stat.vue';

describe('GsStat', () => {
  it('aligns with GsCard float surface and renders label, value, suffix, hint, and trend with tabular-nums', () => {
    const wrapper = mount(GsStat, {
      props: {
        hint: '较过去 7 天新增',
        label: '高价值线索',
        suffix: '家',
        trend: '+18%',
        trendTone: 'success',
        value: 128,
      },
    });

    expect(wrapper.findComponent(GsCard).exists()).toBe(true);
    expect(wrapper.find('[data-gs="stat"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('高价值线索');
    expect(wrapper.text()).toContain('128');
    expect(wrapper.text()).toContain('家');

    const trend = wrapper.find('[data-gs="stat-trend"]');
    expect(trend.exists()).toBe(true);
    expect(trend.text()).toContain('+18%');
    expect(trend.attributes('data-gs-tone')).toBe('success');
    expect(trend.classes()).toContain('tabular-nums');

    const hint = wrapper.find('[data-gs="stat-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain('较过去 7 天新增');
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('remains backward compatible when only label and value are passed', () => {
    const wrapper = mount(GsStat, {
      props: {
        label: '活跃任务',
        value: 6,
      },
    });

    expect(wrapper.text()).toContain('活跃任务');
    expect(wrapper.text()).toContain('6');
    expect(wrapper.find('[data-gs="stat-trend"]').exists()).toBe(false);
    expect(wrapper.find('[data-gs="stat-hint"]').exists()).toBe(false);
  });
});
