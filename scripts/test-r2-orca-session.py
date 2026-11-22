#!/usr/bin/env python3
"""Run real Orca in an isolated X11/AT-SPI session, without desktop settings.

Prerequisites: Xvfb, dbus-run-session and Orca dependencies, optionally extracted
from distro .deb packages under OUTPUT/runtime (no root installation required).
Speech uses Speech Dispatcher's dummy sink: generated/issued speech is captured,
not an assertion about audible synthesis or physical braille hardware.
"""
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import time


def keys(sequence):
    x = ctypes.CDLL("libX11.so.6")
    xt = ctypes.CDLL("libXtst.so.6")
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x.XStringToKeysym.restype = ctypes.c_ulong
    x.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XKeysymToKeycode.restype = ctypes.c_uint
    x.XFlush.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Private X11 display is unavailable")
    try:
        for combination in sequence:
            codes = [x.XKeysymToKeycode(display, x.XStringToKeysym(key.encode())) for key in combination.split("+")]
            if not all(codes):
                raise RuntimeError(f"Unknown X11 key: {combination}")
            for code in codes:
                xt.XTestFakeKeyEvent(display, code, 1, 0)
            for code in reversed(codes):
                xt.XTestFakeKeyEvent(display, code, 0, 0)
            x.XFlush(display)
            time.sleep(0.2)
    finally:
        x.XCloseDisplay(display)


def focus_window(title):
    x = ctypes.CDLL("libX11.so.6")
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    x.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XInternAtom.restype = ctypes.c_ulong
    x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
    x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    x.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XFlush.argtypes = [ctypes.c_void_p]
    x.XFree.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Private X11 display is unavailable")
    try:
        root = x.XDefaultRootWindow(display)
        queue = [root]
        names = []
        while queue:
            window = queue.pop(0)
            value = ""
            actual, items, after = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_ulong()
            format = ctypes.c_int()
            data = ctypes.c_void_p()
            if x.XGetWindowProperty(display, window, x.XInternAtom(display, b"_NET_WM_NAME", 0), 0, 1024, 0, 0, ctypes.byref(actual), ctypes.byref(format), ctypes.byref(items), ctypes.byref(after), ctypes.byref(data)) == 0 and data.value:
                value = ctypes.string_at(data, items.value).decode(errors="replace")
                x.XFree(data)
            name = ctypes.c_char_p()
            if not value and x.XFetchName(display, window, ctypes.byref(name)) and name.value:
                value = name.value.decode(errors="replace")
                x.XFree(name)
            if value:
                names.append(value)
            if title in value:
                x.XRaiseWindow(display, window)
                x.XSetInputFocus(display, window, 2, 0)
                x.XFlush(display)
                return
            found_root, parent = ctypes.c_ulong(), ctypes.c_ulong()
            children = ctypes.POINTER(ctypes.c_ulong)()
            count = ctypes.c_uint()
            if x.XQueryTree(display, window, ctypes.byref(found_root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
                queue.extend(children[index] for index in range(count.value))
                if children:
                    x.XFree(children)
        raise RuntimeError(f"No private X11 browser window named {title}; found {names}")
    finally:
        x.XCloseDisplay(display)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=f"output/playwright/r2/orca/run-{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}")
    parser.add_argument("--runtime")
    parser.add_argument("--inner", action="store_true")
    parser.add_argument("--keys", nargs="+")
    parser.add_argument("--focus")
    parser.add_argument("--status-server", action="store_true")
    args = parser.parse_args()
    if args.keys:
        keys(args.keys)
        return
    if args.focus:
        focus_window(args.focus)
        return
    if args.status_server:
        # This private bus status endpoint replaces desktop-wide accessibility
        # preferences. Actual AT-SPI events/registry and Orca remain unmodified.
        from gi.repository import Gio, GLib
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", GLib.Variant("(su)", ("org.a11y.Bus", 0)), None, Gio.DBusCallFlags.NONE, -1, None)
        xml = '<node><interface name="org.a11y.Bus"><method name="GetAddress"><arg type="s" direction="out"/></method></interface><interface name="org.a11y.Status"><property name="IsEnabled" type="b" access="readwrite"/><property name="ScreenReaderEnabled" type="b" access="readwrite"/></interface></node>'
        interfaces = Gio.DBusNodeInfo.new_for_xml(xml).interfaces
        def call(connection, sender, path, interface, method, parameters, invocation):
            invocation.return_value(GLib.Variant("(s)", (os.environ["AT_SPI_BUS_ADDRESS"],)))
        def get_property(*unused):
            return GLib.Variant("b", True)
        def set_property(*unused):
            return True
        for interface in interfaces:
            connection.register_object("/org/a11y/bus", interface, call, get_property, set_property)
        GLib.MainLoop().run()
        return
    output = Path(args.output).resolve()
    runtime = Path(args.runtime).resolve() if args.runtime else Path("output/playwright/r2/orca/runtime").resolve()
    evidence_root = Path(__file__).resolve().parent.parent / "output/playwright"
    if not output.is_relative_to(evidence_root) or not runtime.is_relative_to(evidence_root):
        raise ValueError("Private Orca runtime and evidence must stay under ignored output/playwright")
    output.mkdir(parents=True, exist_ok=True)
    if not args.inner:
        # A fresh session bus excludes the user's active desktop and applications.
        forwarded = ["--output", str(output), "--runtime", str(runtime)]
        os.execvp("dbus-run-session", ["dbus-run-session", "--", "/usr/bin/python3", str(Path(__file__).resolve()), "--inner", *forwarded])
    if (output / "orca-debug.log").exists():
        raise RuntimeError("Choose a new output directory; retained Orca evidence must not be overwritten")
    lock = (runtime.parent / "orca-runtime.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def terminate(signum, frame):
        raise KeyboardInterrupt("The isolated Orca session was interrupted")
    signal.signal(signal.SIGTERM, terminate)
    environment = os.environ.copy()
    environment.update({
        "PYTHONPATH": str(runtime / "usr/lib/python3/dist-packages"),
        "GI_TYPELIB_PATH": str(runtime / "usr/lib/x86_64-linux-gnu/girepository-1.0"),
        "LD_LIBRARY_PATH": str(runtime / "usr/lib/x86_64-linux-gnu"),
        "GSETTINGS_BACKEND": "memory",
        "NO_AT_BRIDGE": "0",
        "LANG": "C.UTF-8",
        "PLAYWRIGHT_BROWSERS_PATH": os.environ.get("PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / ".cache/ms-playwright")),
    })
    for kind in ["CONFIG", "CACHE", "DATA", "STATE", "RUNTIME"]:
        directory = output / f"xdg-{kind.lower()}"
        directory.mkdir(mode=0o700, exist_ok=True)
        environment[f"XDG_{kind}_HOME" if kind != "RUNTIME" else "XDG_RUNTIME_DIR"] = str(directory)
    children = []
    handles = []

    def spawn(command, name, capture_address=False, env=None):
        handle = (output / f"{name}.log").open("w")
        handles.append(handle)
        child = subprocess.Popen(command, env=env or environment, stdout=subprocess.PIPE if capture_address else handle, stderr=handle, text=True)
        children.append(child)
        return child

    try:
        display = spawn(["Xvfb", "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], "xvfb", True)
        environment["DISPLAY"] = f":{display.stdout.readline().strip()}"
        services = output / "accessibility-services"
        services.mkdir(exist_ok=True)
        (services / "org.a11y.atspi.Registry.service").write_text(f"[D-BUS Service]\nName=org.a11y.atspi.Registry\nExec={runtime}/usr/libexec/at-spi2-registryd\n")
        config = (runtime / "usr/share/defaults/at-spi2/accessibility.conf").read_text().replace("/usr/share/dbus-1/accessibility-services", str(services))
        bus_config = output / "accessibility.conf"
        bus_config.write_text(config)
        bus = spawn(["dbus-daemon", "--nofork", "--print-address=1", f"--config-file={bus_config}"], "accessibility-bus", True)
        environment["AT_SPI_BUS_ADDRESS"] = bus.stdout.readline().strip()
        spawn(["/usr/bin/python3", str(Path(__file__).resolve()), "--status-server"], "private-status")
        speech_config = output / "speech-config"
        speech_config.mkdir(exist_ok=True)
        (speech_config / "speechd.conf").write_text('LogLevel 5\nAudioOutputMethod "alsa"\nAudioALSADevice "null"\nAddModule "dummy" "sd_dummy"\nDefaultModule dummy\n')
        environment["SPEECHD_PLUGIN_DIR"] = str(runtime / "usr/lib/x86_64-linux-gnu/speech-dispatcher")
        socket = output / "speech.sock"
        spawn([str(runtime / "usr/bin/speech-dispatcher"), "-s", "-C", str(speech_config), "-m", str(runtime / "usr/lib/speech-dispatcher-modules"), "-S", str(socket), "-P", str(output / "speech.pid"), "-L", str(output)], "speech-dispatcher")
        environment["SPEECHD_ADDRESS"] = f"unix_socket:{socket}"
        prefs = output / "orca-userprefs"
        prefs.mkdir(exist_ok=True)
        (prefs / "user-settings.conf").write_text(json.dumps({"general": {"firstStart": False, "enableSpeech": True, "enableBraille": False, "startingProfile": ["Default", "default"]}, "profiles": {"default": {"profile": ["Default", "default"], "pronunciations": {}, "keybindings": {}}}, "pronunciations": {}, "keybindings": {}}))
        time.sleep(0.5)
        orca = spawn(["/usr/bin/python3", str(Path(__file__).with_name("test-r2-orca-process.py")), str(runtime / "usr/bin/orca"), str(prefs), str(output / "orca-debug.log")], "orca")
        time.sleep(1)
        if orca.poll() is not None:
            raise RuntimeError("Orca failed to start; inspect private orca.log")
        command = ["node", str(Path(__file__).with_name("test-r2-orca-browser.mjs")), "--output", str(output)]
        result = subprocess.run(command, env=environment)
        return result.returncode
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        for handle in handles:
            handle.close()
        lock.close()


if __name__ == "__main__":
    sys.exit(main())
