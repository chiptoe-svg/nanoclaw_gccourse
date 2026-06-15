#!/usr/bin/env python3
"""Report basic metadata for an image file — no dependencies (stdlib only).

Reads the file's bytes directly and parses the header to find the pixel
dimensions, so it works without Pillow or any pip install.

Usage:  python3 metadata.py <path-to-image>
Example: python3 metadata.py /workspace/agent/attachments/playground_x_0.jpg
"""
import os
import sys

# SOFn markers that carry the frame dimensions in a JPEG.
JPEG_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def jpeg_dimensions(data):
    """(width, height) from a JPEG's first SOF marker, or None."""
    if data[:2] != b"\xff\xd8":  # SOI
        return None
    i, n = 2, len(data)
    while i < n:
        if data[i] != 0xFF:
            i += 1
            continue
        while i < n and data[i] == 0xFF:  # skip fill bytes
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        # Standalone markers (no length field): SOI/EOI and RSTn.
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if i + 1 >= n:
            break
        seg_len = (data[i] << 8) | data[i + 1]
        if marker in JPEG_SOF_MARKERS and i + 6 < n:
            height = (data[i + 3] << 8) | data[i + 4]
            width = (data[i + 5] << 8) | data[i + 6]
            return (width, height)
        i += seg_len  # length includes its own 2 bytes
    return None


def png_dimensions(data):
    """(width, height) from a PNG's IHDR chunk, or None."""
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    return (width, height)


def detect_format(data):
    if data[:2] == b"\xff\xd8":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return "unknown"


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: metadata.py <path-to-image>")
    path = sys.argv[1]
    if not os.path.isfile(path):
        sys.exit(f"file not found: {path}")

    size = os.path.getsize(path)
    with open(path, "rb") as f:
        data = f.read()

    fmt = detect_format(data)
    dims = jpeg_dimensions(data) if fmt == "JPEG" else png_dimensions(data) if fmt == "PNG" else None

    print(f"file:   {os.path.basename(path)}")
    print(f"format: {fmt}")
    print(f"size:   {size:,} bytes ({size / 1024:.1f} KB)")
    if dims:
        w, h = dims
        ratio = (w / h) if h else 0
        orient = "square" if w == h else ("landscape" if w > h else "portrait")
        print(f"dimensions: {w} x {h} px")
        print(f"aspect ratio: {ratio:.2f}:1 ({orient})")
        print(f"megapixels: {w * h / 1_000_000:.2f} MP")
    else:
        print("dimensions: (could not read from header)")


if __name__ == "__main__":
    main()
