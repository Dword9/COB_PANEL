# Аудит: противоречия, дубликаты, недоделки

Ревизия кодовой базы и документации **на 16.08.2026** (HEAD `bf000e9`).
Сверено по коду, не по комментариям. Ничего не исправлено — только инвентарь.

---

## 1. Противоречия (док ↔ код)

### 1.1 Устаревшие ссылки на удалённые файлы
`docs/reactive-light-midi.md` (стр. 97–106, 149, 439) и `docs/REFACTORING.md`
(Волны 1–3) описывают как существующие файлы **StemNode, PannerNode,
`stemAudioManager.ts`**. Факт: они удалены 27.07 (`DEV-NOTES.md:1259`),
в `web/services/` их нет, `git log` их не содержит.
→ `reactive-light-midi.md` и `REFACTORING.md` устарели относительно кода.

### 1.2 Несуществующие role-шины
`docs/reactive-light-midi.md` (таблица «Выходы по ролям»: kick/snare/hats/bass/
harmony/lead/all) — в коде midi-track таких выходов НЕТ. У ноды только
`out-0..out-3` (`web/nodes/MidiTrackNode.tsx:240-247`).
→ Старая дока вводит в заблуждение; `docs/NODES.md` фиксирует факт.

### 1.3 Статус «ПРОЕКТ (не кодим)» при написанном коде
`docs/panel-console-impl.md` помечен «Статус: ПРОЕКТ (не кодим)», но движок
`console_engine.py` написан, закоммичен (`58ef43a`), подключён к серверу
(`server_v4.py:1853, 2579`) и имеет незакоммиченные правки юзера.
→ Заголовок статуса противоречит факту.

### 1.4 Нереализованная функциональность, описанная как направление
`docs/ai_event_director_concept.md` и `docs/implementation_plan.md` описывают
«двухрежимное голосовое управление» (OpenRouter/Claude/GPT, локальная
Qwen 3.6 MoE, LM Studio :1234). В `server_v4.py` нет `api/voice` и подобного.
Утверждённое направление — `docs/track-director-architecture.md`.
→ Две концепт-доки фактически вытеснены, но остаются в дереве и путают.

### 1.5 Физика рига vs дефолты проекта
`docs/rig-sozvezdie.md` / `docs/fixture-map.md`: физически **2 COB на одном
адресе 200** (план расширения — 4). А `INITIAL_FIXTURES`
(`web/constants.ts:84-99`) уже содержит **4 ноды COB (200/208/216/224) +
4 mini_par (422/429/436/443)**. Кнопка «Add All Missing Fixtures» создаст
приборы, которых на сцене нет (плюс spider/spark/laser с полки).
→ Карта рига и дефолты проекта расходятся.

### 1.6 Мёртвый ключ `decay` в дефолтах audio
`App.tsx:943` — `{ gain: 1, gate: 0, decay: 0 }`, движок читает только
`decaySmoothing`/`attackSmoothing` (`graphEngine.ts:373-428`). Тот же неверный
`decay` — в стартовом проекте (`App.tsx:654`). Дефолт не влияет на поведение,
но UI/доки видят несуществующий параметр.

### 1.7 Runtime-состояние в git непоследовательно
`scenes_store.json` и `routing_store.json` — в `.gitignore` (рантайм).
`wing_depot.json` (рантайм-депо крыла, `server_v4.py:1619`) — **в git**,
содержит стейдж `{"playback":{}}`. Политика «рантайм не коммитим» нарушена.

---

## 2. Излишний / дублирующийся функционал

### 2.1 `audioConfigs`/`AudioReactiveConfig` — мёртвый груз
Интерфейс `types.ts:18-36`; генератор `createDefaultAudioConfig()` вызывается
для КАЖДОГО прибора в `INITIAL_FIXTURES` (`constants.ts:38,49-99`) — сотни
строк бойлерплейта. Чтений нет: 0 совпадений в `web/nodes` и
`web/components`. Док уже помечает как мёртвый (`reactive-light-midi.md:133`).
→ Кандидат на удаление (интерфейс + генератор + поле в фикстурах).

### 2.2 comb-controller vs midi-track — оба пишут расчёски
Обе ноды пишут каналы расчёсок (250/293/336/379, 43ch) через HTP-max
(`graphEngine.ts:976-994` и `498-682`). Это осознанная «автономная» замена
(`reactive-light-midi.md:242-250`), но при двух активных нодах в одном проекте
— борьба на каналах через max-merge. Нужна явная фиксация правила
«используем что-то одно» либо взаимное исключение.

### 2.3 KKZ-клиент захардкожен в двух местах
`web/nodes/KkzNode.tsx` (url/pin в params) и `web/electron/main.cjs:75-76`
(трей). Одинаковый HTTP-клиент (`api/batch`, `api/status`, X-Pin, таймаут 4с)
реализован дважды. Смена сервера/PIN = две ручные правки.
→ **ИСПРАВЛЕНО 16.08**: общий модуль `web/electron/kkz-client.mjs`
(`KKZ_URL`/`KKZ_PIN`/`kkzFetch`), его используют нода, трей (`main.cjs` через
динамический `import()`) и дефолт создания ноды в `App.tsx`. Проверено:
`tsc --noEmit` чистый, `vite build` OK (URL в бандле один раз), реальный
`/api/status` через общий клиент отвечает.

### 2.4 Шесть точек запуска сервера
`run_server.bat`, `run_server_debug.bat`, `run_server_hidden.bat`,
`lumina_control.bat`, `start_server_task.bat`, `stop_server_task.bat` —
частично дублируют друг друга (различие — флаги `LUMINA_SERVICE`/
`LUMINA_WS_LOG` и способ запуска). Возможна консолидация.

### 2.5 `web/metadata.json`
Закоммичен, нигде не читается (grep по `requestFramePermissions` — только сам
файл). Устаревшая метадата.

### 2.6 Корневой `index.html`
«Mini Wing 6 Web Avatar» (1504 строки), закоммичен. Сервер раздаёт только
`web/dist/index.html` и `web/visual/index.html` (`server_v4.py:48,87,2520`);
React-панели его не используют. Устаревший стендалон-аватар крыла.

### 2.7 Три реализации LFO/двига лучей
`generator` (`graphEngine.ts:441-496`), `comb-controller` (фаза+синус, `:498-682`),
`lightEngine` midi-track (`lightEngine.ts`) — каждая со своим набором
параметров скорости/фазы/огибающей. Частично перекрываются.

---

## 3. Недоделки / риски

### 3.1 Untracked-артефакты, не покрытые `.gitignore`
`web_ui_data/` в корне (analysis/export/lyrics/midi/rendered/uploads) —
остаток старого пайплайна; сервер пишет в `..\music 2 midi\web_ui_data`
(`server_v4.py:927`), а не в корневой. В `.gitignore` только
`music 2 midi/web_ui_data/`. Плюс `kkz-button-src/` и `kkz-button.zip`
(untracked). **`git add -A` подметёт всё это в коммит.**
→ В `.gitignore` добавить `web_ui_data/`, `kkz-button-src/`, `*.zip`.

### 3.2 Хардкод пути в автозапуске
`install_autostart.ps1` зашивает `N:\python_ide\DMX-ART-L`; при переносе
проекта планировщик `LuminaDMX` молча сломается. Кандидат: вычислять путь от
`$PSScriptRoot`.

### 3.3 Статусы документации
Обновить заголовки: `panel-console-impl.md` (статус «реализовано»),
`reactive-light-midi.md` / `REFACTORING.md` (пометка о расхождении с кодом),
`ai_event_director_concept.md` / `implementation_plan.md` (пометка
«не реализовано / вытеснено»).

### 3.4 Устаревшая физика наклона в старых текстах
`reactive-light-midi.md` (24.07, «центр 128 ± 90» и т.п.) — до калибровки
`tiltGuard`. Физика уточнена 27–28.07 (0 = в зал, 128 = вверх, 255 = внутрь
сцены). Старые цифры не удалять молча, а пометить ссылкой на калибровку.

---

## Примечание к методу

Каждый пункт сверен с кодом на момент аудита (пути:строка указаны).
Направление исправлений согласуется отдельно: начать предлагается с
безрисковых (`.gitignore`, статусы доков, пометка `audioConfigs`).
