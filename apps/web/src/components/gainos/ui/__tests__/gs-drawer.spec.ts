import { mount } from '@vue/test-utils';
import { Drawer } from 'ant-design-vue';
import { describe, expect, it } from 'vitest';

import GsDrawer from '#/components/gainos/ui/gs-drawer.vue';

describe('GsDrawer', () => {
  it.each([
    ['sm', 440],
    ['md', 640],
    ['lg', 720],
    ['xl', 'min(920px, 100vw)'],
  ] as const)('maps size=%s to standardized Drawer width %s', (size, expectedWidth) => {
    const wrapper = mount(GsDrawer, {
      props: {
        getContainer: false,
        open: true,
        size,
        title: '画像详情',
      },
    });

    const drawer = wrapper.findComponent(Drawer);
    expect(drawer.exists()).toBe(true);
    expect(drawer.props('width')).toBe(expectedWidth);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('defaults to md (640), allows explicit width override, and renders title/subtitle/slots with data-gs="drawer"', () => {
    const wrapper = mount(GsDrawer, {
      props: {
        getContainer: false,
        open: true,
        subtitle: '共 12 条买家画像规则',
        title: '编辑目标客户画像',
      },
      slots: {
        default: '<p class="drawer-body-copy">主体表单</p>',
        extra: '<button type="button" class="drawer-extra-btn">导出</button>',
        footer: '<button type="button" class="drawer-save-btn">保存</button>',
      },
    });

    expect(wrapper.findComponent(Drawer).props('width')).toBe(640);
    expect(wrapper.find('[data-gs="drawer"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('编辑目标客户画像');
    expect(wrapper.text()).toContain('共 12 条买家画像规则');
    expect(wrapper.find('.drawer-body-copy').text()).toBe('主体表单');
    expect(wrapper.find('.drawer-extra-btn').exists()).toBe(true);
    expect(wrapper.find('.drawer-save-btn').exists()).toBe(true);

    const customWidthWrapper = mount(GsDrawer, {
      props: {
        getContainer: false,
        open: true,
        title: '自定义宽度',
        width: 500,
      },
    });
    expect(customWidthWrapper.findComponent(Drawer).props('width')).toBe(500);
  });

  it('syncs v-model:open and emits close when Drawer closes', async () => {
    const wrapper = mount(GsDrawer, {
      props: {
        getContainer: false,
        open: true,
        title: '详情抽屉',
      },
    });

    const drawer = wrapper.findComponent(Drawer);
    drawer.vm.$emit('update:open', false);
    drawer.vm.$emit('close', new MouseEvent('click'));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
