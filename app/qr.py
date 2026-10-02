"""Tiny dependency-free QR code encoder (byte mode, error correction L, versions 1-6 = up to 134 bytes).
Enough for a short http://<lan-ip>:<port>/p/<token> URL. Returns an SVG string."""
from __future__ import annotations

# version -> (data codewords, EC codewords per block, blocks)
_VER = {1: (19, 7, 1), 2: (34, 10, 1), 3: (55, 15, 1), 4: (80, 20, 1), 5: (108, 26, 1), 6: (136, 18, 2)}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]}


def _gmul(x: int, y: int) -> int:
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(deg: int) -> list[int]:
    res = [0] * (deg - 1) + [1]
    root = 1
    for _ in range(deg):
        for j in range(deg):
            res[j] = _gmul(res[j], root)
            if j + 1 < deg:
                res[j] ^= res[j + 1]
        root = _gmul(root, 2)
    return res


def _rs_remainder(data: list[int], div: list[int]) -> list[int]:
    res = [0] * len(div)
    for b in data:
        f = b ^ res.pop(0)
        res.append(0)
        for i, c in enumerate(div):
            res[i] ^= _gmul(c, f)
    return res


def _codewords(data: bytes, ver: int) -> list[int]:
    dcw, ecw, nblk = _VER[ver]
    bits = [0, 1, 0, 0] + [(len(data) >> i) & 1 for i in range(7, -1, -1)]
    for b in data:
        bits += [(b >> i) & 1 for i in range(7, -1, -1)]
    bits += [0] * min(4, dcw * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    cws = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(cws) < dcw:
        cws.append(pad)
        pad ^= 0xEC ^ 0x11
    per = dcw // nblk
    div = _rs_divisor(ecw)
    blocks = [cws[i * per:(i + 1) * per] for i in range(nblk)]
    ecs = [_rs_remainder(b, div) for b in blocks]
    out = [b[i] for i in range(per) for b in blocks]
    out += [e[i] for i in range(ecw) for e in ecs]
    return out


def _mask(k: int, x: int, y: int) -> bool:
    return [(x + y) % 2 == 0, y % 2 == 0, x % 3 == 0, (x + y) % 3 == 0,
            (x // 3 + y // 2) % 2 == 0, x * y % 2 + x * y % 3 == 0,
            (x * y % 2 + x * y % 3) % 2 == 0, ((x + y) % 2 + x * y % 3) % 2 == 0][k]


def _build(cws: list[int], ver: int, mask: int):
    size = ver * 4 + 17
    m = [[False] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def put(x, y, dark):
        m[y][x] = bool(dark)
        fn[y][x] = True

    for i in range(size):
        put(6, i, i % 2 == 0)
        put(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    put(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    al = _ALIGN[ver]
    for i, ax in enumerate(al):
        for j, ay in enumerate(al):
            if (i == 0 and j == 0) or (i == 0 and j == len(al) - 1) or (i == len(al) - 1 and j == 0):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    put(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)
    # format bits (EC level L = 01)
    data = (1 << 3) | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    fb = ((data << 10) | rem) ^ 0x5412

    def bit(i):
        return (fb >> i) & 1

    for i in range(6):
        put(8, i, bit(i))
    put(8, 7, bit(6)); put(8, 8, bit(7)); put(7, 8, bit(8))
    for i in range(9, 15):
        put(14 - i, 8, bit(i))
    for i in range(8):
        put(size - 1 - i, 8, bit(i))
    for i in range(8, 15):
        put(8, size - 15 + i, bit(i))
    put(8, size - 8, True)
    # data, zig-zag
    i = 0
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                y = size - 1 - vert if ((right + 1) & 2) == 0 else vert
                if not fn[y][x] and i < len(cws) * 8:
                    m[y][x] = bool((cws[i >> 3] >> (7 - (i & 7))) & 1)
                    i += 1
        right -= 2
    for y in range(size):
        for x in range(size):
            if not fn[y][x] and _mask(mask, x, y):
                m[y][x] = not m[y][x]
    return m


def _penalty(m) -> int:
    n = len(m)
    p = 0
    for grid in (m, [list(r) for r in zip(*m)]):
        for row in grid:
            run = 1
            for a, b in zip(row, row[1:]):
                run = run + 1 if a == b else 1
                if run == 5:
                    p += 3
                elif run > 5:
                    p += 1
    for y in range(n - 1):
        for x in range(n - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                p += 3
    dark = sum(map(sum, m))
    p += abs(dark * 20 - n * n * 10) // (n * n) * 10
    return p


def encode(text: str) -> list[list[bool]]:
    data = text.encode("utf-8")
    for ver in range(1, 7):
        if len(data) <= _VER[ver][0] - 2:  # conservative: header takes 12 bits
            break
    else:
        raise ValueError("text too long for QR")
    cws = _codewords(data, ver)
    return min((_build(cws, ver, k) for k in range(8)), key=_penalty)


def svg(text: str, border: int = 4) -> str:
    m = encode(text)
    n = len(m)
    d = "".join(f"M{x + border},{y + border}h1v1h-1z" for y in range(n) for x in range(n) if m[y][x])
    s = n + border * 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" shape-rendering="crispEdges">'
            f'<rect width="{s}" height="{s}" fill="#fff"/><path d="{d}" fill="#000"/></svg>')
