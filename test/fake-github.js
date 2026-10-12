// Фейк клієнта з src/github.js: відповіді за ключем «МЕТОД шлях», журнал викликів.
function fakeGithub(routes = {}) {
  const calls = [];
  const answer = (key, arg) => {
    if (!(key in routes)) {
      const err = new Error(`fake: немає відповіді для ${key}`);
      err.status = 404;
      throw err;
    }
    const v = routes[key];
    return typeof v === 'function' ? v(arg) : v;
  };
  return {
    calls,
    async rest(path, { method = 'GET', body } = {}) {
      calls.push({ method, path, body });
      return answer(`${method} ${path}`, body);
    },
    async restAll(path) {
      calls.push({ method: 'GET', path });
      return answer(`GET ${path}`);
    },
    async graphql(query, variables) {
      calls.push({ method: 'GRAPHQL', path: 'graphql', body: variables });
      return answer('GRAPHQL', variables);
    },
  };
}

module.exports = { fakeGithub };
