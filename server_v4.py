import asyncio
import aiohttp
import hashlib
import json
import logging
import os
import sys
import threading
import time
import webbrowser
import subprocess
from typing import Any, Dict, Set

from aiohttp import web, WSMsgType

# Прямой выход в USB-крыло (VID 03EB / PID 160B) — драйвер лежит в tools/wing
WING_DIR = os.path.join(os.path.dirname(__file__), "tools", "wing")
sys.path.insert(0, WING_DIR)
try:
    from wing_driver import Wing
    WING_AVAILABLE = True
except Exception:
    WING_AVAILABLE = False

# ================== CONFIG ==================
# 03.08: открыт на LAN (0.0.0.0) для «веб-панели звукача» на другом ПК
# (Resolume webserver :8080 → окошко с фейдерами → ws://192.168.0.128:8000/ws).
# Внимание: вместе с WS наружу открываются и остальные API (projects/stems/
# upload/tracks) — это доверенная локальная сеть площадки, вне её не светить.
WS_HOST = "0.0.0.0"
PORT = 8000
AUTO_BUILD = True  # Автоматически собирать фронтенд при запуске

# Режим вывода DMX: только "wing" — напрямую в USB-крыло
OUTPUT_MODE = "wing"
WING_FPS = 30       # Частота DMX-фреймов в крыло
DMX_CHANNELS = 512  # Размер DMX-вселенной

DIST_PATH = os.path.join(os.path.dirname(__file__), "web", "dist")
VISUAL_PATH = os.path.join(os.path.dirname(__file__), "web", "visual", "index.html")
PROJECTS_PATH = os.path.join(os.path.dirname(__file__), "projects")
MEDIA_PATH = os.path.join(os.path.dirname(__file__), "media")
STEMS_PATH = os.path.join(MEDIA_PATH, "stems")

if not os.path.exists(PROJECTS_PATH):
    os.makedirs(PROJECTS_PATH)
if not os.path.exists(STEMS_PATH):
    os.makedirs(STEMS_PATH)

IS_SERVICE = os.environ.get("LUMINA_SERVICE") == "1"
if IS_SERVICE:
    LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
    if not os.path.exists(LOG_DIR):
        os.makedirs(LOG_DIR)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.FileHandler(os.path.join(LOG_DIR, "lumina_service.log"), encoding="utf-8")],
    )
else:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )

def build_frontend():
    """Запускает сборку фронтенда через npm (только если dist ещё нет)"""
    if not AUTO_BUILD:
        return

    web_dir = os.path.join(os.path.dirname(__file__), "web")
    if not os.path.exists(web_dir):
        logging.warning("Папка 'web' не найдена, пропуск сборки.")
        return

    # Если dist уже собран, не тратим время на пересборку (особенно важно для службы)
    if os.path.exists(os.path.join(web_dir, "dist", "index.html")):
        logging.info("dist/index.html уже есть, пропускаем сборку фронтенда.")
        return

    logging.info("--- ЗАПУСК СБОРКИ ФРОНТЕНДА ---")
    try:
        # Проверяем наличие node_modules
        if not os.path.exists(os.path.join(web_dir, "node_modules")):
            logging.info("Установка зависимостей (npm install)...")
            subprocess.run(["npm", "install"], cwd=web_dir, check=True, shell=True)

        logging.info("Компиляция проекта (npm run build)...")
        # shell=True нужен для Windows, чтобы найти npm.cmd
        subprocess.run(["npm", "run", "build"], cwd=web_dir, check=True, shell=True)
        logging.info("--- СБОРКА ЗАВЕРШЕНА УСПЕШНО ---")
    except subprocess.CalledProcessError as e:
        logging.error("Ошибка при сборке фронтенда: %s", e)
        logging.error("Сервер будет запущен с текущей версией в папке dist (если она есть).")
    except Exception as e:
        logging.error("Непредвиденная ошибка сборки: %s", e)

# ================== CORS ==================
@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=200)
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    return resp

# ================== USB WING ==================
# Ключ источника для железа (фейдеры/энкодеры/кнопки самого крыла): его
# вклад в HTP-микс живёт отдельно от WS-клиентов и не сбрасывается с ними.
LOCAL_SOURCE = "wing-local"


class WingSender:
    """Прямая отправка DMX в USB-крыло.

    Интерфейс: set_channel/send/close. Стриминг идёт в своём потоке:
    pyusb-братья блокирующие, asyncio-цикл их не ждёт.

    HTP-merge по источникам (грабля 26.07 «прибор мигает ~2 Гц»): раньше
    set_channel писал прямо в общий буфер и последний писатель выигрывал.
    Любой второй WS-клиент (headless Chrome от webshot, вторая вкладка,
    забытый Electron) слал свой heartbeat-fullFrame с нулями и перебивал
    боевую сцену. Теперь у каждого источника свой буфер, в крыло уходит
    поканальный max — как в dmxAggregator на фронте.
    """

    def __init__(self, dmx_len: int):
        self.dmx_len = dmx_len
        self.dmx_data = bytearray(dmx_len)
        # Буферы источников: ключ -> bytearray(dmx_len). Ключ WS-клиента —
        # id(ws), крыло пишет в LOCAL_SOURCE. dmx_data = поканальный max.
        self._sources: Dict[Any, bytearray] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._wing = None
        self._mapper = None
        # callable(dict) — события ввода крыла (fader/encoder/button) для UI
        self.event_cb = None
        self._wave_running = False
        self._led_map = None
        # Серверный blackout (14.08): клиент/крыло шлют {type:'blackout'},
        # пока флаг поднят — в DMX уходит нулевой кадр, поверх HTP-микса.
        self._blackout = False
        # Bypass (14.08): Lumina не генерирует сигналов на линии (отладка
        # COB-панели). При включении уходит один нулевой кадр (приборы
        # гаснут и держат ноль), дальше линия молчит — приборы не реагируют.
        self._bypass = False
        self._bypass_zeroed = False
        # Источники, слающие ПОЛНЫЕ кадры (списки) — автоматика Lumina
        # (консоль: граф/сцены/генераторы). В bypass они отсекаются;
        # single-управление (фейдеры веб-панели, прямое крыло) проходит.
        self._list_sources = set()
        # Последний кадр, реально ушедший в линию (для /api/debug/dmx).
        self._last_sent = bytes(self.dmx_len)
        # Тумблер световой волны (14.08): серверный, синхронизируется панелям.
        # По умолчанию OFF; стартовая волна (boot=1) играет всегда.
        self._wing_wave_enabled = False

    # ---------- LED: волна и эквалайзер ----------
    def _maybe_wave(self):
        """Волна подсветки при (пере)подключении крыла."""
        if self._wave_running or self._wing is None:
            return
        wave_path = os.path.join(WING_DIR, "wing_wave.json")
        if not os.path.exists(wave_path):
            return
        self._wave_running = True
        threading.Thread(target=self._play_wave, args=(wave_path,),
                         daemon=True, name="wing-wave").start()

    def _play_wave(self, wave_path: str):
        try:
            with open(wave_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            time.sleep(0.3)  # дать сессии стабилизироваться
            for frame in data.get("frames", []):
                if self._stop.is_set() or self._wing is None:
                    return
                time.sleep(frame.get("dt", 0.033))
                self._wing.set_led_frame(bytes.fromhex(frame["body"]))
            steady = data.get("steady")
            if steady and self._wing is not None and not self._stop.is_set():
                self._wing.set_led_frame(bytes.fromhex(steady))
        except Exception as e:
            logging.warning("LED-волна не проигралась: %s", e)
        finally:
            self._wave_running = False

    def _load_led_map(self):
        try:
            with open(os.path.join(WING_DIR, "wing_led_map.json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def set_bands(self, bands):
        """VU-индикатор на подсветке крыла.

        Режимы (по wing_led_map.json):
          "bar"   — один общий уровень = max полос, слева направо по words;
          "bands" — отдельный столбик на каждую полосу low/mid/high.
        """
        if self._bypass:
            # Bypass (14.08): индикация из Lumina на крыло не уходит —
            # VU-бары UI молчат, остаётся только собственный VU крыла
            # (линейный вход, прошивка).
            return
        if self._wing is None:
            return
        if self._led_map is None:
            self._led_map = self._load_led_map()
        maxv = int(self._led_map.get("max_value", 2047))
        bar = self._led_map.get("bar")
        if bar and bar.get("words"):
            level = max(bands) if bands else 0
            self._render_bar(bar["words"], level, maxv)
            return
        layout = self._led_map.get("bands", [])
        for i, level in enumerate(bands[:len(layout)]):
            self._render_bar(layout[i].get("words", []), level, maxv)

    def _render_bar(self, words, level, maxv):
        """Столбик уровня 0..255 слева направо по списку LED-слов."""
        if not words:
            return
        level = max(0, min(255, int(level)))
        lit = level / 255.0 * len(words)
        full = int(lit)
        for wi, word in enumerate(words):
            if wi < full:
                v = maxv
            elif wi == full:
                v = int(maxv * (lit - full))
            else:
                v = 0
            self._wing.set_led(word, v)

    def set_leds(self, pairs):
        """Прямая запись LED: pairs = [[word, value], ...]."""
        if self._wing is None:
            return
        for w, v in pairs:
            self._wing.set_led(int(w), int(v))

    def _on_wing_event(self, kind: str, ident: int, value: int):
        cb = self.event_cb
        if cb is not None:
            try:
                cb({"kind": kind, "id": ident, "value": value})
            except Exception:
                pass

    # ---------- Волна на физическом крыле (14.08) ----------
    def _load_btn_word_map(self):
        """Обратная карта кнопка -> LED-слово (из wing_led_button_map.json)."""
        try:
            with open(os.path.join(WING_DIR, "wing_led_button_map.json"), "r", encoding="utf-8") as f:
                data = json.load(f)
            rev = {}
            for w, b in data.items():
                rev[int(b)] = int(w)
            self._btn_word = rev
        except Exception:
            self._btn_word = {}

    def wing_wave(self, events, boot=False):
        """Вспышки LED на крыле по задержкам от панели: events = [[btn_id, delay_ms], ...].

        Серия волн (14.08, фикс зависания): снапшот LED снимается ОДИН раз при
        старте серии (первая волна), восстановление делает только ПОСЛЕДНИЙ
        поток серии (владелец). Промежуточные волны свой снапшот не берут и
        чужое состояние не затирают — иначе на быстрых повторных нажатиях
        оборванная волна возвращала старый буфер и волна «зависала».

        boot=True — стартовая волна при подключении панели: играет ВСЕГДА,
        независимо от тумблера _wing_wave_enabled (это сигнал перезагрузки).
        """
        if self._wing is None:
            return
        if not boot and not getattr(self, "_wing_wave_enabled", False):
            return
        if not hasattr(self, "_btn_word") or not self._btn_word:
            self._load_btn_word_map()
        ev = [(int(a), int(b)) for a, b in events if a is not None]
        if not ev:
            return
        if not hasattr(self, "_wave_cancel"):
            self._wave_cancel = threading.Event()
        if not hasattr(self, "_wave_state_lock"):
            self._wave_state_lock = threading.Lock()
        if not hasattr(self, "_wave_active"):
            self._wave_active = False
        with self._wave_state_lock:
            if not self._wave_active:
                with self._wing._led_lock:
                    self._wave_restore = bytes(self._wing.led_body)
                self._wave_active = True
        old = getattr(self, "_wave_cancel", None)
        if old is not None:
            old.set()
        cancel = threading.Event()
        self._wave_cancel = cancel
        token = object()

        def run():
            with self._wave_state_lock:
                self._wave_owner = token
            try:
                t0 = time.time()
                for btn_id, delay in sorted(ev, key=lambda x: x[1]):
                    if cancel.is_set() or self._stop.is_set():
                        return
                    dt = delay / 1000.0 - (time.time() - t0)
                    if dt > 0:
                        time.sleep(dt)
                    word = self._btn_word.get(btn_id)
                    if word is not None:
                        self._wing.set_led(word, 2047)
                time.sleep(0.7)
            except Exception:
                pass
            finally:
                with self._wave_state_lock:
                    if getattr(self, "_wave_owner", None) is token:
                        self._wave_active = False
                        if self._wing is not None:
                            try:
                                self._wing.set_led_frame(self._wave_restore)
                            except Exception:
                                pass

        threading.Thread(target=run, daemon=True, name="wing-wave-btn").start()

    def set_wing_wave_enabled(self, on: bool):
        """Глобальный тумблер волны (14.08): выкл — волны не запускаются
        и текущая немедленно обрывается (LED восстановятся её finally)."""
        on = bool(on)
        if not hasattr(self, "_wave_state_lock"):
            self._wave_state_lock = threading.Lock()
        with self._wave_state_lock:
            self._wing_wave_enabled = on
            if not on:
                old = getattr(self, "_wave_cancel", None)
                if old is not None:
                    old.set()

    def start(self) -> bool:
        if not WING_AVAILABLE:
            logging.warning("pyusb/libusb не установлены — крыло недоступно")
            return False
        self._wing = Wing(verbose=False, full_session=True)
        # Hook up hardware control mapping (faders/encoders/buttons from the wing)
        try:
            from wing_input_mapper import WingInputMapper
            self._mapper = WingInputMapper(self.set_channel, on_event=self._on_wing_event)
            self._wing.set_input_callback(self._mapper.on_raw_packet)
            # Активный пресет роутинга (если есть в сторе) применяется вместо
            # статичного wing_input_map.json — пресет может отличаться.
            _rname = ROUTING_STORE.get("active") or ""
            _rpresets = ROUTING_STORE.get("presets", {})
            if _rname in _rpresets and isinstance(_rpresets[_rname], dict):
                try:
                    self._mapper.set_map(_rpresets[_rname])
                except Exception as e:
                    logging.warning("Пресет роутинга '%s' не применился: %s", _rname, e)
        except Exception as e:
            logging.warning("Аппаратный маппинг крыла не активен: %s", e)
        try:
            self._wing.start()
            self._maybe_wave()
        except Exception as e:
            # Крыло физически не найдено. Если оно есть, но занято
            # (напр., старым процессом сервера) — дожимаем в фоне.
            logging.error("Не удалось инициализировать крыло: %s", e)
            try:
                from wing_driver import open_wing
                if open_wing(timeout=2.0) is None:
                    self._wing = None
                    return False
            except Exception:
                self._wing = None
                return False
            logging.warning("Крыло найдено, но занято — продолжаем попытки подключения в фоне")
        self._thread = threading.Thread(target=self._loop, daemon=True, name="wing-dmx")
        self._thread.start()
        return True

    def _loop(self):
        interval = 1.0 / WING_FPS
        # Вторая вселенная = ЗЕРКАЛО первой (28.07): TX-база wireless пересажена
        # на OUT 2, основная линия (кулисы/диммеры) — на OUT 1 через A/B.
        # Адреса не пересекаются (основная 1-191, wireless 200-449), поэтому
        # одинаковый кадр на обоих выходах корректен: каждая линия читает
        # «свои» адреса и игнорирует чужие. Отдельная адресация U2 не нужна.
        while not self._stop.is_set():
            try:
                if self._wing.dev is None or not self._wing.is_input_alive():
                    # сессия ещё не установлена (крыло было занято при старте)
                    # ИЛИ поток ввода тихо умер (USBError в reader) — выход DMX
                    # при этом жив, поэтому ввод крыла перестаёт доходить до
                    # панели. Перезапускаем сессию, чтобы вернуть и ввод (14.08).
                    self._wing.start()
                    logging.info("Крыло подключено (ввод восстановлен)")
                    self._maybe_wave()
                with self._lock:
                    # Лок держим только на чтение буфера — отправка и sleep
                    # ВНЕ лока (зависший USB-write не должен ронять весь сервер,
                    # грабля 14.08: send_dmx внутри лока заморозил HTTP/WS).
                    if self._bypass:
                        # Bypass (14.08 v3): в линию идёт ТОЛЬКО ручное
                        # управление — прямое крыло (LOCAL_SOURCE) + источники,
                        # слающие single-обновления (веб-панель COB: фейдеры/
                        # энкодеры). Источники полных кадров (консоль Lumina —
                        # граф/сцены/генераторы) отсекаются. Первый кадр при
                        # включении — нулевой (сброс приборов).
                        send_zero = not self._bypass_zeroed
                        self._bypass_zeroed = True
                        buf = self._sources.get(LOCAL_SOURCE)
                        manual = bytearray(buf) if buf else bytearray(self.dmx_len)
                        for s, b in self._sources.items():
                            if s is LOCAL_SOURCE or s in self._list_sources:
                                continue
                            for i in range(self.dmx_len):
                                v = b[i]
                                if v > manual[i]:
                                    manual[i] = v
                        frame = bytes(manual)
                    else:
                        self._bypass_zeroed = False
                        send_zero = False
                        frame = bytes(self.dmx_data)
                        if self._blackout:
                            frame = bytes(len(frame))
                if send_zero:
                    self._wing.send_dmx(bytes(self.dmx_len), bytes(self.dmx_len))
                else:
                    self._wing.send_dmx(frame, frame)
                self._last_sent = frame
            except Exception as e:
                logging.error("Ошибка записи в крыло: %s — переподключение...", e)
                try:
                    self._wing.start()
                    logging.info("Крыло переподключено")
                    self._maybe_wave()
                except Exception as e2:
                    logging.error("Переподключение не удалось: %s", e2)
                    time.sleep(2.0)
            time.sleep(interval)

    def set_channel(self, ch_index: int, value: int, source: Any = LOCAL_SOURCE) -> None:
        """Записать канал от имени источника и пересчитать HTP-микс."""
        value = max(0, min(255, int(value)))
        if not (0 <= ch_index < self.dmx_len):
            return
        with self._lock:
            buf = self._sources.get(source)
            if buf is None:
                buf = bytearray(self.dmx_len)
                self._sources[source] = buf
            if buf[ch_index] == value:
                return  # источник не изменился — микс тот же
            buf[ch_index] = value
            self._remix_channel(ch_index)

    def _remix_channel(self, ch_index: int) -> None:
        """HTP по одному каналу. Вызывать под self._lock."""
        top = 0
        for buf in self._sources.values():
            v = buf[ch_index]
            if v > top:
                top = v
                if top == 255:
                    break
        self.dmx_data[ch_index] = top

    def drop_source(self, source: Any) -> bool:
        """Убрать источник (ушёл WS-клиент) и пересчитать весь микс.

        Без этого состояние отключившегося клиента навсегда осталось бы
        в HTP-миксе и держало бы приборы включёнными.
        """
        with self._lock:
            if self._sources.pop(source, None) is None:
                return False
            for ch in range(self.dmx_len):
                self._remix_channel(ch)
            return True

    def reset_source(self, source: Any) -> None:
        """Обнулить буфер источника, не удаляя его (blackout от клиента)."""
        with self._lock:
            if source in self._sources:
                self._sources[source] = bytearray(self.dmx_len)
                for ch in range(self.dmx_len):
                    self._remix_channel(ch)

    def set_blackout(self, on: bool) -> None:
        """Глобальный blackout (14.08): нулевой кадр в крыло, пока включён."""
        with self._lock:
            self._blackout = bool(on)

    def set_bypass(self, on: bool) -> None:
        """Bypass (14.08): линия замолкает (нулевой кадр один раз при включении).

        Для отладки приборов (COB-панель): Lumina не генерирует сигналов,
        приборы держат ноль и не реагируют. При выключении — обычная работа.
        """
        with self._lock:
            self._bypass = bool(on)
            if not on:
                self._bypass_zeroed = False
            elif self._wing is not None:
                # Гасим и индикацию крыла: кнопки не должны показывать уровни
                # из Lumina, пока линия в bypass (жалоба 14.08). Нулевой
                # led_body уйдёт в крыло вместе с нулевым кадром из send-цикла,
                # дальше CTL-пакеты не отправляются — индикация молчит.
                self._wing.clear_leds()

    def apply_routing(self, routing_map: dict) -> None:
        """Живо применить пресет роутинга крыла (фейдеры/энкодеры/кнопки).

        Старый вклад LOCAL_SOURCE снимается целиком (иначе каналы прежней
        карты остались бы в HTP-миксе), новый маппинг вступает со следующего
        пакета крыла.
        """
        with self._lock:
            if self._mapper is not None:
                try:
                    self._mapper.set_map(routing_map)
                except Exception as e:
                    logging.warning("Применение роутинга не удалось: %s", e)
            self._sources.pop(LOCAL_SOURCE, None)
            for ch in range(self.dmx_len):
                self._remix_channel(ch)

    def source_stats(self) -> Dict[str, int]:
        """Диагностика: сколько каналов держит каждый источник (не ноль)."""
        with self._lock:
            return {
                ("wing" if s is LOCAL_SOURCE else f"ws:{s}"): sum(1 for v in buf if v)
                for s, buf in self._sources.items()
            }

    def send(self) -> None:
        pass  # стриминг делает свой поток на WING_FPS

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._wing is not None:
            self._wing.stop()

# ================== API ==================
async def list_projects(request: web.Request):
    """Возвращает список сохраненных проектов из папки projects/"""
    projects = []
    if os.path.exists(PROJECTS_PATH):
        for filename in os.listdir(PROJECTS_PATH):
            if filename.endswith(".json"):
                path = os.path.join(PROJECTS_PATH, filename)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        mtime = os.path.getmtime(path)
                        projects.append({
                            "id": filename,
                            "name": data.get("name", filename),
                            "comment": data.get("comment", ""),
                            "timestamp": mtime * 1000, # ms for JS
                            "isEmpty": False
                        })
                except Exception as e:
                    logging.error("Ошибка при чтении проекта %s: %s", filename, e)
    
    # Сортируем по времени изменения (новые сверху)
    projects.sort(key=lambda x: x["timestamp"], reverse=True)
    return web.json_response(projects)

async def save_project(request: web.Request):
    """Сохраняет проект в файл"""
    try:
        data = await request.json()
        name = data.get("name", "Unnamed").strip()
        # Чистим имя файла от запрещенных символов
        safe_name = "".join(c for c in name if c.isalnum() or c in (" ", "-", "_")).rstrip()
        if not safe_name:
            safe_name = "project"
            
        filename = f"{safe_name}.json"
        path = os.path.join(PROJECTS_PATH, filename)
        
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            
        logging.info("Проект сохранен: %s", filename)
        return web.json_response({"status": "ok", "filename": filename})
    except Exception as e:
        logging.error("Ошибка при сохранении проекта: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)

async def load_project_api(request: web.Request):
    """Загружает конкретный файл проекта"""
    filename = os.path.basename(request.match_info.get("name", ""))
    if not filename.endswith(".json"):
        filename += ".json"
        
    path = os.path.join(PROJECTS_PATH, filename)
    if not os.path.exists(path):
        return web.json_response({"status": "error", "message": "File not found"}, status=404)
        
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return web.json_response(data)
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

async def delete_project_api(request: web.Request):
    """Удаляет файл проекта"""
    filename = os.path.basename(request.match_info.get("name", ""))
    if not filename.endswith(".json"):
        filename += ".json"
        
    path = os.path.join(PROJECTS_PATH, filename)
    if os.path.exists(path):
        os.remove(path)
        logging.info("Проект удален: %s", filename)
        return web.json_response({"status": "ok"})
    return web.json_response({"status": "error", "message": "File not found"}, status=404)

async def save_incoming_file(file_field) -> Dict[str, Any] | None:
    """Стриминговое сохранение multipart-поля в media/stems с dedup по sha256.
    Возвращает описание файла или None для пустого файла."""
    original_name = file_field.filename or "file.bin"
    _, ext = os.path.splitext(original_name)
    safe_ext = ext.lower()[:10] if ext else ".bin"

    hasher = hashlib.sha256()
    total = 0
    # Пишем во временный файл: треки могут весить сотни МБ, в память не грузим
    tmp_path = os.path.join(STEMS_PATH, f".upload-{os.getpid()}-{int(time.time() * 1000)}.part")
    try:
        with open(tmp_path, "wb") as tmp:
            while True:
                chunk = await file_field.read_chunk()
                if not chunk:
                    break
                hasher.update(chunk)
                tmp.write(chunk)
                total += len(chunk)
    except Exception:
        try: os.remove(tmp_path)
        except OSError: pass
        raise

    if total == 0:
        try: os.remove(tmp_path)
        except OSError: pass
        return None

    digest = hasher.hexdigest()
    stored_name = f"{digest}{safe_ext}"
    stored_path = os.path.join(STEMS_PATH, stored_name)

    if os.path.exists(stored_path):
        os.remove(tmp_path)
        logging.info("Stem reused: %s", stored_name)
    else:
        os.replace(tmp_path, stored_path)
        logging.info("Stem saved: %s", stored_name)

    # Оригинальное имя — в индекс библиотеки (пере-заливка того же файла
    # под настоящим именем чинит запись: dedup переиспользует файл)
    remember_stem_name(stored_name, original_name, total)

    return {
        "storedName": stored_name,
        "originalName": original_name,
        "ext": safe_ext,
        "size": total,
        "url": f"/media/stems/{stored_name}",
    }


async def upload_stem_api(request: web.Request):
    """Загружает stem-файл с дедупликацией по содержимому"""
    try:
        reader = await request.multipart()
        file_field = await reader.next()

        if not file_field or file_field.name != "file":
            return web.json_response({"status": "error", "message": "File field is required"}, status=400)

        original_name = file_field.filename or "stem.wav"
        _, ext = os.path.splitext(original_name)
        safe_ext = ext.lower()[:10] if ext else ".bin"

        saved = await save_incoming_file(file_field)
        if not saved:
            return web.json_response({"status": "error", "message": "Empty file"}, status=400)

        resp = {
            "status": "ok",
            "fileName": saved["originalName"],
            "storedName": saved["storedName"],
            "url": saved["url"]
        }
        # Автоподхват анализа: к аудио «Бугу.wav» ищем «Бугу.analysis.json»
        # и т.п. (см. find_analysis_for) — нода подставит его сама
        if safe_ext in AUDIO_EXTS:
            match = find_analysis_for(original_name)
            if match:
                resp["analysisUrl"] = f"/media/stems/{match['storedName']}"
                resp["analysisName"] = match["name"]
        return web.json_response(resp)
    except Exception as e:
        logging.error("Ошибка при загрузке stem: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)

# ================== МЕДИАТЕКА ==================
# Файлы лежат в media/stems/ под sha256-именами (дедупликация по содержимому),
# оригинальные имена помним в index.json рядом. Связь «аудио ↔ анализ» — по
# basename: «Бугу.wav» ↔ «Бугу.analysis.json» (так сохраняет music2midi),
# запасные варианты: «Бугу.json», «Бугу-анализ.json».
STEMS_INDEX_PATH = os.path.join(STEMS_PATH, "index.json")
AUDIO_EXTS = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".opus"}

_stems_index_cache: Dict[str, Any] | None = None


def load_stems_index() -> Dict[str, Any]:
    global _stems_index_cache
    if _stems_index_cache is None:
        try:
            with open(STEMS_INDEX_PATH, "r", encoding="utf-8") as f:
                _stems_index_cache = json.load(f)
        except Exception:
            _stems_index_cache = {}
    return _stems_index_cache


def save_stems_index(idx: Dict[str, Any]) -> None:
    tmp = STEMS_INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STEMS_INDEX_PATH)


def remember_stem_name(stored_name: str, original_name: str, size: int) -> None:
    idx = load_stems_index()
    meta = idx.get(stored_name) or {}
    # Имя обновляем ВСЕГДА: повторная заливка того же файла под настоящим
    # именем («86157f….json» → «Бугу-анализ.json») чинит запись библиотеки
    meta.update({"name": original_name, "size": size, "ts": int(time.time())})
    idx[stored_name] = meta
    try:
        save_stems_index(idx)
    except OSError as e:
        logging.warning("Не удалось сохранить индекс стемов: %s", e)


def find_analysis_for(audio_name: str | None) -> Dict[str, str] | None:
    """Подбор analysis.json к аудио по basename. None, если не нашлось."""
    if not audio_name:
        return None
    base = os.path.splitext(os.path.basename(audio_name))[0].strip().lower()
    if not base:
        return None
    best = None  # (rank, stored_name, original_name)
    for stored, meta in load_stems_index().items():
        if os.path.splitext(stored)[1].lower() != ".json":
            continue
        n = (meta.get("name") or "").strip().lower()
        if not n:
            continue
        nb = os.path.splitext(n)[0]
        if nb == base + ".analysis":
            rank = 0
        elif nb == base:
            rank = 1
        elif nb.startswith(base) and ("анализ" in nb or "analysis" in nb):
            rank = 2
        else:
            continue
        if not os.path.exists(os.path.join(STEMS_PATH, stored)):
            continue
        if best is None or rank < best[0]:
            best = (rank, stored, meta.get("name"))
    if best is None:
        return None
    return {"storedName": best[1], "name": best[2]}


async def list_stems_api(request: web.Request):
    """Листинг библиотеки с настоящими именами; аудио — с подобранным анализом."""
    idx = load_stems_index()
    try:
        stored_names = [
            n for n in os.listdir(STEMS_PATH)
            if not n.startswith(".") and n != "index.json"
            and os.path.isfile(os.path.join(STEMS_PATH, n))
        ]
    except OSError:
        stored_names = []

    files = []
    for stored in stored_names:
        ext = os.path.splitext(stored)[1].lower()
        meta = idx.get(stored) or {}
        name = meta.get("name")
        is_audio = ext in AUDIO_EXTS
        entry: Dict[str, Any] = {
            "storedName": stored,
            "url": f"/media/stems/{stored}",
            "name": name,
            "ext": ext,
            "size": meta.get("size") or os.path.getsize(os.path.join(STEMS_PATH, stored)),
            "audio": is_audio,
        }
        if is_audio:
            match = find_analysis_for(name)
            if match:
                entry["analysis"] = {
                    "url": f"/media/stems/{match['storedName']}",
                    "name": match["name"],
                }
            lyr = find_lyrics_for(name)
            if lyr:
                entry["lyrics"] = {
                    "url": f"/media/stems/{lyr['storedName']}",
                    "name": lyr["name"],
                }
        files.append(entry)

    # Аудио первыми, дальше по имени
    files.sort(key=lambda e: (not e["audio"], (e["name"] or e["storedName"]).lower()))
    return web.json_response({"status": "ok", "files": files})

# ================== АВТОАНАЛИЗ ТРЕКОВ (music2midi headless) ==================
# Нода «ТРЕК» шлёт MP3 -> сохраняем в библиотеку и гоняем через music2midi
# (:8222) БЕЗ открытия его UI: /upload -> poll /job -> /analyze -> экспорт
# <трек>.analysis.json -> импорт в media/stems. Если music2midi не запущен —
# поднимаем сами (модель грузится в lifespan ДО ответа сервера, так что
# ответ на GET / == «модель готова»). Статус — GET /api/tracks/prepare/{id}.
M2M_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "music 2 midi"))
M2M_PY = os.path.join(M2M_DIR, ".venv", "Scripts", "python.exe")
M2M_BASE = "http://127.0.0.1:8222"
M2M_EXPORT_DIR = os.path.join(M2M_DIR, "web_ui_data", "export")

# ================== GPU: music2midi — ТОЛЬКО на RTX 4090 ==================
# RTX 5080 занята под завязку (whisper + Qwen vision/LLM) — НЕ трогаем.
# Анализ треков происходит перед мероприятием, не во время, поэтому ему
# место на 4090 рядом с LM Studio (решение юзера 27.07). ГРАБЛЯ из
# PROJECTS.md: нумерация CUDA ≠ nvidia-smi, привязка ТОЛЬКО по UUID
# (CUDA_VISIBLE_DEVICES=GPU-<uuid>). UUID резолвим в рантайме по имени
# карты — не хардкодим, переживёт замену железа.
_gpu4090_uuid_cache: str | None = None


def gpu4090_uuid() -> str | None:
    global _gpu4090_uuid_cache
    if _gpu4090_uuid_cache:
        return _gpu4090_uuid_cache
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,uuid", "--format=csv,noheader"],
            text=True, timeout=10)
        for line in out.splitlines():
            if "4090" in line:
                _gpu4090_uuid_cache = line.split(",")[1].strip()
                break
    except Exception as e:
        logging.warning("nvidia-smi не ответил, music2midi пойдёт на GPU по умолчанию: %s", e)
    if _gpu4090_uuid_cache:
        logging.info("music2midi будет на RTX 4090: %s", _gpu4090_uuid_cache)
    return _gpu4090_uuid_cache


def _m2m_env() -> Dict[str, str]:
    env = dict(os.environ)
    uuid = gpu4090_uuid()
    if uuid:
        env["CUDA_VISIBLE_DEVICES"] = uuid
    # С одной видимой картой 'cuda' == 4090
    env["DEVICE"] = "cuda"
    # ГРАБЛЯ 27.07: трек «Nils Frahm - … (Piano × …)» уронил транскрибацию —
    # print('×') в cp1251-консоль падает с 'charmap' codec can't encode.
    # Принудительно UTF-8 для stdout/stderr дочернего процесса.
    env["PYTHONIOENCODING"] = "utf-8"
    return env


# ================== music2midi: разогрев + часовой таймаут простоя ==========
# Юзер (27.07): «пусть висит час, потом выгружается из видеопамяти».
# Кнопка в ноде ТРЕК зовёт /api/tracks/engine/warm — модель грузится, пока
# юзер выбирает трек. Рипер гасит сервер через его же /shutdown после
# M2M_IDLE_TTL секунд без анализов и разогревов.
M2M_IDLE_TTL = 3600  # секунд простоя → выгрузка из VRAM
_m2m_last_activity = 0.0
_m2m_starting = False
_m2m_start_lock: "asyncio.Lock | None" = None
_m2m_alive_cache: Dict[str, Any] = {"alive": False, "at": 0.0}


def _m2m_touch() -> None:
    global _m2m_last_activity
    _m2m_last_activity = time.time()


async def _m2m_alive_fast() -> bool:
    """_m2m_alive с кэшем 5 с — нода ТРЕК поллит состояние часто."""
    if time.time() - _m2m_alive_cache["at"] < 5:
        return bool(_m2m_alive_cache["alive"])
    alive = await _m2m_alive()
    _m2m_alive_cache.update(alive=alive, at=time.time())
    return alive


async def ensure_m2m() -> None:
    """Поднять music2midi, если ещё не поднят. Лок — без гонки двойных спавнов."""
    global _m2m_start_lock, _m2m_starting
    if _m2m_start_lock is None:
        _m2m_start_lock = asyncio.Lock()
    async with _m2m_start_lock:
        if await _m2m_alive_fast():
            _m2m_touch()
            return
        if not os.path.exists(M2M_PY):
            raise RuntimeError(f"не найден python music2midi: {M2M_PY}")
        _m2m_starting = True
        try:
            # БЕЗОКОННЫЙ запуск: DETACHED_PROCESS консоль всё равно показывал
            # (скриншот юзера 27.07). CREATE_NO_WINDOW + SW_HIDE — канонический
            # рецепт невидимого консольного процесса на Windows.
            si = subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            si.wShowWindow = 0  # SW_HIDE
            subprocess.Popen(
                [M2M_PY, "web_ui.py"], cwd=M2M_DIR,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=_m2m_env(),
                startupinfo=si,
                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            logging.info("music2midi: поднимаю на RTX 4090…")
            deadline = time.time() + 900
            while time.time() < deadline:
                if await _m2m_alive():
                    break
                await asyncio.sleep(3)
            else:
                raise RuntimeError("music2midi не поднялся за 15 минут")
            _m2m_alive_cache.update(alive=True, at=time.time())
            logging.info("music2midi: готов")
        finally:
            _m2m_starting = False
        _m2m_touch()


async def _m2m_idle_reaper() -> None:
    """Час простоя → POST /shutdown music2midi (он сам себя убивает)."""
    while True:
        await asyncio.sleep(60)
        try:
            if not _m2m_last_activity:
                continue
            if time.time() - _m2m_last_activity < M2M_IDLE_TTL:
                continue
            if not await _m2m_alive():
                _m2m_alive_cache.update(alive=False, at=time.time())
                continue
            logging.info("music2midi: %d с простоя — выгружаю из VRAM", M2M_IDLE_TTL)
            async with aiohttp.ClientSession() as s:
                await s.post(M2M_BASE + "/shutdown",
                             timeout=aiohttp.ClientTimeout(total=5))
            _m2m_alive_cache.update(alive=False, at=time.time())
        except Exception as e:
            logging.warning("m2m reaper: %s", e)


async def engine_state_api(request: web.Request):
    """Состояние нейросети анализа для ноды ТРЕК: cold/starting/warm."""
    alive = await _m2m_alive_fast()
    state = "warm" if alive else ("starting" if _m2m_starting else "cold")
    return web.json_response({
        "status": "ok",
        "state": state,
        "idleSec": int(time.time() - _m2m_last_activity) if _m2m_last_activity else None,
        "idleTtlSec": M2M_IDLE_TTL,
    })


async def _warm_task() -> None:
    try:
        await ensure_m2m()
    except Exception as e:
        logging.error("warm-up music2midi: %s", e)


async def engine_warm_api(request: web.Request):
    """Кнопка «разогреть нейросеть» в ноде ТРЕК."""
    if await _m2m_alive_fast():
        _m2m_touch()
        return web.json_response({"status": "ok", "state": "warm"})
    if not _m2m_starting:
        asyncio.create_task(_warm_task())
    return web.json_response({"status": "ok", "state": "starting"})

PREPARE_JOBS: Dict[str, Dict[str, Any]] = {}


def _safe_base(name: str) -> str:
    """Тот же санитайзер, что в music2midi (_original_base) — иначе экспорт не найдём."""
    stem = os.path.splitext(os.path.basename(name))[0].strip()
    safe = "".join(c for c in stem if c not in '\\/:*?"<>|').strip()
    return safe or "track"


def import_analysis_file(base: str) -> Dict[str, Any] | None:
    """export/<base>.analysis.json из music2midi -> media/stems + индекс.
    ВНИМАНИЕ: путь по ИМЕНИ ненадёжен (multipart-приводил имена к %20) —
    основной путь теперь store_analysis_bytes через /analysis/{job_id}."""
    src = os.path.join(M2M_EXPORT_DIR, f"{base}.analysis.json")
    if not os.path.exists(src):
        return None
    with open(src, "rb") as f:
        data = f.read()
    return store_analysis_bytes(base, data)


def store_analysis_bytes(base: str, raw: bytes) -> Dict[str, Any]:
    """Анализ -> media/stems (dedup по sha256) + индекс под правильным именем."""
    digest = hashlib.sha256(raw).hexdigest()
    stored_name = f"{digest}.json"
    stored_path = os.path.join(STEMS_PATH, stored_name)
    if not os.path.exists(stored_path):
        with open(stored_path, "wb") as f:
            f.write(raw)
    display_name = f"{base}.analysis.json"
    remember_stem_name(stored_name, display_name, len(raw))
    return {"storedName": stored_name, "url": f"/media/stems/{stored_name}",
            "name": display_name, "raw": raw}


async def _m2m_alive() -> bool:
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(M2M_BASE + "/", timeout=aiohttp.ClientTimeout(total=3)) as r:
                return r.status == 200
    except Exception:
        return False


def _analysis_stats(raw: bytes):
    try:
        j = json.loads(raw.decode("utf-8"))
        notes = sum(len(t.get("notes", [])) for t in j.get("tracks", []))
        return notes, j.get("duration", 0)
    except Exception:
        return 0, 0


async def run_prepare_pipeline(job_id: str, saved: Dict[str, Any]):
    job = PREPARE_JOBS[job_id]
    base = _safe_base(saved["originalName"])

    def done(analysis_url, analysis_name, notes, duration):
        job.update(status="done", percent=100, message="Готово", result={
            "audioUrl": saved["url"], "audioName": saved["originalName"],
            "analysisUrl": analysis_url, "analysisName": analysis_name,
            "notes": notes, "duration": duration,
        })

    try:
        _m2m_touch()
        # 1. Анализ уже есть в библиотеке — гонять модель не нужно
        match = find_analysis_for(saved["originalName"])
        if match:
            logging.info("prepare: анализ уже в библиотеке (%s)", match["name"])
            with open(os.path.join(STEMS_PATH, match["storedName"]), "rb") as f:
                notes, duration = _analysis_stats(f.read())
            return done(f"/media/stems/{match['storedName']}", match["name"], notes, duration)

        # 2. music2midi жив? Нет — поднимаем (модель грузит lifespan до ответа)
        if not await _m2m_alive_fast():
            job.update(status="starting",
                       message="Запускаю music2midi — модель грузится, в первый раз это минуты…")
        await ensure_m2m()

        # 3. Upload файла из нашей библиотеки
        job.update(status="uploading", message="Отправляю трек в music2midi…", percent=5)
        audio_path = os.path.join(STEMS_PATH, saved["storedName"])
        async with aiohttp.ClientSession() as s:
            form = aiohttp.FormData()
            form.add_field("file", open(audio_path, "rb"),
                           filename=saved["originalName"],
                           content_type="application/octet-stream")
            async with s.post(M2M_BASE + "/upload", data=form,
                              timeout=aiohttp.ClientTimeout(total=300)) as r:
                up = await r.json()
        m2m_job = up.get("job_id")
        if not m2m_job:
            raise RuntimeError(f"music2midi /upload: {up}")

        # 4. Транскрибация (самое долгое)
        job.update(status="transcribing", message="Распознаю ноты…", percent=10)
        deadline = time.time() + 3600
        while True:
            await asyncio.sleep(3)
            async with aiohttp.ClientSession() as s:
                async with s.get(f"{M2M_BASE}/job/{m2m_job}",
                                 timeout=aiohttp.ClientTimeout(total=10)) as r:
                    st = await r.json()
            if st.get("status") == "done":
                break
            if st.get("status") == "error":
                raise RuntimeError(f"music2midi: {st.get('message')}")
            pct = 10 + int((st.get("percent") or 0) * 0.8)
            job.update(percent=min(90, pct),
                       message=f"Распознаю ноты… {st.get('percent', 0)}%")
            if time.time() > deadline:
                raise RuntimeError("music2midi: транскрибация дольше часа — прервано")

        # 5. Анализ уровней + забор JSON НАПРЯМУЮ с сервера. Раньше тянули
        # из export/ по ИМЕНИ файла — а имя приезжало URL-encoded
        # («Nils%20Frahm%20…»), экспорт не находился и весь прогон падал
        # ПОСЛЕ 12 минут транскрибации (разбор скриншота 27.07).
        job.update(status="analyzing", message="Считаю уровни нот…", percent=92)
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{M2M_BASE}/analyze/{m2m_job}",
                              timeout=aiohttp.ClientTimeout(total=300)) as r:
                ana = await r.json()
                if r.status != 200:
                    raise RuntimeError(f"music2midi /analyze: {ana}")
            async with s.get(f"{M2M_BASE}/analysis/{m2m_job}",
                             timeout=aiohttp.ClientTimeout(total=60)) as r:
                if r.status != 200:
                    raise RuntimeError(f"music2midi /analysis: HTTP {r.status}")
                raw = await r.read()

        # 6. Импорт в нашу библиотеку под правильным именем
        job.update(status="importing", message="Забираю анализ в библиотеку…", percent=96)
        imported = store_analysis_bytes(base, raw)
        notes, duration = _analysis_stats(imported["raw"])
        logging.info("prepare: готово, %s нот", notes)
        _m2m_touch()
        done(imported["url"], imported["name"], notes, duration)
    except Exception as e:
        logging.error("prepare: ошибка: %s", e)
        _m2m_touch()
        job.update(status="error", message=str(e))


async def prepare_track_api(request: web.Request):
    """MP3 -> библиотека + автоанализ через music2midi (в фоне). Два режима:
    multipart-файл (новый трек) или JSON {storedName} (трек уже в библиотеке)."""
    try:
        saved = None
        if (request.content_type or "").startswith("application/json"):
            body = await request.json()
            stored = os.path.basename((body or {}).get("storedName") or "")
            path = os.path.join(STEMS_PATH, stored)
            if not stored or not os.path.isfile(path):
                return web.json_response({"status": "error", "message": "нет такого файла в библиотеке"}, status=404)
            meta = load_stems_index().get(stored) or {}
            saved = {
                "storedName": stored,
                "originalName": meta.get("name") or stored,
                "url": f"/media/stems/{stored}",
            }
        else:
            reader = await request.multipart()
            file_field = await reader.next()
            if not file_field or file_field.name != "file":
                return web.json_response({"status": "error", "message": "File field is required"}, status=400)
            saved = await save_incoming_file(file_field)
            if not saved:
                return web.json_response({"status": "error", "message": "Empty file"}, status=400)

        job_id = hashlib.sha1(f"{saved['storedName']}-{time.time()}".encode()).hexdigest()[:12]
        PREPARE_JOBS[job_id] = {"status": "queued", "percent": 0,
                                "message": "В очереди", "result": None}
        # Держим не больше 20 последних задач
        while len(PREPARE_JOBS) > 20:
            PREPARE_JOBS.pop(next(iter(PREPARE_JOBS)))
        asyncio.create_task(run_prepare_pipeline(job_id, saved))
        return web.json_response({
            "status": "ok", "jobId": job_id,
            "audioUrl": saved["url"], "audioName": saved["originalName"],
        })
    except Exception as e:
        logging.error("Ошибка prepare: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def prepare_status_api(request: web.Request):
    job = PREPARE_JOBS.get(request.match_info["job_id"])
    if not job:
        return web.json_response({"status": "error", "message": "unknown job"}, status=404)
    return web.json_response({"status": "ok", **job})

# ================== КАРАОКЕ-ТЕКСТ (28.07) ==================
# Текст песни для проекций: Lumina -> music2midi /lyrics (Demucs-стем голоса
# + faster-whisper word-тайминги) -> <трек>.lyrics.json в библиотеку.
# Страница /visual подхватывает lyricsUrl из visual_state и рисует караоке.
LYRICS_JOBS: Dict[str, Dict[str, Any]] = {}


def store_lyrics_bytes(base: str, raw: bytes) -> Dict[str, Any]:
    digest = hashlib.sha256(raw).hexdigest()
    stored_name = f"{digest}.lyrics.json"
    stored_path = os.path.join(STEMS_PATH, stored_name)
    if not os.path.exists(stored_path):
        with open(stored_path, "wb") as f:
            f.write(raw)
    display_name = f"{base}.lyrics.json"
    remember_stem_name(stored_name, display_name, len(raw))
    return {"storedName": stored_name, "url": f"/media/stems/{stored_name}",
            "name": display_name}


def find_lyrics_for(audio_name: str | None) -> Dict[str, str] | None:
    """Подбор lyrics.json к аудио по basename (зеркало find_analysis_for).
    При равном рангу — самый СВЕЖИЙ по ts (перезапуск с подсказкой
    whisper'у создаёт второй файл с тем же именем, 28.07)."""
    if not audio_name:
        return None
    base = os.path.splitext(os.path.basename(audio_name))[0].strip().lower()
    if not base:
        return None
    best = None  # (rank, stored, name, ts)
    for stored, meta in load_stems_index().items():
        if not stored.lower().endswith(".lyrics.json"):
            continue
        n = (meta.get("name") or "").strip().lower()
        if not n:
            continue
        nb = os.path.splitext(os.path.splitext(n)[0])[0]  # отрезаем .json, потом .lyrics
        if nb == base:
            rank = 0
        elif nb.startswith(base) and "lyrics" in n:
            rank = 1
        else:
            continue
        if not os.path.exists(os.path.join(STEMS_PATH, stored)):
            continue
        ts = int(meta.get("ts") or 0)
        if best is None or rank < best[0] or (rank == best[0] and ts > best[3]):
            best = (rank, stored, meta.get("name"), ts)
    if best is None:
        return None
    return {"storedName": best[1], "name": best[2]}


async def run_lyrics_pipeline(job_id: str, saved: Dict[str, Any]):
    job = LYRICS_JOBS[job_id]
    base = _safe_base(saved["originalName"])

    def done(url, name, lines):
        job.update(status="done", percent=100, message="Готово", result={
            "lyricsUrl": url, "lyricsName": name, "lines": lines,
        })

    try:
        _m2m_touch()
        # 1. Текст уже есть в библиотеке — повторно не распознаём.
        # НО: если прислали подсказку whisper'у (текст песни) — это
        # осознанный ПЕРЕЗАПУСК с улучшением, кэш пропускаем (28.07).
        hint = saved.get("hint")
        match = None if hint else find_lyrics_for(saved["originalName"])
        if match:
            logging.info("lyrics: уже в библиотеке (%s)", match["name"])
            return done(f"/media/stems/{match['storedName']}", match["name"], None)

        # 2. music2midi жив? Нет — поднимаем (его lifespan грузит модель)
        await ensure_m2m()

        # 3. Upload из библиотеки (dedup по sha256 — повтор мгновенный)
        job.update(status="uploading", message="Трек уже в music2midi…", percent=5)
        audio_path = os.path.join(STEMS_PATH, saved["storedName"])
        async with aiohttp.ClientSession() as s:
            form = aiohttp.FormData()
            form.add_field("file", open(audio_path, "rb"),
                           filename=saved["originalName"],
                           content_type="application/octet-stream")
            async with s.post(M2M_BASE + "/upload", data=form,
                              timeout=aiohttp.ClientTimeout(total=300)) as r:
                up = await r.json()
        m2m_job = up.get("job_id")
        if not m2m_job:
            raise RuntimeError(f"music2midi /upload: {up}")

        # 4. Старт распознавания текста и поллинг
        job.update(status="transcribing", message="Отделяю голос и распознаю текст…", percent=15)
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{M2M_BASE}/lyrics/{m2m_job}",
                              json={"hint": hint} if hint else None,
                              timeout=aiohttp.ClientTimeout(total=30)) as r:
                st = await r.json()
                if r.status == 404:
                    # Старый процесс music2midi (поднят до появления /lyrics):
                    # иначе уйдём поллить в пустоту до дедлайна (грабля 28.07).
                    raise RuntimeError("music2midi без эндпоинта lyrics — нужен его рестарт")
                if r.status != 200:
                    raise RuntimeError(f"music2midi /lyrics: HTTP {r.status} {st}")
        if st.get("status") == "done" and st.get("cached"):
            pass  # lyrics уже лежал у music2midi — просто заберём
        deadline = time.time() + 1800
        while True:
            await asyncio.sleep(3)
            async with aiohttp.ClientSession() as s:
                async with s.get(f"{M2M_BASE}/lyrics_status/{m2m_job}",
                                 timeout=aiohttp.ClientTimeout(total=10)) as r:
                    st = await r.json()
            if st.get("status") == "done":
                break
            if st.get("status") == "error":
                raise RuntimeError(f"music2midi lyrics: {st.get('message')}")
            if time.time() > deadline:
                raise RuntimeError("music2midi lyrics: дольше 30 минут — прервано")

        # 5. Забор и импорт в библиотеку
        job.update(status="importing", message="Забираю текст в библиотеку…", percent=92)
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{M2M_BASE}/lyrics_file/{m2m_job}",
                             timeout=aiohttp.ClientTimeout(total=60)) as r:
                if r.status != 200:
                    raise RuntimeError(f"music2midi /lyrics_file: HTTP {r.status}")
                raw = await r.read()
        imported = store_lyrics_bytes(base, raw)
        try:
            n_lines = len(json.loads(raw.decode("utf-8")).get("lines", []))
        except Exception:
            n_lines = None
        logging.info("lyrics: готово, %s строк", n_lines)
        _m2m_touch()
        done(imported["url"], imported["name"], n_lines)
    except Exception as e:
        logging.error("lyrics: ошибка: %s", e)
        _m2m_touch()
        job.update(status="error", message=str(e))


async def lyrics_track_api(request: web.Request):
    """JSON {storedName} -> текст песни в фоне (трек уже в библиотеке)."""
    try:
        body = await request.json()
        stored = os.path.basename((body or {}).get("storedName") or "")
        path = os.path.join(STEMS_PATH, stored)
        if not stored or not os.path.isfile(path):
            return web.json_response({"status": "error", "message": "нет такого файла в библиотеке"}, status=404)
        meta = load_stems_index().get(stored) or {}
        saved = {"storedName": stored,
                 "originalName": meta.get("name") or stored,
                 "url": f"/media/stems/{stored}"}
        # Подсказка whisper'у (текст песни из интернета) — опционально
        hint = (body or {}).get("hint")
        if isinstance(hint, str) and hint.strip():
            saved["hint"] = hint.strip()[:8000]
        job_id = hashlib.sha1(f"lyr-{saved['storedName']}-{time.time()}".encode()).hexdigest()[:12]
        LYRICS_JOBS[job_id] = {"status": "queued", "percent": 0,
                               "message": "В очереди", "result": None}
        while len(LYRICS_JOBS) > 20:
            LYRICS_JOBS.pop(next(iter(LYRICS_JOBS)))
        asyncio.create_task(run_lyrics_pipeline(job_id, saved))
        return web.json_response({"status": "ok", "jobId": job_id})
    except Exception as e:
        logging.error("Ошибка lyrics: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def lyrics_status_api(request: web.Request):
    job = LYRICS_JOBS.get(request.match_info["job_id"])
    if not job:
        return web.json_response({"status": "error", "message": "unknown job"}, status=404)
    return web.json_response({"status": "ok", **job})

# ================== WS ==================
UI_CLIENTS: Set[web.WebSocketResponse] = set()

# ================== СЦЕНЫ / ШАБЛОНЫ (COB-пульт) ==================
# Общее для всех WS-клиентов хранилище: шаблон = именованный набор 12 сцен,
# сцена = снапшот каналов 200-207. Хранится файлом (переживает рестарт),
# каждое изменение рассылается всем клиентам (телефон/ноут/комп видит одно).
SCENE_STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenes_store.json")


def load_scene_store() -> Dict:
    default = {"active": "", "templates": {}}
    try:
        if os.path.exists(SCENE_STORE_PATH):
            with open(SCENE_STORE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("templates"), dict):
                return {"active": str(data.get("active") or ""),
                        "templates": data["templates"]}
    except Exception as e:
        logging.warning("Не удалось прочитать сцены (%s): %s", SCENE_STORE_PATH, e)
    return default


def save_scene_store(store: Dict):
    try:
        with open(SCENE_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False, indent=1)
    except Exception as e:
        logging.warning("Не удалось сохранить сцены (%s): %s", SCENE_STORE_PATH, e)


SCENE_STORE = load_scene_store()


def sanitize_snap(snap: Any) -> Dict:
    """Надёжный снапшот: только int-ключи, значения 0-255."""
    out: Dict = {}
    if not isinstance(snap, dict):
        return out
    for k, v in snap.items():
        try:
            out[str(int(k))] = max(0, min(255, int(v)))
        except (ValueError, TypeError):
            pass
    return out


def scene_active_template() -> str:
    """Текущий активный шаблон; при пустом сторе создаётся 'default'."""
    active = SCENE_STORE.get("active") or ""
    if not active or active not in SCENE_STORE.get("templates", {}):
        active = "default"
        SCENE_STORE["active"] = active
        SCENE_STORE["templates"].setdefault(active, {})
    return active


def broadcast_scene_store(app: web.Application):
    """Разослать актуальный стор сцен всем подключённым клиентам."""
    loop = app.get("loop")
    msg = json.dumps({"type": "scene_store", "payload": SCENE_STORE}, ensure_ascii=False)

    async def _send():
        for ws in list(UI_CLIENTS):
            try:
                await ws.send_str(msg)
            except Exception:
                UI_CLIENTS.discard(ws)

    if loop is None:
        asyncio.ensure_future(_send())
        return
    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except RuntimeError:
        pass


# ================== РОУТИНГ КРЫЛА / ПРЕСЕТЫ (COB-пульт) ==================
# Именованные пресеты аппаратного маппинга крыла (куда шлют фейдеры 1-8,
# энкодеры 1-4 и кнопки). Аналог SCENE_STORE: файл + рассылка всем WS-клиентам,
# переживает рестарт. Переключение — живое, без рестарта задачи LuminaDMX
# (см. WingSender.apply_routing).
ROUTING_STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "routing_store.json")


def _default_routing_map() -> Dict:
    """Базовый маппинг крыла из конфига; это и есть стартовый пресет."""
    try:
        with open(os.path.join(WING_DIR, "wing_input_map.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {"faders": data.get("faders", []),
                    "encoders": data.get("encoders", []),
                    "buttons": data.get("buttons", {})}
    except Exception as e:
        logging.warning("Не удалось прочитать базовый роутинг крыла: %s", e)
    return {"faders": [], "encoders": [], "buttons": {}}


def load_routing_store() -> Dict:
    default = {"active": "", "presets": {}}
    try:
        if os.path.exists(ROUTING_STORE_PATH):
            with open(ROUTING_STORE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("presets"), dict):
                return {"active": str(data.get("active") or ""),
                        "presets": data["presets"]}
    except Exception as e:
        logging.warning("Не удалось прочитать пресеты роутинга (%s): %s", ROUTING_STORE_PATH, e)
    return default


def save_routing_store(store: Dict):
    try:
        with open(ROUTING_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False, indent=1)
    except Exception as e:
        logging.warning("Не удалось сохранить пресеты роутинга (%s): %s", ROUTING_STORE_PATH, e)


ROUTING_STORE = load_routing_store()


def routing_active_name() -> str:
    """Имя активного пресета; при пустом сторе засеивается 'default' из файла крыла."""
    active = ROUTING_STORE.get("active") or ""
    if not active or active not in ROUTING_STORE.get("presets", {}):
        ROUTING_STORE.setdefault("presets", {})
        if "default" not in ROUTING_STORE["presets"]:
            ROUTING_STORE["presets"]["default"] = _default_routing_map()
        ROUTING_STORE["active"] = "default"
        save_routing_store(ROUTING_STORE)
        active = "default"
    return active


def apply_routing_to_sender(sender: Any) -> None:
    """Применить активный пресет роутинга к живому крылу."""
    if not isinstance(sender, WingSender):
        return
    name = ROUTING_STORE.get("active") or ""
    routing_map = ROUTING_STORE.get("presets", {}).get(name)
    if isinstance(routing_map, dict):
        sender.apply_routing(routing_map)


def broadcast_routing_store(app: web.Application):
    """Разослать актуальный стор роутинга всем подключённым клиентам."""
    loop = app.get("loop")
    msg = json.dumps({"type": "route_store", "payload": ROUTING_STORE}, ensure_ascii=False)

    async def _send():
        for ws in list(UI_CLIENTS):
            try:
                await ws.send_str(msg)
            except Exception:
                UI_CLIENTS.discard(ws)

    if loop is None:
        asyncio.ensure_future(_send())
        return
    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except RuntimeError:
        pass


def refresh_routing(sender: Any, app: web.Application):
    """Сохранить + разослать + применить активный пресет роутинга."""
    save_routing_store(ROUTING_STORE)
    broadcast_routing_store(app)
    apply_routing_to_sender(sender)


def broadcast_wing_event(app: web.Application, ev: dict):
    """Событие ввода крыла -> всем подключённым UI-клиентам.

    Вызывается из потока крыла (pyusb reader), поэтому отправку
    планируем в asyncio-цикл через run_coroutine_threadsafe.
    """
    loop = app.get("loop")
    if loop is None:
        return
    msg = json.dumps({"type": "wing_input", "payload": ev}, ensure_ascii=False)

    async def _send():
        for ws in list(UI_CLIENTS):
            try:
                await ws.send_str(msg)
            except Exception:
                UI_CLIENTS.discard(ws)

    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except RuntimeError:
        pass


def broadcast_wing_wave_state(app: web.Application):
    """Синхронизация тумблера световой волны между всеми панелями (14.08)."""
    sender = app.get("artnet")
    on = bool(getattr(sender, "_wing_wave_enabled", False)) if isinstance(sender, WingSender) else False
    loop = app.get("loop")
    msg = json.dumps({"type": "wing_wave_state", "payload": {"enabled": 1 if on else 0}},
                     ensure_ascii=False)

    async def _send():
        for ws in list(UI_CLIENTS):
            try:
                await ws.send_str(msg)
            except Exception:
                UI_CLIENTS.discard(ws)

    if loop is None:
        asyncio.ensure_future(_send())
        return
    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except RuntimeError:
        pass


def broadcast_blackout_state(app: web.Application, exclude=None):
    """Синхронизация блекаута между панелями (14.08): мигающая B на экранчике
    у ВСЕХ клиентов, а не только у того, кто включил. exclude — ws источника
    (он своё состояние уже знает)."""
    sender = app.get("artnet")
    on = bool(getattr(sender, "_blackout", False)) if isinstance(sender, WingSender) else False
    loop = app.get("loop")
    msg = json.dumps({"type": "blackout_state", "payload": {"set": 1 if on else 0}},
                     ensure_ascii=False)

    async def _send():
        for ws in list(UI_CLIENTS):
            if ws is exclude:
                continue
            try:
                await ws.send_str(msg)
            except Exception:
                UI_CLIENTS.discard(ws)

    if loop is None:
        asyncio.ensure_future(_send())
        return
    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except RuntimeError:
        pass


def broadcast_clients(app: web.Application):
    """Сообщить всем клиентам, сколько их сейчас.

    UI рисует предупреждение при N>1: второй клиент (забытая вкладка,
    headless-браузер от скриншотилки) незаметно участвует в HTP-миксе.
    """
    loop = app.get("loop")
    n = len(UI_CLIENTS)
    msg = json.dumps({"type": "clients", "payload": {"count": n}}, ensure_ascii=False)

    async def _send():
        for ws in list(UI_CLIENTS):
            try:
                await ws.send_str(msg)
            except Exception:
                UI_CLIENTS.discard(ws)

    if loop is None:
        asyncio.ensure_future(_send())
        return
    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except RuntimeError:
        pass

async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    app = request.app
    sender = app["artnet"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    UI_CLIENTS.add(ws)
    # Ключ источника в HTP-миксе: у каждого клиента свой буфер, поэтому
    # нулевой heartbeat одной вкладки больше не гасит сцену другой.
    src = id(ws)
    await ws.send_str(json.dumps({
        "type": "hello_ack",
        "payload": {"server": "lumina-v4", "clients": len(UI_CLIENTS)},
    }, ensure_ascii=False))
    if len(UI_CLIENTS) > 1:
        logging.warning("К серверу подключено %d WS-клиентов — выход идёт в HTP-миксе "
                        "(проверь забытые вкладки/headless-браузеры)", len(UI_CLIENTS))
    broadcast_clients(app)
    # Опоздавшей визуалке (проектор) — сразу последнее известное состояние
    last_visual = app.get("visual_state")
    if isinstance(last_visual, dict):
        await ws.send_str(json.dumps(
            {"type": "visual_state", "payload": last_visual}, ensure_ascii=False))
    # Пульту — текущий стор сцен/шаблонов (общий для всех устройств)
    await ws.send_str(json.dumps(
        {"type": "scene_store", "payload": SCENE_STORE}, ensure_ascii=False))
    # Пульту — пресеты роутинга крыла (активный + список) на момент подключения
    await ws.send_str(json.dumps(
        {"type": "route_store", "payload": ROUTING_STORE}, ensure_ascii=False))
    # Пульту — текущие уровни физических фейдеров крыла (обратная связь,
    # 05.08: веб-панель показывает/дублирует движение крыла). Снапшот на
    # подключение, дальше — дельта-события wing_input.
    if isinstance(sender, WingSender):
        # Пульту — текущее состояние тумблера волны (14.08: по умолчанию OFF)
        await ws.send_str(json.dumps(
            {"type": "wing_wave_state",
             "payload": {"enabled": 1 if sender._wing_wave_enabled else 0}},
            ensure_ascii=False))
        # Пульту — текущее состояние блекаута (мигающая B на экранчике)
        await ws.send_str(json.dumps(
            {"type": "blackout_state",
             "payload": {"set": 1 if sender._blackout else 0}},
            ensure_ascii=False))
        with sender._lock:
            # Снапшот физических фейдеров по АКТИВНОЙ карте (13.08): карта
            # теперь шлёт фейдеры в каналы COB-раскладки 200-205/201-204, а не 1-8
            mapper = getattr(sender, "_mapper", None)
            if mapper is not None:
                wing_lv = mapper.get_fader_levels()
            else:
                buf = sender._sources.get(LOCAL_SOURCE, bytearray(512))
                wing_lv = list(buf[0:8])
        await ws.send_str(json.dumps(
            {"type": "wing_levels", "payload": wing_lv}, ensure_ascii=False))

    try:
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(m.data)
                if isinstance(data, dict) and data.get("type") == "visual_state":
                    # Реле реактивной проекции (28.07): UI публикует семантическое
                    # состояние (энергия/цвет/секция/удар), сервер рассылает его
                    # всем ОСТАЛЬНЫМ клиентам (WebGL-страницы проекторов). В DMX
                    # это не пишется, на HTP-микс не влияет.
                    payload = data.get("payload")
                    if isinstance(payload, dict):
                        app["visual_state"] = payload
                        msg = json.dumps({"type": "visual_state", "payload": payload},
                                         ensure_ascii=False)
                        for client in list(UI_CLIENTS):
                            if client is ws:
                                continue
                            try:
                                await client.send_str(msg)
                            except Exception:
                                UI_CLIENTS.discard(client)
                elif isinstance(data, list):
                    # Полный кадр (автоматика Lumina: граф/сцены/генераторы).
                    # Помечаем источник — в bypass такие отсекаются, а ручное
                    # single-управление (веб-панель) продолжает работать (14.08).
                    sender._list_sources.add(src)
                    # Дамп WS-трафика в лог для расследования мигания
                    if os.environ.get("LUMINA_WS_LOG") == "1" and data:
                        dml = logging.getLogger("lumina_ws")
                        # Сколько раз ch=200 в списке и какие значения (_detect duplicates)
                        ch200_vals = [it.get("val") for it in data if isinstance(it, dict) and it.get("ch") == 200]
                        v1 = next((it.get("val") for it in data if isinstance(it, dict) and it.get("ch") == 1), None)
                        v250 = next((it.get("val") for it in data if isinstance(it, dict) and it.get("ch") == 250), None)
                        dml.info("ws-list src=%s n=%d ch1=%s ch250=%s | ch200_count=%d vals=%s",
                                 src, len(data), v1, v250, len(ch200_vals), ch200_vals)
                    for it in data:
                        if isinstance(it, dict) and "ch" in it and "val" in it:
                            sender.set_channel(int(it["ch"]) - 1, it["val"], src)
                elif isinstance(data, dict) and data.get("type") in ("scene_set", "tpl_save", "tpl_load", "tpl_del"):
                    # Сцены/шаблоны COB-пульта: общее хранилище для всех клиентов.
                    # Любое изменение -> файл + бродкаст, остальные устройства
                    # применяют стор и перерисовывают пады.
                    mtype = data.get("type")
                    if mtype == "scene_set":
                        snap = sanitize_snap(data.get("snap"))
                        if snap:
                            cur = scene_active_template()
                            SCENE_STORE["templates"][cur][str(int(data.get("idx")))] = snap
                            save_scene_store(SCENE_STORE)
                            broadcast_scene_store(app)
                    elif mtype == "tpl_save":
                        name = str(data.get("name") or "").strip()
                        if name:
                            # «Сохранить как»: копия текущего шаблона под новым именем
                            cur = scene_active_template()
                            SCENE_STORE["templates"][name] = dict(SCENE_STORE["templates"].get(cur, {}))
                            SCENE_STORE["active"] = name
                            save_scene_store(SCENE_STORE)
                            broadcast_scene_store(app)
                    elif mtype == "tpl_load":
                        name = str(data.get("name") or "").strip()
                        if name in SCENE_STORE["templates"]:
                            SCENE_STORE["active"] = name
                            save_scene_store(SCENE_STORE)
                            broadcast_scene_store(app)
                    elif mtype == "tpl_del":
                        name = str(data.get("name") or "").strip()
                        if name in SCENE_STORE["templates"]:
                            del SCENE_STORE["templates"][name]
                            if SCENE_STORE.get("active") == name:
                                SCENE_STORE["active"] = ""
                            save_scene_store(SCENE_STORE)
                            broadcast_scene_store(app)
                elif isinstance(data, dict) and data.get("type") in ("route_save", "route_load", "route_del"):
                    # Пресеты роутинга крыла: смена маппинга вживую, без рестарта.
                    mtype = data.get("type")
                    name = str(data.get("name") or "").strip()
                    presets = ROUTING_STORE.setdefault("presets", {})
                    if mtype == "route_save" and name:
                        # «Сохранить как»: копия активного маппинга под новым именем + активация
                        cur = routing_active_name()
                        presets[name] = dict(presets.get(cur, _default_routing_map()))
                        ROUTING_STORE["active"] = name
                        refresh_routing(sender, app)
                    elif mtype == "route_load" and name in presets:
                        ROUTING_STORE["active"] = name
                        refresh_routing(sender, app)
                    elif mtype == "route_del" and name in presets and len(presets) > 1:
                        del presets[name]
                        if ROUTING_STORE.get("active") == name:
                            nxt = next(iter(presets)) if presets else "default"
                            ROUTING_STORE["active"] = nxt
                        refresh_routing(sender, app)
                elif isinstance(data, dict) and data.get("type") == "wing_leds":
                    # VU-эквалайзер / прямая запись подсветки крыла из UI
                    if isinstance(sender, WingSender):
                        payload = data.get("payload") or {}
                        if "bands" in payload:
                            sender.set_bands(payload["bands"])
                        elif "leds" in payload:
                            sender.set_leds(payload["leds"])
                elif isinstance(data, dict) and "ch" in data and "val" in data:
                    if os.environ.get("LUMINA_WS_LOG") == "1":
                        logging.getLogger("lumina_ws").info("ws-single src=%s ch=%d v=%d", src, data.get("ch", -1), data.get("val", -1))
                    sender.set_channel(int(data["ch"]) - 1, data["val"], src)
                elif isinstance(data, dict) and data.get("type") == "blackout":
                    sender.set_blackout(bool(data.get("set")))
                    logging.getLogger("lumina_ws").info("blackout %s (src=%s)", "ON" if data.get("set") else "OFF", src)
                    broadcast_blackout_state(request.app, exclude=ws)
                elif isinstance(data, dict) and data.get("type") == "bypass":
                    sender.set_bypass(bool(data.get("set")))
                    logging.getLogger("lumina_ws").info("bypass %s (src=%s)", "ON" if data.get("set") else "OFF", src)
                elif isinstance(data, dict) and data.get("type") == "enc_reset":
                    # Сброс энкодера с панели: 12 часов = 0 (договорённость 14.08).
                    # Только панель сбрасывает, крыло права сброса не имеет.
                    mapper = getattr(sender, "_mapper", None)
                    if mapper is not None:
                        mapper.reset_encoder(int(data.get("idx", 1)))
                        logging.getLogger("lumina_ws").info(
                            "enc_reset idx=%s (src=%s)", data.get("idx"), src)
                elif isinstance(data, dict) and data.get("type") == "wing_wave":
                    if "enabled" in data:
                        sender.set_wing_wave_enabled(data.get("enabled"))
                        broadcast_wing_wave_state(request.app)
                    else:
                        sender.wing_wave(data.get("events") or [], boot=bool(data.get("boot")))
            except (ValueError, TypeError) as e:
                # Одно битое сообщение не должно ронять соединение
                logging.warning("Пропущено некорректное WS-сообщение: %s", e)
    finally:
        UI_CLIENTS.discard(ws)
        # Клиент ушёл — снимаем его вклад из HTP-микса. Иначе его последний
        # кадр остался бы в миксе навсегда (приборы держат значение, расчёски
        # включают авто-программу), а blackout соседа не смог бы его перебить.
        sender = request.app.get("artnet")
        if isinstance(sender, WingSender):
            sender.drop_source(src)
            if not UI_CLIENTS:
                # Ушёл последний UI — снимаем и вклад железа: фейдеры крыла
                # физически остались подняты, но старое поведение (грабля
                # «расчёска включает авто-программу после закрытия окна»)
                # требует чистого нуля. Значения вернутся при первом движении.
                sender.reset_source(LOCAL_SOURCE)
                logging.info("Последний клиент отключился — DMX-буфер обнулён")
        broadcast_clients(request.app)
    return ws

# ================== APP ==================
async def debug_dmx_handler(request: web.Request):
    """Временная отладка: дамп значений ключевых каналов DMX-буфера."""
    sender = request.app.get("artnet")
    if not isinstance(sender, WingSender):
        return web.json_response({"error": "no wing sender"})
    with sender._lock:
        data = list(sender.dmx_data)
        sent = list(getattr(sender, "_last_sent", bytes(512)))
    # Каналы 1-8 (фейдеры крыла), 33-48 (кулисы: Backdrop L — первая пара), 200-207 (COB), 250-260 (расчёска мотор/скорость/первые лучи)
    return web.json_response({
        "ch_1_8": data[0:8],
        # Кулисные Euro DJ led_par 6ch: 33-128 (диагностика «кулисы молчат», 28.07)
        "ch_33_48": data[32:48],
        "ch_200_210": data[199:210],
        "ch_250_260": data[249:260],
        "ch_290_300": data[289:300],
        # 500+ — свободный хвост вселенной, на нём гоняются тесты HTP-микса
        "ch_500_512": data[499:512],
        # Что реально ушло в линию (в bypass = только LOCAL_SOURCE крыла)
        "sent_200_210": sent[199:210],
        "wing_dev": "yes" if (sender._wing and sender._wing.dev) else "no",
        "wing_led": (lambda lb: {"nonzero": sum(1 for i in range(0, 260, 2) if int.from_bytes(lb[i:i + 2], "little")), "sum": sum(int.from_bytes(lb[i:i + 2], "little") for i in range(0, 260, 2))})(bytes(sender._wing.led_body) if sender._wing else b""),
        "wing_wave_enabled": sender._wing_wave_enabled,
        "blackout": sender._blackout,
        "bypass": sender._bypass,
        "encoders": sender._mapper.get_encoder_state() if sender._mapper else [],
        "clients": len(UI_CLIENTS),
        # Сколько ненулевых каналов держит каждый источник в HTP-миксе:
        # >1 WS-источника = кто-то ещё управляет светом (вкладка/headless).
        "sources": sender.source_stats(),
        # Диагностика ввода крыла (14.08): жив ли поток и сколько IN-пакетов пришло
        "wing_input": sender._wing.input_stats() if sender._wing else None,
    })

async def calibration_handler(request: web.Request):
    """Калибровка наклона расчёсок, измеренная tools/calibrate_tilt.py.

    Фронт (web/utils/tiltGuard.ts) строит из этих отметок безопасный сектор.
    Файла нет — отдаём marks:null, фронт остаётся на консервативных дефолтах.
    """
    path = os.path.join(WING_DIR, "tilt_calibration.json")
    if not os.path.exists(path):
        return web.json_response({"marks": None, "measured": False})
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response({
            "marks": data.get("marks"),
            "limits": data.get("limits"),
            "measured": bool(data.get("marks") or data.get("limits")),
            "fixtureType": data.get("fixtureType"),
            "channelOffset": data.get("channelOffset"),
        })
    except Exception as e:
        logging.error("Калибровка наклона не прочитана: %s", e)
        return web.json_response({"marks": None, "measured": False, "error": str(e)})


async def calibration_save_handler(request: web.Request):
    """Сохранить сектор наклона, выставленный руками в UI.

    Пишем в тот же файл, что и калибровщик, но в поле `limits` — так ручная
    правка не затирает результат замера по свету (`marks`), а имеет приоритет
    при чтении на фронте.
    """
    path = os.path.join(WING_DIR, "tilt_calibration.json")
    try:
        body = await request.json()
        clamp = lambda v: max(0, min(255, int(v)))
        safe_lo = clamp(body["safeLo"])
        safe_hi = max(safe_lo, clamp(body["safeHi"]))
        park = min(safe_hi, max(safe_lo, clamp(body["park"])))
    except (ValueError, TypeError, KeyError) as e:
        return web.json_response(
            {"status": "error", "message": f"нужны числа safeLo/safeHi/park: {e}"},
            status=400)

    data = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
    data.setdefault("_comment", (
        "Безопасный сектор наклона расчёсок (канал MotorY, comb_rgbw offset 0). "
        "Физика: 0 = луч в зал, ~середина = вверх, 255 = вглубь сцены. "
        "`marks` — замер по свету через tools/calibrate_tilt.py; "
        "`limits` — правка руками из UI (приоритет при чтении)."
    ))
    data["fixtureType"] = "comb_rgbw"
    data["channelOffset"] = 0
    data["limits"] = {"safeLo": safe_lo, "safeHi": safe_hi, "park": park}
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logging.error("Калибровка наклона не сохранена: %s", e)
        return web.json_response({"status": "error", "message": str(e)}, status=500)
    logging.info("Сектор наклона сохранён: %s..%s, парковка %s", safe_lo, safe_hi, park)
    return web.json_response({"status": "ok", "limits": data["limits"]})


async def index_handler(request: web.Request):
    resp = web.FileResponse(os.path.join(DIST_PATH, "index.html"))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp

async def visual_handler(request: web.Request):
    """Реактивная проекция: WebGL-страница для дисплеев проекторов (28.07).
    Отдельный самодостаточный HTML (без сборки), питается visual_state по WS."""
    resp = web.FileResponse(VISUAL_PATH)
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp

async def _dmx_dump_loop(app: web.Application):
    """Тикер дампа dmx_data в лог: пишет ключевые каналы раз в 250 мс."""
    logger = logging.getLogger("lumina_dmx_dump")
    sender = app.get("artnet")
    if not isinstance(sender, WingSender):
        return
    last = None
    while True:
        await asyncio.sleep(0.25)
        with sender._lock:
            d = sender.dmx_data
            # первый канал расчёски, мотор/скорость, первые лучи; 1-8 (фидеры)
            snapshot = (
                tuple(d[249:262]) + tuple(d[0:8]) +
                (d[199], d[200], d[207], d[289], d[299])
            )
        if snapshot != last:
            logger.info("dump ch250-261=%s ch1-8=%s ch200=%d ch207=%d ch290=%d ch300=%d",
                        list(d[249:262]), list(d[0:8]),
                        d[199], d[207], d[289], d[299])
            last = snapshot


async def on_startup(app: web.Application):
    app["loop"] = asyncio.get_running_loop()
    sender = app.get("artnet")
    if isinstance(sender, WingSender):
        # Крыло шлёт события ввода из своего потока — пересылаем в UI по WS
        sender.event_cb = lambda ev: broadcast_wing_event(app, ev)
    # Пресет роутинга: при пустом сторе создаём 'default' из файла крыла
    routing_active_name()
    logging.info("Lumina Backend Started. Output: %s", app["output_name"])
    if os.environ.get("LUMINA_WS_LOG") == "1":
        asyncio.create_task(_dmx_dump_loop(app))
    # Часовой репер простоя music2midi: выгружает модель из VRAM
    app["m2m_reaper"] = asyncio.create_task(_m2m_idle_reaper())
    if not IS_SERVICE:
        webbrowser.open(f"http://localhost:{PORT}")

async def on_cleanup(app: web.Application):
    for ws in list(UI_CLIENTS): await ws.close()
    app["artnet"].close()

def create_app() -> web.Application:
    # Стемы могут весить сотни МБ — дефолтный лимит aiohttp (1 МБ) не подходит
    app = web.Application(middlewares=[cors_middleware], client_max_size=4 * 1024**3)

    # Вывод DMX: только USB-крыло напрямую
    if OUTPUT_MODE != "wing":
        raise ValueError(f"Unsupported OUTPUT_MODE: {OUTPUT_MODE!r}; only 'wing' is supported")
    sender = WingSender(DMX_CHANNELS)
    if not sender.start():
        logging.warning("USB-крыло не инициализировано при старте; сервер продолжит работу в режиме ожидания")
    output_name = "USB wing (direct)"

    app["artnet"] = sender
    app["output_name"] = output_name
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/visual", visual_handler)
    app.router.add_get("/api/debug/dmx", debug_dmx_handler)
    app.router.add_get("/api/calibration", calibration_handler)
    app.router.add_post("/api/calibration", calibration_save_handler)
    
    # API для проектов
    app.router.add_get("/api/projects", list_projects)
    app.router.add_post("/api/projects/save", save_project)
    app.router.add_get("/api/projects/{name}", load_project_api)
    app.router.add_delete("/api/projects/{name}", delete_project_api)
    app.router.add_post("/api/stems/upload", upload_stem_api)
    app.router.add_get("/api/stems/list", list_stems_api)
    app.router.add_post("/api/tracks/prepare", prepare_track_api)
    app.router.add_get("/api/tracks/prepare/{job_id}", prepare_status_api)
    app.router.add_post("/api/tracks/lyrics", lyrics_track_api)
    app.router.add_get("/api/tracks/lyrics/{job_id}", lyrics_status_api)
    app.router.add_get("/api/tracks/engine", engine_state_api)
    app.router.add_post("/api/tracks/engine/warm", engine_warm_api)
    
    # Пытаемся добавить статику только если она есть
    if os.path.exists(DIST_PATH):
        app.router.add_get("/", index_handler)
        app.router.add_static("/assets", os.path.join(DIST_PATH, "assets"), name='assets')
    else:
        logging.warning("Папка 'dist' не найдена. Пожалуйста, дождитесь завершения сборки.")

    app.router.add_static("/media/stems", STEMS_PATH, name="stems_media")

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app

if __name__ == "__main__":
    # Сначала собираем фронтенд
    build_frontend()
    # Затем запускаем сервер
    web.run_app(create_app(), host=WS_HOST, port=PORT)
