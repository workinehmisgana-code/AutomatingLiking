import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { optional } from "@/lib/support/env";
import { projectSummaries } from "@/lib/support/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await supportGuard();
  if (denied) return denied;
  return NextResponse.json({
    projects: projectSummaries(),
    groq: Boolean(optional("GEMINI_API_KEY") || optional("GROQ_API_KEY")),
  });
}
