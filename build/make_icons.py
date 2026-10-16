#!/usr/bin/env python3
"""Generate extension icons (16/48/128) as PNG without any third-party imaging lib.

Draws a rounded-square badge with a download arrow, using 4x supersampling for
anti-aliasing, then writes the result with a hand-rolled PNG encoder.
"""
import os
import struct
import sys
import zlib

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "."

SS = 4  # supersampling factor

# Brand colours (RGBA, 0-255)
BG_TOP = (59, 130, 246)    # blue-500
BG_BOT = (37, 99, 235)     # blue-600
FG = (255, 255, 255)


def _in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _in_triangle(x, y, ax, ay, bx, by, cx, cy):
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def sample(x, y):
    """Return (r, g, b, a) for a subpixel at normalised position (x, y)."""
    # badge background
    if not _in_round_rect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22):
        return (0, 0, 0, 0)
    t = min(max(y, 0.0), 1.0)
    bg = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))

    # arrow shaft
    if 0.435 <= x <= 0.565 and 0.20 <= y <= 0.52:
        return FG + (255,)
    # arrow head
    if _in_triangle(x, y, 0.50, 0.72, 0.28, 0.43, 0.72, 0.43):
        return FG + (255,)
    # base bar
    if 0.26 <= x <= 0.74 and 0.79 <= y <= 0.885:
        return FG + (255,)
    return bg + (255,)


def render(size):
    n = size * SS
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) / n
                    y = (py * SS + sy + 0.5) / n
                    r, g, b, a = sample(x, y)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            total_a = acc[3]
            if total_a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((
                    int(acc[0] / total_a + 0.5),
                    int(acc[1] / total_a + 0.5),
                    int(acc[2] / total_a + 0.5),
                    int(total_a / (SS * SS) + 0.5),
                ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        rows = render(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, rows)
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
