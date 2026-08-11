r"""Калибровка наклона расчёсок: измерить безопасный сектор на железе.

ФИЗИКА (со слов юзера 26.07). Рейка с 10 светодиодами качается вбок на 180°,
канал MotorY (offset 0 у comb_rgbw):

     0            ~середина          255
  в зал   →   ВВЕРХ (вертикаль)  →  внутрь сцены (крайнее положение)

Приборы стоят на авансцене на уровне глаз сидящих людей. Опасна ТОЛЬКО
зона около нуля: там луч бьёт прямо в зрителя. Сторона «внутрь сцены»
безопасна. Приборы при включении сами калибруются в 0 — то есть по питанию
они уже смотрят в зал, пока пульт не возьмёт канал под управление.

Что делает скрипт: включает лучи тускло-белым и даёт крутить мотор с
клавиатуры. Ты смотришь на приборы и отмечаешь три точки:

  z — последнее значение, на котором луч ещё бьёт В ЗАЛ (в глаза)
  u — ВЕРТИКАЛЬ, лучи строго вверх (это будет угол парковки)
  e — предел хода внутрь сцены (обычно так и остаётся 255)

Результат → tools/wing/tilt_calibration.json. Сервер отдаёт его на
GET /api/calibration, фронт (web/utils/tiltGuard.ts) строит из него
безопасный сектор: safeLo = z + запас, park = u, safeHi = e.

Запуск (сервер Lumina работает, пульт Lumina ЗАКРЫТ):
    tools\wing\venv\Scripts\python.exe tools\calibrate_tilt.py

Клавиши:
    ↑ / ↓        мотор ±1
    PgUp / PgDn  мотор ±10
    ← / →        скорость мотора (SpdY) ±10
    1..4         одна расчёска (1=ch250, 2=ch293, 3=ch336, 4=ch379)
    a            все четыре разом (наклон у них одинаковый)
    + / -        яркость лучей
    z / u / e    отметить: в зал / вертикаль / предел в сцену
    d            запас безопасности (margin) ±, по умолчанию 8
    s            сохранить и выйти
    q            выйти без сохранения (гасит лучи, мотор уводит вверх)
"""
import asyncio
import json
import msvcrt
import os
import sys

import aiohttp

WS_URL = "http://127.0.0.1:8000/ws"
DBG_URL = "http://127.0.0.1:8000/api/debug/dmx"
OUT_PATH = os.path.join(os.path.dirname(__file__), "wing", "tilt_calibration.json")

# Раскладка comb_rgbw (web/constants.ts): 0=MotorY, 1=SpdY, 2..41=10x RGBW, 42=Reset
COMB_BASES = [250, 293, 336, 379]
OFF_MOTOR, OFF_SPEED, OFF_BEAMS = 0, 1, 2
BEAM_COUNT, BEAM_W = 10, 3

MARK_KEYS = {"z": "hall", "u": "up", "e": "stage"}
MARK_TITLE = {
    "hall": "в зал (опасно)",
    "up": "вертикаль/парковка",
    "stage": "предел в сцену",
}


class Calib:
    def __init__(self):
        # Стартуем в середине: по физике это «вверх», безопасно.
        self.motor = 128
        self.speed = 128
        self.bright = 40
        self.margin = 8
        self.selected = list(range(len(COMB_BASES)))
        self.marks = {}

    def frame(self):
        out = []
        for i in range(len(COMB_BASES)):
            base = COMB_BASES[i]
            on = i in self.selected
            out.append({"ch": base + OFF_MOTOR, "val": self.motor if on else 128})
            out.append({"ch": base + OFF_SPEED, "val": self.speed})
            for b in range(BEAM_COUNT):
                ch = base + OFF_BEAMS + b * 4
                out.append({"ch": ch + 0, "val": 0})
                out.append({"ch": ch + 1, "val": 0})
                out.append({"ch": ch + 2, "val": 0})
                out.append({"ch": ch + BEAM_W, "val": self.bright if on else 0})
        return out

    def park_frame(self):
        """Гасим лучи, мотор уводим в вертикаль (или в отмеченную парковку)."""
        park = self.marks.get("up", 128)
        out = []
        for base in COMB_BASES:
            out.append({"ch": base + OFF_MOTOR, "val": park})
            for b in range(BEAM_COUNT):
                ch = base + OFF_BEAMS + b * 4
                for k in range(4):
                    out.append({"ch": ch + k, "val": 0})
        return out

    def status(self):
        sel = ",".join(str(i + 1) for i in self.selected) if self.selected else "нет"
        marks = "  ".join(f"{MARK_TITLE[k]}={v}" for k, v in self.marks.items()) or "ничего"
        return (f"\rприборы [{sel}]  МОТОР={self.motor:3d}  скор={self.speed:3d}  "
                f"ярк={self.bright:3d}  запас={self.margin}  |  {marks}          ")


HELP = """
=== Калибровка наклона расчёсок ===

Лучи включены тускло. Крути мотор: ↑/↓ по 1, PgUp/PgDn по 10.
По физике: 0 = в зал, середина = вверх, 255 = внутрь сцены.

Отметь три точки:
  z — луч ещё бьёт В ЗАЛ (последнее опасное значение)
  u — ВЕРТИКАЛЬ, строго вверх (станет углом парковки)
  e — предел хода внутрь сцены (можно оставить 255: жать e на 255)

  1..4 прибор, a все, ←/→ скорость, +/- яркость, d запас (сейчас 8)
  s сохранить и выйти,  q выйти без сохранения
"""


async def read_key(loop):
    return await loop.run_in_executor(None, msvcrt.getch)


async def main():
    loop = asyncio.get_running_loop()
    c = Calib()

    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(DBG_URL) as r:
                dbg = await r.json()
        except Exception as e:
            print(f"Сервер Lumina не отвечает ({DBG_URL}): {e}")
            print("Запусти сервер (run_server.bat или задачу LuminaDMX) и повтори.")
            return 1
        if dbg.get("clients", 0) > 0:
            print(f"ОСТАНОВЛЕНО: к серверу подключено клиентов: {dbg['clients']}.")
            print("Сервер мержит каналы по HTP (максимум) — чужие значения исказят")
            print("замер. Закрой пульт Lumina и headless-браузеры:")
            print('  python "%USERPROFILE%\\.config\\opencode\\tools\\webshot.py" --reset')
            return 1

        ws = await session.ws_connect(WS_URL)
        print(HELP)
        await ws.send_str(json.dumps(c.frame()))
        sys.stdout.write(c.status())
        sys.stdout.flush()

        save = False
        while True:
            k = await read_key(loop)
            if k in (b"\xe0", b"\x00"):
                k2 = await read_key(loop)
                if k2 == b"H":   c.motor = min(255, c.motor + 1)
                elif k2 == b"P": c.motor = max(0, c.motor - 1)
                elif k2 == b"I": c.motor = min(255, c.motor + 10)
                elif k2 == b"Q": c.motor = max(0, c.motor - 10)
                elif k2 == b"M": c.speed = min(255, c.speed + 10)
                elif k2 == b"K": c.speed = max(0, c.speed - 10)
            else:
                ch = k.decode("ascii", "ignore").lower()
                if ch == "q":
                    break
                elif ch == "s":
                    save = True
                    break
                elif ch in "1234":
                    c.selected = [int(ch) - 1]
                elif ch == "a":
                    c.selected = list(range(len(COMB_BASES)))
                elif ch in "+=":
                    c.bright = min(255, c.bright + 10)
                elif ch in "-_":
                    c.bright = max(0, c.bright - 10)
                elif ch == "d":
                    c.margin = 4 if c.margin >= 16 else c.margin + 4
                elif ch in MARK_KEYS:
                    c.marks[MARK_KEYS[ch]] = c.motor

            await ws.send_str(json.dumps(c.frame()))
            sys.stdout.write(c.status())
            sys.stdout.flush()

        await ws.send_str(json.dumps(c.park_frame()))
        await asyncio.sleep(0.4)
        await ws.close()
        print()

        if not save:
            print("Выход без сохранения. Лучи погашены, мотор уведён вверх.")
            return 0

        if "hall" not in c.marks:
            print("Не отмечена граница «в зал» (клавиша z) — без неё сектор не построить.")
            print(f"Отмечено: {c.marks}")
            return 1
        if "up" not in c.marks:
            print("Не отмечена вертикаль (клавиша u) — это угол парковки, он обязателен.")
            print(f"Отмечено: {c.marks}")
            return 1

        marks = dict(c.marks)
        marks["margin"] = c.margin
        marks.setdefault("stage", 255)
        marks["park"] = marks["up"]

        safe_lo = min(255, marks["hall"] + c.margin)
        data = {
            "_comment": (
                "Измерено на железе через tools/calibrate_tilt.py. Канал MotorY "
                "расчёсок (comb_rgbw, offset 0). hall = луч ещё бьёт в зал; "
                "up = вертикаль (угол парковки); stage = предел внутрь сцены; "
                "margin = запас безопасности над hall. Фронт строит сектор: "
                "safeLo = hall + margin, park = up, safeHi = stage."
            ),
            "fixtureType": "comb_rgbw",
            "channelOffset": OFF_MOTOR,
            "marks": marks,
            "derived": {"safeLo": safe_lo, "safeHi": marks["stage"], "park": marks["park"]},
            "speedUsed": c.speed,
        }
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Сохранено: {OUT_PATH}")
        print(f"Безопасный сектор: {safe_lo}..{marks['stage']}, парковка {marks['park']}")
        print("Перезагрузи пульт (F5) — он подтянет калибровку с сервера.")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
