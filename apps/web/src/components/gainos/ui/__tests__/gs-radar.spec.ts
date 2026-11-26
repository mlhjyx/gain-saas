import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import GsRadar from '#/components/gainos/ui/gs-radar.vue';

const SAMPLE_DIMS = [
  { id: 'c1', name: '产品品类', score: 8 },
  { id: 'c2', name: '买家角色', score: 6 },
  { id: 'c3', name: '生产工艺', score: 7 },
  { id: 'c4', name: '经营模式', score: 9 },
  { id: 'c5', name: '企业规模', score: null },
];

describe('GsRadar', () => {
  it('mounts standalone with explicit $t import for unknown dimensions and uses semi-transparent rgba(51, 92, 255, 0.14) polygon fill', () => {
    const wrapper = mount(GsRadar, {
      props: {
        ariaLabel: '五维匹配图：综合分 75',
        dims: SAMPLE_DIMS,
      },
    });

    const figure = wrapper.find('figure');
    expect(figure.attributes('role')).toBe('img');
    expect(figure.attributes('aria-label')).toBe('五维匹配图：综合分 75');
    expect(figure.attributes('data-gs')).toBe('radar');

    const area = wrapper.find('polygon.gs-radar__area');
    expect(area.exists()).toBe(true);
    expect(area.attributes('fill')).toBe('rgba(51, 92, 255, 0.14)');

    // 4 known solid vertices + 1 unknown hollow vertex
    expect(wrapper.findAll('circle.gs-radar__dot')).toHaveLength(5);
    expect(wrapper.findAll('circle.gs-radar__dot--hollow')).toHaveLength(1);

    // Explicit $t import renders figcaption note without needing global $t mock
    const note = wrapper.find('figcaption.gs-radar__note');
    expect(note.exists()).toBe(true);
    expect(note.text().trim().length).toBeGreaterThan(0);

    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('omits unknown figcaption when all dimensions have numeric scores', () => {
    const wrapper = mount(GsRadar, {
      props: {
        ariaLabel: '五维匹配图：完整数据',
        dims: SAMPLE_DIMS.map((d) => ({ ...d, score: d.score ?? 5 })),
      },
    });

    expect(wrapper.findAll('circle.gs-radar__dot--hollow')).toHaveLength(0);
    expect(wrapper.find('figcaption.gs-radar__note').exists()).toBe(false);
  });
});
