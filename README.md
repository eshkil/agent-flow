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
   і коментар із посиланням на запуск.

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
   `ubuntu-latest`), `AGENT_DRY_RUN=1` на час перевірки.
4. Скопіюй `templates/agent.yml` у `.github/workflows/agent.yml` і заповни блок STACK.
   Job `review-reset` у шаблоні знімає `ai:reviewed` на кожен пуш у PR — не видаляй його:
   на ньому тримається гейт мерджу.

Завис `agent:running` (у журналі Actions немає активного запуску) — зніми лейбл
вручну й постав сигнал знову.

## Локально в Claude Code

```bash
claude plugin marketplace add eshkil/agent-flow
claude plugin install agent-flow@agent-flow
```

## Тести

```bash
npm test
```
