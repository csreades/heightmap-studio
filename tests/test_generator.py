"""Generator correctness: determinism, seams, windows, crop rotation."""

import numpy as np
import pytest

from battlefield import Domain, default_config

SEED = 1337


@pytest.fixture(scope="module")
def dom():
    return Domain(seed=SEED)


def test_determinism_same_seed(dom):
    a = dom.render_region(-37.5, 12.25, 64, 64, 2.0)
    b = Domain(default_config(), SEED).render_region(-37.5, 12.25, 64, 64, 2.0)
    assert np.array_equal(a, b)


def test_determinism_repeated_calls(dom):
    a = dom.render_region(100, 200, 48, 48, 3.0)
    b = dom.render_region(100, 200, 48, 48, 3.0)
    assert np.array_equal(a, b)


def test_different_seed_differs(dom):
    a = dom.render_region(0, 0, 32, 32, 2.0)
    b = Domain(default_config(), SEED + 1).render_region(0, 0, 32, 32, 2.0)
    assert not np.array_equal(a, b)


def test_config_changes_output(dom):
    cfg = default_config()
    cfg["layers"]["craters"]["probability"] = 1.0
    cfg["layers"]["craters"]["spacing_mm"] = 10.0
    b = Domain(cfg, SEED).render_region(0, 0, 32, 32, 2.0)
    a = dom.render_region(0, 0, 32, 32, 2.0)
    assert not np.array_equal(a, b)


def test_adjacent_tiles_seam_perfectly(dom):
    """2x2 grid of tiles must equal one large render, bit-exact."""
    ppm = 2.0
    size = 64.0
    x0, y0 = -80.0, 40.0
    big = dom.render_region(x0, y0, size * 2, size * 2, ppm)
    n = int(size * ppm)
    for j in range(2):
        for i in range(2):
            tile = dom.render_region(x0 + i * size, y0 + j * size,
                                     size, size, ppm)
            assert np.array_equal(
                tile, big[j * n:(j + 1) * n, i * n:(i + 1) * n]), \
                f"tile ({i},{j}) does not match the large render"


def test_subwindow_consistency(dom):
    """A small region must be identical whether rendered alone or as part
    of a much larger region (feature collection must not depend on the
    query bounding box)."""
    ppm = 2.0
    big = dom.render_region(0, 0, 400, 400, ppm)
    small = dom.render_region(150, 150, 50, 50, ppm)
    i0 = int(150 * ppm)
    n = int(50 * ppm)
    assert np.array_equal(small, big[i0:i0 + n, i0:i0 + n])


def test_crop_rotation_90_degrees(dom):
    """crop(w, h, rotation=90) must equal rot90 of crop(h, w, rotation=0):
    for 90-degree rotations the two sample grids coincide exactly."""
    cx, cy = 33.0, -21.0
    a = dom.crop(cx, cy, 25.0, 12.5, rotation=0.0, px_per_mm=4.0)
    b = dom.crop(cx, cy, 12.5, 25.0, rotation=90.0, px_per_mm=4.0)
    assert a.shape == (50, 100)
    assert b.shape == (100, 50)
    assert np.allclose(b, np.rot90(a), atol=1e-12)


def test_crop_rotation_360_identity(dom):
    a = dom.crop(10, 10, 25.0, 12.5, rotation=0.0, px_per_mm=4.0)
    b = dom.crop(10, 10, 25.0, 12.5, rotation=360.0, px_per_mm=4.0)
    assert np.allclose(a, b, atol=1e-9)


def test_crop_deterministic_and_arbitrary_rotation(dom):
    a = dom.crop(-5, 87, 25.0, 12.5, rotation=33.7, px_per_mm=8.0)
    b = Domain(default_config(), SEED).crop(-5, 87, 25.0, 12.5,
                                            rotation=33.7, px_per_mm=8.0)
    assert np.array_equal(a, b)
    assert a.shape == (100, 200)
    assert np.isfinite(a).all()


def test_crop_matches_render_region_at_zero_rotation(dom):
    """crop() is center-based; render_region() is corner-based. Same grid
    -> identical values (crop must be usable by the mesh pipeline without
    any viewer code)."""
    crop = dom.crop(0, 0, 20.0, 10.0, rotation=0.0, px_per_mm=4.0)
    region = dom.render_region(-10.0, -5.0, 20.0, 10.0, 4.0)
    assert np.array_equal(crop, region)


def test_layer_toggles(dom):
    base = dom.render_region(0, 0, 32, 32, 2.0)
    for layer in ["ground", "cracks", "craters", "plates", "roads", "detail"]:
        cfg = default_config()
        cfg["layers"][layer]["enabled"] = False
        out = Domain(cfg, SEED).render_region(0, 0, 32, 32, 2.0)
        assert out.shape == base.shape
        assert np.isfinite(out).all()


def test_relief_in_physical_range(dom):
    """Default config should produce relief in a plausible band for
    0.3-0.8mm target features on a 25mm base."""
    h = dom.render_region(0, 0, 200, 200, 2.0)
    relief = h.max() - h.min()
    assert 0.3 < relief < 3.0
    lo, hi = dom.estimated_range()
    assert lo <= h.min() + 0.3 and hi >= h.max() - 0.3


def test_master_amplitude_scales_linearly(dom):
    cfg = default_config()
    cfg["master_amplitude"] = 2.0
    a = dom.render_region(5, 5, 32, 32, 2.0)
    b = Domain(cfg, SEED).render_region(5, 5, 32, 32, 2.0)
    assert np.allclose(b, a * 2.0, atol=1e-12)


def test_sourced_layers_deterministic():
    """Library-driven cracks + crater stamps must be as deterministic as
    the procedural path (skipped if the library hasn't been sourced)."""
    import os
    from battlefield import Library
    if not os.path.isdir("library/ph_mud_cracked_dry_03"):
        pytest.skip("library not populated")
    cfg = default_config()
    cfg["layers"]["cracks"]["source"] = "ph_mud_cracked_dry_03"
    cfg["layers"]["craters"]["source"] = "nasa_lola_tycho"
    a = Domain(cfg, SEED, library=Library("library")).render_region(0, 0, 64, 64, 2.0)
    b = Domain(cfg, SEED, library=Library("library")).render_region(0, 0, 64, 64, 2.0)
    assert np.array_equal(a, b)
    big = Domain(cfg, SEED, library=Library("library")).render_region(-32, -32, 128, 128, 2.0)
    assert np.array_equal(a, big[64:192, 64:192])
