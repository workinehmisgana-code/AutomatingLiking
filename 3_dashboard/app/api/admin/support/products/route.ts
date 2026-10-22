import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { creditsForPlanName } from "@/lib/support/plans";
import { getProject } from "@/lib/support/projects";
import { BillingError, providerFor } from "@/lib/support/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type DowngradeTarget = {
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  interval: string | null;
  /** Credits this plan grants, from <PROJECT>_CREDITS_* — null if unmapped. */
  credits: number | null;
};

/** Plans a subscription could be moved onto, for the downgrade dialog. */
export async function GET(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project");
  const project = projectId ? getProject(projectId) : null;

  if (!project) {
    return NextResponse.json({ error: "project query param is required" }, { status: 400 });
  }
  const provider = providerFor(project);
  if (!provider) {
    return NextResponse.json(
      { error: `${project.label} has no billing credentials configured.` },
      { status: 400 },
    );
  }

  try {
    const products = await provider.listProducts();
    const targets: DowngradeTarget[] = products
      .filter((p) => !p.archived)
      .map((p) => ({
        id: p.id,
        name: p.name,
        amount: p.amount,
        currency: p.currency,
        interval: p.interval,
        credits: project.creditMap[p.id] ?? creditsForPlanName(p.name.split(/\s+/)[0]) ?? null,
      }))
      .sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0));

    return NextResponse.json({ products: targets, planChanges: provider.capabilities.planChanges });
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
