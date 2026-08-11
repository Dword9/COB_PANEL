#!/usr/bin/env python3
"""
Auto-mapping LED words -> physical buttons on the wing.

Lights one LED word at max, waits for button press on the wing,
records word -> button_id mapping.

Usage:
  1. Stop Lumina server
  2. python wing_led_button_map.py [start] [end]
  3. Each step: one word lights up -> press that button on the wing

Keys:
  SPACE/ENTER - skip to next word
  B           - go back
  Q           - quit (saves progress)
"""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wing_driver import Wing, LED_WORDS, LED_MAX
from wing_input_mapper import find_button_events

DEFAULT_START = 0
DEFAULT_END   = 129

OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wing_led_button_map.json")

pressed_button = None
press_event = threading.Event()


def on_raw_packet(data: bytes):
    for bid, pressed in find_button_events(data):
        if pressed:
            global pressed_button
            pressed_button = bid
            press_event.set()


def load_existing_map() -> dict:
    try:
        with open(OUT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_map(mapping: dict):
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)
    print()
    print("[SAVED] " + OUT_FILE)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="LED word -> button mapper")
    parser.add_argument("start", type=int, nargs="?", default=DEFAULT_START)
    parser.add_argument("end", type=int, nargs="?", default=DEFAULT_END)
    args = parser.parse_args()

    start = max(0, min(args.start, LED_WORDS - 1))
    end   = max(start, min(args.end, LED_WORDS - 1))

    print("=== Wing LED <-> Button Mapper ===")
    print("Range: %d .. %d" % (start, end))
    print("Keys:  SPACE/ENTER=next  B=back  Q=quit")
    print("Step:  one LED lights up -> press that button on the wing")
    print()

    mapping = load_existing_map()
    if mapping:
        print("Loaded %d existing mappings" % len(mapping))

    wing = Wing(verbose=True, full_session=True)
    print("Connecting to wing...")
    try:
        wing.start()
    except RuntimeError as e:
        print()
        print("ERROR: %s" % e)
        print("Stop LuminaDMX task first.")
        return

    wing.set_input_callback(on_raw_packet)

    stop_ka = threading.Event()
    def keep_alive():
        while not stop_ka.is_set():
            try:
                wing.send_dmx(bytes(512), bytes(512))
            except Exception:
                time.sleep(0.5)
            time.sleep(1.0 / 30)
    threading.Thread(target=keep_alive, daemon=True).start()

    global pressed_button
    i = start
    try:
        while start <= i <= end:
            word = i
            wing.clear_leds()
            wing.set_led(word, LED_MAX)

            sys.stdout.write("\r>>> word %3d  press the lit button  (%d mapped, SPACE=skip B=back Q=quit)   " % (word, len(mapping)))
            sys.stdout.flush()

            pressed_button = None
            press_event.clear()

            while True:
                if press_event.is_set():
                    btn = pressed_button
                    mapping[str(i)] = btn
                    sys.stdout.write("\r    OK word %3d -> button %d               \n" % (i, btn))
                    sys.stdout.flush()
                    save_map(mapping)
                    break

                try:
                    import msvcrt
                    if msvcrt.kbhit():
                        ch = msvcrt.getwch()
                        if ch in ("\x00", "\xe0"):
                            msvcrt.getwch()
                            continue
                        ch = ch.lower()
                    else:
                        time.sleep(0.02)
                        continue
                except ImportError:
                    import select
                    if not select.select([sys.stdin], [], [], 0)[0]:
                        time.sleep(0.02)
                        continue
                    ch = sys.stdin.read(1).lower()

                if ch in (" ", "\r", "\n"):
                    sys.stdout.write("\r    SKIP word %3d                          \n" % i)
                    sys.stdout.flush()
                    break
                elif ch == "b":
                    i = max(start, i - 1)
                    break
                elif ch == "q":
                    print("Quitting...")
                    raise KeyboardInterrupt

            i += 1
            time.sleep(0.15)

    except KeyboardInterrupt:
        pass
    finally:
        wing.clear_leds()
        try:
            wing.stop()
        except Exception:
            pass
        save_map(mapping)
        print()
        print("Done. Mapping saved to %s" % OUT_FILE)
        print("Contents:")
        for w, b in sorted(mapping.items(), key=lambda x: int(x[0])):
            print("  word %3s -> button %s" % (w, b))


if __name__ == "__main__":
    main()
