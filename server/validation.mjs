export const bad = (message, status = 400) => Object.assign(new Error(message), { status });
export function text(value, name, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw bad(`${name} is required (maximum ${max.toLocaleString()} characters).`);
  return value.trim();
}
export function number(value, min, max, name, integer = false) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw bad(`${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
}
export function promptBody(body) {
  return {
    title: text(body.title, 'Title', 160),
    category: text(body.category, 'Category', 60),
    content: text(body.content, 'Prompt', 100000),
    baseVersionId: body.baseVersionId,
  };
}
export function ids(value) {
  if (!Array.isArray(value) || !value.length || value.some((x) => typeof x !== 'string'))
    throw bad('Select at least one prompt and one model.');
  return [...new Set(value)];
}
export function runIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10000 ||
    value.some(id => typeof id !== 'string' || !id || id.length > 200))
    throw bad('Select between 1 and 10,000 runs.');
  return [...new Set(value)];
}
