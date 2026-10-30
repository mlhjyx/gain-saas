#!/usr/bin/env python3
"""
GainOS 图标生成器(与 src/assets/logo-gainos.svg 同源几何)

用法(任意目录):python3 apps/web/scripts/make-icons.py
产出:public/favicon.ico(16/32/48)、public/apple-touch-icon.png(180)

字形构造(而非描边路径),这样切口干净、没有圆帽鼓包:
  环:外半径 21.6 / 内半径 13.2(笔画 8.4),圆心 (32,32)
  开口:自 -58° 到 -6° 的径向切口,横杠正好落在 0°(3 点钟)
  横杠:厚 8.4,自 x=53.6(与环外缘齐平)向左到 x=34.4,内侧圆头
  横杠与环的右侧柱合并成一个 G
底:圆角矩形 + 深海军蓝→墨绿对角渐变 + 14% 白内描边

位图用 Pillow 以超采样绘制;渐变在低分辨率生成后放大(渐变平滑,
无需逐像素,避免慢)。小尺寸自动关闭非必要细节。
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public'

C_TILE_A = (17, 32, 60)     # #11203C
C_TILE_B = (8, 38, 30)      # #08261E
C_MINT = (92, 242, 182)     # #5CF2B6
C_GREEN = (0, 185, 107)     # #00B96B

CX = CY = 32.0
R_OUT, R_IN = 20.4, 12.4          # 略收,四周留呼吸
BAR_HALF = (R_OUT - R_IN) / 2     # 4.0
BAR_LEFT = 34.6
BAR_RIGHT = CX + R_OUT            # 与环外缘齐平
# 开口下缘与横杠上缘对齐(atan(BAR_HALF / R_OUT)),避免出现台阶
CUT_FROM = -56.0
CUT_TO = -math.degrees(math.atan(BAR_HALF / R_OUT))


def _gradient(size, c0, c1, angle_deg, samples=96):
    """对角线性渐变:低分辨率生成后放大,避免逐像素开销。"""
    g = Image.new('RGB', (samples, samples))
    px = g.load()
    rad = math.radians(angle_deg)
    dx, dy = math.cos(rad), math.sin(rad)
    proj = [x * dx + y * dy for x in (0, samples - 1) for y in (0, samples - 1)]
    lo, hi = min(proj), max(proj)
    span = (hi - lo) or 1
    for y in range(samples):
        row = y * dy
        for x in range(samples):
            t = ((x * dx + row) - lo) / span
            px[x, y] = (
                round(c0[0] + (c1[0] - c0[0]) * t),
                round(c0[1] + (c1[1] - c0[1]) * t),
                round(c0[2] + (c1[2] - c0[2]) * t),
            )
    return g.resize((size, size), Image.BICUBIC)


def _ss_for(size):
    """超采样倍数:小尺寸多采,大尺寸少采(视觉一致,速度快)。"""
    if size <= 64:
        return 8
    if size <= 256:
        return 3
    return 2


def build(size):
    # 光学尺寸:≤24px 时放宽内圈、收细笔画,让小尺寸的反白空间(字怀)不糊死
    if size <= 24:
        r_out, r_in = 20.4, 13.6
    else:
        r_out, r_in = R_OUT, R_IN
    bar_half = (r_out - r_in) / 2
    bar_right = CX + r_out
    cut_to = -math.degrees(math.atan(bar_half / r_out))

    ss = _ss_for(size)
    s = size * ss
    k = s / 64.0

    # ── 底 ──
    grad = _gradient(s, C_TILE_A, C_TILE_B, 52).convert('RGBA')
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0.75 * k, 0.75 * k, 63.25 * k, 63.25 * k], radius=15.5 * k, fill=255
    )
    icon = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)
    border = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [0.75 * k, 0.75 * k, 63.25 * k, 63.25 * k],
        radius=15.5 * k,
        outline=(255, 255, 255, 38),
        width=max(1, round(1.4 * k)),
    )
    icon = Image.alpha_composite(icon, border)

    # ── 字形:G 的实心轮廓 ──
    glyph = Image.new('L', (s, s), 0)
    gd = ImageDraw.Draw(glyph)

    # 1) 环:外圆填充,内圆挖空
    gd.ellipse([(CX - r_out) * k, (CY - r_out) * k, (CX + r_out) * k, (CY + r_out) * k], fill=255)
    gd.ellipse([(CX - r_in) * k, (CY - r_in) * k, (CX + r_in) * k, (CY + r_in) * k], fill=0)

    # 2) 开口:径向切口(从圆心向外,覆盖足够大半径)
    r_far = (r_out + 4) * k
    a0, a1 = math.radians(CUT_FROM), math.radians(cut_to)
    wedge = [
        (CX * k, CY * k),
        (CX * k + r_far * math.cos(a0), CY * k + r_far * math.sin(a0)),
        (CX * k + r_far * math.cos(a1), CY * k + r_far * math.sin(a1)),
    ]
    gd.polygon(wedge, fill=0)

    # 3) 横杠:与环右侧柱合并,内侧圆头
    bar_left = CX + 2.6
    gd.rounded_rectangle(
        [bar_left * k, (CY - bar_half) * k, bar_right * k + 0.5, (CY + bar_half) * k],
        radius=bar_half * k * 1.05,
        fill=255,
    )

    # ── 字形上渐变 ──
    mark_grad = _gradient(s, C_MINT, C_GREEN, 62).convert('RGBA')
    mark = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    mark.paste(mark_grad, (0, 0), glyph)
    icon = Image.alpha_composite(icon, mark)

    return icon.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # 交付物只有三个:SVG(仓库内 src/assets)、ICO、触屏图标。
    # 中间尺寸写到系统临时目录,便于人工核对,不进仓库也不进产物。
    debug_dir = Path('/tmp/gainos-icons')
    debug_dir.mkdir(parents=True, exist_ok=True)
    for size in (16, 24, 32, 48, 64, 256, 512):
        build(size).save(debug_dir / f'icon-{size}.png')
    build(180).save(OUT / 'apple-touch-icon.png')
    build(256).save(OUT / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
    # SVG 侧的单一真值在 src/assets;public 只是分发副本
    (OUT / 'favicon.svg').write_text((ROOT / 'src/assets/logo-gainos.svg').read_text())
    (OUT / 'logo-mark.svg').write_text((ROOT / 'src/assets/logo-mark.svg').read_text())
    (OUT / 'logo-gainos.svg').write_text((ROOT / 'src/assets/logo-gainos.svg').read_text())
    print('favicon.ico / apple-touch-icon.png / favicon.svg written to', OUT)
    print('debug pngs in', debug_dir)


if __name__ == '__main__':
    sys.exit(main())
