import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { getProject } from "@/lib/support/projects";
import { BillingError, providerFor } from "@/lib/support/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Body = {
  projectId?: string;
  subscriptionId?: string;
  /** true = keep access until the paid period ends; false = revoke now. */
  atPeriodEnd?: boolean;
  confirm?: string;
};

export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as Body;

  const project = body.projectId ? getProject(body.projectId) : null;
  if (!project) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  const provider = providerFor(project);
  if (!provider) {
    return NextResponse.json(
      { error: `${project.label} has no billing credentials configured.` },
      { status: 400 },
    );
  }
  if (!body.subscriptionId) {
    return NextResponse.json({ error: "subscriptionId is required" }, { status: 400 });
  }
  if (body.confirm !== body.subscriptionId) {
    return NextResponse.json(
      { error: "Confirmation does not match the subscription id" },
      { status: 400 },
    );
  }

  // LemonSqueezy has no immediate revoke — force the grace-period behaviour so
  // the response can't claim something the provider didn't do.
  const atPeriodEnd = provider.capabilities.immediateCancellation
    ? (body.atPeriodEnd ?? true)
    : true;

  try {
    const subscription = await provider.cancelSubscription(body.subscriptionId, atPeriodEnd);
    return NextResponse.json({
      ok: true,
      subscription,
      atPeriodEnd,
      downgradedToPeriodEnd: body.atPeriodEnd === false && !provider.capabilities.immediateCancellation,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.message, details: error.body }, { status: 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
