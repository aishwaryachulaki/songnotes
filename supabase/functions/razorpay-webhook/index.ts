import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.1";

// ─────────────────────────────────────────────────────────────────────────────
// razorpay-webhook — server-to-server backstop for credit granting.
//
// The browser-driven verify-razorpay-payment is the happy path. But if the user
// pays and then closes the tab before that callback fires, the order is left
// 'created' and credits are never granted even though money changed hands. This
// webhook is Razorpay calling US directly on payment.captured, so the grant no
// longer depends on the browser staying open.
//
// Auth here is NOT a user JWT (Razorpay has no login token) — it is the webhook
// HMAC signature over the RAW body, using the Razorpay *webhook secret* (a
// different secret from the API key secret). Because of that, this function must
// be deployed with --no-verify-jwt.
//
// It does the EXACT same atomic claim (created -> fulfilled) as the verify
// function, so whichever arrives first (browser or webhook) grants exactly once;
// the loser is a harmless no-op. Fully idempotent: Razorpay retries are safe.
// ─────────────────────────────────────────────────────────────────────────────

// Must match the catalog in create-razorpay-order / verify-razorpay-payment.
// Credits/lifetime come from HERE (keyed by the stored order's package_id),
// never from the webhook payload.
const PACKAGES: Record<string, { amount_paise: number; credits: number; lifetime: boolean }> = {
  letters_5:  { amount_paise: 14900, credits: 5,  lifetime: false },
  letters_10: { amount_paise: 24900, credits: 10, lifetime: false },
  letters_15: { amount_paise: 34900, credits: 15, lifetime: false },
  lifetime:   { amount_paise: 99900, credits: 0,  lifetime: true  },
};

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare to avoid signature timing leaks.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    // Read the RAW body — the signature is computed over these exact bytes, so
    // we must verify before parsing (re-serializing JSON would change them).
    const rawBody = await req.text();

    const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error("Missing RAZORPAY_WEBHOOK_SECRET");
      // 500 so Razorpay retries once we've configured the secret.
      return new Response(JSON.stringify({ error: "Webhook misconfigured" }), { status: 500 });
    }

    const sigHeader = req.headers.get("x-razorpay-signature") || "";
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw", enc.encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const expected = hex(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(rawBody)));
    if (!sigHeader || !timingSafeEqual(expected, sigHeader)) {
      console.error("Webhook signature mismatch — rejecting");
      // 401 (no retry) — a bad signature means it isn't really from Razorpay.
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
    }

    // Signature is valid — safe to parse.
    const event = JSON.parse(rawBody);
    const eventType = event?.event;

    // We only act on a captured payment. (order.paid is also fine but
    // payment.captured carries both order_id and payment id reliably.)
    if (eventType !== "payment.captured") {
      return new Response(JSON.stringify({ ok: true, ignored: eventType || "unknown" }), { status: 200 });
    }

    const payment = event?.payload?.payment?.entity;
    const orderId = payment?.order_id;
    const paymentId = payment?.id;
    if (!orderId || !paymentId) {
      console.error("payment.captured missing order_id/id");
      return new Response(JSON.stringify({ ok: true, ignored: "no_order" }), { status: 200 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Atomically claim the order: only the FIRST transition of a 'created' order
    // flips it to 'fulfilled' and reads back what to grant. If the browser path
    // already fulfilled it, this returns nothing -> idempotent no-op.
    const { data: claimed, error: claimErr } = await admin
      .from("payment_orders")
      .update({ status: "fulfilled", payment_id: paymentId, fulfilled_at: new Date().toISOString() })
      .eq("order_id", orderId)
      .eq("status", "created")
      .select("user_id, package_id, amount_paise")
      .maybeSingle();
    if (claimErr) {
      console.error("Order claim failed:", claimErr);
      return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
    }
    if (!claimed) {
      // Already fulfilled by the browser path (or unknown order) — nothing to do.
      return new Response(JSON.stringify({ ok: true, already_processed: true }), { status: 200 });
    }

    const pkg = PACKAGES[claimed.package_id];
    if (!pkg) {
      console.error("Unknown package on order:", claimed.package_id);
      // Roll back so it can be retried/inspected, but don't keep failing forever.
      await admin.from("payment_orders")
        .update({ status: "created", payment_id: null, fulfilled_at: null })
        .eq("order_id", orderId);
      return new Response(JSON.stringify({ error: "Unknown package" }), { status: 500 });
    }

    // Grant with SERVER values only.
    const { error: rpcError } = await admin.rpc("add_credits", {
      p_user_id:      claimed.user_id,
      p_credits:      pkg.credits,
      p_lifetime:     pkg.lifetime,
      p_razorpay_id:  paymentId,
      p_amount_paise: claimed.amount_paise,
    });
    if (rpcError) {
      // Roll back to 'created' so the next webhook retry (or the browser) grants.
      console.error("Credit grant failed after verified webhook:", rpcError);
      await admin.from("payment_orders")
        .update({ status: "created", payment_id: null, fulfilled_at: null })
        .eq("order_id", orderId);
      return new Response(JSON.stringify({ error: "Credit update failed" }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true, granted: true }), { status: 200 });
  } catch (err) {
    console.error("Unexpected webhook error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
  }
});
