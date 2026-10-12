---
name: "merge"
description: "Мерджить схвалений PR після повторної перевірки гейту (ai:reviewed без нових пушів, Approve людини на поточному коміті, зелений CI), видаляє гілку і закриває задачу. Використовувати лише за командою диспетчера agent-flow або коли людина прямо просить «змерджи PR #N»."
---

# Мердж схваленого PR

## Крок 0. Дані

`REPO`, `PR`, `ISSUE` (може бути відсутнім) — з першого рядка запиту.

```bash
gh pr view $PR -R "$REPO" --json state,isDraft,mergeable,headRefName,headRefOid,labels,reviews,closingIssuesReferences
```

## Крок 1. Перевір гейт заново

Диспетчер перевіряв гейт до запуску, але стан міг змінитися. Перевір кожну умову сам:

1. Стан `OPEN`, не draft, `mergeable` ≠ `CONFLICTING`.
2. Є лейбл `ai:reviewed`, і після його встановлення не було комітів:
   ```bash
   gh api "repos/$REPO/issues/$PR/timeline" --paginate \
     -q '.[] | select(.event=="committed" or .event=="head_ref_force_pushed" or (.event=="labeled" and .label.name=="ai:reviewed")) | {event, at: (.created_at // .committer.date)}'
   ```
   Останній `labeled ai:reviewed` має бути пізнішим за останній коміт / force-push.
3. Останній відгук людини зі списку дозволених — `APPROVED`, і його `commit_id` == `headRefOid`.
4. `gh pr checks $PR -R "$REPO"` — жодної червоної або незавершеної перевірки (перевірок немає зовсім — ок).

Хоч одна умова не виконана — коментар зі списком того, чого бракує, і **зупинись без дій**.

## Крок 2. Мердж

```bash
gh pr merge $PR -R "$REPO" --squash --delete-branch
```

Гілки `ai/<N>-spec-mockup` **не видаляй**: на них посилаються картинки в коментарі зі специфікацією.

## Крок 3. Задача

Для кожного issue з `closingIssuesReferences` (або `ISSUE` із запиту):

```bash
gh issue view <N> -R "$REPO" --json state -q .state
```

Ще відкрите — `gh issue close <N> -R "$REPO" --reason completed`. Підсумковий коментар у issue:

```markdown
## ✅ Змерджено

PR #<PR> змерджено (squash), гілку видалено.

<sub>🤖 Мердж</sub>
```

## Заборонено

Мерджити з будь-якою невиконаною умовою, обходити хуки проєкту (`--admin`, `--no-verify`),
видаляти інші гілки, крім гілки цього PR.
