# Lumina DMX Control Center

Веб-интерфейс для системы реактивного управления световыми приборами по DMX/Art-Net.

## Что умеет

- Визуальный граф нод (React Flow): аудио, MIDI, генераторы, математика, приборы.
- Реактивное управление светом: аудиовход/стемы → DSP → приборы.
- Поддержка MIDI-контроллеров с learn-режимом и LED-фидбэком.
- Группы приборов и сценовые активаторы (solo-логика).
- Сохранение/загрузка проектов на сервер, автосейв в localStorage.
- Загрузка stem-файлов с дедупликацией по содержимому (SHA-256).
- Кастомный конструктор приборов.

## Стек

- React 19 + TypeScript (strict)
- React Flow (@xyflow/react) для нодового редактора
- Vite для сборки

## Запуск

Требуется Node.js.

```bash
cd web
npm install
npm run dev
```

Для production-сборки:

```bash
npm run build
```

Проверка типов:

```bash
npm run lint
```

## Связь с сервером

Фронтенд ожидает Python-сервер `server_v4.py` на `localhost:8000`. Сервер раздаёт статику из `web/dist` и предоставляет WebSocket `/ws` и REST API `/api/*`.

Запуск сервера (вручную, с консолью):

```bash
python server_v4.py
```

Или из проекта:

```bash
run_server.bat          # с консолью
run_server_hidden.bat   # без консоли, лог в logs/lumina_service.log
```

Автозапуск при входе в Windows (без окна, от имени администратора):

```bash
install_autostart_admin.bat
```

При запуске сервер автоматически соберёт фронтенд, если `web/dist/index.html` отсутствует.

## Структура

- `App.tsx` — корневой компонент, движок графа и циклы отправки DMX.
- `utils/graphEngine.ts` — топологическая сортировка и вычисление значений нод.
- `nodes/` — компоненты нод.
- `services/` — WebSocket/DMX, MIDI, аудио-менеджеры.
- `components/` — UI: шапка, сайдбар, менеджер проектов, контекстное меню.
- `constants.ts` — начальные приборы и DMX-раскладки.

## Проверка

```bash
npm run lint
python -m py_compile ../server_v4.py
```
