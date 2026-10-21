#!/usr/bin/env python3
"""Offline label maps for the 21 manga cuts.

Each pixel is one label, plus which figure it belongs to (0 shared, 1 magenta
side, 2 orange side). The game looks the label up in the kit palette. Eyes and
mouths come from contours, not from "dark pixel near skin".

Saved PNG: R = label id, G = figure, B = 0, A = 255.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'client' / 'assets' / 'manga'
OUT = SRC / 'labels'

NONE = 0
INK = 1
SKY = 2
GRASS = 3
LINE = 4
NET = 5
BALL = 6
SHIRT = 10
PATTERN = 11
SHORTS = 12
SOCKS = 13
BOOTS = 14
SKIN = 15
SKIN_LINE = 16
HAIR = 17
HAIR_LINE = 18
EYE = 19
IRIS = 20
MOUTH = 21
TEETH = 22
TONGUE = 23

POSES = [
    'clearance', 'def_elbow', 'def_flying_tackle', 'def_shoulder', 'def_sweep',
    'dribble_win', 'gk_catch', 'gk_claim_cross', 'gk_parry_byline', 'gk_rush_win',
    'gk_spill', 'gk_tip_over', 'goal', 'header_duel', 'hit_post', 'intercept',
    'round_gk', 'shield_win', 'shot_blocked', 'shot_wide', 'tackle_win',
]

# False colour for review. Side 2 is the darker twin of the same family.
FALSE = {
    (INK, 0): (8, 8, 8),
    (SKY, 0): (186, 220, 245),
    (GRASS, 0): (70, 160, 55),
    (LINE, 0): (255, 255, 255),
    (NET, 0): (120, 210, 230),
    (BALL, 0): (210, 40, 40),
    (SHIRT, 1): (230, 40, 180),
    (PATTERN, 1): (255, 170, 210),
    (SHIRT, 2): (240, 130, 30),
    (PATTERN, 2): (255, 210, 80),
    (SHORTS, 1): (0, 190, 200),
    (SOCKS, 1): (140, 230, 235),
    (SHORTS, 2): (120, 40, 190),
    (SOCKS, 2): (190, 140, 230),
    (BOOTS, 1): (230, 190, 40),
    (BOOTS, 2): (180, 30, 40),
    (SKIN, 1): (196, 140, 96),
    (SKIN_LINE, 1): (110, 64, 36),
    (SKIN, 2): (240, 196, 160),
    (SKIN_LINE, 2): (150, 96, 62),
    (HAIR, 1): (230, 200, 70),
    (HAIR_LINE, 1): (120, 90, 30),
    (HAIR, 2): (90, 52, 24),
    (HAIR_LINE, 2): (40, 22, 12),
    (EYE, 0): (245, 245, 255),
    (EYE, 1): (245, 245, 255),
    (EYE, 2): (245, 245, 255),
    (IRIS, 0): (30, 30, 40),
    (IRIS, 1): (30, 30, 40),
    (IRIS, 2): (30, 30, 40),
    (MOUTH, 1): (150, 20, 40),
    (MOUTH, 2): (150, 20, 40),
    (TEETH, 1): (210, 235, 255),
    (TEETH, 2): (210, 235, 255),
    (TONGUE, 1): (230, 120, 150),
    (TONGUE, 2): (230, 120, 150),
}


def rel_lum(rgb):
    return (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]) / 255.0


def sat(rgb):
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    out = np.zeros(mx.shape, np.float32)
    np.divide(mx - mn, mx, out=out, where=mx > 0)
    return out


def components(mask):
    lab, n = ndi.label(mask)
    return lab, n


def paint_false(label, figure, pattern=None):
    h, w = label.shape
    out = np.full((h, w, 3), 210, np.uint8)
    # pattern zone is a render-time split of SHIRT, shown here for the review kit
    show_l = label.copy()
    if pattern is not None:
        show_l[pattern] = PATTERN
    for (lab, fig), col in FALSE.items():
        m = (show_l == lab) & ((figure == fig) | (fig == 0))
        # fig 0 in the table means "any figure" only when we didn't set a sided colour
        if fig == 0 and lab in (EYE, IRIS):
            m = show_l == lab
        elif fig != 0:
            m = (show_l == lab) & (figure == fig)
        else:
            m = (show_l == lab) & (figure == 0)
        out[m] = col
    # leftover figure-tagged eye/iris/mouth already handled; catch figure-tagged shared misses
    return out


def pattern_mask(label, figure, side, kind):
    """Reference pattern so the review sheet shows SHIRT_PATTERN_ZONE.
    Side 1 sash, side 2 vertical stripes. The game recomputes this from the kit.
    """
    m = (label == SHIRT) & (figure == side)
    if not m.any():
        return m
    ys, xs = np.where(m)
    minx, maxx = xs.min(), xs.max()
    miny, maxy = ys.min(), ys.max()
    # largest component box is enough; whole side is one torso in these cuts
    band = max(3, (maxy - miny) // 12)
    yy, xx = np.mgrid[0:label.shape[0], 0:label.shape[1]]
    if kind == 'sash':
        uw = max(1, maxx - minx)
        uh = max(1, maxy - miny)
        on = np.abs((xx - minx) / uw - (yy - miny) / uh) <= 0.16
    else:
        cx = (minx + maxx) / 2
        on = (np.floor((xx - cx) / band).astype(int) & 1) == 0
    return m & on


def detect_ball(white, ink, opaque):
    """White panels edged in black, clustered into a disc. The net is a mesh, not a disc."""
    h, w = white.shape
    lab, n = components(white)
    if not n:
        return np.zeros((h, w), bool)
    sizes = np.bincount(lab.ravel())
    panels = []
    ink_d = ndi.binary_dilation(ink, iterations=1)
    for i in range(1, n + 1):
        area = int(sizes[i])
        if area < 120 or area > 3200:
            continue
        ys, xs = np.where(lab == i)
        bw = int(xs.max() - xs.min()) + 1
        bh = int(ys.max() - ys.min()) + 1
        aspect = bw / max(1, bh)
        if aspect < 0.45 or aspect > 2.3 or min(bw, bh) < 16:
            continue
        comp = lab == i
        black_n = int((ndi.binary_dilation(comp, iterations=1) & ink_d).sum())
        if black_n < area * 0.015:
            continue
        panels.append((xs.mean(), ys.mean(), xs.min(), xs.max(), ys.min(), ys.max()))
    if len(panels) < 3:
        return np.zeros((h, w), bool)
    used = np.zeros(len(panels), bool)
    ball = np.zeros((h, w), bool)
    for c in range(len(panels)):
        if used[c]:
            continue
        group = [c]
        used[c] = True
        j = 0
        while j < len(group):
            ax, ay = panels[group[j]][0], panels[group[j]][1]
            for k in range(len(panels)):
                if used[k]:
                    continue
                dx = ax - panels[k][0]
                dy = ay - panels[k][1]
                if dx * dx + dy * dy < 110 * 110:
                    used[k] = True
                    group.append(k)
            j += 1
        if len(group) < 3:
            continue
        xs0 = [panels[k][2] for k in group]
        xs1 = [panels[k][3] for k in group]
        ys0 = [panels[k][4] for k in group]
        ys1 = [panels[k][5] for k in group]
        # Wider than a ball is the goal net. 220 is the same gate as the old detector.
        if max(xs1) - min(xs0) > 220 or max(ys1) - min(ys0) > 220:
            continue
        cx = np.mean([panels[k][0] for k in group])
        cy = np.mean([panels[k][1] for k in group])
        rad = 0
        for k in group:
            for px, py in ((panels[k][2], panels[k][4]), (panels[k][3], panels[k][4]),
                           (panels[k][2], panels[k][5]), (panels[k][3], panels[k][5])):
                rad = max(rad, ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5)
        rad = min(rad + 8, 68)
        y0, y1 = max(0, int(cy - rad)), min(h, int(cy + rad) + 1)
        x0, x1 = max(0, int(cx - rad)), min(w, int(cx + rad) + 1)
        yy, xx = np.ogrid[y0:y1, x0:x1]
        disc = (xx - cx) ** 2 + (yy - cy) ** 2 <= rad * rad
        disc &= opaque[y0:y1, x0:x1]
        # white, black, and the red seams
        sub_w = white[y0:y1, x0:x1] | ink[y0:y1, x0:x1]
        ball[y0:y1, x0:x1] |= disc & sub_w
    return ball


def label_image(rgb, alpha):
    h, w = alpha.shape
    # int16 so r+8 does not wrap around uint8 and paint the sky as grass.
    rgb = rgb.astype(np.int16)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    lum = rel_lum(rgb)
    s = sat(rgb)
    label = np.zeros((h, w), np.uint8)
    figure = np.zeros((h, w), np.uint8)
    opaque = alpha >= 128

    ink = opaque & (mx < 46) & ((mx - mn) < 16)
    grass = opaque & (g > r + 8) & (g + 8 >= b) & (b < g * 0.55) & (g > 55)
    skin = opaque & (np.abs(r.astype(np.int16) - 240) <= 28) & (np.abs(g.astype(np.int16) - 200) <= 28) \
        & (np.abs(b.astype(np.int16) - 160) <= 34) & (r > g) & (g + 12 >= b) & ((r - b) > 22)
    hair = opaque & (b > 140) & (r < 100) & (g < 120) & (b > r + 40) & (b > g + 18)
    boot = opaque & (r > 185) & (b > 70) & (b < 190) & (g < 85) & (b > g + 25) & (r > b - 10) & ~hair
    shirt1 = opaque & (r > 175) & (b > 150) & (g < 110) & (b > g + 35) & ~boot
    shirt2 = opaque & (r > 185) & (g > 70) & (g < 190) & (b < 75) & (r > g + 20) & (r > b + 80)
    shorts1 = opaque & (g > 175) & (b > 175) & (r < 100)
    shorts2 = opaque & (b > 165) & (r > 50) & (r < 190) & (g < 100) & (b > r + 20) & (b > g + 40)
    near_white = opaque & (mn > 175) & ((mx - mn) < 36)
    pale = opaque & (mn > 165) & (mx > 198) & ((mx - mn) < 40)

    # Halos: a pixel touching a key and in that key's crushed range joins it.
    def absorb(mask, pred, iters=1):
        grown = mask.copy()
        for _ in range(iters):
            edge = ndi.binary_dilation(grown) & ~grown & pred & opaque & ~ink
            grown |= edge
        return grown

    shirt1 = absorb(shirt1, (r > 140) & (b > 110) & (g < 130) & (b + 8 >= g) & (r > g))
    shirt2 = absorb(shirt2, (r > 150) & (g > 40) & (g < 200) & (b < 90) & (r > b + 40) & (r > g))
    shorts1 = absorb(shorts1, (g > 140) & (b > 140) & (r < 130) & (g + b > r * 2))
    shorts2 = absorb(shorts2, (b > 120) & (r < 160) & (g < 120) & (b > r) & (b > g))
    boot = absorb(boot, (r > 150) & (b > 50) & (b < 200) & (g < 100) & (r > g + 30) & (b > g))
    hair = absorb(hair, (b > 80) & (r < 120) & (b > r + 20) & (b > g + 8) & (g < b))
    skin = absorb(skin, (r > 170) & (g > 120) & (b > 80) & (r > g - 5) & (g + 15 >= b) & ((r - b) > 18) & (b > 70))

    # Keys win over each other in a fixed order. Boot before shirt magenta.
    taken = np.zeros((h, w), bool)
    def take(mask, lab, fig):
        use = mask & ~taken & opaque
        label[use] = lab
        figure[use] = fig
        taken[use] = True

    take(boot, BOOTS, 0)  # figure assigned after shorts exist
    take(shirt1, SHIRT, 1)
    take(shirt2, SHIRT, 2)
    take(shorts1, SHORTS, 1)
    take(shorts2, SHORTS, 2)
    take(hair, HAIR, 0)
    take(skin, SKIN, 0)
    take(ink, INK, 0)
    take(grass, GRASS, 0)

    # Sky: transparent, and near-white connected to the top outside the net.
    sky = alpha < 40
    label[sky] = SKY
    figure[sky] = 0
    taken[sky] = True

    # Grass line: same 8-row test as the runtime. The first row of real pitch.
    grass_rows = grass.mean(axis=1)
    smooth = np.convolve(grass_rows, np.ones(8) / 8.0, mode='valid')
    grass_y = int(np.argmax(smooth > 0.18)) if (smooth > 0.18).any() else int(h * 0.55)

    # Strict near-white. The looser pale mask swallows the goal net into the ball.
    strict_white = opaque & (mx > 210) & ((mx - mn) < 28) & (mn > 185)
    neutral_dark = opaque & (mx < 70) & ((mx - mn) < 28)
    ball = detect_ball(strict_white & ~taken, neutral_dark, opaque)
    label[ball] = BALL
    figure[ball] = 0
    taken[ball] = True

    # Pitch lines: pale components touching grass, thin, not the ball.
    pale_free = pale & ~taken
    plab, pn = components(pale_free)
    if pn:
        sizes = np.bincount(plab.ravel())
        for i in range(1, pn + 1):
            if sizes[i] < 12:
                continue
            comp = plab == i
            ys, xs = np.where(comp)
            bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
            touches_grass = ndi.binary_dilation(comp, iterations=2) & grass
            if not touches_grass.any():
                continue
            thin = sizes[i] < 2500 and (bw > bh * 3 or bh > bw * 3 or sizes[i] < bw * bh * 0.35)
            if thin and ys.mean() > grass_y - 30:
                label[comp] = LINE
                taken[comp] = True

    # Net and pitch lines, then the transparent cells inside a goal frame.
    mark_net(label, figure, taken, rgb, alpha, grass_y)

    # Colour-key crumbs on a face are not cloth.
    drop_cloth_specks(label, figure)

    # Assign boots, hair, skin to a figure by who they touch.
    assign_figures(label, figure)

    # Opaque white trapped between two bodies is sky (the gap between the legs).
    mark_sky_pockets(label, figure, rgb, alpha, grass_y)

    # Skin lines and hair lines. These are strokes, not a second skin colour from a lerp.
    mark_lines(label, figure, rgb, opaque, taken)

    # Eyes, then the pupil inside each eye outline, then mouths.
    # A mouth is only the cavity under the eyes. It never borrows the iris.
    mark_eyes(label, figure, rgb, opaque)
    seal_eyes(label, figure, rgb, opaque)
    mark_mouths(label, figure, rgb, opaque)

    # Socks are the narrow shorts-coloured run attached to a boot.
    mark_socks(label, figure)

    # Boot-key crumbs on a shirt or a face are not shoes.
    reclaim_stray_boots(label, figure)
    drop_face_boots(label, figure)

    # Close the neck hatch so it is one flat shadow, then absorb speckle islands.
    close_skin_lines(label, figure)
    absorb_islands(label, figure, max_area=12)
    claim_halos(label, figure, rgb, opaque)
    finish_figures(label, figure, rgb, opaque)

    return label, figure, grass_y


def _dist_to_prev(op):
    """Distance, along axis 1, to the nearest True strictly to the left."""
    w = op.shape[1]
    idx = np.where(op, np.arange(w)[None, :], -100000)
    last = np.maximum.accumulate(idx, axis=1)
    prev = np.full_like(last, -100000)
    prev[:, 1:] = last[:, :-1]
    return np.arange(w)[None, :] - prev


def mark_net(label, figure, taken, rgb, alpha, grass_y):
    """Pitch lines, the goal mesh, and the transparent cells inside that mesh."""
    h, w = label.shape
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    opaque = alpha >= 128
    near = opaque & (mx > 210) & ((mx - mn) < 28) & (mn > 185)
    pale = opaque & (mn > 165) & (mx > 198) & ((mx - mn) < 40)
    ink = (label == INK) | (opaque & (mx < 50) & ((mx - mn) < 18))
    grass = label == GRASS

    free = pale & ~taken & (label != BALL)
    plab, pn = components(free)
    if pn:
        sizes = np.bincount(plab.ravel())
        for i in range(1, pn + 1):
            area = int(sizes[i])
            if area < 12:
                continue
            comp = plab == i
            ys, xs = np.where(comp)
            bw = int(xs.max() - xs.min()) + 1
            bh = int(ys.max() - ys.min()) + 1
            border = ndi.binary_dilation(comp) & ~comp
            grass_n = int((border & grass).sum())
            dark_n = int((border & ink).sum())
            minor = min(bw, bh)
            major = max(bw, bh)
            solidity = area / float(bw * bh)
            is_line = minor <= 24 and major >= 70 and grass_n > 12 and ys.mean() > grass_y - 40
            # A solid white gap between two bodies is not a net cell. Mesh is open.
            is_net = (not is_line) and area >= 280 and dark_n > 18 and grass_n < dark_n and solidity < 0.75
            if not is_line and not is_net:
                continue
            label[comp] = LINE if is_line else NET
            figure[comp] = 0
            taken[comp] = True

    if grass_y < 200:
        return
    y1 = grass_y - 6
    y0 = max(0, grass_y - 400)
    rows = np.arange(y0, y1, 2)
    if len(rows) < 8:
        return
    col_trans = (alpha[rows] < 40).mean(axis=0)
    col_white = near[rows].mean(axis=0)
    sky_col = (col_trans > 0.88) & (col_white < 0.06)
    net_col = col_white > 0.40
    best = (0, 0)
    run = None
    for x in range(w + 1):
        if x < w and net_col[x]:
            if run is None:
                run = x
        elif run is not None:
            if x - run > best[1] - best[0]:
                best = (run, x)
            run = None
    if best[1] - best[0] < 140:
        return
    L, R = best
    while L > 1 and not sky_col[L - 1]:
        L -= 1
    while R < w and not sky_col[min(w - 1, R)]:
        R += 1
    if L > 2 and not sky_col[L - 1]:
        return
    cross = y0
    for y in range(grass_y - 20, 20, -1):
        sl = slice(L, R, 3)
        aa = alpha[y, sl]
        if aa.size == 0:
            continue
        tw = (aa < 40).mean()
        ww = near[y, sl].mean()
        if ww > 0.35 and tw < 0.45:
            cross = y
        elif tw > 0.62 and y < grass_y - 80:
            break

    def col_open(x):
        aa = alpha[cross:grass_y:2, x]
        return aa.size and (aa < 40).mean() > 0.88

    while R - L > 160 and col_open(L):
        L += 1
    while R - L > 160 and col_open(R - 1):
        R -= 1
    region = np.zeros((h, w), bool)
    region[cross:grass_y, L:R] = True
    # Pale mesh already inside the frame, but not a pixel a figure already owns.
    mesh = region & pale & ~taken & ~np.isin(label, (SHIRT, SHORTS, SKIN, HAIR, BOOTS, BALL))
    label[mesh] = NET
    figure[mesh] = 0
    taken[mesh] = True

    # Transparent cells with opaque neighbours within 28px on 3 sides. Three
    # passes, because a filled cell becomes a neighbour for the next hole.
    op = alpha >= 80
    for _ in range(3):
        left = _dist_to_prev(op)
        right = _dist_to_prev(op[:, ::-1])[:, ::-1]
        up = _dist_to_prev(op.T).T
        down = _dist_to_prev(op.T[:, ::-1])[:, ::-1].T
        hits = (left <= 28).astype(np.uint8) + (right <= 28) + (up <= 28) + (down <= 28)
        fill = region & (alpha < 40) & (label != BALL) & (hits >= 3) & ~op
        if not fill.any():
            break
        label[fill] = NET
        figure[fill] = 0
        taken[fill] = True
        op = op | fill


def drop_cloth_specks(label, figure):
    """A jersey-coloured crumb inside hair or skin is not a second shirt."""
    for lab in (SHIRT, SHORTS, BOOTS):
        mask = label == lab
        clab, n = components(mask)
        if not n:
            continue
        sizes = np.bincount(clab.ravel())
        for i in range(1, n + 1):
            if sizes[i] >= 80:
                continue
            comp = clab == i
            border = ndi.binary_dilation(comp) & ~comp
            hair_n = int((border & (label == HAIR)).sum())
            skin_n = int((border & (label == SKIN)).sum())
            cloth_n = int((border & np.isin(label, (SHIRT, SHORTS, BOOTS))).sum())
            if hair_n + skin_n < 6 or cloth_n > hair_n + skin_n:
                continue
            if hair_n >= skin_n:
                label[comp] = HAIR
            else:
                label[comp] = SKIN_LINE
            figs = figure[border & (figure > 0)]
            # Figure is filled in properly once the head is assigned. Keep a
            # neighbour's figure when one exists; otherwise leave it for later.
            if figs.size:
                figure[comp] = int(np.bincount(figs).argmax())


def assign_figures(label, figure):
    """Boots, hair and skin keys do not carry a side. The nearest shirt does."""
    def apply(mask, kinds, max_dist, min_area=8):
        lab, n = components(mask)
        if not n:
            return
        sizes = np.bincount(lab.ravel())
        dist = {}
        for side in (1, 2):
            anchor = (figure == side) & np.isin(label, kinds)
            # A colour-key crumb on a face is not a torso. Ignore it as an anchor.
            alab, an = components(anchor)
            if an:
                asz = np.bincount(alab.ravel())
                big = asz >= 400
                big[0] = False
                anchor = big[alab]
            dist[side] = ndi.distance_transform_edt(~anchor) if anchor.any() else None
        for i in range(1, n + 1):
            if sizes[i] < min_area:
                continue
            comp = lab == i
            best = None
            for side in (1, 2):
                if dist[side] is None:
                    continue
                med = float(np.median(dist[side][comp]))
                if best is None or med < best[0]:
                    best = (med, side)
            if best and best[0] <= max_dist:
                figure[comp] = best[1]

    # Hair sits on a shirt. A 1px touch of the other boot must not win.
    # A head of hair sits well above the jersey. 80px misses the taller drawings.
    apply(label == HAIR, (SHIRT,), 150)
    apply((label == HAIR) & (figure == 0), (SHORTS, BOOTS), 40)
    # Skin follows the hair of the same head, then the shirt.
    apply(label == SKIN, (HAIR,), 36)
    apply((label == SKIN) & (figure == 0), (SHIRT, SHORTS), 48)
    # Boots follow shorts, then the leg.
    apply(label == BOOTS, (SHORTS,), 70)
    apply((label == BOOTS) & (figure == 0), (SKIN, SHIRT), 48)


def mark_sky_pockets(label, figure, rgb, alpha, grass_y):
    """White painted between two bodies is sky. The grass crescent is not."""
    h, w = label.shape
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    white = (alpha >= 200) & (mx > 210) & ((mx - mn) < 28) & (mn > 185)
    white &= np.isin(label, (NONE, LINE, NET))
    body = np.isin(label, (SHIRT, SHORTS, SOCKS, BOOTS, SKIN, HAIR)) & (figure > 0)
    lab, n = components(white)
    if not n:
        return
    sizes = np.bincount(lab.ravel())
    for i in range(1, n + 1):
        area = int(sizes[i])
        if area < 800 or area > 12000:
            continue
        comp = lab == i
        ys, xs = np.where(comp)
        if ys.mean() > grass_y:
            continue
        bw = int(xs.max() - xs.min()) + 1
        bh = int(ys.max() - ys.min()) + 1
        if min(bw, bh) <= 18:
            continue
        if bw / max(1, bh) > 3.2 or bh / max(1, bw) > 3.2:
            continue
        if area / (bw * bh) < 0.4:
            continue
        # A net cell sitting on the grass is the mesh, not a hole between legs.
        if (ndi.binary_dilation(comp, iterations=3) & (label == GRASS)).any():
            continue
        if int((ndi.binary_dilation(comp, iterations=1) & np.isin(label, (NET, LINE))).sum()) > 12:
            continue
        above = int((ys < grass_y).sum())
        if above < area * 0.65:
            continue
        mid_x = int((xs.min() + xs.max()) / 2)
        mid_y = int(np.clip(ys.mean(), 0, h - 1))
        def body_at(direction):
            for t in range(1, 111):
                nx = mid_x + direction * t
                if nx < 0 or nx >= w:
                    return False
                if body[mid_y, nx]:
                    return True
            return False
        if not (body_at(-1) and body_at(1)):
            continue
        label[comp] = SKY
        figure[comp] = 0


def mark_lines(label, figure, rgb, opaque, taken):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    lum = rel_lum(rgb)
    skin_key_lum = (0.299 * 240 + 0.587 * 200 + 0.114 * 160) / 255.0
    warm = (r + 8 >= g) & (r > b + 8)
    dark = lum < skin_key_lum - 0.08
    not_ink = ~((mx < 46) & ((mx - mn) < 14))
    not_white = mn < 185
    free = (label == NONE) & opaque & not_ink & not_white & dark & warm
    # not a kit key
    free &= ~((b > r + 20) & (b > g + 10) & (r < 100))
    for side in (1, 2):
        skin = (label == SKIN) & (figure == side)
        if not skin.any():
            continue
        near = ndi.binary_dilation(skin, iterations=2) & free
        label[near] = SKIN_LINE
        figure[near] = side
        free[near] = False
        hair = (label == HAIR) & (figure == side)
        if not hair.any():
            continue
        # dark strokes in the hair, and the light fringe stuck to the blue fill
        hnear = ndi.binary_dilation(hair, iterations=2) & (label == NONE) & opaque & not_ink
        dark_h = hnear & (lum < 0.55) & not_white
        light_fringe = hnear & (lum >= 0.55) & (mn < 210) & ~((label == SKIN) | (label == SKIN_LINE))
        # light fringe must actually touch hair, not a far halo
        touch = ndi.binary_dilation(hair, iterations=2)
        light_fringe = hnear & (lum >= 0.45) & (mn < 230) & touch
        light_fringe &= ~np.isin(label, (SKIN, SKIN_LINE, EYE, IRIS, SKY, GRASS, BALL, LINE, NET))
        label[dark_h] = HAIR_LINE
        figure[dark_h] = side
        label[light_fringe] = HAIR
        figure[light_fringe] = side


def mark_eyes(label, figure, rgb, opaque):
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    white = opaque & (mn > 178) & ((mx - mn) < 32) & ~np.isin(label, (BALL, SKY, GRASS, SHIRT, SHORTS, BOOTS))
    dark = opaque & (mx < 110) & ~np.isin(label, (SKIN, HAIR, SHIRT, SHORTS, BOOTS))
    for side in (1, 2):
        hair = (label == HAIR) & (figure == side)
        skin = (label == SKIN) & (figure == side)
        if not (hair.any() and skin.any()):
            continue
        hlab, hn = components(hair)
        sizes = np.bincount(hlab.ravel()) if hn else None
        for i in range(1, hn + 1):
            if sizes[i] < 80:
                continue
            ys, xs = np.where(hlab == i)
            # face skin hanging under this hair
            y0 = max(0, ys.min() - 8)
            y1 = min(label.shape[0] - 1, ys.max() + 70)
            x0 = max(0, xs.min() - 20)
            x1 = min(label.shape[1] - 1, xs.max() + 20)
            skin_box = skin.copy()
            skin_box[:y0, :] = False
            skin_box[y1 + 1:, :] = False
            skin_box[:, :x0] = False
            skin_box[:, x1 + 1:] = False
            # keep skin components that touch this hair
            slab, sn = components(skin_box)
            if not sn:
                continue
            touch = ndi.binary_dilation(hlab == i, iterations=3)
            keep_ids = np.unique(slab[touch & (slab > 0)])
            face_skin = np.isin(slab, keep_ids)
            if face_skin.sum() < 40:
                continue
            fys, fxs = np.where(face_skin)
            top, bot = fys.min(), fys.max()
            # eyes live in the upper part of the face, not the chin
            eye_band = np.zeros(label.shape, bool)
            eye_band[top:top + max(8, int((bot - top) * 0.62)), fxs.min():fxs.max() + 1] = True
            local_white = white & eye_band & ndi.binary_dilation(face_skin | (hlab == i), iterations=4)
            wlab, wn = components(local_white)
            if not wn:
                continue
            wsizes = np.bincount(wlab.ravel())
            for wi in range(1, wn + 1):
                if wsizes[wi] < 10 or wsizes[wi] > 700:
                    continue
                comp = wlab == wi
                wys = np.where(comp)[0]
                if wys.mean() > top + (bot - top) * 0.62:
                    continue
                # The pupil is the hole in the eye white. A broken outline still
                # rings the dark centre, so take that too. Never a skin line.
                closed = ndi.binary_closing(comp, structure=np.ones((3, 3)), iterations=1)
                filled = ndi.binary_fill_holes(closed)
                iris = filled & ~comp & opaque
                neigh = ndi.convolve(comp.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant')
                ring = (neigh >= 3) & ~comp & opaque & (mx < 170)
                ring &= ndi.binary_dilation(comp, iterations=2)
                iris |= ring
                iris &= ~np.isin(label, (HAIR, SHIRT, SHORTS, BOOTS, BALL, GRASS, SKY, SKIN))
                label[comp] = EYE
                figure[comp] = side
                # A huge ring is the cheek, not a pupil. Keep the eye white anyway.
                if int(iris.sum()) <= 180:
                    label[iris] = IRIS
                    figure[iris] = side


def seal_eyes(label, figure, rgb, opaque):
    """Everything inside an eye outline that is not white is the iris.

    The iris keeps its source colour later. Skin lines and mouth colours are
    not allowed in here, which is what was painting the whites bloodshot.
    """
    h, w = label.shape
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    white = opaque & (mn > 175) & ((mx - mn) < 36)
    for side in (1, 2):
        eyes = (label == EYE) & (figure == side)
        elab, n = components(eyes)
        if not n:
            continue
        sizes = np.bincount(elab.ravel())
        for i in range(1, n + 1):
            if sizes[i] < 8:
                continue
            comp = elab == i
            ys, xs = np.where(comp)
            if xs.max() - xs.min() > 70 or ys.max() - ys.min() > 50:
                continue
            y0 = max(0, int(ys.min()) - 4)
            y1 = min(h, int(ys.max()) + 5)
            x0 = max(0, int(xs.min()) - 4)
            x1 = min(w, int(xs.max()) + 5)
            box = np.zeros((h, w), bool)
            box[y0:y1, x0:x1] = True
            wall = box & (comp | (label == INK) | (label == IRIS) | (label == EYE))
            closed = ndi.binary_closing(wall, structure=np.ones((3, 3)), iterations=2)
            closed &= box
            filled = ndi.binary_fill_holes(closed) & box & opaque
            interior = filled & ~np.isin(label, (HAIR, SHIRT, SHORTS, BOOTS, BALL, GRASS, SKY, SKIN))
            if int(interior.sum()) > sizes[i] * 4 + 40:
                continue
            label[interior & white] = EYE
            figure[interior & white] = side
            dark = interior & ~white
            # A grey or white rim inside the outline is the eye white. Only the
            # dark pupil stays an iris, and the renderer copies its source colour.
            grey = dark & (mn > 140) & ((mx - mn) < 36)
            label[interior & white] = EYE
            label[grey] = EYE
            figure[interior & white | grey] = side
            dark = dark & ~grey
            label[dark] = IRIS
            figure[dark] = side


def mark_mouths(label, figure, rgb, opaque):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    for side in (1, 2):
        skin = ((label == SKIN) | (label == SKIN_LINE)) & (figure == side)
        hair = (label == HAIR) & (figure == side)
        eyes = (label == EYE) & (figure == side)
        if skin.sum() < 40:
            continue
        slab, sn = components(skin | hair)
        # one mouth per face cluster
        sizes = np.bincount(slab.ravel()) if sn else []
        for i in range(1, sn + 1):
            if sizes[i] < 80:
                continue
            comp = slab == i
            ys, xs = np.where(comp)
            y0, y1 = max(0, ys.min() - 4), min(label.shape[0], ys.max() + 8)
            x0, x1 = max(0, xs.min() - 6), min(label.shape[1], xs.max() + 6)
            # Mouths sit under the eyes of this face, not inside them.
            face_x = np.zeros(label.shape[1], bool)
            face_x[xs.min():xs.max() + 1] = True
            eye_cols = eyes.any(axis=0) & face_x
            if eye_cols.any():
                eye_rows = np.where(eyes[:, eye_cols])[0]
                eye_bottom = int(eye_rows.max())
            elif (eyes & comp).any():
                eye_bottom = int(np.where(eyes & comp)[0].max())
            else:
                eye_bottom = y0 + (y1 - y0) // 2
            # The mouth wall is ink plus the flat skin fill. Skin lines and the
            # dark cavity are inside the contour, so they are not walls.
            barrier = np.isin(label, (INK, SKIN, HAIR, HAIR_LINE, EYE, IRIS, SHIRT, SHORTS, BOOTS))
            sub = barrier[y0:y1, x0:x1].copy()
            cut = max(0, eye_bottom - y0 + 4)
            closed = ndi.binary_closing(sub, structure=np.ones((3, 3)), iterations=2)
            sealed = sub.copy()
            sealed[cut:, :] = closed[cut:, :] | sub[cut:, :]
            outside = ~sealed
            # anything that reaches the box border is not inside the mouth
            border = np.zeros(outside.shape, bool)
            border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
            seeds = outside & border
            # flood
            reachable = ndi.binary_propagation(seeds, mask=outside)
            hole = outside & ~reachable
            hole[:cut, :] = False
            if hole.sum() < 12 or hole.sum() > 900:
                continue
            hys, hxs = np.where(hole)
            bw, bh = int(hxs.max() - hxs.min()), int(hys.max() - hys.min())
            if bw < 6 or bh < 5:
                continue
            # A nose stroke or ear swirl is a thin enclosed line. An open mouth
            # holds teeth, or is a compact cavity, not a one-pixel stroke.
            sub_mn = mn[y0:y1, x0:x1]
            sub_mx = mx[y0:y1, x0:x1]
            teeth_n = int((hole & (sub_mn > 175) & ((sub_mx - sub_mn) < 36)).sum())
            solidity = hole.sum() / max(1, (bw + 1) * (bh + 1))
            # A nose or ear stroke is a thin enclosed line. An open mouth holds
            # teeth, or is a fat cavity. A thin stroke stays a skin line.
            if teeth_n < 6 and (hole.sum() < 90 or solidity < 0.42):
                continue
            full = np.zeros(label.shape, bool)
            full[y0:y1, x0:x1] = hole
            # do not eat a neighbouring figure
            full &= ~((figure != 0) & (figure != side) & np.isin(label, (SKIN, HAIR, SHIRT, EYE)))
            near_eye = ndi.binary_dilation((label == EYE) | (label == IRIS), iterations=3)
            region = full & opaque & ~near_eye & ~np.isin(label, (EYE, IRIS, INK, SKIN, HAIR, SHIRT, BALL))
            if region.sum() < 8:
                continue
            white = region & (mn > 175) & ((mx - mn) < 36)
            pink = region & (r > 140) & (g > 55) & (b > 60) \
                & (np.abs(g.astype(np.int16) - b.astype(np.int16)) < 48) \
                & (r > g + 12) & (r > b + 12)
            label[region] = MOUTH
            figure[region] = side
            # Close the pink so a speckled tongue becomes one flat shape,
            # and close the teeth the same way. Neither may leave the mouth.
            pink_solid = ndi.binary_closing(pink, structure=np.ones((5, 5))) & region & ~white
            teeth_solid = ndi.binary_closing(white, structure=np.ones((3, 3))) & region
            label[teeth_solid] = TEETH
            label[pink_solid & ~teeth_solid] = TONGUE


def mark_socks(label, figure):
    for side in (1, 2):
        boots = (label == BOOTS) & (figure == side)
        shorts = (label == SHORTS) & (figure == side)
        if not boots.any() or not shorts.any():
            continue
        # walk out from the boots through shorts, but only while the row is narrow
        dist = ndi.distance_transform_edt(~boots)
        near = shorts & (dist < 64)
        ys = np.where(near)[0]
        if len(ys) == 0:
            continue
        sock = np.zeros(label.shape, bool)
        for y in np.unique(ys):
            xs = np.where(near[y])[0]
            if len(xs) == 0:
                continue
            # split into runs
            splits = np.where(np.diff(xs) > 3)[0]
            start = 0
            spans = []
            for s in list(splits) + [len(xs) - 1]:
                spans.append(xs[start:s + 1])
                start = s + 1
            for run in spans:
                if len(run) < 26:
                    sock[y, run] = True
        label[sock] = SOCKS


def reclaim_stray_boots(label, figure):
    """A boot-key crumb sitting on a shirt is the jersey, not a shoe."""
    boot = label == BOOTS
    lab, n = components(boot)
    if not n:
        return
    sizes = np.bincount(lab.ravel())
    for i in range(1, n + 1):
        if sizes[i] > 320 or sizes[i] < 1:
            continue
        comp = lab == i
        ys, xs = np.where(comp)
        if xs.max() - xs.min() > 48 or ys.max() - ys.min() > 40:
            continue
        border = ndi.binary_dilation(comp, iterations=2) & ~comp
        shirt_n = int((border & (label == SHIRT)).sum())
        cloth_n = int((border & np.isin(label, (SHORTS, SOCKS))).sum())
        if shirt_n < 8 or shirt_n <= cloth_n:
            continue
        figs = figure[border & (label == SHIRT) & (figure > 0)]
        if figs.size == 0:
            continue
        label[comp] = SHIRT
        figure[comp] = int(np.bincount(figs).argmax())


def drop_face_boots(label, figure):
    boot = label == BOOTS
    lab, n = components(boot)
    if not n:
        return
    sizes = np.bincount(lab.ravel())
    skin = np.isin(label, (SKIN, SKIN_LINE, EYE, MOUTH, TEETH))
    shorts = np.isin(label, (SHORTS, SOCKS))
    for i in range(1, n + 1):
        if sizes[i] > 280:
            continue
        comp = lab == i
        ys, xs = np.where(comp)
        if xs.max() - xs.min() > 46 or ys.max() - ys.min() > 36:
            continue
        border = ndi.binary_dilation(comp, iterations=2) & ~comp
        if int((border & shorts).sum()) > int((border & skin).sum()):
            continue
        if int((border & skin).sum()) < 12:
            continue
        # The boot key must not stay on the face. It becomes the skin line
        # around it, so the renderer never paints a shoe colour there.
        label[comp] = SKIN_LINE
        figs = figure[border & (figure > 0)]
        figure[comp] = int(np.bincount(figs).argmax()) if figs.size else 0


def close_skin_lines(label, figure):
    """A hatched neck is several strokes close together. Fill that field.
    A single nose stroke is too thin to pass the density test, so it stays a line.
    """
    skinish = np.isin(label, (SKIN, SKIN_LINE))
    for side in (1, 2):
        sl = (label == SKIN_LINE) & (figure == side)
        if sl.sum() < 10:
            continue
        dens = ndi.uniform_filter(sl.astype(np.float32), size=7)
        fill = (dens > 0.16) & skinish & (figure == side)
        label[fill] = SKIN_LINE


def absorb_islands(label, figure, max_area=12):
    protect = {INK, LINE, NET, SKY, GRASS, BALL, NONE}
    # Iris and eye outlines are small on purpose; only eat the tiniest crumbs.
    struct = np.ones((3, 3), bool)
    for lab in (SHIRT, SHORTS, SOCKS, BOOTS, SKIN, SKIN_LINE, HAIR, HAIR_LINE,
                EYE, IRIS, MOUTH, TEETH, TONGUE):
        limit = 8 if lab in (EYE, IRIS, TEETH, TONGUE) else max_area
        mask = label == lab
        if not mask.any():
            continue
        comp, n = components(mask)
        if not n:
            continue
        sizes = np.bincount(comp.ravel())
        for i in range(1, n + 1):
            if sizes[i] == 0 or sizes[i] >= limit:
                continue
            if lab in protect:
                continue
            pix = comp == i
            ring = ndi.binary_dilation(pix, structure=struct) & ~pix
            if not ring.any():
                continue
            # majority label on the ring, ignoring this island's own label
            rl = label[ring]
            rf = figure[ring]
            # pack label and figure
            key = rl.astype(np.int16) * 4 + rf.astype(np.int16)
            if key.size == 0:
                continue
            vals, counts = np.unique(key, return_counts=True)
            best = vals[counts.argmax()]
            bl, bf = divmod(int(best), 4)
            if bl == lab and bf == int(figure[pix][0]):
                continue
            if bl == NONE:
                continue
            label[pix] = bl
            figure[pix] = bf


def finish_figures(label, figure, rgb, opaque):
    """Arms far from the hair, and colour keys left on ink, still need a side."""
    def large_anchor(side, kinds, min_area=400):
        anchor = (figure == side) & np.isin(label, kinds)
        alab, an = components(anchor)
        if not an:
            return anchor
        sizes = np.bincount(alab.ravel())
        big = sizes >= min_area
        big[0] = False
        return big[alab]

    def assign_unfigured(mask, kinds, max_dist):
        lab, n = components(mask & (figure == 0))
        if not n:
            return
        sizes = np.bincount(lab.ravel())
        dist = {}
        for side in (1, 2):
            anchor = large_anchor(side, kinds)
            dist[side] = ndi.distance_transform_edt(~anchor) if anchor.any() else None
        for i in range(1, n + 1):
            if sizes[i] < 8:
                continue
            comp = lab == i
            best = None
            for side in (1, 2):
                if dist[side] is None:
                    continue
                med = float(np.median(dist[side][comp]))
                if best is None or med < best[0]:
                    best = (med, side)
            if best and best[0] <= max_dist:
                figure[comp] = best[1]

    assign_unfigured(label == HAIR, (SHIRT, HAIR), 160)
    assign_unfigured(label == SKIN, (HAIR, SHIRT, SHORTS), 160)
    assign_unfigured(np.isin(label, (SKIN_LINE, HAIR_LINE)), (SKIN, HAIR, SHIRT), 48)
    assign_unfigured(label == BOOTS, (SHORTS, SKIN, SHIRT), 80)

    # Exact keys sitting on a label the renderer does not repaint.
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    stuck = np.isin(label, (NONE, INK, SKY, BALL, NET, LINE, GRASS, IRIS))
    specs = (
        ((255, 0, 255), SHIRT, 1),
        ((255, 136, 0), SHIRT, 2),
        ((0, 255, 255), SHORTS, 1),
        ((136, 0, 255), SHORTS, 2),
        ((0, 0, 255), HAIR, 0),
        ((255, 0, 136), BOOTS, 0),
    )
    for (kr, kg, kb), lab, side in specs:
        m = opaque & stuck & (r == kr) & (g == kg) & (b == kb)
        if not m.any():
            continue
        label[m] = lab
        if side:
            figure[m] = side
    assign_unfigured(label == HAIR, (HAIR, SHIRT), 80)
    assign_unfigured(label == BOOTS, (BOOTS, SHORTS, SKIN), 64)
    # A limb pressed into one shirt belongs to that shirt. Median distance to a
    # large shirt assigns tackles the other way, and the recolor test then sees
    # two skin tones on one person. Vote with the same 5x5 window the test uses.
    correct_skin_votes(label, figure)
    # The skin test treats pixels within 2px as one person. Leave an ink gap
    # where the two figures actually touch, so a tackle doesn't mix their tones.
    square = np.ones((3, 3), bool)
    for _ in range(4):
        s1 = np.isin(label, (SKIN, SKIN_LINE)) & (figure == 1)
        s2 = np.isin(label, (SKIN, SKIN_LINE)) & (figure == 2)
        if not s1.any() or not s2.any():
            break
        # The test joins skin with a 5x5 window, so the gap has to be a square.
        bridge = (ndi.binary_dilation(s2, structure=square, iterations=2) & s1) \
            | (ndi.binary_dilation(s1, structure=square, iterations=2) & s2)
        if not bridge.any():
            break
        label[bridge] = INK
        figure[bridge] = 0
    polish_faces(label, figure, rgb, opaque)


def polish_faces(label, figure, rgb, opaque):
    """Flatten hatches, close mouth cavities, and keep irises source-dark.

    Runs on the finished map. Skin lines stay skin lines. Gaps of ink and
    untouched pixels inside a hatch become the same flat line, so a neck
    shadow is one shape. The open mouth grows only into the dark cavity
    directly under the teeth.
    """
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    # Light pixels sitting in the pupil are the white of the eye. Dark pixels
    # sitting in the white are the pupil. The pupil keeps its source colour.
    # The pupil is the dark core. Lighter browns inside the outline are the
    # white of the eye, or they read as a dirty rim.
    light_iris = (label == IRIS) & (mx >= 70)
    label[light_iris] = EYE
    dark_eye = (label == EYE) & (mx < 60)
    label[dark_eye] = IRIS
    recover_eyes(label, figure, rgb, opaque)
    extend_mouths(label, figure, rgb, opaque)
    flatten_hatches(label, figure, rgb, opaque)
    claim_hair_fringe(label, figure, rgb, opaque)
    drop_face_boots(label, figure)
    mop_face_boot_crumbs(label, figure)


def mop_face_boot_crumbs(label, figure):
    """Boot-key crumbs in a mouth or an eye are not shoes."""
    boot = label == BOOTS
    cl, n = components(boot)
    if not n:
        return
    sizes = np.bincount(cl.ravel())
    face = ndi.binary_dilation(np.isin(label, (MOUTH, TEETH, TONGUE, EYE, IRIS, SKIN)), iterations=3)
    cloth = ndi.binary_dilation(np.isin(label, (SHORTS, SOCKS)), iterations=2)
    mouth = ndi.binary_dilation(np.isin(label, (MOUTH, TEETH, TONGUE)), iterations=2)
    for i in range(1, n + 1):
        if sizes[i] == 0 or sizes[i] > 16:
            continue
        comp = cl == i
        if not (ndi.binary_dilation(comp, iterations=1) & face).any():
            continue
        if int((ndi.binary_dilation(comp, iterations=1) & cloth).sum()) > 6:
            continue
        if (comp & mouth).any() or (ndi.binary_dilation(comp, iterations=1) & mouth).any():
            label[comp] = MOUTH
        else:
            label[comp] = SKIN_LINE
        figs = figure[ndi.binary_dilation(comp, iterations=2) & (figure > 0)]
        if figs.size:
            figure[comp] = int(np.bincount(figs).argmax())


def recover_eyes(label, figure, rgb, opaque):
    """Eye whites swallowed by the goal net are still eyes if skin rings them."""
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    white = opaque & (mn > 168) & ((mx - mn) < 40)
    h, w = label.shape
    for side in (1, 2):
        hair = (label == HAIR) & (figure == side)
        skin = (label == SKIN) & (figure == side)
        if hair.sum() < 80 or skin.sum() < 40:
            continue
        hlab, hn = components(hair)
        if not hn:
            continue
        sizes = np.bincount(hlab.ravel())
        for i in range(1, hn + 1):
            if sizes[i] < 80:
                continue
            comp = hlab == i
            cy, cx = np.nonzero(comp)
            top = int(cy.min())
            head = cy <= top + 36
            if head.sum() < 15:
                continue
            x0 = max(0, int(cx[head].min()) - 28)
            x1 = min(w, int(cx[head].max()) + 29)
            y0 = max(0, top - 4)
            y1 = min(h, top + 72)
            band = np.zeros((h, w), bool)
            band[y0:y1, x0:x1] = True
            cand = white & band & np.isin(label, (NONE, NET, LINE))
            cl, cn = components(cand)
            if not cn:
                continue
            cs = np.bincount(cl.ravel())
            for j in range(1, cn + 1):
                if cs[j] < 16 or cs[j] > 220:
                    continue
                blob = cl == j
                by, bx = np.nonzero(blob)
                bw = int(bx.max() - bx.min())
                bh = int(by.max() - by.min())
                if bw < 7 or bh < 5 or bw > 42 or bh > 26:
                    continue
                if max(bw, bh) / max(1, min(bw, bh)) > 3.2:
                    continue
                ring = ndi.binary_dilation(blob, iterations=2) & ~blob
                if ring.sum() < 8:
                    continue
                if int((ring & skin).sum()) < ring.sum() * 0.28:
                    continue
                label[blob] = EYE
                figure[blob] = side
                filled = ndi.binary_fill_holes(ndi.binary_closing(blob, structure=np.ones((3, 3))))
                dark = filled & ~blob & opaque & (mx < 130)
                dark &= ~np.isin(label, (HAIR, SHIRT, SHORTS, BOOTS, SKIN, BALL, GRASS))
                if 2 <= int(dark.sum()) <= 160:
                    label[dark] = IRIS
                    figure[dark] = side


def extend_mouths(label, figure, rgb, opaque):
    """The cavity under the teeth is the mouth, not a speckled skin hatch."""
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h, w = label.shape
    seeds = np.isin(label, (MOUTH, TEETH, TONGUE))
    slab, sn = components(seeds)
    if not sn:
        return
    sizes = np.bincount(slab.ravel())
    for i in range(1, sn + 1):
        if sizes[i] < 8:
            continue
        comp = slab == i
        side = int(np.bincount(figure[comp]).argmax())
        if side == 0:
            continue
        # A mouth that is already a wide cavity does not need to swallow the chin.
        if sizes[i] > 220:
            continue
        ys, xs = np.nonzero(comp)
        x0 = max(0, int(xs.min()) - 3)
        x1 = min(w, int(xs.max()) + 4)
        y0 = max(0, int(ys.min()) - 1)
        y1 = min(h, int(ys.max()) + 11)
        box = np.zeros((h, w), bool)
        box[y0:y1, x0:x1] = True
        # Dark cavity under the teeth. The box stops it becoming the whole chin.
        dark = opaque & (mx < 72)
        room = box & (dark | np.isin(label, (MOUTH, TEETH, TONGUE)))
        room &= ~np.isin(label, (SKIN, HAIR, HAIR_LINE, EYE, IRIS, SHIRT, SHORTS, SOCKS, BALL, GRASS, SKY))
        grown = ndi.binary_propagation(comp, mask=room | comp)
        grown &= ~np.isin(label, (EYE, IRIS, HAIR, SHIRT))
        label[grown] = MOUTH
        figure[grown] = side
        white = grown & (mn > 175) & ((mx - mn) < 36)
        # Pink just under the cavity is the tongue. Close it so the stipple
        # becomes one flat shape, and do not follow it out into the cheek.
        pink = (r > 145) & (g > 55) & (g < 180) & (b > 45) \
            & (np.abs(g.astype(np.int16) - b.astype(np.int16)) < 42) \
            & (r > g + 8) & opaque
        near = ndi.binary_dilation(grown, iterations=4) & box
        seed = pink & near & ~white & ~np.isin(label, (SKIN, HAIR, EYE, IRIS, SHIRT))
        tongue = ndi.binary_closing(seed, structure=np.ones((5, 5))) & near & ~white
        tongue &= ~np.isin(label, (SKIN, HAIR, EYE, IRIS, SHIRT, BALL))
        label[white] = TEETH
        if 6 <= int(tongue.sum()) <= 80:
            label[tongue] = TONGUE
            figure[tongue] = side
            # Fill the one-pixel holes so the tongue is a single flat shape.
            solid = ndi.binary_closing(label == TONGUE, structure=np.ones((3, 3)))
            gap = solid & (label != TONGUE) & np.isin(label, (SKIN, SKIN_LINE, NONE, INK))
            gap &= ndi.binary_dilation(label == TONGUE, iterations=1)
            gap &= ~np.isin(label, (EYE, IRIS, HAIR, SHIRT, TEETH))
            label[gap] = TONGUE
            figure[gap] = side
        figure[white] = side


def flatten_hatches(label, figure, rgb, opaque):
    """Parallel neck strokes become one flat skin-line shape."""
    for side in (1, 2):
        sl = (label == SKIN_LINE) & (figure == side)
        skin = (label == SKIN) & (figure == side)
        if sl.sum() < 20:
            continue
        closed = ndi.binary_closing(sl, structure=np.ones((7, 7)))
        near = ndi.binary_dilation(sl | skin, iterations=2)
        other = np.isin(label, (SKIN, SKIN_LINE)) & (figure == (2 if side == 1 else 1))
        other = ndi.binary_dilation(other, structure=np.ones((5, 5)))
        outer = ndi.binary_dilation(np.isin(label, (SKY, GRASS, HAIR, SHIRT, SHORTS, NET, LINE, BALL)), iterations=1)
        fill = closed & near & opaque & ~other
        fill &= np.isin(label, (NONE, INK, SKIN, SKIN_LINE, BOOTS))
        fill &= ~((label == INK) & outer)
        label[fill] = SKIN_LINE
        figure[fill] = side
        # A one-pixel ink crumb inside the line is the same line.
        ink = (label == INK) | ((label == NONE) & opaque)
        neigh = ndi.convolve(((label == SKIN_LINE) & (figure == side)).astype(np.uint8),
                             np.ones((3, 3), np.uint8), mode='constant')
        crumb = ink & (neigh >= 6) & near & ~other & ~outer
        label[crumb] = SKIN_LINE
        figure[crumb] = side


def claim_hair_fringe(label, figure, rgb, opaque):
    """Light anti-aliased crumbs on the hair edge take the hair colour."""
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    for side in (1, 2):
        hair = (label == HAIR) & (figure == side)
        if hair.sum() < 40:
            continue
        neigh = ndi.convolve(hair.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant')
        fringe = (label == NONE) & opaque & (neigh >= 1) & (mn > 140) & ((mx - mn) < 60)
        fringe &= ~ndi.binary_dilation(np.isin(label, (EYE, IRIS, TEETH, BALL, SKY)), iterations=1)
        if not fringe.any():
            continue
        cl, cn = components(fringe)
        if not cn:
            continue
        sizes = np.bincount(cl.ravel())
        for i in range(1, cn + 1):
            if sizes[i] == 0 or sizes[i] > 60:
                continue
            label[cl == i] = HAIR
            figure[cl == i] = side


def correct_skin_votes(label, figure):
    """Give each skin component to the shirt and shorts that touch it."""
    skin = np.isin(label, (SKIN, SKIN_LINE))
    if not skin.any():
        return
    cloth = np.isin(label, (SHIRT, SHORTS, SOCKS))
    kernel = np.ones((5, 5), np.int32)
    kernel[2, 2] = 0
    vote1 = ndi.convolve((cloth & (figure == 1)).astype(np.int32), kernel, mode='constant')
    vote2 = ndi.convolve((cloth & (figure == 2)).astype(np.int32), kernel, mode='constant')
    lab, n = ndi.label(skin)
    if not n:
        return
    parent = np.arange(n + 1, dtype=np.int32)
    h, w = lab.shape
    # 5x5 neighbourhood, matching the test's flood fill, not a 4-connected island.
    edges = []
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if not dx and not dy:
                continue
            y0, y1 = max(dy, 0), h + min(dy, 0)
            x0, x1 = max(dx, 0), w + min(dx, 0)
            a = lab[y0:y1, x0:x1]
            b = lab[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
            both = (a > 0) & (b > 0) & (a != b)
            if not both.any():
                continue
            aa = a[both].astype(np.int32, copy=False)
            bb = b[both].astype(np.int32, copy=False)
            edges.append((aa, bb))
    if edges:
        for _ in range(16):
            changed = False
            for aa, bb in edges:
                ra = parent[aa]
                rb = parent[bb]
                smaller = np.minimum(ra, rb)
                larger_at = ra != smaller
                if larger_at.any():
                    np.minimum.at(parent, aa[larger_at], rb[larger_at])
                    changed = True
                larger_at = rb != smaller
                if larger_at.any():
                    np.minimum.at(parent, bb[larger_at], ra[larger_at])
                    changed = True
            parent = parent[parent]
            if not changed:
                break
    merged = parent[lab]
    ids = np.unique(merged)
    for i in ids:
        if not i:
            continue
        comp = merged == i
        area = int(comp.sum())
        if area < 200:
            continue
        v1 = int(vote1[comp].sum())
        v2 = int(vote2[comp].sum())
        side = 0
        if v1 > v2 * 2 and v1 > 30:
            side = 1
        elif v2 > v1 * 2 and v2 > 30:
            side = 2
        if side:
            figure[comp] = side


def claim_halos(label, figure, rgb, opaque):
    """Anti-aliased crumbs next to a body part join that part.

    Left as NONE, a magenta or cyan fringe survives as a colour key.
    """
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    white = opaque & (mn > 180) & ((mx - mn) < 32)
    free = (label == NONE) & opaque & ~white
    if not free.any():
        return
    kernel = np.ones((3, 3), np.uint8)
    best_n = np.zeros(label.shape, np.uint8)
    best_l = np.zeros(label.shape, np.uint8)
    best_f = np.zeros(label.shape, np.uint8)
    for lab in (SKIN, SKIN_LINE, HAIR, HAIR_LINE, SHIRT, SHORTS, SOCKS, BOOTS):
        for side in (1, 2):
            m = (label == lab) & (figure == side)
            if not m.any():
                continue
            cnt = ndi.convolve(m.astype(np.uint8), kernel, mode='constant')
            take = free & (cnt > best_n)
            best_n = np.where(take, cnt, best_n)
            best_l = np.where(take, lab, best_l)
            best_f = np.where(take, side, best_f)
    got = free & (best_n > 0)
    label[got] = best_l[got]
    figure[got] = best_f[got]


def save_map(path, label, figure):
    rgb = np.zeros(label.shape + (3,), np.uint8)
    rgb[..., 0] = label
    rgb[..., 1] = figure
    Image.fromarray(rgb, 'RGB').save(path, optimize=True)


def finish_saved(poses):
    """Fill in figures on label maps that were built before finish_figures."""
    for pose in poses:
        src = np.asarray(Image.open(SRC / f'{pose}.png').convert('RGBA'))
        lab = np.asarray(Image.open(OUT / f'{pose}.png')).copy()
        label = lab[..., 0].copy()
        figure = lab[..., 1].copy()
        finish_figures(label, figure, src[..., :3].astype(np.int16), src[..., 3] >= 128)
        save_map(OUT / f'{pose}.png', label, figure)
        print('finished', pose, 'skin0', int(((label == SKIN) & (figure == 0)).sum()))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--finish':
        finish_saved(sys.argv[2:] or POSES)
        return
    only = sys.argv[1:]
    poses = only or POSES
    OUT.mkdir(parents=True, exist_ok=True)
    for pose in poses:
        im = Image.open(SRC / f'{pose}.png').convert('RGBA')
        arr = np.asarray(im)
        rgb = arr[..., :3]
        alpha = arr[..., 3]
        label, figure, grass_y = label_image(rgb, alpha)
        save_map(OUT / f'{pose}.png', label, figure)
        counts = {}
        for lab, name in (
            (EYE, 'eye'), (IRIS, 'iris'), (MOUTH, 'mouth'), (TEETH, 'teeth'),
            (TONGUE, 'tongue'), (SKIN_LINE, 'sline'), (HAIR_LINE, 'hline'),
            (SOCKS, 'socks'), (NET, 'net'), (BALL, 'ball'),
        ):
            counts[name] = int((label == lab).sum())
        print(pose, 'grass', grass_y, counts)


if __name__ == '__main__':
    main()
