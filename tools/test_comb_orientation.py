import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server_v4 import COMB_START_CHANNELS, map_comb_rig_orientation


frame = bytearray(512)
frame[0] = 77
for start in COMB_START_CHANNELS:
    base = start - 1
    frame[base] = 17
    frame[base + 1] = 23
    frame[base + 42] = 99
    for pixel in range(10):
        for color in range(4):
            frame[base + 2 + pixel * 4 + color] = 10 * pixel + color + 1

mapped = map_comb_rig_orientation(bytes(frame))
assert mapped[0] == 77
for start in COMB_START_CHANNELS:
    base = start - 1
    assert mapped[base] == 238
    assert mapped[base + 1] == 23
    assert mapped[base + 42] == 99
    for pixel in range(10):
        for color in range(4):
            assert mapped[base + 2 + pixel * 4 + color] == 10 * (9 - pixel) + color + 1

zero = map_comb_rig_orientation(bytes(512))
for start in COMB_START_CHANNELS:
    assert zero[start - 1] == 127

print("comb orientation: 4/4 OK")
