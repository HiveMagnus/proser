#!/usr/bin/env python3
"""Launch the distro Orca CLI unchanged with its debug stream line buffered."""
import builtins
import runpy
import sys

source, prefs, debug = sys.argv[1:]
original_open = builtins.open


def open_output(file, *args, **kwargs):
    if str(file) == debug:
        kwargs["buffering"] = 1
    return original_open(file, *args, **kwargs)


builtins.open = open_output
sys.argv = [source, "--user-prefs", prefs, "--debug-file", debug]
runpy.run_path(source, run_name="__main__")
