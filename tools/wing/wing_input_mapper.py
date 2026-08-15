"""Map wing hardware controls (faders/encoders/buttons) to DMX channel writes.

Decoded packet format (probe + interactive calibration, full USB session):

  * Periodic STATE REPORT: starts with header 03 90 7c 00; length 140/144 in
    the bare session, can grow (200/392/...) once the wing streams full input.

    FADERS — 8 x uint16 little-endian, 10-bit (0..1023), at offsets 80..94.
      The wing numbers them internally as [3,4,5,6,7,8,1,2], so in physical
      label order (1..8) the offsets are:
        fader 1 @92, fader 2 @94, fader 3 @80, fader 4 @82,
        fader 5 @84, fader 6 @86, fader 7 @88, fader 8 @90

    ENCODERS — 4 x int32 SIGNED accumulated position counters at offsets
      32/36/40/44 (encoder 1..4 respectively). Turning left decreases,
      right increases. Mapped to DMX as relative increments of a virtual
      0..255 value (delta * sensitivity).

    NOTE: faders/encoders stream only while the host sends the 264-byte
    ctl packet 04 90 04 01 ... every cycle (see wing_driver.CMD_CTL,
    Wing(full_session=True)). In the bare session only the 4 encoder
    counters report, faders stay silent.

  * BUTTON EVENT: appended as a trailer to the state report.
      trailer : <01|02> 91 08 00  <u32 counter>  <u32 value>
                byte before magic = 01 -> press, 02 -> release
                value (u32, low byte is the button id) identifies the button.
"""
import json
import logging
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MAP_FILE = os.path.join(HERE, "wing_input_map.json")

STATE_HEAD = bytes.fromhex("03907c00")

# encoder counters: 4 x int32 signed at these offsets (name kept for
# compatibility with wing_calibrate.py imports)
ANALOG_OFFSETS = [(32, True), (36, True), (40, True), (44, True)]

# fader offsets in physical label order 1..8 (index 0 = fader 1)
FADER_OFFSETS = [92, 94, 80, 82, 84, 86, 88, 90]
FADER_RAW_MAX = 1023  # 10-bit ADC

logger = logging.getLogger("wing_input")


def is_state_report(data: bytes) -> bool:
    return len(data) >= 48 and data[:4] == STATE_HEAD


def find_button_events(data: bytes):
    """Return list of (button_id:int, pressed:bool) found in a packet."""
    out = []
    for i in range(1, len(data) - 10):
        if data[i] == 0x91 and data[i + 1] == 0x08 and data[i + 2] == 0x00:
            mb = data[i - 1]
            if mb in (0x01, 0x02):
                pressed = (mb == 0x01)
                value = int.from_bytes(data[i + 7:i + 11], "little")
                out.append((value, pressed))
    return out


def parse_analog(data: bytes):
    """Return list of 4 signed encoder counters (or None if not a state report)."""
    if not is_state_report(data):
        return None
    return [int.from_bytes(data[o:o + 4], "little", signed=s) for o, s in ANALOG_OFFSETS]


def parse_faders(data: bytes):
    """Return list of 8 uint16 fader values in physical order 1..8 (or None)."""
    if not is_state_report(data) or len(data) < 96:
        return None
    return [int.from_bytes(data[o:o + 2], "little") for o in FADER_OFFSETS]


class WingInputMapper:
    """Parses incoming wing packets and applies configured DMX mappings.

    If ``write_dmx`` is given it is called as write_dmx(ch_index, value) for
    every mapped control (used by WingSender). Otherwise the values are kept
    in an internal per-universe buffer accessible via get_frame().

    ``on_event(kind, ident, value)`` — вызывается на КАЖДОЕ движение органа
    (fader/encoder/button, value 0..255), независимо от карты: так UI может
    слушать крыло для Learn-режима MidiNode.
    """

    def __init__(self, write_dmx=None, on_event=None):
        self._write_dmx = write_dmx
        self._on_event = on_event
        self._debug = os.environ.get("WING_INPUT_DEBUG") == "1"
        self._map = {"faders": [], "encoders": [], "buttons": {}}
        self._dmx = {1: bytearray(512), 2: bytearray(512)}
        self._last_faders = [None] * 8
        self._fader_display = [0] * 8  # 0..255 позиции ВСЕХ фейдеров (вкл. пустые/немапленные) для UI-зеркала
        self._last_enc_raw = [None] * 4
        self._enc_value = [0, 0, 0, 0]  # virtual 0..255 positions
        self._enc_zero = [None] * 4  # калибровка текущей USB-сессии: raw = «12 часов» = 0
        self._load_map()

    def _event(self, kind, ident, value):
        cb = self._on_event
        if cb is not None:
            try:
                cb(kind, ident, value)
            except Exception:
                pass

    def _emit(self, universe, channel, value):
        value = max(0, min(255, int(value)))
        buf = self._dmx.get(universe)
        if buf is not None:
            buf[channel - 1] = value
        if self._write_dmx is not None:
            self._write_dmx(channel - 1, value)

    # ---------- config ----------
    def _load_map(self):
        try:
            with open(MAP_FILE, "r", encoding="utf-8") as f:
                self._map = json.load(f)
        except FileNotFoundError:
            logger.warning("wing_input_map.json not found, no hardware mapping")

    def set_map(self, mp: dict) -> None:
        """Заменить карту маппинга на лету (пресет роутинга, без рестарта
        USB-сессии). Сброс «последних значений»: следующий же пакет с крыла
        пропишет уровни уже в НОВЫЕ каналы."""
        mp = mp or {}
        self._map = {
            "faders": list(mp.get("faders", [])),
            "encoders": list(mp.get("encoders", [])),
            "buttons": dict(mp.get("buttons", {})),
        }
        self._last_faders = [None] * 8
        self._fader_display = [0] * 8
        self._last_enc_raw = [None] * 4
        self._enc_value = [0, 0, 0, 0]
        logger.info("Карта роутинга крыла заменена на лету")

    def reset_encoder(self, idx: int) -> None:
        """Сбросить виртуальную позицию энкодера (условные «12 часов» = 0)

        Калибровка ТЕКУЩЕЙ USB-сессии: текущее физическое положение ручки
        становится «12 часами» = 0. Счётчики крыла обнуляются при старте
        сессии, поэтому ноль живёт только в рамках сессии (персистентность
        на диск — ГРАБЛЯ: после рестарта сервера raw стартует с 0, а старый
        zero превращается в мёртвую зону на десятки/сотни детентов)."""
        if not 1 <= idx <= 4:
            return
        i = idx - 1
        cur = self._last_enc_raw[i]
        if cur is None:
            return
        self._enc_zero[i] = cur
        self._enc_value[i] = 0
        logger.info("Энкодер %s откалиброван: физ. положение %s = 0 (12 часов)", idx, cur)

    def get_encoder_state(self) -> list:
        """Состояние энкодеров для дебага: [raw, zero, value] по каждому."""
        return [
            {"raw": self._last_enc_raw[i], "zero": self._enc_zero[i], "val": self._enc_value[i]}
            for i in range(4)
        ]

    def get_fader_levels(self) -> list:
        """Уровни физических фейдеров 1..8 по АКТИВНОЙ карте (для снапшота
        wing_levels): пустые фейдеры / вне диапазона -> 0."""
        out = []
        cfg = self._map.get("faders", [])
        for idx in range(8):
            a = cfg[idx] if idx < len(cfg) else {}
            ch = a.get("channel")
            if not isinstance(ch, int) or not 1 <= ch <= 512:
                out.append(0)
            else:
                buf = self._dmx.get(a.get("universe", 1))
                out.append(buf[ch - 1] if buf else 0)
        return out

    def get_fader_display(self) -> list:
        """0..255 позиции ВСЕХ фейдеров крыла (вкл. пустые/немапленные):
        последние считанные физические положения — для UI-зеркала, чтобы
        веб показывал движение фейдеров даже без DMX-канала."""
        return list(self._fader_display)

    # ---------- DMX buffer access (for WingSender) ----------
    def get_frame(self, universe: int) -> bytes:
        return bytes(self._dmx.get(universe, bytearray(512)))

    def channel_count(self) -> int:
        n = 0
        for section in ("faders", "encoders"):
            for a in self._map.get(section, []):
                n = max(n, a.get("channel", 0))
        for b in self._map.get("buttons", {}).values():
            n = max(n, b.get("channel", 0))
        return n

    # ---------- scaling ----------
    @staticmethod
    def _scale(raw, in_min, in_max):
        span = (in_max - in_min) or 1
        norm = (raw - in_min) / span
        return max(0, min(255, int(round(norm * 255))))

    # ---------- packet entry ----------
    def on_raw_packet(self, data: bytes):
        if self._debug:
            logger.info("IN len=%s: %s", len(data), data[:64].hex(" "))
        faders = parse_faders(data)
        if faders is not None:
            self._apply_faders(faders)
        encoders = parse_analog(data)
        if encoders is not None:
            self._apply_encoders(encoders)
        # button events ride as a trailer on state packets of any length;
        # skip the one-time huge init dump (>1000 bytes)
        if len(data) < 1000:
            for bid, pressed in find_button_events(data):
                self._apply_button(bid, pressed)

    def _apply_faders(self, faders):
        cfg = self._map.get("faders", [])
        for idx, raw in enumerate(faders):
            if raw == self._last_faders[idx]:
                continue
            self._last_faders[idx] = raw
            a = cfg[idx] if idx < len(cfg) else {}
            in_min = a.get("in_min", 0)
            in_max = a.get("in_max", FADER_RAW_MAX)
            out = self._scale(raw, in_min, in_max)
            self._fader_display[idx] = out
            self._event("fader", idx + 1, out)
            if not a.get("enabled", True):
                continue
            channel = a.get("channel")
            if channel is None:
                continue
            universe = a.get("universe", 1)
            self._emit(universe, channel, out)
            if self._debug:
                logger.info("fader[%s] raw=%s -> ch%s = %s", idx + 1, raw, channel, out)

    def _apply_encoders(self, encoders):
        cfg = self._map.get("encoders", [])
        for idx, raw in enumerate(encoders):
            prev = self._last_enc_raw[idx]
            self._last_enc_raw[idx] = raw
            a = cfg[idx] if idx < len(cfg) else {}
            sens = float(a.get("sensitivity", 1.0))
            # Скачок счётчика ~ новый старт USB-сессии (крыло обнуляет счётчики):
            # калибровка «12 часов» из старой сессии больше недействительна.
            if prev is not None and abs(raw - prev) > 100000:
                self._enc_zero[idx] = None
                self._enc_value[idx] = 0
                logger.warning("Энкодер %s: скачок счётчика (новая сессия), калибровка сброшена", idx + 1)
                continue
            zero = self._enc_zero[idx]
            if zero is not None:
                # Абсолютный режим: значение = (сырой счётчик - калибровка 12ч)
                new_val = (raw - zero) * sens
            else:
                # Дельта-режим (до первой калибровки): от позиции после старта
                if prev is None or raw == prev:
                    continue
                new_val = self._enc_value[idx] + (raw - prev) * sens
            new_val = int(round(new_val)) % 256
            if new_val == self._enc_value[idx]:
                continue
            self._enc_value[idx] = new_val
            self._event("encoder", idx + 1, new_val)
            if not a.get("enabled", True):
                continue
            channel = a.get("channel")
            if channel is None:
                continue
            universe = a.get("universe", 1)
            self._emit(universe, channel, new_val)
            if self._debug:
                logger.info("encoder[%s] delta=%s -> ch%s = %s",
                            idx + 1, raw - prev, channel, new_val)

    def _apply_button(self, bid, pressed):
        self._event("button", bid, 255 if pressed else 0)
        cfg = self._map.get("buttons", {}).get(str(bid)) or self._map.get("buttons", {}).get(bid)
        if not cfg:
            if self._debug:
                logger.info("button id=%s %s (unmapped)", bid, "PRESS" if pressed else "release")
            return
        universe = cfg.get("universe", 1)
        channel = cfg.get("channel")
        if channel is None:
            return
        mode = cfg.get("mode", "momentary")
        if mode == "momentary":
            self._emit(universe, channel, 255 if pressed else 0)
        elif mode == "toggle":
            if pressed:
                cur = self._dmx[universe][channel - 1]
                self._emit(universe, channel, 0 if cur >= 128 else 255)
        if self._debug:
            logger.info("button id=%s %s -> ch%s", bid, "PRESS" if pressed else "release", channel)
