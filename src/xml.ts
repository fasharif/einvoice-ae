/**
 * A small, strict XML writer. It only builds what UBL documents need: elements with
 * attributes and either text or child elements. Output is deterministic (fixed attribute
 * order, two-space indentation, LF line ends), which keeps document hashes stable.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly text?: string;
  readonly children: readonly XmlElement[];
}

export type XmlChild = XmlElement | undefined | null | false;

type AttributeInput = Record<string, string | undefined>;

// XML 1.0 Char production: tab, LF, CR and the ranges below. Anything else cannot appear
// in a document, not even escaped.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHAR = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/u;

export function containsInvalidXmlCharacter(value: string): boolean {
  return INVALID_XML_CHAR.test(value);
}

function attributes(input: AttributeInput | undefined): (readonly [string, string])[] {
  if (!input) return [];
  return Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined);
}

/** An element with child elements. Undefined, null and false children are skipped. */
export function element(name: string, children: readonly XmlChild[], attrs?: AttributeInput): XmlElement {
  return {
    name,
    attributes: attributes(attrs),
    children: children.filter((child): child is XmlElement => Boolean(child)),
  };
}

/** An element with text content. */
export function textElement(name: string, text: string, attrs?: AttributeInput): XmlElement {
  return { name, attributes: attributes(attrs), text, children: [] };
}

/** A text element, or nothing when the value is undefined. */
export function optionalText(name: string, text: string | undefined, attrs?: AttributeInput): XmlElement | undefined {
  return text === undefined ? undefined : textElement(name, text, attrs);
}

/** An element with children, or nothing when every child was skipped. */
export function optionalElement(name: string, children: readonly XmlChild[], attrs?: AttributeInput): XmlElement | undefined {
  const built = element(name, children, attrs);
  return built.children.length === 0 ? undefined : built;
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

function serialiseElement(node: XmlElement, depth: number, out: string[]): void {
  if (containsInvalidXmlCharacter(node.name)) throw new Error(`Invalid element name: ${node.name}`);
  const indent = '  '.repeat(depth);
  const attrs = node.attributes
    .map(([key, value]) => {
      if (containsInvalidXmlCharacter(value)) throw new Error(`Invalid XML character in attribute ${key} of ${node.name}`);
      return ` ${key}="${escapeAttribute(value)}"`;
    })
    .join('');
  if (node.text !== undefined) {
    if (node.text.trim() === '') {
      // Empty elements are rejected by rule ibr-079; the builder must never produce one.
      throw new Error(`Element ${node.name} would be empty`);
    }
    if (containsInvalidXmlCharacter(node.text)) throw new Error(`Invalid XML character in ${node.name}`);
    out.push(`${indent}<${node.name}${attrs}>${escapeText(node.text)}</${node.name}>`);
    return;
  }
  if (node.children.length === 0) throw new Error(`Element ${node.name} would be empty`);
  out.push(`${indent}<${node.name}${attrs}>`);
  for (const child of node.children) serialiseElement(child, depth + 1, out);
  out.push(`${indent}</${node.name}>`);
}

/** Serialises a document with an XML declaration and a trailing newline. */
export function serialise(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serialiseElement(root, 0, out);
  return `${out.join('\n')}\n`;
}
