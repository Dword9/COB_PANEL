"""
Interactive calibration: verify which physical controls (8 faders, 4 encoders,
buttons) actually send data, and WHERE in the packet they report it.

Flow per control: prompt "move fader N, then press SPACE". While measuring,
the tool tracks:
  * the 4 known analog int32 channels (offsets 32/36/40/44),
  * EVERY byte offset of the 140/144-byte state packet (full-packet diff),
  * all packet lengths seen (in case a control uses a different packet shape).

Buttons phase: press each button once, IDs are printed live; SPACE finishes.

Run with the Lumina server STOPPED (use calibrate.bat - it stops/starts the
server task for you). Result is saved to wing_calibrate_result.json.
"""
import json
import os
import sys
import threading
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wing_driver import Wing
from wing_input_mapper import find_button_events, ANALOG_OFFSETS

try:
    import msvcrt
except ImportError:
    msvcrt = None

RESULT_FILE = "wing_calibrate_result.json"
MOVE_THRESHOLD = 3        # min raw delta for the known analog channels
BYTE_THRESHOLD = 2        # min byte-level delta for the full-packet scan
STATE_HEAD = bytes.fromhex("03907c00")  # state report header (any length)
KNOWN_ANALOG_BYTES = set(range(32, 48))  # bytes of the 4 known int32 channels


def is_state(data: bytes) -> bool:
    return len(data) >= 48 and data[:4] == STATE_HEAD


def parse_analog_any(data: bytes):
    """4 x int32 at offsets 32/36/40/44 in any state packet (140/144/200/...)."""
    if not is_state(data):
        return None
    return [int.from_bytes(data[o:o + 4], "little", signed=s) for o, s in ANALOG_OFFSETS]

ANALOG_STEPS = [f"Фейдер {i}" for i in range(1, 9)] + [f"Энкодер {i}" for i in range(1, 5)]


def wait_space():
    """Block until SPACE is pressed (Enter works as fallback)."""
    if msvcrt is None:
        input("  [нажмите Enter]")
        return
    while msvcrt.kbhit():
        msvcrt.getwch()
    while True:
        if msvcrt.kbhit():
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):  # special-key prefix, consume scancode
                msvcrt.getwch()
                continue
            if ch == " " or ch in ("\r", "\n"):
                return
        time.sleep(0.05)


class Calibrator:
    def __init__(self):
        self.wing = Wing(verbose=True, full_session=True)
        self._lock = threading.Lock()
        self._latest = [0, 0, 0, 0]   # last known analog int32 values
        self._minmax = None           # per-step [[mn, mx] x4] for known channels
        self._bytescan = None         # per-step {offset: [mn, mx]} full-packet diff
        self._pktlens = None          # per-step Counter of packet lengths
        self._buttons = []            # pressed button ids, in order
        self._ka_stop = threading.Event()

    # ---------- input ----------
    def on_input(self, data: bytes):
        with self._lock:
            if self._pktlens is not None:
                self._pktlens[len(data)] += 1
            if is_state(data) and self._bytescan is not None:
                bs = self._bytescan
                for i, b in enumerate(data):
                    mm = bs.get(i)
                    if mm is None:
                        bs[i] = [b, b]
                    else:
                        if b < mm[0]:
                            mm[0] = b
                        if b > mm[1]:
                            mm[1] = b
        analog = parse_analog_any(data)
        if analog is not None:
            with self._lock:
                self._latest = list(analog)
                if self._minmax is not None:
                    for i, v in enumerate(analog):
                        mm = self._minmax[i]
                        if v < mm[0]:
                            mm[0] = v
                        if v > mm[1]:
                            mm[1] = v
        # button events can ride as a trailer on state packets of any length;
        # skip the one-time huge init dump (>1000 bytes)
        if len(data) < 1000:
            for bid, pressed in find_button_events(data):
                if pressed:
                    with self._lock:
                        self._buttons.append(bid)
                    print(f"  >> нажата кнопка ID={bid}")

    # ---------- session ----------
    def _keepalive_loop(self):
        while not self._ka_stop.is_set():
            try:
                self.wing.send_dmx(bytes(512), bytes(512))
            except Exception as e:
                print(f"[CAL] сессия потеряна ({e}); перезапуск...")
                try:
                    self.wing.stop()
                except Exception:
                    pass
                try:
                    self.wing.start()
                except Exception:
                    pass
                time.sleep(0.5)
                continue
            time.sleep(1.0 / 30)

    # ---------- steps ----------
    def run_analog_step(self, label: str) -> dict:
        with self._lock:
            self._minmax = [[v, v] for v in self._latest]
            self._bytescan = {}
            self._pktlens = Counter()
        print(f"\n=== {label}: двигайте (энкодер — крутите в обе стороны), затем ПРОБЕЛ ===")
        wait_space()
        with self._lock:
            mm = self._minmax
            bs = self._bytescan
            lens = self._pktlens
            self._minmax = None
            self._bytescan = None
            self._pktlens = None

        # 1) known analog channels
        moved = []
        for i, (mn, mx) in enumerate(mm):
            if mx - mn >= MOVE_THRESHOLD:
                off, signed = ANALOG_OFFSETS[i]
                moved.append({"channel": i, "offset": off, "signed": signed,
                              "min": mn, "max": mx})
        # 2) full-packet diff outside the known channels
        other = []
        for off in sorted(bs):
            mn, mx = bs[off]
            if off in KNOWN_ANALOG_BYTES:
                continue
            if mx - mn >= BYTE_THRESHOLD:
                other.append({"offset": off, "min": mn, "max": mx})
        # 3) packet shapes seen during the step
        shapes = {str(k): v for k, v in sorted(lens.items())}

        if moved:
            for m in moved:
                s = " (signed)" if m["signed"] else ""
                print(f"  OK аналог: ch{m['channel']} @{m['offset']}{s}, "
                      f"диапазон {m['min']}..{m['max']}")
        if other:
            rng = ", ".join(f"@{o['offset']}:[{o['min']}..{o['max']}]" for o in other)
            print(f"  OK байты пакета вне известных каналов: {rng}")
        if not moved and not other:
            print("  !! сигнала нет (ни в известных каналах, ни где-либо в пакете)")
        print(f"  длины пакетов за шаг: {shapes}")
        return {"label": label, "moved": moved, "other_bytes": other,
                "packet_lengths": shapes}

    def run_buttons_phase(self):
        print("\n=== Кнопки: нажимайте по одной (лучше рядами слева направо), "
              "ПРОБЕЛ — завершить ===")
        with self._lock:
            self._buttons = []
        wait_space()
        with self._lock:
            unique = list(dict.fromkeys(self._buttons))  # unique, in press order
        print(f"  Зафиксировано уникальных кнопок: {len(unique)} -> {unique}")
        return unique


def print_summary(results):
    print("\n" + "=" * 60)
    print("СВОДКА")
    print("=" * 60)
    silent = []
    for step in results["analog_steps"]:
        parts = []
        for m in step["moved"]:
            parts.append(f"аналог ch{m['channel']} [{m['min']}..{m['max']}]")
        if step.get("other_bytes"):
            offs = ",".join(str(o["offset"]) for o in step["other_bytes"])
            parts.append(f"байты @{offs}")
        if parts:
            print(f"  {step['label']:<12} -> {'; '.join(parts)}")
        else:
            silent.append(step["label"])
            print(f"  {step['label']:<12} -> МОЛЧИТ")
    if silent:
        print(f"\n  Не отвечают ({len(silent)}): {', '.join(silent)}")
    print(f"\n  Кнопок нажато: {len(results['buttons'])}: {results['buttons']}")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    cal = Calibrator()
    cal.wing.set_input_callback(cal.on_input)
    print("Подключаюсь к крылу...")
    try:
        cal.wing.start()
    except RuntimeError as e:
        print(f"\nОШИБКА: {e}")
        print("Вероятно, сервер Lumina ещё держит крыло.")
        print("Запускайте через calibrate.bat — он сам остановит и поднимет сервер.")
        return
    ka = threading.Thread(target=cal._keepalive_loop, daemon=True)
    ka.start()
    print("Сессия запущена.\n")
    print("Порядок: 8 фейдеров, 4 энкодера, затем кнопки.")
    print("На каждом шаге: подвигайте орган управления, затем нажмите ПРОБЕЛ.")
    print("Если орган не даёт сигнала — просто нажмите ПРОБЕЛ, пойдём дальше.")
    results = {"analog_steps": [], "buttons": []}
    try:
        for label in ANALOG_STEPS:
            results["analog_steps"].append(cal.run_analog_step(label))
        results["buttons"] = cal.run_buttons_phase()
    except KeyboardInterrupt:
        print("\nПрервано пользователем.")
    finally:
        cal._ka_stop.set()
        try:
            cal.wing.stop()
        except Exception:
            pass
    print_summary(results)
    with open(RESULT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nРезультат сохранён: {os.path.abspath(RESULT_FILE)}")


if __name__ == "__main__":
    main()
