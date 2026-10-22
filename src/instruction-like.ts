// One filter for both the planner (never drafts from these) and the Desk's
// "Held back" list. No imports: the Desk bundles it for the browser.
const instructionPatterns = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,60}\b(rules?|instructions?|prompts?|guidelines|previous|earlier|above)\b/i,
  /\b(system prompt|you are now|act as|new instructions?)\b/i,
  /\b(send|forward|export|share)\b[^.\n]{0,30}\b(all|every)\b[^.\n]{0,30}\b(contacts?|messages?|emails?|data|files)\b/i,
  /\bmark\b[^.\n]{0,20}\b(all|every)\b/i,
  /\b(api[ -]?key|password|access token|credentials?)\b/i,
];
export function isInstructionLike(text: string): boolean {
  return instructionPatterns.some((p) => p.test(text));
}
