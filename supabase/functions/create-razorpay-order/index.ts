import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://dropakeepsake.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

// Server-authoritative catalog (INR + USD / Razorpay). The client picks a package_id
// and currency; it can NEVER set the price or the number of credits.
// Amount units: paise for INR, cents for USD. Keep in sync with TIERS in account.html.
const PACKAGES: Record<string, Record<string, { amount_units: number; credits: number; lifetime: boolean }>> = {
  letters_5: {
    INR: { amount_units: 14900, credits: 5, lifetime: false },
    USD: { amount_units: 199, credits: 5, lifetime: false },
  },
  letters_10: {
    INR: { amount_units: 24900, credits: 10, lifetime: false },
    USD: { amount_units: 349, credits: 10, lifetime: false },
  },
  letters_15: {
    INR: { amount_units: 34900, credits: 15, lifetime: false },
    USD: { amount_units: 499, credits: 15, lifetime: false },
  },
  lifetime: {
    INR: { amount_units: 99900, credits: 0, lifetime: true },
    USD: { amount_units: 999, credits: 0, lifetime: true },
  },
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
    const body = await req.json();
    if (body.warmup) return json({ ok: true }, 200);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Authenticate the caller from their login token — the order is bound to them.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Not authenticated" }, 401);

    const currency = body.currency || "INR"; // Default to INR if not specified
    if (!["INR", "USD"].includes(currency)) {
      return json({ error: "Invalid currency" }, 400);
    }

    const pkg = PACKAGES[body.package_id]?.[currency];
    if (!pkg) return json({ error: "Unknown package or currency" }, 400);

    const keyId     = Deno.env.get("RAZORPAY_KEY_ID");
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keyId || !keySecret) {
      console.error("Missing Razorpay credentials");
      return json({ error: "Payment service misconfigured" }, 500);
    }

    // Create the order for the SERVER-decided amount.
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${keyId}:${keySecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: pkg.amount_units,
        currency: currency,
        receipt: `${user.id.slice(0, 8)}_${Date.now()}`,
      }),
    });
    if (!rzpRes.ok) {
      console.error("Razorpay order creation failed:", await rzpRes.text());
      return json({ error: "Failed to create payment order" }, 502);
    }
    const order = await rzpRes.json();

    // Record what was ordered so verify derives credits from this, not the client.
    const { error: insErr } = await admin.from("payment_orders").insert({
      order_id: order.id,
      user_id: user.id,
      package_id: body.package_id,
      amount_units: pkg.amount_units,
      currency: currency,
      status: "created",
    });
    if (insErr) {
      console.error("Failed to record order:", insErr);
      return json({ error: "Could not record order" }, 500);
    }

    return json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: keyId }, 200);
  } catch (err) {
    console.error("Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
