/**
 * 日期格式机检的正向/负向用例（QW14）。
 * 运行：node --test scripts/lint-date-format.test.mjs（根 test 脚本已包含）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lintSource } from './lint-date-format.mjs';

describe('lintSource', () => {
  it('负向：视图直接 toLocaleString 即命中', () => {
    const source = `const a = new Date(x).toLocaleString();\nconst b = new Date(x).toLocaleDateString();\n`;
    const violations = lintSource(source);
    assert.equal(violations.length, 2);
    assert.equal(violations[0].line, 1);
  });

  it('正向：使用共享格式化函数时通过', () => {
    const source = `import { formatDateTime } from '@gain-saas/shared';\nconst a = formatDateTime(x);\n`;
    assert.deepEqual(lintSource(source), []);
  });

  it('豁免：带理由的 date-lint-disable 行通过，无理由仍命中', () => {
    const withReason = `const a = x.toLocaleString(); // date-lint-disable: 第三方库回调原始值`;
    assert.deepEqual(lintSource(withReason), []);
    const withoutReason = `const a = x.toLocaleString(); // date-lint-disable:`;
    assert.equal(lintSource(withoutReason).length, 1);
  });
});
