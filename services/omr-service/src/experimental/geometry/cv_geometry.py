#!/usr/bin/env python3
"""
Cheap geometry, Track A (classical CV): staves, systems, barlines and chord
columns from rendered score pages. No symbol recognition.

    python3 cv_geometry.py --dpi 150 page-1.png page-2.png ... > geometry.json

Output (all coordinates page-normalised 0..1, pages in argv order):
{
  "pages": [{
    "index": 0, "width": W, "height": H, "interline": px,
    "systems": [{
      "y0", "y1",                       # band incl. one staff-height padding
      "staves": [{"y0","y1","x0","x1"}], # 5-line staff extents
      "barlines": [x, ...],             # incl. virtual left/right edges
      "measures": [{"x0","x1","columns":[x, ...]}]
    }]
  }]
}

Pipeline per page: Otsu binarise → long-horizontal-run mask → row projection
peaks → 5-line clusters (staves) → staves joined by a vertical run spanning
them (systems; fallback: pairs) → vertical runs spanning a whole system
(barlines; fallback: top-staff-height lines) → per measure, column ink peaks
with staff lines removed (chord columns, the `sl` candidates).
"""
import argparse
import json
import sys

import cv2
import numpy as np


def binarize(gray):
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return bw  # ink = 255


def deskew(bw):
    """Scans are rarely square. Estimate the skew from long near-horizontal
    segments and rotate the binary image; returns (image, angle_deg)."""
    H, W = bw.shape
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(10, W // 40), 1))
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    segs = cv2.HoughLinesP(horiz, 1, np.pi / 720, threshold=80, minLineLength=W // 8, maxLineGap=4)
    if segs is None or len(segs) < 5:
        return bw, 0.0
    angles = []
    for x1, y1, x2, y2 in segs[:, 0, :]:
        if x2 != x1:
            angles.append(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
    angle = float(np.median(angles)) if angles else 0.0
    if abs(angle) < 0.05 or abs(angle) > 5:
        return bw, 0.0
    M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    rotated = cv2.warpAffine(bw, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
    return rotated, angle


def merge_close_lines(centres, interline):
    """A slightly skewed or thick line can split into several row runs; merge
    runs closer than ~half an interline into one centre."""
    if not centres:
        return centres
    out = [list(centres[0])]
    for y, thick in centres[1:]:
        if y - out[-1][0] <= interline * 0.45:
            out[-1] = [(out[-1][0] + y) / 2.0, out[-1][1] + thick]
        else:
            out.append([y, thick])
    return [tuple(c) for c in out]


def find_staff_lines(bw, width):
    # Long horizontal runs only: opening with a wide kernel removes everything
    # but staff lines (and the odd long beam, filtered by the 5-line grouping).
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, width // 12), 1))
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    rows = (horiz > 0).sum(axis=1)
    thresh = max(width * 0.2, 1)
    ys = np.where(rows > thresh)[0]
    if len(ys) == 0:
        return [], horiz
    # merge adjacent rows into line centres
    lines = []
    start = ys[0]
    prev = ys[0]
    for y in ys[1:]:
        if y != prev + 1:
            lines.append((start, prev))
            start = y
        prev = y
    lines.append((start, prev))
    centres = [((a + b) / 2.0, b - a + 1) for a, b in lines]
    return centres, horiz


def group_staves(centres):
    """Cluster line centres into groups of 5 equally spaced lines."""
    if len(centres) < 5:
        return []
    ys_all = np.array([c[0] for c in centres])
    gaps = np.diff(ys_all)
    # dominant small gap = interline
    small = gaps[gaps < np.median(gaps) * 2.5] if len(gaps) else gaps
    if len(small) == 0:
        return []
    interline = float(np.median(small))
    # Beams survive the opening too. A beam lying between lines is off-grid and
    # simply never gets picked by the chain below; a beam lying *on* a staff
    # line merges with it into a thick run whose centre is still near the grid,
    # so only reject runs too thick to contain a line at all.
    ys = [c[0] for c in centres if c[1] <= interline * 0.8]
    staves = []
    used = set()
    tol = interline * 0.3
    for i in range(len(ys)):
        if i in used:
            continue
        chain = [i]
        # Walk down expecting one line per interline; tolerate spurious lines in between.
        while len(chain) < 5:
            expected = ys[chain[-1]] + interline
            best = None
            for j in range(chain[-1] + 1, len(ys)):
                if j in used:
                    continue
                if ys[j] > expected + tol:
                    break
                if abs(ys[j] - expected) <= tol and (best is None or abs(ys[j] - expected) < abs(ys[best] - expected)):
                    best = j
            if best is None:
                break
            chain.append(best)
        if len(chain) == 5:
            used.update(chain)
            block = [ys[k] for k in chain]
            staves.append({"lines": block, "interline": float(np.mean(np.diff(block)))})
    staves.sort(key=lambda s: s["lines"][0])
    return staves


def staff_x_extent(horiz, staff):
    y0 = int(round(staff["lines"][0]))
    y1 = int(round(staff["lines"][-1]))
    band = horiz[max(0, y0 - 2) : y1 + 3, :]
    cols = (band > 0).sum(axis=0)
    xs = np.where(cols >= 2)[0]
    if len(xs) == 0:
        return 0, horiz.shape[1] - 1
    return int(xs[0]), int(xs[-1])


def vertical_runs(bw, min_height):
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, int(max(3, min_height))))
    vert = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(vert, connectivity=8)
    runs = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if h >= min_height and w <= max(4, min_height * 0.08):
            runs.append({"x": x + w / 2.0, "y0": int(y), "y1": int(y + h - 1), "w": int(w)})
    return runs


def build_systems(staves, runs, interline):
    """Join staves connected by a vertical run spanning from one to the other."""
    n = len(staves)
    if n == 0:
        return []
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    tol = interline * 1.5
    for r in runs:
        covered = [i for i, s in enumerate(staves) if r["y0"] <= s["lines"][0] + tol and r["y1"] >= s["lines"][-1] - tol]
        for a, b in zip(covered, covered[1:]):
            if b == a + 1:
                parent[find(b)] = find(a)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    systems = [sorted(g) for g in groups.values()]
    systems.sort(key=lambda g: staves[g[0]]["lines"][0])
    # Fallback for piano scores whose barlines do not join the staves: pair up.
    if all(len(g) == 1 for g in systems) and n % 2 == 0 and n >= 2:
        systems = [[i, i + 1] for i in range(0, n, 2)]
    return systems


def cluster_xs(xs, tol):
    if not xs:
        return []
    xs = sorted(xs)
    out = [[xs[0]]]
    for x in xs[1:]:
        if x - out[-1][-1] <= tol:
            out[-1].append(x)
        else:
            out.append([x])
    return [float(np.mean(c)) for c in out]


def system_barlines(staves_in_sys, runs, interline, x_left, x_right):
    top = staves_in_sys[0]["lines"][0]
    bottom = staves_in_sys[-1]["lines"][-1]
    tol = interline * 1.2
    spanning = [r["x"] for r in runs if r["y0"] <= top + tol and r["y1"] >= bottom - tol]
    xs = cluster_xs(spanning, interline * 1.1)
    if len(xs) < 2:
        # Barlines drawn per staff: take lines matching the top staff's height.
        s = staves_in_sys[0]
        h = s["lines"][-1] - s["lines"][0]
        per_staff = [
            r["x"]
            for r in runs
            if abs(r["y0"] - s["lines"][0]) <= interline * 0.6
            and abs(r["y1"] - s["lines"][-1]) <= interline * 0.6
            and (r["y1"] - r["y0"]) >= h * 0.9
        ]
        xs = cluster_xs(per_staff, interline * 1.1)
    xs = [x for x in xs if x_left - interline <= x <= x_right + interline]
    # Virtual edges: a system's first bar often has no left barline; the last always ends on one.
    if not xs or xs[0] > x_left + interline * 1.5:
        xs.insert(0, float(x_left))
    if xs[-1] < x_right - interline * 1.5:
        xs.append(float(x_right))
    # Drop implausibly narrow measures (double barlines, repeat dots, stems next to a barline).
    cleaned = [xs[0]]
    for x in xs[1:]:
        if x - cleaned[-1] >= interline * 2.5:
            cleaned.append(x)
        else:
            cleaned[-1] = max(cleaned[-1], x) if cleaned[-1] != xs[0] else cleaned[-1]
    return cleaned


def chord_columns(bw, horiz, x0, x1, y0, y1, interline):
    """Column ink peaks inside a measure box with staff lines removed."""
    x0i, x1i = int(x0), int(x1)
    if x1i - x0i < interline * 2:
        return []
    region = bw[int(y0) : int(y1) + 1, x0i : x1i + 1].copy()
    lines = horiz[int(y0) : int(y1) + 1, x0i : x1i + 1]
    region[lines > 0] = 0
    # keep blobs at least ~half an interline tall (noteheads), drop thin stems/dots
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(2, int(interline * 0.5)), max(2, int(interline * 0.5))))
    heads = cv2.morphologyEx(region, cv2.MORPH_OPEN, k)
    cols = (heads > 0).sum(axis=0).astype(np.float32)
    if cols.max() <= 0:
        return []
    win = max(3, int(interline * 0.6)) | 1
    smooth = cv2.blur(cols.reshape(1, -1), (win, 1)).ravel()
    thresh = max(interline * 0.35, smooth.max() * 0.15)
    peaks = []
    in_peak = False
    start = 0
    for i, v in enumerate(smooth):
        if v >= thresh and not in_peak:
            in_peak = True
            start = i
        elif v < thresh and in_peak:
            in_peak = False
            seg = smooth[start:i]
            peaks.append(start + int(np.argmax(seg)))
    if in_peak:
        seg = smooth[start:]
        peaks.append(start + int(np.argmax(seg)))
    # ignore the first ~1 interline after the barline (clefs/key sigs live further left anyway)
    xs = [x0i + p for p in peaks if p > interline * 0.8 and (x1i - x0i - p) > interline * 0.4]
    return cluster_xs(xs, interline * 0.9)


def analyse_page(path, index):
    gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise SystemExit(f"cannot read {path}")
    H, W = gray.shape
    bw = binarize(gray)
    bw, skew = deskew(bw)
    centres, horiz = find_staff_lines(bw, W)
    page = {"index": index, "width": W, "height": H, "interline": None, "skewDeg": skew, "systems": []}
    if len(centres) >= 5:
        gaps = np.diff([c[0] for c in centres])
        rough = float(np.median(gaps[gaps > 2])) if np.any(gaps > 2) else 0.0
        if rough > 0:
            centres = merge_close_lines(centres, rough)
    staves = group_staves(centres)
    if not staves:
        return page
    interline = float(np.median([s["interline"] for s in staves]))
    page["interline"] = interline
    for s in staves:
        s["x0"], s["x1"] = staff_x_extent(horiz, s)
    staff_h = interline * 4
    runs = vertical_runs(bw, staff_h * 0.9)
    systems = build_systems(staves, runs, interline)
    for group in systems:
        ss = [staves[i] for i in group]
        x_left = min(s["x0"] for s in ss)
        x_right = max(s["x1"] for s in ss)
        bars = system_barlines(ss, runs, interline, x_left, x_right)
        top = ss[0]["lines"][0]
        bottom = ss[-1]["lines"][-1]
        measures = []
        for a, b in zip(bars, bars[1:]):
            cols = chord_columns(bw, horiz, a, b, top - interline * 2, bottom + interline * 2, interline)
            measures.append({"x0": a / W, "x1": b / W, "columns": [c / W for c in cols]})
        page["systems"].append(
            {
                "y0": max(0.0, (top - staff_h) / H),
                "y1": min(1.0, (bottom + staff_h) / H),
                "staves": [
                    {"y0": s["lines"][0] / H, "y1": s["lines"][-1] / H, "x0": s["x0"] / W, "x1": s["x1"] / W} for s in ss
                ],
                "barlines": [b / W for b in bars],
                "measures": measures,
            }
        )
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pages", nargs="+")
    args = ap.parse_args()
    out = {"pages": [analyse_page(p, i) for i, p in enumerate(args.pages)]}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
