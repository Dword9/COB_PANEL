import json
import re
import urllib.request
import urllib.error

CFG_PATH = r"C:\Users\Dword\.config\opencode\opencode.jsonc"

def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    clean = strip_jsonc_comments(text)
    return json.loads(clean)


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
                # line comment: skip to end of line
                while i < len(text) and text[i] not in "\r\n":
                    i += 1
                continue
            if text[i + 1] == "*":
                # block comment: skip until */
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

def main():
    cfg = load_config(CFG_PATH)
    nr = cfg.get("provider", {}).get("nordrouter", {})
    opts = nr.get("options", {})
    base = opts.get("baseURL", "https://nordrouter.com/v1").rstrip("/")
    key = opts.get("apiKey", "")
    models = list(nr.get("models", {}).keys())

    print("=== NordRouter model check ===")
    print("Provider:", base)
    print("Models in config:", len(models))
    print()

    if not key:
        print("ERROR: API key not found in config")
        return

    # 1. Try /models endpoint (free)
    print("1) Checking /models endpoint...")
    try:
        req = urllib.request.Request(
            f"{base}/models",
            headers={"Authorization": f"Bearer {key}"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        available = [m.get("id") for m in data.get("data", [])]
        print("   Available models:", len(available))
        for m in models:
            status = "OK" if m in available else "NOT LISTED"
            print(f"   [{status}] {m}")
        print()
        print("Done (used free /models endpoint).")
        return
    except Exception as e:
        print("   /models failed:", e)
        print("   Will do cheap test calls instead.")

    # 2. Cheap per-model test
    print()
    print("2) Testing each model with a cheap call...")
    for m in models:
        body = {
            "model": m,
            "messages": [{"role": "user", "content": "Hi"}],
            "max_tokens": 1
        }
        req = urllib.request.Request(
            f"{base}/chat/completions",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
            usage = data.get("usage", {})
            cost = usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
            print(f"   [OK] {m}  tokens={cost}")
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:120]
            print(f"   [FAIL] {m}  HTTP {e.code}: {err}")
        except Exception as e:
            print(f"   [FAIL] {m}  {e}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
