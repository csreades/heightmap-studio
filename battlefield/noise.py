"""Seeded, coordinate-based noise primitives.

Every function here is a pure function of (world coordinates, seed):
evaluating any point at any time yields the same value. That property is
what makes the domain effectively unbounded, tiles seam perfectly, and
rotated crops exact (we simply evaluate the field at rotated coordinates).

All hashing is integer lattice hashing on uint32 -- no permutation tables,
no global RNG state.
"""

from __future__ import annotations

import zlib

import numpy as np

U32 = np.uint32
_INV_U32 = 1.0 / 4294967296.0


def seed_for(seed: int, tag: str | int) -> int:
    """Derive a decorrelated sub-seed for a named layer/octave."""
    if isinstance(tag, int):
        tag = f"#{tag}"
    return (int(seed) ^ zlib.crc32(tag.encode())) & 0xFFFFFFFF


def hash_u32(ix, iy, seed: int):
    """Vectorized 2D integer lattice hash -> uint32."""
    with np.errstate(over="ignore"):  # uint32 wraparound is intentional
        h = np.asarray(ix).astype(U32, copy=False) * U32(0x9E3779B1)
        h = h ^ (np.asarray(iy).astype(U32, copy=False) * U32(0x85EBCA77))
        h = h ^ U32((seed * 0xC2B2AE3D) & 0xFFFFFFFF)
        h = h ^ (h >> U32(15))
        h = h * U32(0x2C1B3C6D)
        h = h ^ (h >> U32(13))
        h = h * U32(0x297A2D39)
        h = h ^ (h >> U32(16))
    return h


def hash01(ix, iy, seed: int):
    """Lattice hash mapped to [0, 1)."""
    return hash_u32(ix, iy, seed).astype(np.float64) * _INV_U32


def _fade(t):
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def gradient_noise(x, y, seed: int):
    """2D Perlin-style gradient noise, range approximately [-1, 1]."""
    ix = np.floor(x)
    iy = np.floor(y)
    fx = x - ix
    fy = y - iy
    ix = ix.astype(np.int64)
    iy = iy.astype(np.int64)

    def grad_dot(ox, oy):
        ang = hash01(ix + ox, iy + oy, seed) * (2.0 * np.pi)
        return np.cos(ang) * (fx - ox) + np.sin(ang) * (fy - oy)

    u = _fade(fx)
    v = _fade(fy)
    n0 = grad_dot(0, 0) + u * (grad_dot(1, 0) - grad_dot(0, 0))
    n1 = grad_dot(0, 1) + u * (grad_dot(1, 1) - grad_dot(0, 1))
    return (n0 + v * (n1 - n0)) * 1.41421356


def fbm(x, y, seed: int, scale_mm: float, octaves: int = 4,
        lacunarity: float = 2.0, gain: float = 0.5):
    """Fractal Brownian motion. Coordinates in mm; result roughly [-1, 1].

    Each octave gets its own sub-seed, a fixed rotation and a large offset
    so octaves are decorrelated and nothing aligns to the lattice axes.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    fx = x / float(scale_mm)
    fy = y / float(scale_mm)
    total = np.zeros(np.broadcast(fx, fy).shape, dtype=np.float64)
    amp = 1.0
    norm = 0.0
    for o in range(int(octaves)):
        s = seed_for(seed, o)
        ang = 0.72 * o + (s & 0xFF) * 0.0245
        ca, sa = np.cos(ang), np.sin(ang)
        offx = ((s >> 8) & 0xFFF) * 0.913
        offy = ((s >> 20) & 0xFFF) * 1.071
        rx = ca * fx - sa * fy + offx
        ry = sa * fx + ca * fy + offy
        total += amp * gradient_noise(rx, ry, s)
        norm += amp
        fx *= lacunarity
        fy *= lacunarity
        amp *= gain
    return total / norm


def worley_edge(x, y, seed: int, cell_mm: float, jitter: float = 1.0):
    """Worley/Voronoi cell noise. Returns (F2 - F1, F1) in mm.

    F2 - F1 goes to 0 on cell borders -- thresholding it gives a crack
    network with cell-size control.
    """
    x = np.asarray(x, dtype=np.float64) / float(cell_mm)
    y = np.asarray(y, dtype=np.float64) / float(cell_mm)
    cx = np.floor(x).astype(np.int64)
    cy = np.floor(y).astype(np.int64)
    fx = x - cx
    fy = y - cy
    shape = np.broadcast(fx, fy).shape
    f1 = np.full(shape, 1e9)
    f2 = np.full(shape, 1e9)
    s2 = seed_for(seed, "wy")
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            jx = hash01(cx + ox, cy + oy, seed)
            jy = hash01(cx + ox, cy + oy, s2)
            px = ox + 0.5 + jitter * (jx - 0.5)
            py = oy + 0.5 + jitter * (jy - 0.5)
            d = np.sqrt((px - fx) ** 2 + (py - fy) ** 2)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            f1 = np.minimum(f1, d)
    return (f2 - f1) * cell_mm, f1 * cell_mm


def smoothstep(edge0: float, edge1: float, x):
    """Hermite smoothstep; exactly 0 below edge0 and 1 above edge1."""
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)
