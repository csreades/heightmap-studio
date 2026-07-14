"""battlefield: procedural battlefield heightmap generator.

Deterministic, seeded, unbounded layered heightfield in physical mm units.
The later STL pipeline should import Domain and use domain.crop() directly.
"""

from .config import (DEFAULT_CONFIG, config_hash, default_config, load_preset,
                     merge_config, save_preset)
from .domain import Domain
from .library import Library, import_map

__all__ = [
    "Domain", "Library", "import_map", "DEFAULT_CONFIG", "default_config",
    "merge_config", "config_hash", "save_preset", "load_preset",
]
