"""Консольная модель пульта (15.08) — движок живёт на сервере.

Крыло и все веб-панели — только ввод + индикация; выход (frame 512) пишется
в CONSOLE_SOURCE в HTP-миксе WingSender. Сцены — снепшоты 512 (только ненулевые
каналы), играет СЕРВЕР.

Приоритет выхода (утв.):
    blackout (источник) > программер (ALT, без мастеров) >
    флеш (255, без мастеров) > субамастера + активная NUM-сцена (через мастера)
    > 0.

Мастера (фейдеры 1-2: диммер/строб) применяются ТОЛЬКО к слою сцен (база +
субамастера); флеш и программер их не проходят. Программер = прямые физические
значения 0..255 (255 = физ. максимум).

Роли каналов зеркалят FIXTURE_LAYOUTS (web/constants.ts):
    dimmer       off0  -> dimmer
    led_par      off0..2 -> rgb, off4 -> strobe
    led_par_8ch  off0  -> dimmer, off5 -> strobe
    spider       off2  -> dimmer, off3 -> strobe
    mini_par     off0  -> dimmer, off5 -> strobe
    comb_rgbw    off2..41 -> rgb (механика яркости: масштабируется RGBW)
    spark, laser -> none
"""
import json
import logging
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SLOTS_PATH = os.path.join(HERE, "console_slots.json")
DMX_LEN = 512

# Роли каналов (см. докстроку)
ROLE_DIMMER = "dimmer"
ROLE_STROBE = "strobe"
ROLE_RGB = "rgb"
ROLE_OTHER = "other"
ROLE_NONE = "none"

# Роли по смещениям каналов для каждого типа прибора (зеркало FIXTURE_LAYOUTS)
ROLES_BY_TYPE = {
    "dimmer": {0: ROLE_DIMMER},
    "led_par": {0: ROLE_RGB, 1: ROLE_RGB, 2: ROLE_RGB, 4: ROLE_STROBE},
    "led_par_8ch": {0: ROLE_DIMMER, 5: ROLE_STROBE},
    "spider": {2: ROLE_DIMMER, 3: ROLE_STROBE},
    "mini_par": {0: ROLE_DIMMER, 5: ROLE_STROBE},
    "comb_rgbw": {i: ROLE_RGB for i in range(2, 42)},
    "spark": {},
    "laser": {},
}

# Число каналов каждого типа (длина раскладки)
CHANNELS_BY_TYPE = {
    "dimmer": 1,
    "led_par": 6,
    "led_par_8ch": 8,
    "spider": 13,
    "mini_par": 7,
    "comb_rgbw": 43,
    "spark": 2,
    "laser": 8,
}

# Кнопки крыла: keypad-цифры (58=1..44=9, 66=0) -> номер NUM-сцены (1-10)
KEYPAD_DIGIT = {58: 1, 59: 2, 60: 3, 50: 4, 51: 5, 52: 6, 42: 7, 43: 8, 44: 9, 66: 10}
# Нижний ряд (112=1..117=6) -> номера сцен 11..16
BOTTOM_ROW = {112: 11, 113: 12, 114: 13, 115: 14, 116: 15, 117: 16}
# Функции крыла
BTN_STORE = 64
BTN_CLEAR = 57
BTN_ALT = 70          # Please
BTN_GO_PLUS = 126
BTN_GO_MINUS = 119
BTN_PAUSE = 118       # blackout (обрабатывает сервер, не движок)

logger = logging.getLogger("console_engine")


def load_slots(path=SLOTS_PATH) -> list:
    """Прочитать конфиг слотов. Возвращает список слотов (см. _expand)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        slots = data.get("slots", [])
        if not isinstance(slots, list):
            return []
        return [s for s in slots if isinstance(s, dict) and "num" in s]
    except Exception as e:
        logger.warning("Не удалось прочитать %s: %s", path, e)
        return []


class ConsoleEngine:
    """Состояние консоли + расчёт выхода. Потокобезопасен (self._lock)."""

    def __init__(self, slots=None, on_frame=None, on_changed=None, on_scene_save=None):
        self._lock = threading.RLock()
        self.dmx_len = DMX_LEN
        self.on_frame = on_frame          # callable(frame: bytes 512) — выход
        self.on_changed = on_changed      # callable() — состояние менялось
        self.on_scene_save = on_scene_save  # callable(n:int, snap:dict)

        self.slots = slots or load_slots()
        self._devices = {}   # num(str) -> [(type, start), ...] — развёрнутые приборы
        self._by_num = {}    # num(str) -> слот (dict)
        self.channel_roles = [ROLE_NONE] * DMX_LEN  # index 0 = ch1
        self._build_channels()

        # Состояние (см. docs/panel-console-impl.md §2)
        self.mode = "normal"            # 'normal' | 'alt'
        self.alt_page = 1
        self.selected = set()           # номера слотов (str)
        self.masters = {"dimmer": 0, "strobe": 0}
        self.submasters = [0] * 6       # фейдеры 3-8 -> сцены 11-16
        self.active_num = 0             # 0 = нет сцены, 1..10
        self.flash_held = set()         # сцены 11..16
        self.programmer = {}            # ch(1-based) -> val (только тронутые)
        self.store_armed = False
        self.scenes = {}                # n(int) -> {ch(str): val}

        self._scene_frame = bytearray(DMX_LEN)  # незамастерённый слой (Store/зеркало)
        self._out_frame = bytearray(DMX_LEN)    # после мастеров -> CONSOLE_SOURCE

    # ---------- конфиг ----------
    def _build_channels(self):
        """Развернуть слоты в приборы и залить channel_roles."""
        self._devices = {}
        self._by_num = {}
        self.channel_roles = [ROLE_NONE] * self.dmx_len
        for s in self.slots:
            num = str(s.get("num"))
            self._by_num[num] = s
            devs = []
            for fx in s.get("fixtures", []):
                ftype = fx.get("type")
                if ftype not in CHANNELS_BY_TYPE:
                    continue
                start = int(fx.get("start", 1))
                count = int(fx.get("count", 1))
                step = int(fx.get("step", CHANNELS_BY_TYPE[ftype]))
                for i in range(count):
                    base = start + i * step
                    dev = (ftype, base)
                    if dev not in devs:
                        devs.append(dev)
            self._devices[num] = devs
            for ftype, base in devs:
                for off, role in ROLES_BY_TYPE[ftype].items():
                    ch = base + off - 1
                    if 0 <= ch < self.dmx_len:
                        self.channel_roles[ch] = role

    def _slot_channels(self, num) -> list:
        """Последовательные глобальные каналы слота (прибор за прибором)."""
        out = []
        for ftype, base in self._devices.get(str(num), []):
            out.extend(base + i for i in range(CHANNELS_BY_TYPE[ftype]))
        return out

    def max_channels(self, nums) -> int:
        """Максимум каналов среди выбранных слотов (для страниц ALT)."""
        mx = 0
        for num in nums:
            mx = max(mx, len(self._slot_channels(num)))
        return mx or 8

    def _page_clamp(self):
        mx = self.max_channels(self.selected) if self.selected else 8
        max_page = max(1, (mx + 7) // 8)
        self.alt_page = max(1, min(self.alt_page, max_page))

    # ---------- состояние -> JSON ----------
    def state_dict(self) -> dict:
        return {
            "mode": self.mode,
            "alt_page": self.alt_page,
            "selected": sorted(self.selected),
            "masters": dict(self.masters),
            "submasters": list(self.submasters),
            "faders": [self.masters["dimmer"], self.masters["strobe"]] + list(self.submasters),
            "active_num": self.active_num,
            "flash_held": sorted(self.flash_held),
            "store_armed": self.store_armed,
            "slots": [{
                "num": str(s.get("num")),
                "name": s.get("name", ""),
                "devices": [{"type": t, "start": b} for t, b in self._devices.get(str(s.get("num")), [])],
            } for s in self.slots],
            "scenes": {str(n): snap for n, snap in sorted(self.scenes.items())},
        }

    # ---------- сцены ----------
    def load_scenes(self, store: dict):
        """Загрузить сцены из SCENE_STORE (templates[active])."""
        self.scenes = {}
        try:
            templates = (store or {}).get("templates", {})
            active = (store or {}).get("active") or ""
            if not active or active not in templates:
                active = "default" if "default" in templates else (list(templates) or [""])[0]
            snaps = templates.get(active, {}) if active else {}
            for k, v in snaps.items():
                try:
                    n = int(k)
                except (TypeError, ValueError):
                    continue
                if 1 <= n <= 16 and isinstance(v, dict):
                    self.scenes[n] = {str(int(c)): max(0, min(255, int(val)))
                                      for c, val in v.items() if int(val) > 0}
        except Exception as e:
            logger.warning("Сцены консоли не загрузились: %s", e)

    def _record_scene(self, n: int):
        """Store: снепшот из _scene_frame (незамастерённый, флеш не входит)."""
        snap = {str(ch + 1): v for ch, v in enumerate(self._scene_frame) if v > 0}
        self.scenes[n] = snap
        self.store_armed = False
        if self.on_scene_save is not None:
            try:
                self.on_scene_save(n, snap)
            except Exception:
                pass

    # ---------- расчёт ----------
    def _add_snap(self, buf: bytearray, snap: dict, level: int):
        """Влить сцену в буфер HTP-максом (level 0..255 — масштаб)."""
        if not snap or not level:
            return
        for ch_s, v in snap.items():
            try:
                idx = int(ch_s) - 1
            except (ValueError, TypeError):
                continue
            if not 0 <= idx < self.dmx_len:
                continue
            vv = (int(v) * level) // 255 if level < 255 else int(v)
            if vv > buf[idx]:
                buf[idx] = vv

    def compute(self) -> bytes:
        """Пересчитать _scene_frame/_out_frame. Под self._lock."""
        dim = self.masters.get("dimmer", 0)
        stro = self.masters.get("strobe", 0)

        # 1. Слой сцены: база (NUM-сцена) + субамастера (наложение HTP), сырые
        scene = bytearray(self.dmx_len)
        if self.active_num:
            self._add_snap(scene, self.scenes.get(self.active_num, {}), 255)
        for i, n in enumerate(range(11, 17)):
            self._add_snap(scene, self.scenes.get(n, {}), self.submasters[i])

        # 2. _scene_frame (для Store/зеркала) = программер где тронут,
        #    иначе слой сцены. НЕзамастерён (снепшот — сырые значения).
        self._scene_frame = bytearray(self.dmx_len)
        self._scene_frame[:] = scene
        for ch, v in self.programmer.items():
            if 1 <= ch <= self.dmx_len:
                self._scene_frame[ch - 1] = v

        # 3. Мастера ТОЛЬКО к слою сцен (флеш и программер их НЕ проходят):
        #    умножаем scene (без программера), потом поверх — программер.
        scene_m = bytearray(self.dmx_len)
        scene_m[:] = scene
        for ch in range(self.dmx_len):
            v = scene_m[ch]
            if not v:
                continue
            role = self.channel_roles[ch]
            if role == ROLE_DIMMER or role == ROLE_RGB:
                scene_m[ch] = (v * dim) // 255
            elif role == ROLE_STROBE:
                scene_m[ch] = (v * stro) // 255

        # 4. Флеш (замена картинки, без мастеров) — если зажат, перекрывает
        #    замастерённый слой сцен целиком.
        out = bytearray(self.dmx_len)
        if self.flash_held:
            for n in sorted(self.flash_held):
                self._add_snap(out, self.scenes.get(n, {}), 255)
        else:
            out[:] = scene_m

        # 5. Программер — поверх всего (прямые значения, без мастеров)
        for ch, v in self.programmer.items():
            if 1 <= ch <= self.dmx_len:
                out[ch - 1] = v

        self._out_frame = out
        return bytes(out)

    def _commit(self):
        """Пересчитать и уведомить слушателей. Под self._lock."""
        frame = self.compute()
        if self.on_frame is not None:
            try:
                self.on_frame(frame)
            except Exception:
                pass
        if self.on_changed is not None:
            try:
                self.on_changed()
            except Exception:
                pass

    def _changed(self):
        try:
            self._lock.acquire()
            self._commit()
        finally:
            self._lock.release()

    # ---------- ввод ----------
    def _num_scene(self, n: int):
        """Свитч NUM-сцены: повтор = выключить. Из store-режима — запись."""
        if self.store_armed:
            self._record_scene(n)
            return
        self.active_num = n if self.active_num != n else 0

    def _slot_toggle(self, num: str):
        if num in self.selected:
            self.selected.discard(num)
        else:
            self.selected.add(num)
        self._page_clamp()

    @staticmethod
    def _slot_to_scene(num: str):
        """Номер сцены по номеру слота: "0"->10, "1".."9"->1..9, "11".."16"->11..16."""
        try:
            n = int(num)
        except (TypeError, ValueError):
            return None
        if n == 0:
            return 10
        if 1 <= n <= 9 or 11 <= n <= 16:
            return n
        return None

    def _flash(self, n: int, on: bool):
        if on:
            self.flash_held.add(n)
        else:
            self.flash_held.discard(n)

    def _chanfader(self, fader: int, value: int):
        """ALT: фейдер = канал (page-1)*8 + (fader-1) слота по порядку приборов."""
        value = max(0, min(255, int(value)))
        idx = (self.alt_page - 1) * 8 + (fader - 1)
        written = False
        for num in sorted(self.selected):
            channels = self._slot_channels(num)
            if idx < len(channels):
                ch = channels[idx]
                if 1 <= ch <= self.dmx_len:
                    self.programmer[ch] = value
                    written = True
        if not written:
            # Нет выбранного слота / канала — фейдер «мёртвый», ничего не пишет.
            pass

    def on_fader(self, fader: int, value: int):
        value = max(0, min(255, int(value)))
        with self._lock:
            if self.mode == "alt":
                self._chanfader(fader, value)
            else:
                if fader == 1:
                    self.masters["dimmer"] = value
                elif fader == 2:
                    self.masters["strobe"] = value
                elif 3 <= fader <= 8:
                    self.submasters[fader - 3] = value
            self._changed()

    def on_button(self, bid: int, value: int):
        """Физическая кнопка крыла. value: 255 = нажата, 0 = отпущена."""
        pressed = value >= 128
        with self._lock:
            if bid in KEYPAD_DIGIT:
                n = KEYPAD_DIGIT[bid]
                if pressed:
                    if self.store_armed:
                        self._record_scene(n)
                    elif self.mode == "alt":
                        # keypad 0 -> слот "0", 1-9 -> слоты "1".."9"
                        self._slot_toggle(str(n % 10))
                    else:
                        self._num_scene(n)
            elif bid in BOTTOM_ROW:
                n = BOTTOM_ROW[bid]
                if self.mode == "alt":
                    if pressed and self.store_armed:
                        self._record_scene(n)
                    elif pressed:
                        self._slot_toggle(str(n))
                else:
                    if pressed and self.store_armed:
                        self._record_scene(n)
                    else:
                        self._flash(n, pressed)
            elif bid == BTN_STORE and pressed:
                self.store_armed = not self.store_armed
            elif bid == BTN_CLEAR and pressed:
                self.programmer.clear()
                self.store_armed = False
            elif bid == BTN_ALT and pressed:
                self.mode = "alt" if self.mode == "normal" else "normal"
                self._page_clamp()
            elif bid == BTN_GO_PLUS and pressed and self.mode == "alt":
                self.alt_page += 1
                self._page_clamp()
            elif bid == BTN_GO_MINUS and pressed and self.mode == "alt":
                self.alt_page -= 1
                self._page_clamp()
            else:
                return
            self._changed()

    # ---------- веб (те же ветки движка, действия из панели) ----------
    def on_action(self, action: str, **kw):
        """WS-действия панели (см. docs/panel-console-impl.md §5)."""
        with self._lock:
            if action == "alt":
                if kw.get("on"):
                    self.mode = "alt"
                else:
                    self.mode = "normal"
                self._page_clamp()
            elif action == "slot":
                num = str(kw.get("num"))
                if kw.get("on") and self.store_armed:
                    # ALT+Store: запись сцены по номеру слота (keypad 0->10)
                    n = self._slot_to_scene(num)
                    if n is not None:
                        self._record_scene(n)
                elif kw.get("on"):
                    self.selected.add(num)
                else:
                    self.selected.discard(num)
                self._page_clamp()
            elif action == "page":
                d = 1 if kw.get("dir", 1) > 0 else -1
                self.alt_page += d
                self._page_clamp()
            elif action == "master":
                idx = int(kw.get("idx", 0))
                v = max(0, min(255, int(kw.get("v", 0))))
                if idx == 1:
                    self.masters["dimmer"] = v
                elif idx == 2:
                    self.masters["strobe"] = v
            elif action == "sub":
                idx = int(kw.get("idx", 0))
                if 3 <= idx <= 8:
                    self.submasters[idx - 3] = max(0, min(255, int(kw.get("v", 0))))
            elif action == "chanfader":
                self._chanfader(int(kw.get("fader", 1)), int(kw.get("v", 0)))
            elif action == "num":
                n = int(kw.get("n", 0))
                if kw.get("on"):
                    self._num_scene(n)
            elif action == "flash":
                n = int(kw.get("n", 0))
                if kw.get("on") and self.store_armed:
                    self._record_scene(n)
                else:
                    self._flash(n, bool(kw.get("on")))
            elif action == "store":
                if kw.get("on"):
                    self.store_armed = not self.store_armed
            elif action == "clear":
                self.programmer.clear()
                self.store_armed = False
            elif action == "scene_rec":
                self._record_scene(int(kw.get("n", 0)))
            else:
                return
            self._changed()

    def on_input(self, source: str, kind: str, ident: int, value: int):
        """Единый вход движка: крыло (wing) и веб (web) — одни ветки."""
        if kind == "fader":
            self.on_fader(ident, value)
        elif kind == "button":
            self.on_button(ident, value)
        # энкодеры движок не обрабатывает — прямой роутинг 41-44 (стопгап)

    # ---------- зеркало ----------
    def fader_levels(self) -> list:
        """Позиции фейдеров 1..8 для live-зеркала: мастер/суб по режиму,
        в ALT — значения каналов программера (0, если не тронут)."""
        with self._lock:
            if self.mode == "alt":
                out = []
                channels = []
                if self.selected:
                    channels = self._slot_channels(sorted(self.selected)[0])
                for f in range(1, 9):
                    idx = (self.alt_page - 1) * 8 + (f - 1)
                    if idx < len(channels):
                        out.append(self.programmer.get(channels[idx], 0))
                    else:
                        out.append(0)
                return out
            return [self.masters["dimmer"], self.masters["strobe"]] + list(self.submasters)
