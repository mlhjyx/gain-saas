/**
 * 零术语机检的负向/正向用例（P6 设计 §4「故意插入违禁词应红」）。
 * 运行：node --test scripts/lint-forbidden-terms.test.mjs（根 test 脚本已包含）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintLocaleObject, lintVueSource } from './lint-forbidden-terms.mjs';

const ids = (result) => result.violations.map((v) => v.pattern);

describe('lintVueSource（页面模板）', () => {
  it('负向：模板静态文本出现 ICP / run 即红', () => {
    const source = `<template>\n  <div>\n    <p>请先设置 ICP</p>\n    <p>本次 run 已完成</p>\n  </div>\n</template>`;
    const result = lintVueSource(source);
    assert.deepEqual(new Set(ids(result)), new Set(['icp', 'run']));
    assert.equal(result.violations[0].line, 3);
  });

  it('负向：裸枚举、plan_hash、canonical、UUID 都命中', () => {
    const source = `<template>
  <div title="canonical_company">PARTIAL</div>
  <p>plan_hash: abc</p>
  <p>任务 3f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c 已完成</p>
  <p>状态 RISKY</p>
</template>`;
    const result = lintVueSource(source);
    assert.deepEqual(new Set(ids(result)), new Set(['canonical', 'enum', 'uuid', 'plan_hash']));
  });

  it('正向：表达式绑定与插值（代码不是文案）不误报', () => {
    const source = `<template>
  <div :class="run.status" :title="run.id">
    {{ run.status }} {{ runId }}
  </div>
  <!-- run 在注释里不渲染 -->
</template>`;
    assert.deepEqual(lintVueSource(source).violations, []);
  });

  it('负向：run_id / runId 这类引擎字段名同样拦截', () => {
    const source = `<template><p>run_id: abc</p><p>看 RunId 字段</p></template>`;
    assert.equal(lintVueSource(source).violations.length, 2);
  });

  it('正向：文件级豁免需理由，带理由则整份跳过', () => {
    const withReason = `<template>\n  <!-- terms-lint-disable-file: 运营台是技术工作面 -->\n  <p>PARTIAL</p>\n</template>`;
    const result = lintVueSource(withReason);
    assert.deepEqual(result.violations, []);
    assert.match(result.exempt, /运营台/);

    const noReason = `<template>\n  <!-- terms-lint-disable-file -->\n  <p>PARTIAL</p>\n</template>`;
    assert.match(lintVueSource(noReason).missingReason, /缺少理由/);
  });

  it('区域级豁免：disable/enable 之间跳过，之外仍检查', () => {
    const source = `<template>
  <div>
    <!-- terms-lint-disable: 技术详情折叠区 -->
    <code>FAILED</code>
    <!-- terms-lint-enable -->
    <p>run 状态</p>
  </div>
</template>`;
    const result = lintVueSource(source);
    assert.deepEqual(ids(result), ['run']);
  });

  it('负向：区域豁免缺理由也算违规', () => {
    const source = `<template>\n  <!-- terms-lint-disable -->\n  <p>FAILED</p>\n  <!-- terms-lint-enable -->\n</template>`;
    const result = lintVueSource(source);
    assert.ok(result.violations.some((v) => v.pattern === 'exempt'));
  });
});

describe('lintLocaleObject（i18n JSON）', () => {
  it('负向：字符串值含 run / ICP / RISKY 即红', () => {
    const violations = lintLocaleObject({
      menu: { workspace: '工作台' },
      runs: '本次 run 已完成',
      icp: '修改 ICP',
      status: { RISKY: '待确认（RISKY）' },
    }, 'fixture.json');
    assert.equal(violations.length, 3);
  });

  it('正向：键名不算用户可见文案', () => {
    const violations = lintLocaleObject({
      notifications: { runCompleted: '挖掘任务已完成', runPartial: '挖掘任务部分完成' },
    }, 'fixture.json');
    assert.deepEqual(violations, []);
  });

  it('正向：中文业务用语不误报（挖掘任务/目标客户画像/部分完成）', () => {
    const violations = lintLocaleObject({
      a: '挖掘任务已完成，可去「买家线索」查看',
      b: '目标客户画像已生效',
      c: '本轮部分完成，已产出的线索保留',
    }, 'fixture.json');
    assert.deepEqual(violations, []);
  });
});
