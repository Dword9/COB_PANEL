"""DMX chain test: pulse all 4 combs red -> green -> blue -> white -> off.
Run: venv python dmx_chain_test.py
"""
import asyncio
import json

import aiohttp

BASE = [250, 293, 336, 379]
STEPS = [((255, 0, 0, 0), "RED"), ((0, 255, 0, 0), "GREEN"), ((0, 0, 255, 0), "BLUE"), ((255, 255, 255, 255), "WHITE")]


async def main() -> None:
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect("http://127.0.0.1:8000/ws") as ws:
            hello = await ws.receive_str()
            print("server says:", hello[:80])
            # SpdY: slow motor speed
            await ws.send_str(json.dumps([{"ch": b + 1, "val": 60} for b in BASE]))
            for (r, g, b, w), name in STEPS:
                out = []
                for base in BASE:
                    for i in range(10):
                        for c, v in enumerate((r, g, b, w)):
                            out.append({"ch": base + 2 + i * 4 + c, "val": v})
                await ws.send_str(json.dumps(out))
                print(f">>> {name} (2 sec)")
                await asyncio.sleep(2.0)
            out = []
            for base in BASE:
                for i in range(10):
                    for c in range(4):
                        out.append({"ch": base + 2 + i * 4 + c, "val": 0})
            await ws.send_str(json.dumps(out))
            print(">>> BLACKOUT. done")


asyncio.run(main())
