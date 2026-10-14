#!/usr/bin/env python3
# 结算演出图生成器。
# 输出 960×640 webp，文件名与 client/js/main.js 的 CUT_KEYS 一致。
# 球衣使用 shared/kits.js 的占位符纯色，运行时按球队换色：
#   #FF00FF 主队衣  #00FFFF 主队裤  #FFFF00 主队袜
#   #FF8800 客队衣  #8800FF 客队裤  #00FF88 客队袜
# 平涂、不在占位色上做明暗，否则换色匹配不上。
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIRS = [
    os.path.join(ROOT, 'client', 'assets', 'cutscene'),
    os.path.join(ROOT, 'docs', 'assets', 'cutscene'),
]
W, H = 960, 640
U = 8
# 标题栏从这里开始。所有人的鞋底必须高于这条线。
BANNER_TOP = 536
FOOT = 508
FONT = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'

HOME = {'j': (255, 0, 255), 's': (0, 255, 255), 'k': (255, 255, 0)}
AWAY = {'j': (255, 136, 0), 's': (136, 0, 255), 'k': (0, 255, 136)}
SKIN = (244, 204, 166)
HAIR = (42, 32, 36)
SHOE = (28, 26, 32)
LINE = (22, 18, 28)
WHITE = (246, 246, 248)
GOLD = (255, 214, 90)
NAVY = (12, 22, 48)

SCENES = [
    ('dribble-win', '突破成功', 'win'),
    ('dribble-lose', '突破失败', 'lose'),
    ('pass-win', '传球成功', 'win'),
    ('pass-lose', '传球被断', 'lose'),
    ('shoot-goal', '射门得分', 'win'),
    ('shoot-save', '门将扑出', 'lose'),
    ('shoot-miss', '射门偏出', 'lose'),
    ('special-goal', '必杀射门', 'special'),
    ('special-save', '必杀被扑', 'lose'),
    ('feint-win', '假动作', 'win'),
    ('foul', '犯规', 'foul'),
    ('offside', '越位', 'foul'),
]


def px(dr, x, y, w, h, c):
    dr.rectangle([int(x), int(y), int(x + w - 1), int(y + h - 1)], fill=c)


def mirror_x(face, x, ox):
    return ox + face * x


def draw_ball(dr, x, y, s=18):
    px(dr, x - s * 0.5, y - s * 0.35, s, s * 0.7, WHITE)
    px(dr, x - s * 0.35, y - s * 0.5, s * 0.7, s, WHITE)
    px(dr, x - s * 0.18, y - s * 0.18, s * 0.36, s * 0.36, (32, 32, 38))
    px(dr, x - s * 0.12, y - s * 0.48, s * 0.24, s * 0.16, (32, 32, 38))


# 严格侧身。字符从左到右 = 背后 → 身前（face>0 朝右，鼻子在右侧）。
# H 发 S 肤 N 鼻 E 眼 J 衣 P 裤 K 袜 O 鞋 A 臂 W 号码/手套 Y 旗
POSES = {
    'run': [
        ".......HHHHH........",
        ".....HHHHHHHHH......",
        "....HHHSSSSSHH......",
        "....HHHSSSEESHH.....",
        "....HHHSSSSSNHH.....",
        ".....HHSSSSSH.......",
        "....JJJJJJJJJJJ.....",
        "...AJJJJJWWJJJJA....",
        "..AAJJJJJJJJJJJAA...",
        "...A.JJJJJJJJJ.A....",
        "......PPPPPPPP......",
        "......PPPPPPPP......",
        ".....KKK...KKKK.....",
        "....KK......KKK.....",
        "...KK........KK.....",
        "..OOO.......OOOO....",
    ],
    'kick': [
        ".......HHHHH........",
        ".....HHHHHHHHH......",
        "....HHHSSSSSHH......",
        "....HHHSSSEESHH.....",
        "....HHHSSSSSNHH.....",
        ".....HHSSSSSH.......",
        "..A..JJJJJJJJJ..AAA.",
        ".AA.JJJJJWWJJJ.AAAA.",
        "..A..JJJJJJJJJ......",
        "......PPPPPPPP......",
        ".....KK.PPPPPP......",
        "....KK..............",
        "...OOO......KKKKKK..",
        "............KKKKKKO.",
        "...............OOOO.",
    ],
    'fall': [
        "....................",
        "...............HHHH.",
        "..........HHHHHHHHH.",
        ".........HHSSSSSHHH.",
        "........HHSSSEESHHH.",
        "AA......HHSSSSSNH...",
        "AAA....JJJJJJJJJJ...",
        ".AA....JJJJWWJJJJ...",
        "........PPPPPPPP....",
        "..KKKKKKK....KKKKKKK",
        ".OOOO..........OOOO.",
    ],
    'pass': [
        ".......HHHHH........",
        ".....HHHHHHHHH......",
        "....HHHSSSSSHH......",
        "....HHHSSSEESHH.....",
        "....HHHSSSSSNHH.....",
        ".....HHSSSSSH.......",
        "..A..JJJJJJJJJ..AA..",
        ".AA.JJJJJWWJJJ.AAA..",
        "..A..JJJJJJJJJ......",
        "......PPPPPPPP......",
        ".....KK..PPPPP......",
        "....KK....KKK.......",
        "...OOO....KK........",
        "..........OOO.......",
    ],
    'celebrate': [
        ".A................A.",
        ".A......HHHHH.....A.",
        ".SA...HHHHHHHHH..AS.",
        "..A..HHHSSSSSHH..A..",
        ".....HHHSSSEESH.....",
        ".....HHHSSSSSNH.....",
        "......HHSSSSSH......",
        ".....JJJJJJJJJJ.....",
        ".....JJJJWWJJJJ.....",
        ".....JJJJJJJJJJ.....",
        "......PPPPPPPP......",
        ".....KKK....KKK.....",
        ".....KK......KK.....",
        "....OOO......OOO....",
    ],
    'stun': [
        ".......HHHHH........",
        ".....HHHHHHHHH......",
        "....HHHSSSSSHH......",
        "....HHHSSSEESHH.....",
        "....HHHSSSSSNHH.....",
        ".....HHSSSSSH.......",
        "....JJJJJJJJJJJ.....",
        "..AAJJJJJWWJJJ..AA..",
        ".AAA.JJJJJJJJJ.AAA..",
        "......PPPPPPPP......",
        ".....KK.....KK......",
        "....KKK.....KKK.....",
        "...OOO......OOO.....",
    ],
    'flag': [
        ".......HHHHH........",
        ".....HHHHHHHHH.YYYY.",
        "....HHHSSSSSHH.YYYY.",
        "....HHHSSSEESH..Y...",
        "....HHHSSSSSNH..Y...",
        ".....HHSSSSSH...Y...",
        "....JJJJJJJJJJ..Y...",
        "...AJJJJJWWJJJ..Y...",
        "..AAJJJJJJJJJJ..Y...",
        "......PPPPPPPP..Y...",
        ".....KKK...KKK......",
        ".....KK.....KK......",
        "....OOO.....OOO.....",
    ],
    'dive': [
        "....................",
        "...............HHHH.",
        "..........HHHHHHHHH.",
        "OOOO....HHSSSSSSHHH.",
        "KKKK...HHSSSEESNHHH.",
        "KK....JJJJJJJJJJJ...",
        ".....JJJJJWWJJJJJWW.",
        ".....PPPPPPPPPPP....",
    ],
}


def draw_player(dr, ox, foot_y, team, pose, face=1):
    """ox 是图案水平中心，foot_y 是鞋底下沿。face>0 朝右。"""
    if foot_y > BANNER_TOP:
        raise ValueError('feet overlap banner: %s %s' % (pose, foot_y))
    rows = POSES.get(pose, POSES['run'])
    width_cells = len(rows[0])
    if any(len(row) != width_cells for row in rows):
        raise ValueError('pose %s has uneven rows' % pose)
    u = U
    j, pcol, k = team['j'], team['s'], team['k']
    cmap = {
        'H': HAIR, 'S': SKIN, 'N': (214, 150, 114), 'E': LINE, 'J': j, 'P': pcol,
        'K': k, 'O': SHOE, 'A': j, 'W': WHITE, 'Y': (255, 208, 48),
    }
    h = len(rows) * u
    width = len(rows[0]) * u
    top = foot_y - h
    cells = []
    for ry, row in enumerate(rows):
        for rx, ch in enumerate(row):
            if ch == '.':
                continue
            colx = rx if face > 0 else (len(row) - 1 - rx)
            cells.append((colx, ry, ch))
    occ = set((c[0], c[1]) for c in cells)
    # 先铺一圈深色轮廓，侧身剪影在草地上能分开
    for colx, ry, ch in cells:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if (colx + dx, ry + dy) not in occ:
                px(dr, ox - width / 2 + (colx + dx) * u, top + (ry + dy) * u, u, u, (16, 14, 22))
    for colx, ry, ch in cells:
        px(dr, ox - width / 2 + colx * u, top + ry * u, u, u, cmap[ch])


def floodlights(dr):
    # 两侧光柱
    for x0, sign in ((80, 1), (880, -1)):
        px(dr, x0 - 8, 78, 16, 70, (210, 220, 235))
        px(dr, x0 - 26, 70, 52, 10, (180, 190, 210))
        for i in range(6):
            px(dr, x0 - 6 + i * 2, 72, 3, 6, (255, 244, 200))
        # 光锥
        overlay_pts = [
            (x0, 80),
            (x0 + sign * 220, 430),
            (x0 + sign * 40, 430),
        ]
        # filled later as translucent via a separate image
        return


def background(kind):
    im = Image.new('RGB', (W, H), (8, 14, 32))
    dr = ImageDraw.Draw(im)
    # 夜空
    for y in range(0, 250):
        t = y / 250
        r = int(10 + 18 * t)
        g = int(18 + 28 * t)
        b = int(42 + 30 * t)
        dr.line([(0, y), (W, y)], fill=(r, g, b))
    # 看台
    px(dr, 0, 168, W, 78, (18, 28, 58))
    px(dr, 0, 168, W, 8, (255, 214, 90))
    # 观众点
    rng = 17
    for row in range(5):
        for col in range(48):
            hue = ((col * 13 + row * 7) % 5)
            cols = [(220, 70, 70), (70, 120, 220), (240, 200, 80), (80, 180, 120), (200, 200, 210)]
            if (col + row) % 3 == 0:
                continue
            px(dr, 16 + col * 20, 182 + row * 12, 8, 8, cols[hue])
    # 草地
    for y in range(246, H):
        t = (y - 246) / (H - 246)
        g = int(46 + 28 * (1 - t))
        dr.line([(0, y), (W, y)], fill=(18, g, 32))
    # 草皮条纹
    for i, x in enumerate(range(0, W, 80)):
        if i % 2 == 0:
            dr.rectangle([x, 246, x + 80, H], fill=(22, 92, 42))
    # 球场线停在人物脚上方，不伸进标题栏
    px(dr, 40, 300, W - 80, 6, (230, 236, 220))
    px(dr, 40, 468, W - 80, 6, (230, 236, 220))
    px(dr, 470, 300, 6, 174, (230, 236, 220))
    # 中圈
    dr.ellipse([400, 340, 560, 468], outline=(230, 236, 220), width=6)
    # 灯光
    for x0 in (70, 890):
        px(dr, x0 - 6, 86, 12, 80, (190, 198, 214))
        px(dr, x0 - 28, 78, 56, 12, (160, 170, 190))
        for i in range(5):
            px(dr, x0 - 22 + i * 10, 80, 6, 8, (255, 236, 170))
    if kind == 'special':
        # 必杀的能量光
        for i in range(8):
            dr.ellipse([180 - i * 8, 200 - i * 4, 780 + i * 8, 520 + i * 4], outline=(255, 186, 64))
    return im


def banner(im, title, tone):
    dr = ImageDraw.Draw(im)
    # 金框
    dr.rectangle([16, 16, W - 17, H - 17], outline=GOLD, width=6)
    dr.rectangle([26, 26, W - 27, H - 27], outline=(90, 60, 20), width=2)
    # 底栏
    colors = {
        'win': (18, 48, 120),
        'lose': (120, 28, 36),
        'special': (92, 28, 120),
        'foul': (120, 78, 16),
    }
    bg = colors[tone]
    # 标题栏整体低于鞋底（FOOT=508），中间留出草地
    bar_top = BANNER_TOP
    bar_bot = 616
    dr.rectangle([40, bar_top, W - 41, bar_bot], fill=bg)
    dr.rectangle([40, bar_top, W - 41, bar_top + 8], fill=GOLD)
    dr.rectangle([40, bar_bot - 8, W - 41, bar_bot], fill=GOLD)
    font = ImageFont.truetype(FONT, 52)
    # 描边
    bbox = dr.textbbox((0, 0), title, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (W - tw) / 2
    ty = bar_top + 8 + (bar_bot - 8 - (bar_top + 8) - th) / 2 - bbox[1]
    for dx in (-3, 0, 3):
        for dy in (-3, 0, 3):
            if dx or dy:
                dr.text((tx + dx, ty + dy), title, font=font, fill=(10, 8, 16))
    fill = GOLD if tone != 'lose' else (255, 236, 220)
    dr.text((tx, ty), title, font=font, fill=fill)
    return im


def stars(dr, x, y):
    px(dr, x, y, 10, 10, GOLD)
    px(dr, x + 16, y - 8, 8, 8, WHITE)
    px(dr, x - 14, y + 6, 8, 8, GOLD)


def goal_net(dr, x, side):
    """side 1 = 球门在右侧开口朝左"""
    post = (236, 236, 236)
    if side > 0:
        px(dr, x, 250, 10, 200, post)
        px(dr, x, 250, 70, 10, post)
        px(dr, x + 60, 250, 8, 90, post)
        for i in range(6):
            dr.line([(x + 8, 260 + i * 28), (x + 60, 258 + i * 12)], fill=(200, 210, 220), width=2)
    else:
        px(dr, x, 250, 10, 200, post)
        px(dr, x - 60, 250, 70, 10, post)
        px(dr, x - 60, 250, 8, 90, post)
        for i in range(6):
            dr.line([(x, 260 + i * 28), (x - 52, 258 + i * 12)], fill=(200, 210, 220), width=2)


def paint(key, title, tone):
    im = background('special' if tone == 'special' or key.startswith('special') else 'normal')
    dr = ImageDraw.Draw(im)
    foot = FOOT
    dive_foot = 456  # 横向飞扑悬在门前，鞋底仍高于标题栏
    if key == 'dribble-win':
        draw_player(dr, 600, foot, HOME, 'run', 1)
        draw_ball(dr, 730, foot - 36, 28)
        draw_player(dr, 280, foot, AWAY, 'fall', -1)
        stars(dr, 180, 300)
    elif key == 'dribble-lose':
        draw_player(dr, 280, foot, HOME, 'fall', 1)
        draw_player(dr, 640, foot, AWAY, 'run', -1)
        draw_ball(dr, 500, foot - 36, 28)
        stars(dr, 160, 300)
    elif key == 'pass-win':
        draw_player(dr, 200, foot, HOME, 'pass', 1)
        draw_player(dr, 740, foot, HOME, 'run', 1)
        draw_ball(dr, 470, 340, 26)
        dr.line([(300, 400), (460, 350), (680, 400)], fill=WHITE, width=5)
    elif key == 'pass-lose':
        draw_player(dr, 200, foot, HOME, 'pass', 1)
        draw_player(dr, 640, foot, AWAY, 'kick', -1)
        draw_ball(dr, 500, 380, 28)
        dr.line([(300, 410), (490, 390)], fill=(255, 180, 160), width=5)
    elif key == 'shoot-goal':
        goal_net(dr, 860, 1)
        draw_player(dr, 340, foot, HOME, 'kick', 1)
        draw_ball(dr, 800, 320, 30)
        dr.line([(480, 400), (780, 330)], fill=WHITE, width=6)
        stars(dr, 640, 250)
    elif key == 'shoot-save':
        goal_net(dr, 860, 1)
        draw_player(dr, 220, foot, HOME, 'kick', 1)
        draw_player(dr, 680, dive_foot, AWAY, 'dive', 1)
        draw_ball(dr, 790, 400, 28)
    elif key == 'shoot-miss':
        goal_net(dr, 800, 1)
        draw_player(dr, 260, foot, HOME, 'kick', 1)
        draw_ball(dr, 880, 230, 28)
        dr.line([(400, 400), (860, 240)], fill=(255, 160, 140), width=5)
    elif key == 'special-goal':
        goal_net(dr, 870, 1)
        draw_player(dr, 240, foot, HOME, 'kick', 1)
        for rad, col in ((40, (255, 140, 40)), (26, (255, 220, 80)), (14, WHITE)):
            dr.ellipse([780 - rad, 330 - rad, 780 + rad, 330 + rad], fill=col)
        dr.line([(380, 410), (750, 340)], fill=(255, 180, 60), width=8)
        stars(dr, 560, 240)
    elif key == 'special-save':
        goal_net(dr, 870, 1)
        draw_player(dr, 200, foot, HOME, 'kick', 1)
        draw_player(dr, 640, dive_foot, AWAY, 'dive', 1)
        for rad, col in ((36, (255, 120, 40)), (20, (255, 210, 80))):
            dr.ellipse([790 - rad, 390 - rad, 790 + rad, 390 + rad], fill=col)
    elif key == 'feint-win':
        draw_player(dr, 560, foot, HOME, 'run', 1)
        draw_ball(dr, 690, foot - 36, 26)
        draw_player(dr, 250, foot, AWAY, 'stun', -1)
        stars(dr, 140, 290)
        dr.line([(500, 390), (380, 340)], fill=(180, 220, 255), width=5)
        dr.line([(600, 400), (700, 350)], fill=WHITE, width=5)
    elif key == 'foul':
        draw_player(dr, 340, foot, HOME, 'fall', 1)
        draw_player(dr, 620, foot, AWAY, 'kick', -1)
        px(dr, 800, 250, 48, 68, (255, 214, 40))
        px(dr, 792, 240, 64, 12, SHOE)
        stars(dr, 180, 290)
    elif key == 'offside':
        draw_player(dr, 700, foot, HOME, 'run', 1)
        draw_ball(dr, 830, foot - 36, 26)
        draw_player(dr, 200, foot, AWAY, 'flag', 1)
        dr.line([(500, 280), (500, 490)], fill=(255, 80, 80), width=8)
        px(dr, 476, 280, 48, 10, (255, 80, 80))
    else:
        draw_player(dr, 480, foot, HOME, 'run', 1)
    # 轻微统一阴影在脚下
    banner(im, title, tone)
    return im


def main():
    for d in OUT_DIRS:
        os.makedirs(d, exist_ok=True)
    for key, title, tone in SCENES:
        im = paint(key, title, tone)
        for d in OUT_DIRS:
            path = os.path.join(d, key + '.webp')
            # 无损：有损 webp 会把品红占位符漂成 (210,30,212)，运行时换色对不上
            im.save(path, 'WEBP', lossless=True, quality=100, method=6)
            print('wrote', path, os.path.getsize(path))


if __name__ == '__main__':
    main()
