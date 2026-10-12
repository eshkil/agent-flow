// Мінімальний клієнт GitHub API на глобальному fetch: action має працювати без npm install.

class GithubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createClient({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com' }) {
  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return { data: null, res };
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new GithubError(res.status, `${method} ${path}: ${res.status} ${data?.message || ''}`.trim());
    return { data, res };
  }

  return {
    async rest(path, opts) { return (await call(path, opts)).data; },
    // Усі сторінки: GitHub віддає наступну в заголовку Link.
    async restAll(path) {
      const out = [];
      let next = path;
      while (next) {
        const { data, res } = await call(next);
        out.push(...(Array.isArray(data) ? data : []));
        const link = res.headers.get('link') || '';
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        next = m ? m[1].replace(baseUrl, '') : null;
      }
      return out;
    },
    async graphql(query, variables) {
      const data = await this.rest('/graphql', { method: 'POST', body: { query, variables } });
      if (data.errors?.length) throw new GithubError(200, data.errors.map(e => e.message).join('; '));
      return data.data;
    },
  };
}

module.exports = { createClient, GithubError };
