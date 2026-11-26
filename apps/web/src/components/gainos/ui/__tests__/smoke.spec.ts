import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import GsTag from '#/components/gainos/ui/gs-tag.vue';

describe('vitest smoke', () => {
  it('mounts Vue SFC via # alias in happy-dom', () => {
    const wrapper = mount(GsTag, {
      props: { tone: 'success' },
      slots: { default: '已生效' },
    });

    expect(wrapper.attributes('data-gs')).toBe('tag');
    expect(wrapper.text()).toContain('已生效');
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });
});
