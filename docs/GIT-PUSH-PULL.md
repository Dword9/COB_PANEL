# GIT-PUSH-PULL — механический алгоритм работы с репо DMX-ART-L

ОБЯЗАТЕЛЬНО прочитать перед любой git-операцией. Работать только отсюда, не «думать» — выполнять по шагам.

## 1. Карта ремоутов (три зеркала)

| remote | URL | ветка для пуша | куда |
|--------|-----|----------------|------|
| `origin` | https://github.com/Dword9/lumina-dmx | `DWORD` (основная рабочая по умолчанию) | GitHub, главный |
| `github` | https://github.com/Dword9/COB_PANEL | `master` | GitHub, зеркало COB-панели |
| `gitflic` | https://gitflic.ru/project/fedototovaleksandr/cob-panel | `master` | GitFlic, зеркало COB-панели |

- `origin/main` — старый снимок, НЕ трогать, слияние только через PR.
- Зеркала `github` и `gitflic` — односторонняя выгрузка состояния (слепок), обратно не тянуть.

## 2. Токены (НЕ в коде, НЕ в коммитах)

- Единый источник: `N:\python_ide\DMX-ART-L\xxx0.txt` — **GITIGNORED (xxx*.txt)**, в коммиты не попадает.
- **github.com — ОДИН fine-grained PAT** на все репо Dword9 (All repositories, Contents read+write). Хранится generic-кредом в Windows Credential Manager + `~/.git-credentials`.
- **gitflic** — свой токен, в `~/.git-credentials` (host gitflic.ru).
- Восстановление кредов — см. п.6.

## 3. Пуш (быстрая процедура, по порядку)

```powershell
# 1. проверить стейдж
git status --short

# 2. убедиться, что токены/секреты не попадут (должно быть пусто)
git status --short | Select-String "github_pat|xxx0"

# 3. закоммитить (имя: <ДД.ММ>: <краткое содержание>)
git add -A
git commit -m "15.08: <краткое содержание>"

# 4. главный ремоут (по умолчанию пушим в ветку DWORD, если юзер не укажет иное)
git push origin HEAD:DWORD

# 5-6. зеркала COB-панели (ТОЛЬКО если правилась панель/сервер COB: COB_5_v3.0.html, server_v4.py и т.п.)
git push github HEAD:master
git push gitflic HEAD:master

# 7. контроль: рабочее дерево чистое
git status --short

# 8. контроль: все три ремоута на одном коммите
git ls-remote origin DWORD
git ls-remote github master
git ls-remote gitflic master
```

## 4. Правило светофора (когда пушить)

- 🔴 **КРАСНЫЙ** (критические изменения: ломают текущую работу юзера, боевые сервисы/данные, рефакторинг, где дебажить дороже) — **пушить АВТОМАТИЧЕСКИ**, сразу после проверок, без вопросов.
- 🟡 **ЖЁЛТЫЙ** (важные, но откатиться проще) — **спросить юзера** («пушить?»), ждать ответа.
- 🟢 **ЗЕЛЁНЫЙ** (мелочь) — не пушить.

Именование коммитов: `<ДД.ММ>: <суть одним-двумя словами>`. Один коммит = один логический срез. Перед коммитом файлы крупнее ~2 МБ не пушим.

## 5. Пулл / обновление

```powershell
git pull origin DWORD
```

Зеркала (github/gitflic) не пулить обратно — это выгрузка, не источник.

## 6. Восстановление кредов (если слетели/403)

```powershell
# github (значение взять из xxx0.txt, строка с меткой github)
$tok = "<github_pat_...>"
"protocol=https`nhost=github.com`nusername=oauth2`npassword=$tok`n" | git credential approve

# gitflic (значение из xxx0.txt, строка с меткой gitflic)
$tok = "<...>"
"protocol=https`nhost=gitflic.ru`nusername=oauth2`npassword=$tok`n" | git credential approve
```

Проверка: `git push origin HEAD:DWORD` → «Everything up-to-date» (значит аутентификация ок).

## 7. ГРАБЛИ (запомнить — 15.08)

1. **git-credential-store матчит ТОЛЬКО по хосту**, не по пути. Два разных токена на один хост `github.com` развести нельзя — вернётся первый записанный. Держи ОДИН токен на хост.
2. **Токен, вставленный в URL ремоута** (`https://oauth2:TOKEN@host/...`), при каждом пуше **перезаписывается в credential-хелперы** и затирает общий кред хоста (ломает другие репо этого хоста). **НЕ вставлять токены в URL ремоутов.**
3. `routing_store.json` — в .gitignore (рантайм-состояние), изменения туда не коммитятся, применяются на сервере.
4. Один коммит, дата первым числом; после пуша `git status --short` пуст.