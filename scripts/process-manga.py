#!/usr/bin/env python3
# process-manga.py — 把漫画原图里偏了的色键吸附到精确占位色，并抠掉白天空。
#
# 用法:
#   python3 scripts/process-manga.py [raw_dir] [out_dir]
# 默认:
#   raw_dir = client/assets/manga/raw
#   out_dir = client/assets/manga
# 每个 foo.jpg / foo.jpeg / foo.png → out_dir/foo.png
#
# 精确色键（平涂，黑墨线）:
#   A 球衣 #FF00FF    A 短裤+球袜 #00FFFF
#   B 球衣 #FF8800    B 短裤+球袜 #8800FF
#   双方球鞋 #FF0088  双方头发 #0000FF  皮肤 #F0C8A0
# JPG 会把品红压成低 G 的粉，和球鞋色相叠在一起。低 G 的粉先标成待定，
# 再按连通块（允许跨过 3 像素墨线）分开：大块是球衣，孤立小块是鞋。
# 草地、白粉笔线、球、手套、门框、墨线保持原色。
# 从顶边连通的近白天空变成透明；草地里的白线不连着顶边，会留下。
#
#   python3 scripts/process-manga.py --self-test
# 用合成像素核对分类，不写文件。
from __future__ import annotations

import os
import sys
from collections import deque

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DEFAULT_RAW = os.path.join(ROOT, 'client', 'assets', 'manga', 'raw')
DEFAULT_OUT = os.path.join(ROOT, 'client', 'assets', 'manga')

EXACT = {
    'atkJersey': (255, 0, 255, 255),
    'atkShorts': (0, 255, 255, 255),
    'defJersey': (255, 136, 0, 255),
    'defShorts': (136, 0, 255, 255),
    'boot': (255, 0, 136, 255),
    'hair': (0, 0, 255, 255),
    'skin': (240, 200, 160, 255),
}


def hsv(r, g, b):
    mx = r if r > g else g
    if b > mx:
        mx = b
    mn = r if r < g else g
    if b < mn:
        mn = b
    d = mx - mn
    s = 0 if mx == 0 else d / mx
    if d == 0:
        h = 0
    elif mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    h *= 60
    if h < 0:
        h += 360
    return h, s, mx


def manga_class(r, g, b, a=255):
    """与 shared/kits.js mangaPixelClass 同一套阈值。"""
    if a < 128:
        return None
    boot_d = abs(r - 255) + abs(g) + abs(b - 136)
    if boot_d <= 18 and g < 30 and b > r * 0.4 and b < r * 0.7:
        return 'boot'
    h, s, v = hsv(r, g, b)
    if v < 34 and s < 0.55:
        return None
    if s < 0.12 and v > 200:
        return None
    if 70 <= h <= 160 and g > r + 8 and g + 8 >= b and b < g * 0.48 and s > 0.22 and g > 55:
        return None
    if (h < 16 or h > 350) and s > 0.5 and b < 75 and g < 110 and v > 90:
        return None
    if 0.14 <= s <= 0.58 and r > 165 and g > 120 and b > 75 and r > g and g + 8 > b and (r - b) > 22 and h < 55:
        return 'skin'
    if 12 <= h <= 44 and s > 0.62 and v > 85 and g > 40 and b < g * 0.55 and r > g:
        return 'defJersey'
    if 282 <= h <= 318 and s > 0.4 and v >= 40 and g < v * 0.4 and abs(r - b) <= max(28, v * 0.32) and b > r * 0.72:
        return 'atkJersey'
    # 品红被 JPG 压成粉，和球鞋叠色。先标待定，再按连通块和 G 通道拆开。
    br = (b / r) if r else 0
    if (h >= 305 or h <= 12) and s > 0.45 and v > 70 and r > 120 and b > 40 and g < 110 and 0.32 < br < 0.85:
        return 'ambiguous'
    if 250 <= h <= 292 and s > 0.35 and v > 48 and b > r and r > 32 and g < b * 0.72:
        return 'defShorts'
    if 48 <= h <= 72 and s > 0.7 and v > 140 and b < 80 and r > 160 and g > 160:
        return 'atkShorts'
    if 140 <= h <= 162 and s > 0.55 and v > 120 and r < 40 and g > 180 and b > 90 and b < g * 0.8:
        return 'defShorts'
    if 195 <= h <= 255 and b > 70 and r < 95 and b > g + 32 and g < b * 0.7 and r < b * 0.6:
        return 'hair'
    if 165 <= h <= 220 and r < 100 and g > 70 and b > 90 and g > b * 0.62:
        return 'atkShorts'
    return None


def resolve_ambiguous(classes, w, h, pixels):
    """pixels 是扁平 RGB，用来比较每块的 G。没有成片真品红时，最大块是球衣。"""
    n = w * h
    true_mag = sum(1 for c in classes if c == 'atkJersey')
    seen = bytearray(n)
    comps = []
    for s in range(n):
        if classes[s] != 'ambiguous' or seen[s]:
            continue
        q = deque([s])
        seen[s] = 1
        comp = [s]
        sum_g = pixels[s * 4 + 1]
        while q:
            i = q.popleft()
            x, y = i % w, i // w
            for dy in range(-4, 5):
                yy = y + dy
                if yy < 0 or yy >= h:
                    continue
                for dx in range(-4, 5):
                    if dx == 0 and dy == 0:
                        continue
                    xx = x + dx
                    if xx < 0 or xx >= w:
                        continue
                    j = yy * w + xx
                    if classes[j] != 'ambiguous' or seen[j]:
                        continue
                    seen[j] = 1
                    q.append(j)
                    comp.append(j)
                    sum_g += pixels[j * 4 + 1]
        min_y = min(i // w for i in comp)
        max_y = max(i // w for i in comp)
        comps.append((comp, sum_g / len(comp), min_y, max_y))
    if true_mag > 200:
        for comp, _g, _a, _b in comps:
            label = 'atkJersey' if len(comp) >= 400 else 'boot'
            for j in comp:
                classes[j] = label
        return
    if not comps:
        return
    comps.sort(key=lambda item: len(item[0]), reverse=True)
    ref_g = comps[0][1]
    ref_max_y = comps[0][3]
    for idx, (comp, gmean, min_y, _max_y) in enumerate(comps):
        below = min_y > ref_max_y + 8
        label = 'atkJersey' if (idx == 0 or (not below and abs(gmean - ref_g) <= 12)) else 'boot'
        for j in comp:
            classes[j] = label


def near_white(r, g, b):
    mx = r if r > g else g
    if b > mx:
        mx = b
    mn = r if r < g else g
    if b < mn:
        mn = b
    return mx > 232 and (mx - mn) < 22


def flood_sky(im):
    """顶边连通的近白变成透明。草地里的白线不连顶边。"""
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        r, g, b, a = px[x, 0]
        if a > 0 and near_white(r, g, b):
            seen[x] = 1
            q.append(x)
    while q:
        i = q.popleft()
        x, y = i % w, i // w
        r, g, b, a = px[x, y]
        px[x, y] = (r, g, b, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            j = ny * w + nx
            if seen[j]:
                continue
            rr, gg, bb, aa = px[nx, ny]
            if aa == 0 or not near_white(rr, gg, bb):
                continue
            seen[j] = 1
            q.append(j)


def process_image(src, dst):
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    px = im.load()
    classes = [None] * (w * h)
    raw = [0] * (w * h * 4)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            i = (y * w + x) * 4
            raw[i], raw[i + 1], raw[i + 2], raw[i + 3] = r, g, b, a
            classes[y * w + x] = manga_class(r, g, b, a)
    resolve_ambiguous(classes, w, h, raw)
    counts = {}
    for y in range(h):
        row = y * w
        for x in range(w):
            kind = classes[row + x]
            if not kind:
                continue
            px[x, y] = EXACT[kind]
            counts[kind] = counts.get(kind, 0) + 1
    flood_sky(im)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst, 'PNG')
    return w, h, counts


def self_test():
    samples = [
        ((255, 0, 255), 'atkJersey'),
        ((248, 6, 250), 'atkJersey'),
        ((120, 0, 120), 'atkJersey'),
        ((0, 255, 255), 'atkShorts'),
        ((8, 178, 227), 'atkShorts'),
        ((255, 136, 0), 'defJersey'),
        ((247, 115, 15), 'defJersey'),
        ((136, 0, 255), 'defShorts'),
        ((108, 61, 163), 'defShorts'),
        ((255, 0, 136), 'boot'),
        ((225, 54, 92), 'ambiguous'),
        ((0, 0, 255), 'hair'),
        ((4, 84, 169), 'hair'),
        ((240, 200, 160), 'skin'),
        ((254, 200, 130), 'skin'),
        ((40, 140, 40), None),
        ((62, 156, 32), None),
        ((250, 250, 250), None),
        ((0, 0, 0), None),
        ((210, 40, 30), None),  # 红球
    ]
    failed = 0
    for rgb, expect in samples:
        got = manga_class(*rgb)
        if got != expect:
            print('FAIL', rgb, 'expect', expect, 'got', got)
            failed += 1
        else:
            print('PASS', rgb, got)
    # 小块精确鞋色要落成 boot，大块低 G 粉要落成球衣
    w = h = 40
    classes = [None] * (w * h)
    for y in range(8, 28):
        for x in range(4, 24):
            classes[y * w + x] = 'ambiguous'
    for y in range(30, 36):
        for x in range(30, 36):
            classes[y * w + x] = 'ambiguous'
    flat = [0] * (w * h * 4)
    for i in range(w * h):
        flat[i * 4 + 1] = 20 if classes[i] == 'ambiguous' and i < 30 * w else 60
    resolve_ambiguous(classes, w, h, flat)
    if classes[10 * w + 10] != 'atkJersey' or classes[32 * w + 32] != 'boot':
        print('FAIL component split', classes[10 * w + 10], classes[32 * w + 32])
        failed += 1
    else:
        print('PASS component split jersey/boot')
    if failed:
        sys.exit(1)
    print('SELF TEST OK')


def main(argv):
    if argv and argv[0] == '--self-test':
        self_test()
        return
    raw = argv[0] if len(argv) > 0 else DEFAULT_RAW
    out = argv[1] if len(argv) > 1 else DEFAULT_OUT
    if not os.path.isdir(raw):
        print('没有原图目录:', raw)
        print('用法: python3 scripts/process-manga.py [raw_dir] [out_dir]')
        sys.exit(1)
    names = [n for n in sorted(os.listdir(raw)) if n.lower().endswith(('.jpg', '.jpeg', '.png'))]
    if not names:
        print('目录里没有图片:', raw)
        sys.exit(1)
    for name in names:
        stem = os.path.splitext(name)[0]
        dst = os.path.join(out, stem + '.png')
        w, h, counts = process_image(os.path.join(raw, name), dst)
        brief = ' '.join('%s=%d' % (k, counts.get(k, 0)) for k in EXACT)
        print('%s %dx%d -> %s  %s' % (name, w, h, dst, brief))


if __name__ == '__main__':
    main(sys.argv[1:])
