#!/usr/bin/env python3
"""Independent Poppler pixel checks for synthetic story fixtures, using only stdlib."""
import json
import pathlib
import sys


def ppm(file: pathlib.Path):
    raw = file.read_bytes()
    offset = 0
    tokens = []
    while len(tokens) < 4:
        while raw[offset] in b' \r\n\t':
            offset += 1
        if raw[offset] == 35:
            offset = raw.index(b'\n', offset) + 1
            continue
        start = offset
        while raw[offset] not in b' \r\n\t':
            offset += 1
        tokens.append(raw[start:offset])
    if tokens[0] != b'P6' or tokens[3] != b'255':
        raise ValueError('Expected bounded RGB PPM output from Poppler.')
    offset += 1
    width, height = int(tokens[1]), int(tokens[2])
    pixels = memoryview(raw)[offset:]
    if width > 1400 or height > 1400 or len(pixels) != width * height * 3:
        raise ValueError('Unexpected raster dimensions or byte count.')
    return width, height, pixels


for filename in sys.argv[1:]:
    path = pathlib.Path(filename)
    width, height, pixels = ppm(path)
    counts = {'headerBlue': 0, 'footerBlue': 0, 'headerRed': 0, 'footerRed': 0}
    for y in range(height):
        area = 'header' if y < height // 8 else 'footer' if y > height * 7 // 8 else None
        if area is None:
            continue
        for x in range(width):
            offset = (y * width + x) * 3
            red, green, blue = pixels[offset:offset + 3]
            if abs(red - 30) < 20 and abs(green - 100) < 20 and abs(blue - 180) < 20:
                counts[area + 'Blue'] += 1
            if abs(red - 170) < 20 and abs(green - 34) < 20 and abs(blue - 34) < 20:
                counts[area + 'Red'] += 1
    assert counts['headerBlue'] > 100 and counts['footerBlue'] > 100, (path, counts)
    # Native review renderers apply their own reviewer colors in markup mode.
    if path.stem == 'final' or (path.parent.name == 'chromium' and path.stem == 'retain-review'):
        assert counts['headerRed'] > 50 and counts['footerRed'] > 50, (path, counts)
    print(json.dumps({'file': str(path), 'passed': True, 'pixels': counts}))
