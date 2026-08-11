# -*- coding: utf-8 -*-
"""
Разовое восстановление имён в медиатеке из сохранённых проектов (27.07).

Файлы в media/stems/ лежат под sha256-именами, а проекты (projects/*.json)
помнят связь url -> настоящее имя (audioName/analysisName у midi-track,
fileName у треков stems). Скрипт вычитывает все проекты и заполняет
media/stems/index.json. Имена, которые уже есть в индексе, НЕ затирает.

ВНИМАНИЕ: сервер держит индекс в памяти — после скрипта перезапустите его,
иначе он перезапишет индекс своим устаревшим кэшем при следующей заливке.

Запуск: tools\wing\venv\Scripts\python.exe tools\backfill_stems_index.py
"""
import glob
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEMS = os.path.join(ROOT, "media", "stems")
INDEX = os.path.join(STEMS, "index.json")
PROJECTS = os.path.join(ROOT, "projects")


def load_index():
    try:
        with open(INDEX, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


idx = load_index()
added = 0
skipped_existing = 0


def remember(url, name):
    global added, skipped_existing
    if not url or not name:
        return
    stored = url.rsplit("/", 1)[-1]
    path = os.path.join(STEMS, stored)
    if not stored or not os.path.isfile(path):
        return
    meta = idx.get(stored) or {}
    if meta.get("name"):
        skipped_existing += 1
        return
    meta.update({"name": name, "size": os.path.getsize(path), "ts": 0})
    idx[stored] = meta
    added += 1
    print(f"  {stored[:16]}… <- {name}")


def walk(obj):
    if isinstance(obj, dict):
        params = obj.get("params")
        if isinstance(params, dict):
            remember(params.get("audioUrl"), params.get("audioName"))
            remember(params.get("analysisUrl"), params.get("analysisName"))
            tracks = params.get("tracks")
            if isinstance(tracks, list):
                for t in tracks:
                    if isinstance(t, dict):
                        remember(t.get("url"), t.get("fileName"))
        for v in obj.values():
            walk(v)
    elif isinstance(obj, list):
        for v in obj:
            walk(v)


for path in sorted(glob.glob(os.path.join(PROJECTS, "*.json"))):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"пропуск {os.path.basename(path)}: {e}")
        continue
    print(f"читаю {os.path.basename(path)}")
    walk(data)

tmp = INDEX + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(idx, f, ensure_ascii=False, indent=1)
os.replace(tmp, INDEX)
print(f"\nготово: записей в индексе {len(idx)}, добавлено {added}, уже с именем {skipped_existing}")
print("ТЕПЕРЬ ПЕРЕЗАПУСТИТЕ СЕРВЕР — он держит индекс в памяти")
