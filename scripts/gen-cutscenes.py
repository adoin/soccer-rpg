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
U = 8  # 像素单位。小人约 128px 高，在 960 画面上能看清五官和出脚。
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


# 侧身小人，每格 U 像素。字符从左到右是“背后 → 身前”（face>0 时朝右）。
# H 发 S 肤 E 眼 J 衣 P 裤 K 袜 O 鞋 A 臂 W 白（手套/号码）
POSES = {
    'run': [
        "........HHH.........",
        "......HHHHHHH.......",
        ".....HHHSSSHH.......",
        ".....HHSEESSH.......",
        ".....HHSSSSSH.......",
        "......HSSSSH........",
        "....JJJJJJJJJJ......",
        "...AJJJJWJJJJA......",
        "...AJJJJJJJJJA......",
        "....JJJJJJJJJ.......",
        ".....PPPPPPP........",
        ".....PPPPPPP........",
        "....KK....KKK.......",
        "....KK.....KK.......",
        "....KK......K.......",
        "...OOO.....OOO......",
    ],
    'kick': [
        "........HHH.........",
        "......HHHHHHH.......",
        ".....HHHSSSHH.......",
        ".....HHSEESSH.......",
        ".....HHSSSSSH.......",
        "......HSSSSH........",
        "...A.JJJJJJJJ..AAA..",
        "...A.JJJWJJJJ.AAAA..",
        ".....JJJJJJJJ.......",
        ".....PPPPPPP........",
        "....KK.PPPPP........",
        "....KK..............",
        "...OOO......KKKKK...",
        "............KKKKKO..",
        "...............OOO..",
    ],
    'fall': [
        "....................",
        "..............HHH...",
        ".........HHHHHHHH...",
        "........HHSSSHHH....",
        ".......HHSEESSHH....",
        "AA.....HHSSSSH......",
        "AAA...JJJJJJJJJ.....",
        ".A....JJJWJJJJJ.....",
        "......PPPPPPPP......",
        "..KKKKKK....KKKKKK..",
        ".OOO..........OOOO..",
    ],
    'pass': [
        "........HHH.........",
        "......HHHHHHH.......",
        ".....HHHSSSHH.......",
        ".....HHSEESSH.......",
        ".....HHSSSSSH.......",
        "......HSSSSH........",
        "...A.JJJJJJJJ..AA...",
        "...A.JJJWJJJJ.AAA...",
        ".....JJJJJJJJ.......",
        ".....PPPPPPP........",
        "....KK..PPPP........",
        "....KK...KKK........",
        "...OOO....KK........",
        "..........OOO.......",
    ],
    'celebrate': [
        "..A..............A..",
        "..A......HHH.....A..",
        "..SA...HHHHHHH..AS..",
        "...A..HHHSSSHH..A...",
        "......HHSEESSH......",
        "......HHSSSSSH......",
        ".......HSSSSH.......",
        ".....JJJJJJJJJ......",
        ".....JJJWWJJJJ......",
        ".....JJJJJJJJJ......",
        "......PPPPPPP.......",
        ".....KK....KK.......",
        ".....KK....KK.......",
        "....OOO....OOO......",
    ],
    'stun': [
        "........HHH.........",
        "......HHHHHHH.......",
        ".....HHHSSSHH.......",
        ".....HHSEESSH.......",
        ".....HHSSSSSH.......",
        "......HSSSSH........",
        "....JJJJJJJJJJ......",
        "...AJJJJWJJJJ..A....",
        "..AA.JJJJJJJJ.AAA...",
        ".....PPPPPPP........",
        "....KK....KK........",
        "...KKK....KKK.......",
        "..OO......OOO.......",
    ],
    'flag': [
        "........HHH.........",
        "......HHHHHHH..YYYY.",
        ".....HHHSSSHH..YYYY.",
        ".....HHSEESSH..Y....",
        ".....HHSSSSSH..Y....",
        "......HSSSSH...Y....",
        "....JJJJJJJJJ..Y....",
        "...AJJJJWJJJJ..Y....",
        "...AJJJJJJJJJ..Y....",
        "....PPPPPPP....Y....",
        "....KK...KK....Y....",
        "....KK...KK....Y....",
        "...OOO...OOO........",
    ],
}
PAL = None  # filled per call


def draw_player(dr, ox, foot_y, team, pose, face=1):
    """ox 是躯干中心，foot_y 是图案最底一行的下沿。face>0 朝右。"""
    rows = POSES.get(pose, POSES['run'])
    u = U
    j, pcol, k = team['j'], team['s'], team['k']
    cmap = {
        'H': HAIR, 'S': SKIN, 'E': LINE, 'J': j, 'P': pcol, 'K': k,
        'O': SHOE, 'A': j, 'W': WHITE, 'Y': (255, 208, 48),
    }
    h = len(rows) * u
    w = len(rows[0]) * u
    top = foot_y - h
    for ry, row in enumerate(rows):
        for rx, ch in enumerate(row):
            if ch == '.':
                continue
            colx = rx if face > 0 else (len(row) - 1 - rx)
            px(dr, ox - w / 2 + colx * u, top + ry * u, u, u, cmap[ch])


def draw_player_dive(dr, ox, oy, team, face=1):
    """横向飞扑。oy 是身体中线。"""
    u = U
    j, s, k = team['j'], team['s'], team['k']
    def B(x, y, w, h, c):
        left = ox + face * x - w / 2.0
        px(dr, left, oy - y - h / 2.0, w, h, c)
    B(-2 * u, 0, 20 * u, 7 * u, j)
    B(-2 * u, -4 * u, 16 * u, 3.5 * u, s)
    B(10 * u, 1 * u, 8 * u, 8 * u, HAIR)
    B(10 * u, 0, 6 * u, 5 * u, SKIN)
    B(12 * u, 0.6 * u, 1.3 * u, 1.4 * u, LINE)
    B(-14 * u, -1 * u, 8 * u, 3 * u, k)
    B(-16 * u, -1 * u, 4 * u, 2.4 * u, SHOE)
    B(6 * u, 3 * u, 5 * u, 3 * u, WHITE)  # 手套


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
    # 球场线
    px(dr, 40, 300, W - 80, 6, (230, 236, 220))
    px(dr, 40, 520, W - 80, 6, (230, 236, 220))
    px(dr, 470, 300, 6, 226, (230, 236, 220))
    # 中圈
    dr.ellipse([400, 360, 560, 500], outline=(230, 236, 220), width=6)
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
    dr.rectangle([40, 500, W - 41, 600], fill=bg)
    dr.rectangle([40, 500, W - 41, 508], fill=GOLD)
    dr.rectangle([40, 592, W - 41, 600], fill=GOLD)
    font = ImageFont.truetype(FONT, 64)
    # 描边
    bbox = dr.textbbox((0, 0), title, font=font)
    tw = bbox[2] - bbox[0]
    tx = (W - tw) / 2
    ty = 516
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
    foot = 488
    if key == 'dribble-win':
        draw_player(dr, 600, foot, HOME, 'run', 1)
        draw_ball(dr, 710, foot - 28, 28)
        draw_player(dr, 300, foot + 8, AWAY, 'fall', -1)
        stars(dr, 230, 330)
    elif key == 'dribble-lose':
        draw_player(dr, 280, foot + 6, HOME, 'fall', 1)
        draw_player(dr, 620, foot, AWAY, 'run', -1)
        draw_ball(dr, 500, foot - 36, 28)
        stars(dr, 200, 330)
    elif key == 'pass-win':
        draw_player(dr, 200, foot, HOME, 'pass', 1)
        draw_player(dr, 740, foot - 8, HOME, 'run', 1)
        draw_ball(dr, 470, 340, 26)
        dr.line([(280, 420), (460, 350), (700, 400)], fill=WHITE, width=5)
    elif key == 'pass-lose':
        draw_player(dr, 200, foot, HOME, 'pass', 1)
        draw_player(dr, 620, foot, AWAY, 'kick', -1)
        draw_ball(dr, 500, 390, 28)
        dr.line([(270, 430), (490, 400)], fill=(255, 180, 160), width=5)
    elif key == 'shoot-goal':
        goal_net(dr, 860, 1)
        draw_player(dr, 360, foot, HOME, 'kick', 1)
        draw_ball(dr, 800, 320, 30)
        dr.line([(460, 420), (780, 330)], fill=WHITE, width=6)
        stars(dr, 680, 260)
    elif key == 'shoot-save':
        goal_net(dr, 860, 1)
        draw_player(dr, 240, foot, HOME, 'kick', 1)
        draw_player_dive(dr, 640, 390, AWAY, 1)
        draw_ball(dr, 760, 370, 28)
    elif key == 'shoot-miss':
        goal_net(dr, 800, 1)
        draw_player(dr, 280, foot, HOME, 'kick', 1)
        draw_ball(dr, 880, 230, 28)
        dr.line([(400, 420), (860, 240)], fill=(255, 160, 140), width=5)
    elif key == 'special-goal':
        goal_net(dr, 870, 1)
        draw_player(dr, 250, foot, HOME, 'kick', 1)
        for rad, col in ((40, (255, 140, 40)), (26, (255, 220, 80)), (14, WHITE)):
            dr.ellipse([780 - rad, 330 - rad, 780 + rad, 330 + rad], fill=col)
        dr.line([(360, 430), (750, 340)], fill=(255, 180, 60), width=8)
        stars(dr, 600, 250)
    elif key == 'special-save':
        goal_net(dr, 870, 1)
        draw_player(dr, 200, foot, HOME, 'kick', 1)
        draw_player_dive(dr, 600, 380, AWAY, 1)
        for rad, col in ((36, (255, 120, 40)), (20, (255, 210, 80))):
            dr.ellipse([740 - rad, 360 - rad, 740 + rad, 360 + rad], fill=col)
    elif key == 'feint-win':
        draw_player(dr, 520, foot, HOME, 'run', 1)
        draw_ball(dr, 640, foot - 30, 26)
        draw_player(dr, 260, foot + 4, AWAY, 'stun', -1)
        stars(dr, 180, 310)
        dr.line([(460, 390), (360, 340)], fill=(180, 220, 255), width=5)
        dr.line([(560, 400), (660, 350)], fill=WHITE, width=5)
    elif key == 'foul':
        draw_player(dr, 360, foot + 4, HOME, 'fall', 1)
        draw_player(dr, 600, foot, AWAY, 'kick', -1)
        px(dr, 760, 280, 48, 68, (255, 214, 40))
        px(dr, 752, 270, 64, 12, SHOE)
        stars(dr, 250, 320)
    elif key == 'offside':
        draw_player(dr, 680, foot, HOME, 'run', 1)
        draw_ball(dr, 790, foot - 28, 26)
        draw_player(dr, 220, foot, AWAY, 'flag', 1)
        dr.line([(520, 280), (520, 490)], fill=(255, 80, 80), width=8)
        px(dr, 496, 280, 48, 10, (255, 80, 80))
    else:
        draw_player(dr, 480, 500, HOME, 'run', 1)
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
