import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://dropakeepsake.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

// Must match the catalog in create-razorpay-order. Credits/lifetime come from
// HERE (keyed by the stored order's package_id), never from the client.
const PACKAGES: Record<string, { amount_paise: number; credits: number; lifetime: boolean }> = {
  letters_5:  { amount_paise: 14900, credits: 5,  lifetime: false },
  letters_10: { amount_paise: 24900, credits: 10, lifetime: false },
  letters_15: { amount_paise: 34900, credits: 15, lifetime: false },
  lifetime:   { amount_paise: 99900, credits: 0,  lifetime: true  },
};

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // NOTE: we intentionally ignore any client-supplied credits/amount/user_id.
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json();
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return json({ error: "Missing required payment fields" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Authenticate the caller from their login token.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Not authenticated" }, 401);

    // Verify the Razorpay HMAC-SHA256 signature (proves Razorpay issued this
    // payment for this order).
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keySecret) return json({ error: "Payment service misconfigured" }, 500);

    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw", enc.encode(keySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(`${razorpay_order_id}|${razorpay_payment_id}`));
    const generated = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (generated !== razorpay_signature) {
      console.error("Signature mismatch — possible tampered request");
      return json({ error: "Payment verification failed" }, 400);
    }

    // Atomically claim the order: only the FIRST verify for this order, owned by
    // this user, while still 'created', flips it to 'fulfilled' and grants. This
    // is the replay/idempotency guard (a resubmitted payment grants nothing).
    const { data: claimed, error: claimErr } = await admin
      .from("payment_orders")
      .update({ status: "fulfilled", payment_id: razorpay_payment_id, fulfilled_at: new Date().toISOString() })
      .eq("order_id", razorpay_order_id)
      .eq("user_id", user.id)
      .eq("status", "created")
      .select("package_id, amount_paise")
      .maybeSingle();
    if (claimErr) { console.error("Order claim failed:", claimErr); return json({ error: "Internal error" }, 500); }

    if (!claimed) {
      // Either already fulfilled (idempotent success) or not this user's order.
      const { data: existing } = await admin
        .from("payment_orders").select("status")
        .eq("order_id", razorpay_order_id).eq("user_id", user.id).maybeSingle();
      if (existing && existing.status === "fulfilled") return json({ success: true, already_processed: true }, 200);
      return json({ error: "Order not found for this account" }, 400);
    }

    const pkg = PACKAGES[claimed.package_id];
    if (!pkg) { console.error("Unknown package on order:", claimed.package_id); return json({ error: "Internal error" }, 500); }

    // Grant credits with SERVER values only.
    const { error: rpcError } = await admin.rpc("add_credits", {
      p_user_id:      user.id,
      p_credits:      pkg.credits,
      p_lifetime:     pkg.lifetime,
      p_razorpay_id:  razorpay_payment_id,
      p_amount_paise: claimed.amount_paise,
    });
    if (rpcError) {
      // Roll the order back to 'created' so the user can retry the grant.
      console.error("Credit grant failed after verified payment:", rpcError);
      await admin.from("payment_orders")
        .update({ status: "created", payment_id: null, fulfilled_at: null })
        .eq("order_id", razorpay_order_id);
      return json({ error: "Payment verified but credit update failed", payment_id: razorpay_payment_id }, 500);
    }

    return json({ success: true }, 200);
  } catch (err) {
    console.error("Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
