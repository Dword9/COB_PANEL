"""
Interactive LED layout probe: lights LED words in groups of 8 so you can map
which physical buttons/LEDs they drive on the wing.

Run with the Lumina server STOPPED (led_test.bat stops/starts it for you).
Uses the full session (the ctl packet carries the 130-word LED body).

Keys: SPACE/ENTER = next group, B = previous group, Q = quit.
Tell the assistant afterwards which group lit what — the VU-map
(wing_led_map.json) will be updated from your notes.
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wing_driver import Wing, LED_WORDS, LED_MAX

try:
    import msvcrt
except ImportError:
    msvcrt = None

GROUP = 8


def wait_key() -> str:
    if msvcrt is None:
        input("  [Enter = дальше]")
        return " "
    while msvcrt.kbhit():
        msvcrt.getwch()
    while True:
        if msvcrt.kbhit():
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):
                msvcrt.getwch()
                continue
            return ch.lower()
        time.sleep(0.05)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    wing = Wing(verbose=True, full_session=True)
    print("Подключаюсь к крылу...")
    try:
        wing.start()
    except RuntimeError as e:
        print(f"\nОШИБКА: {e}")
        print("Вероятно, сервер Lumina ещё держит крыло. Запускайте через led_test.bat.")
        return
    stop = threading.Event()

    def ka():
        while not stop.is_set():
            try:
                wing.send_dmx(bytes(512), bytes(512))
            except Exception:
                time.sleep(0.5)
            time.sleep(1.0 / 30)

    threading.Thread(target=ka, daemon=True).start()
    print("Сессия запущена. Подсвечиваю группы LED по 8 слов на максимум.")
    print("SPACE/ENTER — следующая группа, B — предыдущая, Q — выход.\n")
    groups = list(range(0, LED_WORDS, GROUP))
    i = 0
    try:
        while 0 <= i < len(groups):
            w0 = groups[i]
            w1 = min(w0 + GROUP, LED_WORDS) - 1
            wing.clear_leds()
            for w in range(w0, w1 + 1):
                wing.set_led(w, LED_MAX)
            print(f">>> words {w0}..{w1} — что зажглось?", end=" ", flush=True)
            k = wait_key()
            print()
            if k == "q":
                break
            elif k == "b":
                i = max(0, i - 1)
            else:
                i += 1
    except KeyboardInterrupt:
        pass
    finally:
        wing.clear_leds()
        stop.set()
        try:
            wing.stop()
        except Exception:
            pass
    print("\nГотово. Сообщите, какая группа что зажигала — обновлю wing_led_map.json.")


if __name__ == "__main__":
    main()
