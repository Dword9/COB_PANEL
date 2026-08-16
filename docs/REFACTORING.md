# История рефакторинга и исправлений

> **ПОМЕТКА 16.08:** в Волнах 1–3 упоминаются ноды **StemNode / PannerNode
> и `stemAudioManager.ts`** — они УДАЛЕНЫ 27.07 (см. `DEV-NOTES.md`, раздел
> «НОДЫ stems И panner УДАЛЕНЫ ПОЛНОСТЮ»). Волны ниже — историческая запись,
> к текущему коду эти файлы отношения не имеют.

Документ фиксирует, что было оптимизировано и исправлено в проекте, чтобы другие
разработчики понимали, зачем сделаны эти изменения и какие ловушки уже закрыты.

## Контекст проекта

Lumina DMX — система реактивного управления световыми приборами (DMX/Art-Net):
аудио (вход или стемы) → граф нод (React Flow) → движок `graphEngine.ts` →
Art-Net → сервер `server_v4.py` → свет. Изначально планировалась связка
«Python играет музыку → DSP-анализатор (melband_roformer) → нарезка на стемы»,
от неё отказались в пользу реактивного управления нодами и генераторов;
оставшееся «мёртвое» наследие вычищено (см. Волну 2).

Стек: фронтенд — React + TypeScript + React Flow + Zustand (`web/`), сборка Vite;
бэкенд — aiohttp (`server_v4.py`), раздаёт статику из `web/dist` и WebSocket API.
Десктопная оболочка — Electron (`web/electron/`): тонкий киоск-шелл без своих
зависимостей, грузит UI с `http://localhost:8000` (в dev — Vite :3000, HMR);
если бэкенд недоступен, показывает splash-экран с автоповтором и кнопкой
запуска задачи `LuminaDMX` Планировщика. Живёт в трее (закрытие/сворачивание
окна прячет в трей, выход — через меню трея), автозапуск с Windows включён
по умолчанию (галка в меню трея), при старте от Windows открывается скрыто.
Команды: `npm run electron:dev` (разработка без `vite build`),
`npm run electron` (прод-шелл), `npm run dist` (NSIS + portable в
`web/release/`). Лаунчеры в корне: `run_desktop.bat`, `run_desktop_dev.bat`.
Подробности и грабли — в `DEV-NOTES.md` в корне проекта.

Проверки после всех волн: `tsc --noEmit` — 0 ошибок (включён `"strict": true`),
`vite build` — успешно, синтаксис Python валиден. Живые тесты на железе
проводил владелец проекта.

---

## Волна 1 — критичные баги

1. **Загрузка стемов на сервер** (`server_v4.py`). `client_max_size`
   увеличен с 1 МБ до 4 ГиБ; загрузка переписана на потоковую: запись во
   временный `.part`-файл, проверка SHA-256, атомарный `os.replace`.
   Раньше стемы ~170 МБ просто не загружались.
2. **Мёртвое сглаживание Attack/Drop** (`graphEngine.ts`, case `'audio'`).
   Добавлено `node.data.values = outputs` — без этого `prev` навсегда оставался
   `[0,0,0]`, и сглаживание аудио-нод никогда не работало.
3. **Неправильный маппинг полос** (`graphEngine.ts`). Добавлены
   `resolveSourceIndex` + `BAND_INDEX` (low/mid/high/kick/snare/hihat → 0/1/2);
   `getInputsForNode`/`getInputsForHandle` теперь принимают `nodeMap`.
   Раньше `mid` и `high` фактически отдавали `low`. Обратная совместимость
   сохранена: числовые handle `stem-<n>` работают как раньше.
4. **Кастомные приборы из конструктора** (`graphEngine.ts`, fixture-ветка).
   Теперь `params.customLayout || FIXTURE_LAYOUTS[...]` — раньше любой
   пользовательский прибор работал как одноканальный диммер.
5. **F5 стирал проект** (`App.tsx`). Параметр `?reset=` снимается через
   `history.replaceState` после обработки — перезагрузка страницы больше
   не сбрасывает проект.
6. **Потеря финальных значений фейдеров** (`dmxClient.ts`). Троттлинг
   переписан на коалесцирование в `pending: Map<ch, val>` вместо молчаливого
   дропа пакетов — последнее значение фейдера гарантированно уходит
   (раньше терялось до 800 мс).
7. **Проводка ломалась при удалении треков** (`StemNode.tsx`). Handle-id
   теперь `stem-<track.id>` вместо индекса массива.
8. **Мёртвый визуализатор паннера** (`PannerNode.tsx`). Зависимости эффекта —
   `[id, totalLamps]`; раньше после добавления первого прибора визуализация
   переставала обновляться.

## Волна 2 — важные баги и вынос мёртвого наследия

**Удалены файлы** (наследие отменённой фичи «Python играет музыку → DSP»):
`web/components/Fader.tsx`, `web/services/midiWorker.ts`,
`web/components/StatusBadge.tsx`, `web/services/dspWsClient.ts`,
`midi_test.html`. Референсы вычищены из `App.tsx` (dspClient, DSP-listener),
`vite.config.ts` (define `GEMINI_API_KEY` + `loadEnv` — заодно закрыта утечка
ключа в бандл), `types.ts` (`Preset`), `Sidebar.tsx` /
`FixtureConstructor.tsx` (8 мёртвых импортов), `autoLayout.ts` (queue),
`PannerNode.tsx` (handleIdx/fixtureHandles).

**Исправления:**

- `midiService.terminate()` — полный сброс `access` / `isReady` /
  `isInitializing` / `_lastDeviceCount`. Раньше MIDI «умирал» после
  reconnect и React StrictMode.
- `ProjectManager.tsx` — `await` удаления перед refetch (гонка «проект
  воскрес»), confirm при перезаписи сохранения, блок ошибки сети с кнопкой
  «Повторить», `onDeleteSlot: (name) => Promise<void> | void`.
- `ContextMenu.tsx` — `structuredClone` при дублировании ноды (params больше
  не делятся между копиями); `findFreeStartChannel` подбирает первый
  свободный DMX-адрес для шаблонов (импорт `FIXTURE_LAYOUTS`); подменю
  фикстур закрывается по `mouseleave`.
- `inputAudioManager.ts` / `stemAudioManager.ts` (переписаны целиком) —
  generation-токены `setupToken` / `playToken` против гонок
  `setupLive`/`startPlayback`; Play в конце трека стартует с 0;
  переиспользование `Uint8Array` в горячих циклах анализа.

## Волна 3 — остаток бэклога

**Сервер (`server_v4.py`):** try/except в `ws_handler` (битое сообщение больше
не роняет WebSocket), `os.path.basename` в load/delete (защита от path
traversal), реально используется `FPS = 45`.

**Движок (`graphEngine.ts`):** кламп каналов 1–512 в fixture-ветке;
`targetGroup ?? 1` в midi-ветке; outputs comb-контроллера = [размах, скорость
Y, средняя яркость, строб] — handle `comb-0..3` ожили; `saturation` без
мёртвого `?? 1` (заработал `preset.sat`).

**Фронтенд:**

- `App.tsx` — дебаунс автосейва в localStorage 500 мс (убран тормоз при
  драге нод); добавлен `clearMonitorCallback` в `window.luminaMidi`
  (+ декларация в `types.ts`, метод в `midiService`).
- `MidiNode.tsx` — `useEdges` вместо `getEdges`; монитор оттроттлен до 10 Гц
  + `clearMonitorCallback` в cleanup; авто-init прекращается после отказа
  (`autoInitFailed`); кламп канала 1–16, группа `min=0`; MATCH считается из
  `lastValRef`.
- `GroupActivatorNode.tsx` — LED обновляется императивно через `ledRef`.
- `InputNode.tsx` — blob-URL ревокается; статус `'idle'` вместо вечного
  `'loading'`; `setCurrentTime` ~5 Гц; cleanup `offLevels`/`offBands`.
- `StemNode.tsx` — `onTime` ~10 Гц (мгновенно при паузе/стопе); cleanup
  `offLevels`/`offTime`. Off-методы добавлены в оба аудио-менеджера.
- `FixtureNode.tsx` — `useStore`-селекторы вместо `useEdges` (строки-ключи
  handle'ов); мутация `currentValuesRef` перенесена в `useEffect`;
  `layoutKey` в deps canvas-эффекта; поля CH/GRP через черновики
  `addrDraft`/`groupDraft` с клампом на blur.
- `GeneratorNode.tsx` — tap-tempo кламп 10–480 BPM.
- `Header.tsx` — `tempUrl` синкается при открытии; дропдаун закрывается по
  клику вне и по Esc (`settingsRef`); reset `value` у file-input.
- `FixtureConstructor.tsx` — валидация `startChannel + channels ≤ 512`;
  сброс состояния при открытии.
- `ContextMenu.tsx` — кламп позиции к viewport. `ButtonEdge.tsx` — `memo`.

## Волна 4 — строгий TypeScript

- В `web/tsconfig.json` включён `"strict": true`; установлены
  `@types/react` / `@types/react-dom` (без них strict давал ~940 ложных
  ошибок).
- `App.tsx` (`injectHandlers`, TS2783) — порядок spread: сначала
  `...(node.data || {})`, затем `label`/`type` с фолбэками, затем колбэки.
- `midiService.ts` (`onstatechange`, TS18047) — добавлена проверка
  `if (port && port.type === 'input')`.
- Итог: `tsc --noEmit` — 0 ошибок, `vite build` — успешно.

## Что сознательно НЕ трогали

- Мутация `params` во время драга слайдеров (осознанный компромисс ради
  отзывчивости UI; данные всё равно сериализуются при сохранении).
- Дуализм хранилища localStorage / сервер (требует продуктового решения,
  какое хранилище канонично).
- Отсутствие авторизации на сервере (предполагается работа в доверенной LAN).
- `AUTO_BUILD` при старте сервера (автосборка фронта — фича, а не баг).

## Как проверять

```bash
cd web
node node_modules/typescript/bin/tsc --noEmit   # типы, strict
node node_modules/vite/bin/vite.js build        # сборка в dist/
python -m py_compile ../server_v4.py            # синтаксис сервера
```
