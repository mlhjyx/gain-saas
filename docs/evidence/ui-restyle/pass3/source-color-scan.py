#!/usr/bin/env python3
"""Pass2 源码颜色白名单扫描（临时脚本，结果见 source-color-scan.txt）。

范围：apps/web/src/**/*.{vue,css,ts,svg} + apps/web/{index,loading}.html
排除：api/（本轮禁止修改；initialAvatar 的旧绿色在 UI 层 basic.vue 归一为品牌蓝）、e2e/。

白名单：
- 纯中性灰（max-min <= 3）、白/黑；
- 品牌蓝家族：色相 200-250 且蓝通道最大；
- success 家族：色相 100-180 且绿通道最大；
- warning 家族：色相 10-50 且红通道最大；
- error 家族：色相 340-360/0-10 且红通道最大。
"""
import re
import sys
from pathlib import Path

ROOT = Path('apps/web')
OUT = ROOT.parent.parent / 'docs/evidence/ui-restyle/pass3/source-color-scan.txt'
PAT = re.compile(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oklab\([^)]*\)')


def rgb_of(value: str):
    v = value.lower().replace(' ', '')
    if v.startswith('#') and len(v) in (4, 7):
        if len(v) == 4:
            return tuple(int(c * 2, 16) for c in v[1:])
        return tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))
    if v.startswith('rgb'):
        nums = re.findall(r'-?\d+\.?\d*', v)
        if len(nums) >= 3:
            return tuple(float(x) for x in nums[:3])
    return None


def classify(value: str) -> str:
    v = value.lower().replace(' ', '')
    if 'var(' in v:
        return 'token'
    rgb = rgb_of(value)
    if not rgb:
        return 'unknown'
    r, g, b = rgb
    if max(rgb) - min(rgb) <= 3:
        return 'neutral'
    mx, mn = max(rgb), min(rgb)
    d = mx - mn
    l = (mx + mn) / 2 / 255
    if mx == r:
        h = 60 * (((g - b) / d) % 6)
    elif mx == g:
        h = 60 * ((b - r) / d + 2)
    else:
        h = 60 * ((r - g) / d + 4)
    if h < 0:
        h += 360
    s = d / 255 / (1 - abs(2 * l - 1) or 1)
    if b > r and b > g and 200 <= h <= 250 and s > 0.15:
        return 'brand'
    if g > r and g > b and 100 <= h <= 180:
        return 'success'
    if r > g and r > b and 10 <= h <= 50:
        return 'warning'
    if r > g and r > b and (h >= 340 or h <= 10):
        return 'error'
    return 'unknown'


def main() -> int:
    files = [
        p for p in ROOT.rglob('*')
        if p.is_file()
        and p.suffix in ('.vue', '.css', '.ts', '.svg', '.html')
        and 'api/' not in p.as_posix()
        and 'e2e/' not in p.as_posix()
        and 'node_modules' not in p.as_posix()
        and 'dist/' not in p.as_posix()
    ]
    rows = []
    counts = {}
    for path in files:
        text = path.read_text(errors='ignore')
        for match in PAT.finditer(text):
            value = match.group(0)
            if value.startswith(('#fff', '#ffffff', '#000', '#000000')):
                continue
            kind = classify(value)
            counts[kind] = counts.get(kind, 0) + 1
            if kind == 'unknown':
                rows.append((path.as_posix(), value))
    lines = [
        '# pass2 source color scan',
        f'files: {len(files)}',
        f'classCounts: {counts}',
        f'violations: {len(rows)}',
        '',
    ]
    for path, value in rows:
        lines.append(f'{path}\t{value}')
    OUT.write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines[:5]))
    return 1 if rows else 0


if __name__ == '__main__':
    sys.exit(main())
