"""
Direct USB driver for the grandMA2-onPC-compatible wing (VID 03EB / PID 160B).

Protocol recovered from USBPcap capture of onPC session:
  1. Host downloads ARM firmware via bulk EP 0x02 (cmd 0x9001 + 0x9002 + raw 512B blocks)
  2. Wing reboots -> enumerates again as bcdUSB 0x100 (runtime mode)
  3. Init: 01 90 04 00 00 00 00 00  +  10 90 04 00 7c 00 00 00
  4. Runtime @ ~30 Hz:
       DMX:       06 90 04 02 00 02 <universe:u16le> <512 bytes>
       keepalive: 05 90 00 00
  5. Shutdown: 1a 91 00 00
"""
import json
import sys
import threading
import time
import os

import usb.core
import usb.backend.libusb1 as libusb1
import libusb_package

VID, PID = 0x03EB, 0x160B
EP_OUT, EP_IN = 0x02, 0x81

HERE = os.path.dirname(os.path.abspath(__file__))
BOOT_SEQ = os.path.join(HERE, "wing_boot_seq.json")

CMD_START = bytes.fromhex("01 90 04 00 00 00 00 00".replace(" ", ""))
CMD_INIT2 = bytes.fromhex("10 90 04 00 7c 00 00 00".replace(" ", ""))
CMD_KEEPALIVE = bytes.fromhex("05 90 00 00".replace(" ", ""))
CMD_SHUTDOWN = bytes.fromhex("1a 91 00 00".replace(" ", ""))
# 264-byte control packet that onPC sends every cycle (captured in stage '1').
# Body (260 bytes) = 130 x u16 LE LED brightness values (0..~2047, PWM).
# The wing only streams FULL input state (8 faders etc.) while it receives
# these; in the bare session it reports only 4 encoder channels.
# onPC plays a LED wave on connect (extracted to wing_wave.json) and then
# holds buttons dim (0x38) as the resting state.
CTL_HEADER = bytes.fromhex("04 90 04 01".replace(" ", ""))
CMD_CTL = CTL_HEADER + bytes(260)
LED_WORDS = 130
LED_MAX = 2047


def get_backend():
    path = libusb_package.get_library_path()
    return libusb1.get_backend(find_library=lambda x: str(path))


def open_wing(bcd=None, timeout=10.0):
    """Find the wing, optionally waiting for a specific bcdUSB (0x200 boot / 0x100 runtime).

    A FRESH libusb context is created on every poll: the Windows backend does not
    reliably see devices that re-enumerate after the context was created.
    """
    t0 = time.time()
    while time.time() - t0 < timeout:
        backend = get_backend()
        if backend is not None:
            dev = usb.core.find(idVendor=VID, idProduct=PID, backend=backend)
            if dev is not None and (bcd is None or dev.bcdUSB == bcd):
                try:
                    dev.set_configuration()
                except usb.core.USBError:
                    pass  # already configured
                return dev
        time.sleep(0.3)
    return None


def drain_in(dev, timeout_ms=200):
    """Read and discard pending IN data (status/memory dumps from the wing)."""
    try:
        while True:
            dev.read(EP_IN, 4096, timeout=timeout_ms)
    except usb.core.USBTimeoutError:
        pass
    except usb.core.USBError:
        pass


def upload_firmware(dev, verbose=True):
    """Replay the recorded firmware download (stage 0 from the capture)."""
    with open(BOOT_SEQ) as f:
        seq = json.load(f)
    packets = seq["stages"]["0"]
    if verbose:
        print(f"[FW] uploading {len(packets)} packets...")
    for e in packets:
        dev.write(EP_OUT, bytes.fromhex(e["data"]))
    if verbose:
        print("[FW] upload done")
    drain_in(dev, 300)


def dmx_packet(universe: int, data: bytes) -> bytes:
    assert len(data) == 512
    hdr = bytes.fromhex("06 90 04 02 00 02".replace(" ", "")) + universe.to_bytes(2, "little")
    return hdr + data


class Wing:
    def __init__(self, verbose=True, full_session=False):
        self.verbose = verbose
        self.full_session = full_session
        self.dev = None
        self._reader_stop = threading.Event()
        self._reader = None
        self._input_callback = None
        self._input_debug = os.environ.get("WING_INPUT_DEBUG") == "1"
        self._in_pkts = 0  # диагностика (14.08): число принятых IN-пакетов крыла
        self._in_last = 0  # длина последнего IN-пакета
        # LED-состояние: 130 слов u16 (яркость 0..2047), уходит в ctl-пакете
        self.led_body = bytearray(260)
        self._led_lock = threading.Lock()

    # ---------- LEDs ----------
    def set_led(self, word: int, value: int):
        """Set one LED word (0..129) to brightness 0..2047."""
        if 0 <= word < LED_WORDS:
            value = max(0, min(LED_MAX, int(value)))
            with self._led_lock:
                self.led_body[word * 2:word * 2 + 2] = value.to_bytes(2, "little")

    def fill_leds(self, value: int):
        value = max(0, min(LED_MAX, int(value)))
        with self._led_lock:
            self.led_body[:] = value.to_bytes(2, "little") * LED_WORDS

    def clear_leds(self):
        with self._led_lock:
            self.led_body[:] = bytes(260)

    def set_led_frame(self, body: bytes):
        """Replace the whole 260-byte LED body (used by the wave player)."""
        if len(body) == 260:
            with self._led_lock:
                self.led_body[:] = body

    def set_input_callback(self, cb):
        """cb(raw_payload: bytes) called on every IN packet from the wing."""
        self._input_callback = cb

    # ---------- low level ----------
    def _open_any(self, timeout=5.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            backend = get_backend()
            if backend is not None:
                dev = usb.core.find(idVendor=VID, idProduct=PID, backend=backend)
                if dev is not None:
                    try:
                        dev.set_configuration()
                    except usb.core.USBError:
                        pass
                    return dev
            time.sleep(0.3)
        return None

    def _start_reader(self):
        self._reader_stop.clear()

        def _run():
            while not self._reader_stop.is_set():
                try:
                    data = bytes(self.dev.read(EP_IN, 4096, timeout=200))
                    self._in_pkts += 1
                    self._in_last = len(data)
                    if self._input_callback is not None:
                        try:
                            self._input_callback(data)
                        except Exception:
                            pass
                    if self._input_debug:
                        print(f"[WING IN] len={len(data)}: {data[:48].hex(' ')}")
                except usb.core.USBTimeoutError:
                    pass
                except usb.core.USBError:
                    break
                except Exception:
                    break

        self._reader = threading.Thread(target=_run, daemon=True)
        self._reader.start()

    def is_input_alive(self) -> bool:
        """Жив ли поток чтения ввода крыла (14.08: перезапуск при тихой смерти)."""
        return self._reader is not None and self._reader.is_alive()

    def input_stats(self) -> dict:
        """Диагностика ввода крыла (14.08): число IN-пакетов и длина последнего."""
        return {"pkts": self._in_pkts, "last_len": self._in_last,
                "alive": self.is_input_alive()}

    def _stop_reader(self):
        self._reader_stop.set()
        if self._reader is not None:
            self._reader.join(timeout=1)
            self._reader = None

    # ---------- session ----------
    def start(self, retries=3):
        """Bring the wing into runtime mode and start a streaming session."""
        for attempt in range(1, retries + 1):
            dev = self._open_any(timeout=5)
            if dev is None:
                raise RuntimeError("Wing not found (check USB connection)")
            if self.verbose:
                print(f"[WING] attempt {attempt}: mode bcdUSB={hex(dev.bcdUSB)} addr={dev.address}")
            try:
                if dev.bcdUSB == 0x200:
                    # boot mode: full firmware upload (jumps to runtime either
                    # after upload or immediately if firmware is still in RAM)
                    try:
                        upload_firmware(dev, self.verbose)
                    except usb.core.USBError as e:
                        if self.verbose:
                            print(f"[FW] interrupted ({e}) - jumped to runtime mode")
                    try:
                        usb.util.dispose_resources(dev)
                    except Exception:
                        pass
                    time.sleep(2.0)  # let it re-enumerate
                    dev = self._open_any(timeout=10)
                    if dev is None:
                        continue
                # runtime mode: start session + stream immediately
                self.dev = dev
                self.dev.write(EP_OUT, CMD_START, timeout=1000)
                time.sleep(0.05)
                self.dev.write(EP_OUT, CMD_INIT2, timeout=1000)
                if self.full_session:
                    # onPC sends the 264-byte ctl packet right after init
                    time.sleep(0.05)
                    self.dev.write(EP_OUT, CMD_CTL, timeout=1000)
                self._start_reader()
                # prove the session works with one real frame
                self.send_dmx(bytes(512), bytes(512))
                if self.verbose:
                    print(f"[WING] runtime session started (bcdUSB={hex(self.dev.bcdUSB)})")
                return
            except usb.core.USBError as e:
                if self.verbose:
                    print(f"[WING] attempt {attempt} failed: {e}")
                self._stop_reader()
                try:
                    usb.util.dispose_resources(dev)
                except Exception:
                    pass
                self.dev = None
                time.sleep(1.0)
        raise RuntimeError("Could not establish runtime session with the wing")

    def send_dmx(self, u1: bytes, u2: bytes = None):
        """Send one DMX frame for universe 1 (and optionally universe 2)."""
        self.dev.write(EP_OUT, dmx_packet(1, u1), timeout=1000)
        if u2 is not None:
            self.dev.write(EP_OUT, dmx_packet(2, u2), timeout=1000)
        if self.full_session:
            # onPC interleaves the ctl packet with DMX frames each cycle;
            # body = current LED state (zeros by default)
            with self._led_lock:
                ctl = CTL_HEADER + bytes(self.led_body)
            self.dev.write(EP_OUT, ctl, timeout=1000)
        self.dev.write(EP_OUT, CMD_KEEPALIVE, timeout=1000)

    def stop(self):
        self._stop_reader()
        try:
            if self.dev is not None:
                self.dev.write(EP_OUT, CMD_SHUTDOWN, timeout=500)
                usb.util.dispose_resources(self.dev)
        except usb.core.USBError:
            pass
        self.dev = None
        if self.verbose:
            print("[WING] shutdown")


def run_test():
    wing = Wing()
    wing.start()
    print("[TEST] sending DMX test pattern for 15 s:")
    print("       U1 ch1 = ramp, ch2 = 128, ch3 = 255 | U2 ch1 = 64")
    t0 = time.time()
    try:
        while time.time() - t0 < 15.0:
            phase = (time.time() - t0) % 4.0
            ramp = int(255 * (phase / 4.0))
            u1 = bytearray(512)
            u1[0] = ramp          # ch1 ramp
            u1[1] = 128           # ch2 half
            u1[2] = 255           # ch3 full
            u2 = bytearray(512)
            u2[0] = 64            # u2 ch1 quarter
            wing.send_dmx(bytes(u1), bytes(u2))
            time.sleep(1.0 / 30)
    except KeyboardInterrupt:
        pass
    wing.stop()
    print("[TEST] done")


def run_comb_test(seconds=30):
    """Test on the first comb fixture (startChannel 250, 43ch comb_rgbw layout)."""
    import math
    wing = Wing()
    wing.start()
    base = 249  # DMX ch 250 -> index 249
    print(f"[COMB] {seconds}s: MotorY swings, all 10 beams white full")
    t0 = time.time()
    try:
        while time.time() - t0 < seconds:
            t = time.time() - t0
            u1 = bytearray(512)
            u1[base + 0] = int(127 + 100 * math.sin(t * 1.2))   # MotorY swing
            u1[base + 1] = 60                                    # SpdY
            for b in range(10):                                  # 10x RGBW beams
                o = base + 2 + b * 4
                u1[o + 0] = 255  # R
                u1[o + 1] = 220  # G
                u1[o + 2] = 180  # B
                u1[o + 3] = 255  # W
            u1[base + 42] = 0                                    # Reset off
            wing.send_dmx(bytes(u1), bytes(512))
            time.sleep(1.0 / 30)
    except KeyboardInterrupt:
        pass
    wing.stop()
    print("[COMB] done")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        run_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "comb":
        run_comb_test()
    else:
        print("usage: wing_driver.py test|comb")
