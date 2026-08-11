"""
Probe: log every incoming USB packet from the wing while you move faders/encoders/buttons.

Run with the Lumina server STOPPED (only one process can claim the wing).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wing_driver import Wing

LOG_FILE = "wing_input_probe.log"


def on_input(data: bytes):
    ts = time.strftime("%H:%M:%S", time.localtime()) + f".{(time.time() % 1) * 1000:03.0f}"
    line = f"{ts} len={len(data)} {data.hex()}\n"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line)


def main():
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)
    wing = Wing(verbose=True)
    wing.set_input_callback(on_input)
    print("Starting wing input probe...")
    print(f"Log file: {os.path.abspath(LOG_FILE)}")
    print("Instructions:")
    print("  1. Move each fader slowly from 0 to max")
    print("  2. Rotate each encoder left/right")
    print("  3. Press and release each button")
    print("  4. Press Ctrl+C to stop")
    try:
        wing.start()
    except RuntimeError as e:
        print(f"\nERROR: {e}")
        print("Most likely the Lumina server is still running and holding the wing.")
        print("Please run 'stop_server_task.bat' first, then retry.")
        return
    print("Session started. Keep moving controls while this runs.")
    count = 0
    try:
        while True:
            try:
                # keep the session alive so the wing keeps streaming input
                wing.send_dmx(bytes(512), bytes(512))
            except Exception as e:
                print(f"[PROBE] session lost ({e}); restarting...")
                try:
                    wing.stop()
                except Exception:
                    pass
                try:
                    wing.start()
                except Exception:
                    pass
                time.sleep(0.5)
                continue
            count += 1
            if count % 30 == 0:
                print(f"[PROBE] running, packets logged: {count}")
            time.sleep(1.0 / 30)
    except KeyboardInterrupt:
        pass
    wing.stop()
    print(f"\nDone. Send me this file: {os.path.abspath(LOG_FILE)}")


if __name__ == "__main__":
    main()
