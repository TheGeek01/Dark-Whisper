export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A CSS mask icon from public/app.css (.i-<name>).
export function icon(name: string, className = ''): HTMLSpanElement {
  const node = el('span', `i i-${name}${className ? ` ${className}` : ''}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
