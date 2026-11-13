import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Compare signatures without leaking where they differ.
function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  if (left.length !== right.length) return false;

  let difference = 0;

  for (let i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i];
  }

  return difference === 0;
}

// Generate PayMongo's HMAC-SHA256 signature.
async function generateSignature(
  timestamp: string,
  rawBody: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Verify PayMongo webhook signature.
async function verifySignature(
  req: Request,
  rawBody: string,
  secret: string,
  livemode: boolean,
): Promise<boolean> {
  const header = req.headers.get("Paymongo-Signature");

  if (!header) return false;

  const parts: Record<string, string> = {};

  for (const part of header.split(",")) {
    const [key, ...values] = part.trim().split("=");

    if (key) parts[key] = values.join("=");
  }

  const timestamp = parts.t;

  if (!timestamp || !/^\d+$/.test(timestamp)) {
    return false;
  }

  const timestampSeconds = Number(timestamp);

  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > 300
  ) {
    return false;
  }

  const receivedSignature = livemode ? parts.li : parts.te;

  if (!receivedSignature) return false;

  const expectedSignature = await generateSignature(
    timestamp,
    rawBody,
    secret,
  );

  return safeEqual(
    expectedSignature,
    receivedSignature.toLowerCase(),
  );
}

// Create Supabase admin client.
function getAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKeys = JSON.parse(
    Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}",
  );

  const secretKey =
    secretKeys.default ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !secretKey) {
    throw new Error("Supabase server credentials are missing.");
  }

  return createClient(supabaseUrl, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json(
      { error: "Method not allowed." },
      { status: 405 },
    );
  }

  try {
    const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET");

    if (!webhookSecret) {
      console.error("PAYMONGO_WEBHOOK_SECRET is missing.");

      return Response.json(
        { error: "Webhook is not configured." },
        { status: 500 },
      );
    }

    // Read the raw body before parsing it.
    const rawBody = await req.text();

    // Verify JSON format.
    let payload: any;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json(
        { error: "Invalid JSON payload." },
        { status: 400 },
      );
    }

    // PayMongo event structure.
    const eventAttributes = payload?.data?.attributes;

    const eventType = eventAttributes?.type;
    const livemode = eventAttributes?.livemode;

    // Ignore events unrelated to successful Checkout Sessions.
    if (eventType !== "checkout_session.payment.paid") {
      return Response.json({
        received: true,
        ignored: true,
      });
    }

    if (typeof livemode !== "boolean") {
      return Response.json(
        { error: "Missing payment environment information." },
        { status: 400 },
      );
    }

    // This integration currently accepts TEST payments only.
    if (livemode !== false) {
      return Response.json(
        { error: "Unexpected live-mode payment event." },
        { status: 400 },
      );
    }

    // Verify signature before processing the payment.
    const validSignature = await verifySignature(
      req,
      rawBody,
      webhookSecret,
      livemode,
    );

    if (!validSignature) {
      return Response.json(
        { error: "Invalid webhook signature." },
        { status: 401 },
      );
    }

    // Extract Checkout Session.
    const session = eventAttributes?.data;
    const sessionAttributes = session?.attributes;

    const sessionId = session?.id;
    const referenceNumber = sessionAttributes?.reference_number;

    if (
      session?.type !== "checkout_session" ||
      typeof sessionId !== "string" ||
      typeof referenceNumber !== "string"
    ) {
      return Response.json(
        { error: "Invalid Checkout Session information." },
        { status: 400 },
      );
    }

    // Find the successful payment attempt.
    const paidPayment = sessionAttributes?.payments?.find(
      (item: any) => item.attributes?.status === "paid",
    );

    if (!paidPayment) {
      return Response.json(
        { error: "No successful payment found." },
        { status: 400 },
      );
    }

    const paymentAttributes = paidPayment.attributes;

    const paidAmount = paymentAttributes?.amount;

    const paidCurrency = paymentAttributes?.currency;

    if (
      !Number.isSafeInteger(paidAmount) ||
      paidCurrency !== "PHP"
    ) {
      return Response.json(
        { error: "Invalid payment amount or currency." },
        { status: 400 },
      );
    }

    // Connect to Supabase.
    const supabase = getAdminClient();

    // Find payment by Checkout Session ID.
    const { data: payment, error: lookupError } = await supabase
      .from("payments")
      .select("id, booking_id, payment_status, amount, currency")
      .eq("paymongo_checkout_session_id", sessionId)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (!payment) {
      return Response.json(
        { error: "Payment record not found." },
        { status: 404 },
      );
    }

    // Verify booking reference.
    if (referenceNumber !== `BOOKING-${payment.booking_id}`) {
      return Response.json(
        { error: "Booking reference mismatch." },
        { status: 400 },
      );
    }

    // Verify rental amount and currency.
    const expectedAmount = Math.round(Number(payment.amount) * 100);

    if (
      !Number.isSafeInteger(expectedAmount) ||
      paidAmount !== expectedAmount ||
      payment.currency !== paidCurrency ||
      payment.currency !== "PHP"
    ) {
      console.error("Payment amount or currency mismatch.");

      return Response.json(
        { error: "Payment amount or currency mismatch." },
        { status: 400 },
      );
    }

    // Update payment only if it is still pending.
    if (payment.payment_status !== "paid") {
      const { data: updatedPayment, error: updateError } =
        await supabase
          .from("payments")
          .update({
            payment_status: "paid",
            payment_method: paymentAttributes?.source?.type ?? null,
            paid_at: new Date().toISOString(),
          })
          .eq("id", payment.id)
          .eq("payment_status", "pending")
          .select("id")
          .maybeSingle();

      if (updateError) throw updateError;

      // Another webhook delivery may have updated it first.
      if (!updatedPayment) {
        const { data: latestPayment, error: latestError } =
          await supabase
            .from("payments")
            .select("payment_status")
            .eq("id", payment.id)
            .single();

        if (latestError) throw latestError;

        if (latestPayment.payment_status !== "paid") {
          throw new Error("Payment could not be marked as paid.");
        }
      }
    }

    // Confirm booking after payment is verified.
    const { error: bookingError } = await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", payment.booking_id);

    if (bookingError) throw bookingError;

    console.log(
      `Payment confirmed for booking ${payment.booking_id}`,
    );

    return Response.json({
      received: true,
      success: true,
      payment_status: "paid",
      booking_status: "confirmed",
      booking_id: payment.booking_id,
    });
  } catch (error) {
    console.error("Webhook processing error:", error);

    return Response.json(
      { error: "Webhook processing failed." },
      { status: 500 },
    );
  }
});
