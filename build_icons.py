"""Generate icon16/48/128.png using only the Python stdlib."""
import math
import os
import struct
import zlib


def png(w: int, h: int, rgba: bytes) -> bytes:
    """Encode an RGBA pixel buffer as a PNG file."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type "None"
        raw.extend(rgba[y * stride : (y + 1) * stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def lerp(a, b, t):
    return a + (b - a) * t


def render(size: int) -> bytes:
    """A rounded dark square with a gradient ring + dot in the middle."""
    out = bytearray(size * size * 4)

    cx = cy = (size - 1) / 2
    bg_radius = size * 0.5         # full coverage edge
    corner = size * 0.22           # rounded-square corner radius
    ring_outer = size * 0.36
    ring_inner = size * 0.24
    dot_radius = size * 0.10

    # Brand gradient stops (top → bottom):
    #   #5b6cff  →  #c084fc
    g_top = (0x5B, 0x6C, 0xFF)
    g_bot = (0xC0, 0x84, 0xFC)

    # Background charcoal:
    bg = (0x12, 0x16, 0x28)

    def rounded_alpha(x, y):
        """Anti-aliased coverage for a rounded square 0..size."""
        # distance to nearest edge, considering rounded corners
        dx = max(corner - x, x - (size - corner), 0)
        dy = max(corner - y, y - (size - corner), 0)
        if dx > 0 and dy > 0:
            d = math.hypot(dx, dy)
            return max(0.0, min(1.0, corner - d + 0.5))
        # straight edges
        edge = min(x, y, size - x, size - y)
        return max(0.0, min(1.0, edge + 0.5))

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4

            # Rounded background coverage
            a_bg = rounded_alpha(x + 0.5, y + 0.5)
            if a_bg <= 0:
                out[i : i + 4] = b"\x00\x00\x00\x00"
                continue

            # Base = dark bg
            r, g, b = bg
            a = int(round(a_bg * 255))

            # Distance from center (for ring + dot)
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)

            # Vertical t for gradient (0 top → 1 bottom)
            t = (y + 0.5) / size
            gr = int(round(lerp(g_top[0], g_bot[0], t)))
            gg = int(round(lerp(g_top[1], g_bot[1], t)))
            gb = int(round(lerp(g_top[2], g_bot[2], t)))

            # Ring coverage (annulus)
            ring_cov = 0.0
            if d <= ring_outer + 1 and d >= ring_inner - 1:
                outer_a = max(0.0, min(1.0, ring_outer - d + 0.5))
                inner_a = max(0.0, min(1.0, d - ring_inner + 0.5))
                ring_cov = min(outer_a, inner_a)

            if ring_cov > 0:
                r = int(lerp(r, gr, ring_cov))
                g = int(lerp(g, gg, ring_cov))
                b = int(lerp(b, gb, ring_cov))

            # Center dot
            if d <= dot_radius + 1:
                dot_a = max(0.0, min(1.0, dot_radius - d + 0.5))
                if dot_a > 0:
                    r = int(lerp(r, 255, dot_a))
                    g = int(lerp(g, 255, dot_a))
                    b = int(lerp(b, 255, dot_a))

            out[i + 0] = r
            out[i + 1] = g
            out[i + 2] = b
            out[i + 3] = a

    return bytes(out)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(here, "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for size in (16, 48, 128):
        data = png(size, size, render(size))
        path = os.path.join(icons_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(data)
        print(f"wrote {path} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
