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
   (`claude-opus-5-5`, `opus`, …; порожньо — модель Claude Code за замовчуванням
   для підписки, зараз це Sonnet).
4. Скопіюй `templates/agent.yml` у `.github/workflows/agent.yml` і заповни блок STACK.
   Job `review-reset` у шаблоні знімає `ai:reviewed` на кожен пуш у PR — не видаляй його:
   на ньому тримається гейт мерджу.

Завис `agent:running` (у журналі Actions немає активного запуску) — зніми лейбл
вручну й постав сигнал знову.

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
