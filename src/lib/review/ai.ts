export function suggestReviewActionWithAI(input: { type: string; description: string }) {
  return `Review manually: ${input.description}`;
}
