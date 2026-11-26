import { mount } from '@vue/test-utils';
import { Skeleton } from 'ant-design-vue';
import { describe, expect, it } from 'vitest';

import GsAsyncSection from '#/components/gainos/ui/gs-async-section.vue';

describe('GsAsyncSection', () => {
  it('renders Skeleton loading state with status role and suppresses error/empty/content', () => {
    const wrapper = mount(GsAsyncSection, {
      props: {
        empty: true,
        error: { title: '加载失败' },
        loading: true,
        loadingText: '正在加载线索…',
      },
      slots: {
        default: '<div class="actual-content">正文内容</div>',
      },
    });

    expect(wrapper.attributes('data-gs')).toBe('async-section');
    expect(wrapper.findComponent(Skeleton).exists()).toBe(true);
    expect(wrapper.find('[role="status"]').text()).toContain('正在加载线索…');
    expect(wrapper.find('[data-gs="error-notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-gs="empty"]').exists()).toBe(false);
    expect(wrapper.find('.actual-content').exists()).toBe(false);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('renders three-part error notice preserving .error-notice__details summary and emits retry', async () => {
    const wrapper = mount(GsAsyncSection, {
      props: {
        empty: true,
        error: {
          code: 'UPSTREAM_503',
          next: '请稍后重试，或检查网络连接。',
          title: '暂时无法读取线索列表',
          why: '获客引擎响应超时。',
        },
        loading: false,
        retryText: '重新加载',
      },
      slots: {
        default: '<div class="actual-content">正文内容</div>',
      },
    });

    expect(wrapper.find('[data-gs="error-notice"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('暂时无法读取线索列表');
    expect(wrapper.text()).toContain('获客引擎响应超时。');
    expect(wrapper.text()).toContain('请稍后重试，或检查网络连接。');

    const detailsSummary = wrapper.find('.error-notice__details summary');
    expect(detailsSummary.exists()).toBe(true);
    expect(wrapper.find('.error-notice__details code').text()).toBe('UPSTREAM_503');

    const retryBtn = wrapper.find('[data-gs="async-section-retry"]');
    expect(retryBtn.exists()).toBe(true);
    expect(retryBtn.text()).toContain('重新加载');
    await retryBtn.trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);

    // Must not simultaneously render empty or content
    expect(wrapper.find('[data-gs="empty"]').exists()).toBe(false);
    expect(wrapper.find('.actual-content').exists()).toBe(false);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('hides retry button when retryable=false and supports string error fallback', () => {
    const wrapper = mount(GsAsyncSection, {
      props: {
        error: '权限不足',
        retryable: false,
      },
    });

    expect(wrapper.find('[data-gs="error-notice"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('权限不足');
    expect(wrapper.find('.error-notice__details').exists()).toBe(false);
    expect(wrapper.find('[data-gs="async-section-retry"]').exists()).toBe(false);
  });

  it('renders GsEmpty state with empty-actions slot when empty=true', () => {
    const wrapper = mount(GsAsyncSection, {
      props: {
        empty: true,
        emptyDescription: '先去设定目标客户画像再开始挖掘。',
        emptyTitle: '还没有买家线索',
      },
      slots: {
        default: '<div class="actual-content">正文内容</div>',
        'empty-actions': '<button type="button" class="empty-cta">去设定</button>',
      },
    });

    expect(wrapper.find('[data-gs="empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('还没有买家线索');
    expect(wrapper.text()).toContain('先去设定目标客户画像再开始挖掘。');
    expect(wrapper.find('.empty-cta').exists()).toBe(true);
    expect(wrapper.find('.actual-content').exists()).toBe(false);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('renders default content slot when ready', () => {
    const wrapper = mount(GsAsyncSection, {
      props: {
        empty: false,
        error: null,
        loading: false,
      },
      slots: {
        default: '<div class="actual-content">已加载的数据列表</div>',
      },
    });

    expect(wrapper.find('.actual-content').text()).toBe('已加载的数据列表');
    expect(wrapper.find('[data-gs="error-notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-gs="empty"]').exists()).toBe(false);
  });
});
