import { mount } from '@vue/test-utils';
import { Alert } from 'ant-design-vue';
import { describe, expect, it } from 'vitest';

import GsAlert from '#/components/gainos/ui/gs-alert.vue';

describe('GsAlert', () => {
  it.each([
    ['info', 'info', 'status'],
    ['success', 'success', 'status'],
    ['warning', 'warning', 'alert'],
    ['danger', 'error', 'alert'],
  ] as const)(
    'maps tone=%s to AntDV Alert type=%s with role=%s and 0 <a-*> tags',
    (tone, expectedType, expectedRole) => {
      const wrapper = mount(GsAlert, {
        props: {
          description: '详细说明文案',
          title: '状态提示标题',
          tone,
        },
      });

      const alert = wrapper.findComponent(Alert);
      expect(alert.exists()).toBe(true);
      expect(alert.props('type')).toBe(expectedType);
      expect(wrapper.attributes('data-gs')).toBe('alert');
      expect(wrapper.attributes('data-gs-tone')).toBe(tone);
      expect(wrapper.find('.ant-alert').attributes('role')).toBe(expectedRole);
      expect(wrapper.text()).toContain('状态提示标题');
      expect(wrapper.text()).toContain('详细说明文案');
      expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
    },
  );

  it('supports single-line default slot, action slot, and closable close event', async () => {
    const wrapper = mount(GsAlert, {
      props: {
        closable: true,
        tone: 'warning',
      },
      slots: {
        action: '<button type="button" class="alert-action-btn">立即处理</button>',
        default: '还有 3 条线索待确认',
      },
    });

    expect(wrapper.text()).toContain('还有 3 条线索待确认');
    expect(wrapper.find('.alert-action-btn').exists()).toBe(true);

    const closeBtn = wrapper.find('button.ant-alert-close-icon');
    expect(closeBtn.exists()).toBe(true);
    await closeBtn.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
