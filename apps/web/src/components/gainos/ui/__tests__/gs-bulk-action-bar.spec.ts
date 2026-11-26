import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import GsBulkActionBar from '#/components/gainos/ui/gs-bulk-action-bar.vue';

describe('GsBulkActionBar', () => {
  it('renders nothing when selectedCount is 0', () => {
    const wrapper = mount(GsBulkActionBar, {
      props: {
        selectedCount: 0,
      },
    });

    expect(wrapper.find('[data-gs="bulk-action-bar"]').exists()).toBe(false);
  });

  it('renders region with aria-live="polite", count badge, actions slot, and clear button when selectedCount > 0', async () => {
    const wrapper = mount(GsBulkActionBar, {
      props: {
        clearLabel: '清除选择',
        selectedCount: 4,
        selectedLabel: '已选 4 条线索',
      },
      slots: {
        actions: '<button type="button" class="bulk-approve-btn">批量通过</button>',
      },
    });

    const bar = wrapper.find('[data-gs="bulk-action-bar"]');
    expect(bar.exists()).toBe(true);
    expect(bar.attributes('role')).toBe('region');
    expect(bar.attributes('aria-live')).toBe('polite');
    expect(wrapper.find('[data-gs="bulk-action-count"]').text()).toBe('4');
    expect(bar.text()).toContain('已选 4 条线索');
    expect(wrapper.find('.bulk-approve-btn').exists()).toBe(true);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);

    const clearBtn = wrapper.find('[data-gs="bulk-action-clear"]');
    expect(clearBtn.exists()).toBe(true);
    await clearBtn.trigger('click');
    expect(wrapper.emitted('clear')).toHaveLength(1);
  });
});
