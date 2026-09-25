import { DOMParser, type Element } from '@xmldom/xmldom';

export const NS = {
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
};

export function parse(xml: string): Element {
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message);
    },
  }).parseFromString(xml, 'text/xml');
  if (errors.length > 0) throw new Error(`XML parse errors: ${errors.join('; ')}`);
  const root = doc.documentElement;
  if (!root) throw new Error('No root element');
  return root;
}

export function children(element: Element): Element[] {
  const out: Element[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) out.push(node as Element);
  }
  return out;
}

export function localNames(element: Element): string[] {
  return children(element).map((c) => c.localName ?? '');
}

/** Follows a path of local names (first match at each step). */
export function at(element: Element, ...path: string[]): Element | undefined {
  let current: Element | undefined = element;
  for (const name of path) {
    current = current ? children(current).find((c) => c.localName === name) : undefined;
  }
  return current;
}

export function all(element: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element): void => {
    for (const c of children(e)) {
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  walk(element);
  return out;
}

export function text(element: Element | undefined): string | undefined {
  return element?.textContent ?? undefined;
}
