import { mount } from '@vue/test-utils';
import { Modal } from 'ant-design-vue';
import { describe, expect, it } from 'vitest';

import GsModal from '#/components/gainos/ui/gs-modal.vue';

describe('GsModal', () => {
  it.each([
    ['sm', 420],
    ['md', 520],
    ['lg', 720],
  ] as const)('maps size=%s to Modal width %d and preserves explicit width override', (size, expectedWidth) => {
    const wrapper = mount(GsModal, {
      props: {
        getContainer: false,
        open: true,
        size,
        title: '确认操作',
      },
    });

    const modal = wrapper.findComponent(Modal);
    expect(modal.exists()).toBe(true);
    expect(modal.props('width')).toBe(expectedWidth);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('keeps default width 520, renders data-gs="modal", subtitle, danger okButtonProps, footer slot, and emits ok/cancel', async () => {
    const wrapper = mount(GsModal, {
      props: {
        danger: true,
        getContainer: false,
        okText: '确认删除',
        open: true,
        subtitle: '删除后不可恢复，请核对草稿内容。',
        title: '删除外发草稿',
      },
      slots: {
        default: '<p class="modal-body-copy">即将删除草稿</p>',
        footer: '<button type="button" class="custom-footer-btn">自定义提交</button>',
      },
    });

    const modal = wrapper.findComponent(Modal);
    expect(modal.props('width')).toBe(520);
    expect(modal.props('okButtonProps')).toMatchObject({ danger: true });
    expect(wrapper.find('[data-gs="modal"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('删除外发草稿');
    expect(wrapper.text()).toContain('删除后不可恢复，请核对草稿内容。');
    expect(wrapper.find('.modal-body-copy').text()).toBe('即将删除草稿');
    expect(wrapper.find('.custom-footer-btn').exists()).toBe(true);

    modal.vm.$emit('ok');
    modal.vm.$emit('cancel');
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('ok')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toHaveLength(1);

    const customWidth = mount(GsModal, {
      props: {
        getContainer: false,
        open: true,
        size: 'sm',
        title: '覆盖宽度',
        width: 600,
      },
    });
    expect(customWidth.findComponent(Modal).props('width')).toBe(600);
  });
});
