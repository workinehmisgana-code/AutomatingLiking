import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { loadCustomerProfile } from "@/lib/support/customer";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const projectId = searchParams.get("project");

  if (!email?.trim()) {
    return NextResponse.json({ error: "email query param is required" }, { status: 400 });
  }
  if (!projectId?.trim()) {
    return NextResponse.json({ error: "project query param is required" }, { status: 400 });
  }

  try {
    const profile = await loadCustomerProfile(projectId, email);
    return NextResponse.json({ profile });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
