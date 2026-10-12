// Збирає з GitHub усе, що потрібно route(): мітки, повʼязаний PR, відгуки,
// timeline, checks і коментарі. Жодних рішень тут — лише факти.

const SIGNATURE = '<sub>🤖';
// Підпис службових коментарів диспетчера (відмови, «вже працює», dry run, збій).
const DISPATCHER_SIGNATURE = '<sub>🤖 agent-flow</sub>';
const TRIAGE_HEADER = '## 🔍 Тріаж';
const QUESTIONS = '❓ Потрібно уточнити';

const LINKED_PRS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        nodes { number state updatedAt }
      }
    }
  }
}`;

const names = labels => (labels || []).map(l => (typeof l === 'string' ? l : l.name));
const ts = s => (s ? Date.parse(s) : null);

function isAgentComment(c, agentLogin) {
  return c.user?.login === agentLogin || (c.body || '').includes(SIGNATURE);
}

const isServiceComment = c => (c.body || '').includes(DISPATCHER_SIGNATURE);

// Як linkedPr у Kando: відкритий, інакше змерджений, інакше найсвіжіший.
const RANK = { OPEN: 0, MERGED: 1, CLOSED: 2 };
function pickLinkedPr(nodes) {
  if (!nodes.length) return null;
  return [...nodes].sort((a, b) => (RANK[a.state] - RANK[b.state]) || (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)))[0].number;
}

function latestApprovals(reviews) {
  const last = new Map();
  for (const r of [...reviews].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))) {
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue; // коментар не скасовує схвалення
    last.set(r.user.login, r);
  }
  return [...last.values()]
    .filter(r => r.state === 'APPROVED')
    .map(r => ({ login: r.user.login, commitId: r.commit_id }));
}

// Час коміту, а не пушу: committer.date — це час створення коміту. Надійний захист
// від пушу після ai:reviewed — окремий job у workflow, що знімає ai:reviewed на
// pull_request synchronize; ця перевірка — додаткова.
function pushAndReviewTimes(timeline) {
  let lastPushAt = null;
  let reviewedLabelAt = null;
  const later = (a, b) => (a === null || b > a ? b : a);
  for (const e of timeline) {
    if (e.event === 'committed' && e.committer?.date) lastPushAt = later(lastPushAt, ts(e.committer.date));
    if (e.event === 'head_ref_force_pushed') lastPushAt = later(lastPushAt, ts(e.created_at));
    if (e.event === 'labeled' && e.label?.name === 'ai:reviewed') reviewedLabelAt = later(reviewedLabelAt, ts(e.created_at));
  }
  return { lastPushAt, reviewedLabelAt };
}

function summarizeChecks(checkRuns, combined) {
  const states = checkRuns.map(r => (r.status !== 'completed' ? 'pending'
    : ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion) ? 'failure' : 'success'));
  if (combined.statuses?.length) states.push(combined.state === 'success' ? 'success' : combined.state === 'pending' ? 'pending' : 'failure');
  if (!states.length) return 'none';
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  return 'success';
}

// Власний run агента (ownRunId) не рахується як перевірка: інакше його in_progress
// тримає checks у pending назавжди й гейт мерджу ніколи не пройде.
function withoutOwnRun(checkRuns, ownRunId) {
  if (ownRunId == null) return checkRuns;
  const marker = `/actions/runs/${ownRunId}/`;
  return checkRuns.filter(r => !(r.details_url || '').includes(marker));
}

async function loadPr(gh, repo, number, ownRunId) {
  const p = await gh.rest(`/repos/${repo}/pulls/${number}`);
  const [reviews, timeline, runs, combined] = await Promise.all([
    gh.restAll(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    gh.restAll(`/repos/${repo}/issues/${number}/timeline?per_page=100`),
    gh.rest(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`),
    gh.rest(`/repos/${repo}/commits/${p.head.sha}/status`),
  ]);
  const info = {
    number: p.number,
    state: p.merged ? 'merged' : p.state,
    labels: names(p.labels),
    draft: Boolean(p.draft),
    mergeable: p.mergeable === false ? 'CONFLICTING' : p.mergeable === true ? 'MERGEABLE' : 'UNKNOWN',
    headSha: p.head.sha,
    ...pushAndReviewTimes(timeline),
    approvals: latestApprovals(reviews),
    checks: summarizeChecks(withoutOwnRun(runs.check_runs || [], ownRunId), combined || {}),
  };
  return { info, reviews };
}

async function gather({ repo, kind, number, agentLogin, allowedUsers, ownRunId }, gh) {
  const [owner, name] = repo.split('/');
  const item = await gh.rest(`/repos/${repo}/issues/${number}`);

  let prNumber = null;
  if (kind === 'pr') {
    prNumber = number;
  } else {
    const data = await gh.graphql(LINKED_PRS, { owner, name, number });
    prNumber = pickLinkedPr(data.repository.issue.closedByPullRequestsReferences.nodes);
  }
  const loaded = prNumber ? await loadPr(gh, repo, prNumber, ownRunId) : null;
  const pr = loaded ? loaded.info : null;

  // Обговорення задачі: issue, а для PR — ще його розмова й коментарі до рядків.
  const comments = [...await gh.restAll(`/repos/${repo}/issues/${number}/comments?per_page=100`)];
  if (pr) {
    if (pr.number !== number) comments.push(...await gh.restAll(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`));
    comments.push(...await gh.restAll(`/repos/${repo}/pulls/${pr.number}/comments?per_page=100`));
    // Тіло рев'ю («перейменуй» у Request changes / Comment) — теж відгук людини.
    for (const r of loaded.reviews) {
      if (r.state === 'PENDING' || !(r.body || '').trim()) continue;
      comments.push({ user: r.user, body: r.body, created_at: r.submitted_at });
    }
  }
  comments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const isHuman = c => allowedUsers.includes(c.user?.login) && !isAgentComment(c, agentLogin);
  // Службові коментарі диспетчера не людські, але й не межа відгуку: інакше відмова
  // («агент уже працює», збій) відсікла б раніше написаний відгук людини.
  const lastAgent = comments.filter(c => isAgentComment(c, agentLogin) && !isServiceComment(c)).pop();
  const since = lastAgent ? Date.parse(lastAgent.created_at) : -Infinity;
  const humanFeedback = comments.some(c => isHuman(c) && Date.parse(c.created_at) > since);

  const lastTriage = comments.filter(c => (c.body || '').includes(TRIAGE_HEADER)).pop();
  const openQuestions = Boolean(lastTriage && lastTriage.body.includes(QUESTIONS)
    && !comments.some(c => isHuman(c) && Date.parse(c.created_at) > Date.parse(lastTriage.created_at)));

  return {
    kind, number,
    closed: item.state !== 'open',
    labels: names(item.labels),
    pr, openQuestions, humanFeedback,
  };
}

module.exports = { gather, isAgentComment, DISPATCHER_SIGNATURE };
