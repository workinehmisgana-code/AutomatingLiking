import { llmChat } from "@/lib/llm";
import { SUPPORT_REPLY_SYSTEM } from "@/lib/prompts";

export type DraftContext = {
  /** Short note from you: "approved refund, 3 days processing" */
  instruction: string;
  customerName?: string | null;
  customerEmail: string;
  originalSubject: string;
  originalBody: string;
  /** Free-form lines describing what the dashboard already did. */
  actionsTaken?: string[];
  /** Account facts the reply may reference (plan, credits, last payment). */
  accountFacts?: string[];
  tone?: "warm" | "neutral" | "firm";
  /** Which site the customer wrote to — the reply must speak as that brand. */
  brand: { label: string; site: string };
};

export async function draftReply(context: DraftContext): Promise<string> {
  const parts = [
    `CUSTOMER: ${context.customerName || "unknown name"} <${context.customerEmail}>`,
    `THEIR SUBJECT: ${context.originalSubject}`,
    `THEIR MESSAGE:\n"""\n${context.originalBody.slice(0, 6000)}\n"""`,
  ];

  if (context.accountFacts?.length) {
    parts.push(`VERIFIED ACCOUNT FACTS (safe to reference):\n- ${context.accountFacts.join("\n- ")}`);
  }
  if (context.actionsTaken?.length) {
    parts.push(`ACTIONS ALREADY COMPLETED:\n- ${context.actionsTaken.join("\n- ")}`);
  }
  parts.push(`WHAT I WANT TO SAY (turn this into the reply): ${context.instruction}`);
  if (context.tone) parts.push(`TONE: ${context.tone}`);

  // The admin's chosen model (lib/llm.ts), with the usual fallbacks, rather
  // than a Groq key of its own.
  const { content: raw } = await llmChat({
    messages: [
      { role: "system", content: SUPPORT_REPLY_SYSTEM(context.brand) },
      { role: "user", content: parts.join("\n\n") },
    ],
    temperature: 0.4,
    maxTokens: 900,
  });
  const content = raw?.trim();
  if (!content) throw new Error("The model returned an empty draft.");

  // Reasoning models can emit a preamble in <think> tags; strip it.
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
