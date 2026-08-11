import json
import re
import urllib.request

CFG_PATH = r"C:\Users\Dword\.config\opencode\opencode.jsonc"


def strip_jsonc_comments(text):
    result = []
    i = 0
    in_string = False
    escape = False
    while i < len(text):
        c = text[i]
        if in_string:
            result.append(c)
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            result.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < len(text):
            if text[i + 1] == "/":
                while i < len(text) and text[i] not in "\r\n":
                    i += 1
                continue
            if text[i + 1] == "*":
                i += 2
                while i + 1 < len(text):
                    if text[i] == "*" and text[i + 1] == "/":
                        i += 2
                        break
                    i += 1
                continue
        result.append(c)
        i += 1
    return "".join(result)


with open(CFG_PATH, "r", encoding="utf-8") as f:
    cfg = json.loads(strip_jsonc_comments(f.read()))

nr = cfg["provider"]["nordrouter"]
base = nr["options"]["baseURL"].rstrip("/")
key = nr["options"]["apiKey"]

req = urllib.request.Request(f"{base}/models", headers={"Authorization": f"Bearer {key}"})
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.loads(resp.read())

print("All Google models available on NordRouter:")
for m in sorted(x["id"] for x in data["data"]):
    if "google" in m.lower():
        print("  " + m)
