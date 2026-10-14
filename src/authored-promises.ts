import type { AuthoredSpan } from "./google-records.ts";

/** Conservative candidate screening, never semantic proof or owner confirmation. */
export function isExplicitCommitment(text: string): boolean {
  if (text.length > 262144) return false;
  const value = text.trim().replace(/’/g, "'");
  if (
    /[?]/.test(value) ||
    /\b(?:not|never|won't|would|could|might|maybe|perhaps|if|unless|provided|assuming|hopefully|pas|jamais|peut-être|si|sauf|condition|éventuellement)\b/iu.test(
      value,
    )
  )
    return false;
  return (
    /^J'(?:enverrai|appellerai|écrirai|apporterai|organiserai)\b/iu.test(
      value,
    ) ||
    /^(?:I (?:will|promise to)|I'll) (?:send|share|review|call|write|prepare|deliver|finish|complete|check|confirm|book|arrange|introduce|follow up|reply|provide|update|submit|bring|pay|meet|contact|schedule)\b/iu.test(
      value,
    ) ||
    /^Je (?:(?:vais|promets de|m'engage à) (?:envoyer|partager|relire|appeler|écrire|préparer|livrer|finir|terminer|vérifier|confirmer|réserver|organiser|répondre|fournir|soumettre|apporter|payer|contacter)|(?:(?:te|vous|t'|lui|leur)\s*)?(?:enverrai|partagerai|relirai|appellerai|écrirai|préparerai|livrerai|finirai|terminerai|vérifierai|confirmerai|réserverai|organiserai|répondrai|fournirai|soumettrai|apporterai|paierai|contacterai))\b/iu.test(
      value,
    )
  );
}

export function authoredSpans(text: string): AuthoredSpan[] {
  if (text.length > 262144) return [];
  const spans: AuthoredSpan[] = [];
  const lines = /[^\r\n]+/g;
  for (const match of text.matchAll(lines)) {
    const value = match[0].trim();
    if (
      /^(?:>|--\s*$|Sent from my\b|Envoyé de mon\b|On .+wrote:\s*$|Le .+(?:écrit|ecrit)\s*:\s*$|Begin forwarded message:|From:\s+.+@|[-_]{2,}\s*(?:Original Message|Forwarded message|Message transféré))/iu.test(
        value,
      )
    )
      break;
    if (
      /^(?:best(?: regards)?|kind regards|regards|sincerely|cordialement|bien cordialement|salutations)[,! .]*$/iu.test(
        value,
      )
    )
      break;
    if (!value) continue;
    const start = match.index + match[0].indexOf(value);
    spans.push({ start, end: start + value.length, text: value });
  }
  return spans;
}

export interface AuthoredEvidence {
  authored_spans?: AuthoredSpan[];
  attribution?: "direct" | "group" | "unknown";
  eligible_for_extraction?: boolean;
  kind: string;
  direction: "sent" | "received" | "event";
  cancelled: boolean;
}
export function eligiblePromiseSpans(record: AuthoredEvidence): AuthoredSpan[] {
  if (
    record.cancelled ||
    record.kind !== "message" ||
    record.direction === "event" ||
    record.attribution !== "direct" ||
    !record.eligible_for_extraction
  )
    return [];
  return (record.authored_spans ?? []).filter((span) =>
    isExplicitCommitment(span.text),
  );
}
