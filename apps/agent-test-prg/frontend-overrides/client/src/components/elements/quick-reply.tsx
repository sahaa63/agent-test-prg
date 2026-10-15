/**
 * PRG quick replies: quoted workflow phrases in the agent's replies ("use defaults",
 * "confirm structure", "Generate a press release for [Month Year]", ...) become clickable.
 * A click types the phrase into the chat box and focuses it; the user presses Enter to send.
 * A [placeholder] in the phrase is selected, so typing replaces it straight away.
 *
 * Only the actions the PRG system prompt asks for are turned into chips, so show names or
 * other quoted text stay plain.
 */

const EXACT = new Set([
  'use defaults',
  'show options',
  'confirm structure',
  'show lineup',
  'validate lineup',
  'show flags',
  'continue',
  'go ahead',
  'proceed',
  'skip',
  'yes',
  'no',
  'next',
  'best day',
  'show rank',
  'skip rank',
  'new show',
  'confirmed',
  'skip digital',
]);

const PATTERNS = [
  /^generate a press release for .{3,40}$/i,
  /^event (\[date\]|\[yyyy-mm-dd\]|\d{4}-\d{2}-\d{2})$/i,
  /^skip \[claim\]$/i,
];

const HREF_PREFIX = '#prg-reply=';

export function isQuickReply(text: string): boolean {
  const t = text.trim().replace(/[.!]+$/, '');
  return EXACT.has(t.toLowerCase()) || PATTERNS.some((p) => p.test(t));
}

/** Turn quoted quick-reply phrases into markdown links the Response renderer shows as chips. */
export function linkQuickReplies(markdown: string): string {
  return markdown.replace(/(["'“‘])([^"'“”‘’\n]{2,60})(["'”’])/g, (match, _open: string, inner: string) => {
    const raw = inner.trim();
    const trail = raw.match(/[.!]+$/)?.[0] ?? '';
    const phrase = raw.slice(0, raw.length - trail.length);
    if (!isQuickReply(phrase)) return match;
    // Brackets escaped so "[Month Year]" stays inside the link text.
    const label = phrase.replace(/[[\]]/g, (c) => `\\${c}`);
    return `[${label}](${HREF_PREFIX}${encodeURIComponent(phrase)})${trail}`;
  });
}

export function quickReplyText(href: string | undefined): string | null {
  if (!href || !href.startsWith(HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(HREF_PREFIX.length));
  } catch {
    return null;
  }
}

/** Put text into the chat box the same way typing does, then focus it. */
export function fillChatInput(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="multimodal-input"]');
  if (!box) return;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setValue?.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  // Select a [placeholder] so typing replaces it; otherwise put the cursor at the end.
  requestAnimationFrame(() => {
    const open = text.indexOf('[');
    const close = text.indexOf(']', open);
    if (open >= 0 && close > open) box.setSelectionRange(open, close + 1);
    else box.setSelectionRange(text.length, text.length);
  });
}

export function QuickReplyChip({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={() => fillChatInput(text)}
      title="Put this in the message box"
      className="mx-0.5 inline-flex cursor-pointer items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 align-baseline font-medium text-primary text-sm hover:bg-primary/20"
    >
      {text}
    </button>
  );
}
