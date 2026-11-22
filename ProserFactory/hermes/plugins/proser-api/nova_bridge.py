"""Load the installed Nova request boundary without copying credentials or state."""
import importlib.util
from pathlib import Path
import sys


def nova():
    from hermes_constants import get_hermes_home
    name = '_nova_creative_shared'
    if name not in sys.modules:
        root = Path(get_hermes_home()) / 'plugins/nova-creative'
        spec = importlib.util.spec_from_file_location(name, root / '__init__.py', submodule_search_locations=[str(root)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None)
            raise
    return sys.modules[name]
