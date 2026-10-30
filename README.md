# agent-flow

Диспетчер агентного флоу для GitHub-дощок Kando: лейбл `agent:go` / `agent:rework`
від людини запускає потрібний скіл Claude Code. Специфікація —
`eshkil/kando-board: docs/superpowers/specs/2026-10-10-agent-flow-design.md`.

## Як це працює

1. Людина ставить `agent:go` («далі») або `agent:rework` («переробити», з коментарем)
   на issue чи PR.
2. Диспетчер (`src/main.js`) перевіряє відправника, збирає стан задачі, визначає етап
   і ставить `agent:running`. Недоречний сигнал отримує коментар-пояснення.
3. `anthropics/claude-code-action` запускає скіл із плагіна `plugin/`.
4. `src/finish.js` знімає `agent:running`; при збої чи таймауті ставить `ai:failed`
   і коментар із посиланням на запуск. Якщо Claude завершився «успішно», а скіл не зняв
   `ai:in-progress` (сесія обірвалась посеред кроку), — теж `ai:failed` і коментар.
   Якщо запуск зупинився на ліміті підписки Claude, поруч з `ai:failed` ставиться
   `ai:limit`, а коментар каже «ліміт Claude, відновлення …» (див.
   [Стан ліміту Claude](#стан-ліміту-claude)). Наступний запуск знімає обидва лейбли.

| Етап | `agent:go` | `agent:rework` |
|---|---|---|
| Нові | triage | triage |
| Розглянуто | фіча → feature-spec, баг → bug-agent | triage |
| Спека на рев'ю | — (схвалення: `spec:approved`) | feature-spec |
| Спеку схвалено | implement | feature-spec |
| На рев'ю | pr-review | pr-fix |
| Рев'ю зроблено | merge (Approve + `ai:reviewed` + зелений CI) | pr-fix |

## Підключення репозиторію

1. Встанови GitHub App **eshkil-agent** на репозиторій.
2. Секрети: `AGENT_APP_ID`, `AGENT_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`.
3. Змінні: `AGENT_LOGIN`, `AGENT_USER_ID`; опційно `AGENT_ALLOWED_USERS`
   (через кому; порожньо — власник репо), `AGENT_RUNS_ON` (за замовчуванням
   `ubuntu-latest`), `AGENT_DRY_RUN=1` на час перевірки, `AGENT_MODEL` — модель Claude
   (див. «Модель Claude»).
4. Скопіюй `templates/agent.yml` у `.github/workflows/agent.yml` і заповни блок STACK.
   Job `review-reset` у шаблоні знімає `ai:reviewed` на кожен пуш у PR — не видаляй його:
   на ньому тримається гейт мерджу.

Завис `agent:running` (у журналі Actions немає активного запуску) — зніми лейбл
вручну й постав сигнал знову.

## Режим C (Kando)

Режим, у якому запуск агента ініціює сам Kando, а не лейбл у GitHub: Kando викликає
workflow `kando-agent.yml` через `workflow_dispatch`, а раннер `eshkil/agent-flow/runner@v2`
міняє OIDC-токен Actions на токен GitHub App (обмежений одним репо) і промпт, запускає
Claude Code з плагіном скілів, раз на хвилину шле heartbeat (він же оновлює токен) і в кінці
доповідає Kando підсумок (успіх, збій, ліміт Claude, завислий `ai:in-progress`).
Лейблами й коментарями після запуску керує Kando. Режим A (`eshkil/agent-flow@v1`) не змінено.

Підключення:

1. Скопіюй `templates/kando-agent.yml` у `.github/workflows/kando-agent.yml` на default-гілці
   (Kando приймає токени лише з неї). Назву файлу не змінюй.
2. Секрет репо: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) або `ANTHROPIC_API_KEY`.
   Секретів GitHub App у репо не потрібно: токен видає Kando.
3. Середовище агента опиши в `.kando/agent.yml` у корені репо:

| Ключ | Що робить |
|---|---|
| `node` | версія Node для `actions/setup-node` (напр. `'22'`) |
| `java` | версія JDK Temurin для `actions/setup-java` (напр. `'21'`) |
| `python` | версія Python для `actions/setup-python` (напр. `'3.12'`) |
| `setup` | список shell-команд, кожна окремим `bash -e` після checkout (напр. `npm ci`) |

Kando читає цей файл і передає в workflow як input `env`. Версії беруться з файлу, а не з
workflow, щоб їх міняв автор репо без правок CI.

Файли поза git (`.env`, `google-services.json` тощо) лежать у секреті репо `KANDO_FILES` —
JSON `{"<шлях>": "<вміст у base64>"}`; його створює майстер онбордингу в Kando. Workflow
передає секрет у необов'язковий input `files` (`files: ${{ secrets.KANDO_FILES }}`), а крок
`files` раннера пише файли в робочу копію **до** `setup` з правами `0600`. Шляхи лише
відносні й усередині репо: `..`, абсолютні, зворотний слеш, `.git/` та symlink-и назовні
відхиляються, причому до запису жодного файлу. У лог ідуть тільки шляхи, значення секрету
й base64 не друкуються навіть у помилках. Без секрету (порожній input) крок нічого не робить,
тож старі `kando-agent.yml` працюють як були.

Усередині запуску `gh` і `git` автоматично користуються актуальним токеном (його оновлює
heartbeat): `bin/gh` підставляє токен з файлу, `bin/git-credential-kando` віддає його лише
для `github.com`. Скіли, що лишають PR як draft, пишуть причину в тіло PR маркером
`<!-- kando:draft-reason: … -->`.

## Модель Claude

`AGENT_MODEL` — одна модель для всіх скілів (`claude-opus-5-5`, `opus`, …) або модель
за замовчуванням плюс перевизначення `скіл=модель` через кому:

```
claude-opus-5-5, triage=claude-sonnet-5-5, pr-review=claude-sonnet-5-5
```

Скіли: `triage`, `feature-spec`, `implement`, `bug-agent`, `pr-review`, `pr-fix`, `merge`.
Без моделі за замовчуванням решта скілів іде на модель Claude Code за замовчуванням для
підписки (зараз Sonnet); порожня змінна — так для всіх. Помилка у змінній (невідомий скіл,
дві моделі за замовчуванням) — диспетчер пише коментар і не запускає Claude. Dry run
називає модель, яку взяв би.

## Стан ліміту Claude

`src/finish.js` розпізнає ліміт підписки з журналу сесії, що вже відбулася
(`execution_file` claude-code-action, подія `rate_limit_event` зі `status: "rejected"`
і `resetsAt`). Жодних додаткових запитів до Claude немає. При збої в журнал запуску
пишеться група «Ліміт Claude у журналі сесії» — лише службові повідомлення про ліміт,
без тексту сесії.

Щоб Kando показував бейдж ліміту на дошці, задай у репо змінну `AGENT_STATUS_URL`
(`https://<kando>/api/github/agent-status`) і секрет `AGENT_STATUS_SECRET` (той самий,
що в Kando) та передай їх у дію:

```yaml
      - uses: eshkil/agent-flow@v1
        with:
          # …
          status_url: ${{ vars.AGENT_STATUS_URL }}
          status_secret: ${{ secrets.AGENT_STATUS_SECRET }}
          timezone: Europe/Kyiv   # для часу в коментарі ai:failed; за замовчуванням UTC
```

Після запуску, де Claude справді стартував, дія шле `POST status_url` з тілом
`{ts, repo, status: "ok" | "limit", until?}` і заголовком
`X-Agent-Signature-256: sha256=<HMAC-SHA256 сирого тіла>`:

- `ok` — після успішного запуску;
- `limit` — коли ліміт розпізнано; `until` — лише якщо час відновлення відомий (без нього
  Kando показує «ліміт вичерпано», доки не прийде наступний `ok`);
- інші збої стан не змінюють.

Таймаут запиту — 10 с; помилка відправки лише пишеться в журнал і не впливає на `ai:failed`.
Без `status_url` дія поводиться як раніше. Виходи дії `limit_reached` і `limit_until` —
для власної реакції в workflow.

## Локально в Claude Code

```bash
claude plugin marketplace add eshkil/agent-flow
claude plugin install agent-flow@agent-flow
```

## Тести

```bash
npm test
```
