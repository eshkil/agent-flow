// Модель Claude для скіла з input `model` (vars.AGENT_MODEL). Формат:
//   claude-opus-5-5                                   — одна модель для всіх скілів
//   claude-opus-5-5, triage=claude-sonnet-5-5, ...    — дефолт + перевизначення
// Записи розділяються комами, крапками з комою або пробілами. Порожньо — модель
// Claude Code за замовчуванням. Помилка формату — виняток: одруківка в назві скіла
// не має тихо запускати не ту модель.

const SKILLS = ['triage', 'feature-spec', 'implement', 'bug-agent', 'pr-review', 'pr-fix', 'merge'];

function parse(spec) {
  const out = { fallback: '', bySkill: {} };
  // Пробіли навколо «=» — частина запису, а не розділювач.
  const entries = (spec || '').replace(/\s*=\s*/g, '=').split(/[\s,;]+/).filter(Boolean);
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq === -1) {
      if (out.fallback) throw new Error(`дві моделі за замовчуванням: \`${out.fallback}\` і \`${entry}\``);
      out.fallback = entry;
      continue;
    }
    const skill = entry.slice(0, eq);
    const model = entry.slice(eq + 1);
    if (!SKILLS.includes(skill)) throw new Error(`невідомий скіл \`${skill}\`; є: ${SKILLS.join(', ')}`);
    if (!model) throw new Error(`для скіла \`${skill}\` не вказано модель`);
    if (out.bySkill[skill]) throw new Error(`скіл \`${skill}\` вказано двічі`);
    out.bySkill[skill] = model;
  }
  return out;
}

function pickModel(spec, skill) {
  const { fallback, bySkill } = parse(spec);
  return bySkill[skill] || fallback;
}

module.exports = { pickModel, SKILLS };
