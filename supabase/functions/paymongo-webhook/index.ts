
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status });
}

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

async function verifySignature(
  req: Request,
  rawBody: string,
  secret: string,
  livemode: boolean,
): Promise<boolean> {
  const header = req.headers.get("Paymongo-Signature");

  if (!header) {
    console.error("Missing Paymongo-Signature header.");
    return false;
  }

  const parts: Record<string, string> = {};

  for (const part of header.split(",")) {
    const [key, ...values] = part.trim().split("=");

    if (key) {
      parts[key] = values.join("=");
    }
  }

  const timestamp = parts.t;
  const receivedSignature = livemode ? parts.li : parts.te;

  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !receivedSignature
  ) {
    console.error("Invalid PayMongo signature header.");
    return false;
  }

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

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");

  let parsedSecrets: any = {};

  try {
    const raw = Deno.env.get("SUPABASE_SECRET_KEYS");

    if (raw) {
      parsedSecrets = JSON.parse(raw);
    }
  } catch {
    console.error("Could not parse SUPABASE_SECRET_KEYS.");
  }

  const secret =
    (typeof parsedSecrets === "string" ? parsedSecrets : null) ??
    parsedSecrets?.default ??
    parsedSecrets?.service_role ??
    Deno.env.get("SUPABASE_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !secret) {
    throw new Error("Supabase admin credentials are missing.");
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405,
    );
  }

  try {
    const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET");

    if (!webhookSecret) {
      throw new Error("PAYMONGO_WEBHOOK_SECRET is missing.");
    }

    // Read the raw body before parsing because the signature
    // is calculated using the original request body.
    const rawBody = await req.text();

    let payload: any;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        { error: "Invalid JSON payload." },
        400,
      );
    }

    const eventAttributes = payload?.data?.attributes;

    const eventType = eventAttributes?.type;
    const livemode = eventAttributes?.livemode;

    if (typeof livemode !== "boolean") {
      return jsonResponse(
        { error: "Missing payment environment information." },
        400,
      );
    }

    // This project currently uses Test Mode only.
    if (livemode !== false) {
      return jsonResponse(
        { error: "Unexpected live-mode event." },
        400,
      );
    }

    const signatureValid = await verifySignature(
      req,
      rawBody,
      webhookSecret,
      livemode,
    );

    if (!signatureValid) {
      console.error("Webhook signature verification failed.");

      return jsonResponse(
        { error: "Invalid webhook signature." },
        401,
      );
    }

    console.log("PayMongo event received:", eventType);

    // Ignore unrelated events.
    if (eventType !== "checkout_session.payment.paid") {
      return jsonResponse({
        received: true,
        ignored: true,
        event_type: eventType,
      });
    }

    // PayMongo's checkout event contains the Checkout Session
    // inside attributes.data.
    const session = eventAttributes?.data;
    const sessionAttributes = session?.attributes;

    const sessionId = session?.id;
    const referenceNumber = sessionAttributes?.reference_number;

    if (
      session?.type !== "checkout_session" ||
      typeof sessionId !== "string" ||
      typeof referenceNumber !== "string"
    ) {
      return jsonResponse(
        { error: "Invalid Checkout Session information." },
        400,
      );
    }

    const payments = Array.isArray(sessionAttributes?.payments)
      ? sessionAttributes.payments
      : [];

    const paidPayment = payments.find(
      (item: any) => item?.attributes?.status === "paid",
    );

    if (!paidPayment) {
      return jsonResponse(
        { error: "No successful payment was found." },
        400,
      );
    }

    const paymentAttributes = paidPayment.attributes;

    const paidAmount = Number(paymentAttributes?.amount);
    const paidCurrency = paymentAttributes?.currency;

    if (
      !Number.isSafeInteger(paidAmount) ||
      paidAmount <= 0 ||
      paidCurrency !== "PHP"
    ) {
      return jsonResponse(
        { error: "Invalid payment amount or currency." },
        400,
      );
    }

    const admin = getAdminClient();

    // Find the payment using the Checkout Session ID.
    const { data: payment, error: lookupError } = await admin
      .from("payments")
      .select(`
        id,
        booking_id,
        payment_status,
        amount,
        currency,
        receipt_number
      `)
      .eq("paymongo_checkout_session_id", sessionId)
      .maybeSingle();

    if (lookupError) {
      console.error("Payment lookup failed:", lookupError.message);
      throw lookupError;
    }

    if (!payment) {
      console.error("Payment record not found:", sessionId);

      return jsonResponse(
        { error: "Payment record not found." },
        404,
      );
    }

    // Validate the reference number against our booking.
    const expectedReference = `BOOKING-${payment.booking_id}`;

    if (referenceNumber !== expectedReference) {
      console.error("Reference mismatch:", {
        received: referenceNumber,
        expected: expectedReference,
      });

      return jsonResponse(
        { error: "Booking reference mismatch." },
        400,
      );
    }

    // PayMongo amount is in centavos.
    const expectedAmount = Math.round(
      Number(payment.amount) * 100,
    );

    if (
      !Number.isSafeInteger(expectedAmount) ||
      paidAmount !== expectedAmount ||
      payment.currency !== "PHP"
    ) {
      console.error("Payment amount mismatch:", {
        paidAmount,
        expectedAmount,
        currency: paidCurrency,
      });

      return jsonResponse(
        { error: "Payment amount or currency mismatch." },
        400,
      );
    }

    const paidAt =
      paymentAttributes?.paid_at &&
      Number.isFinite(Number(paymentAttributes.paid_at))
        ? new Date(
            Number(paymentAttributes.paid_at) * 1000,
          ).toISOString()
        : new Date().toISOString();

    const receiptNumber =
      payment.receipt_number ||
      `SAR-${payment.booking_id}-${Date.now()}`;

    const paymentMethod =
      paymentAttributes?.source?.type ??
      paymentAttributes?.payment_method_used ??
      null;

    // Only update if the payment has not already been marked paid.
    if (payment.payment_status !== "paid") {
      const { data: updatedPayment, error: updateError } =
        await admin
          .from("payments")
          .update({
            payment_status: "paid",
            payment_method: paymentMethod,
            paid_at: paidAt,
            receipt_number: receiptNumber,
          })
          .eq("id", payment.id)
          .neq("payment_status", "paid")
          .select("id")
          .maybeSingle();

      if (updateError) {
        console.error(
          "Payment update failed:",
          updateError.message,
        );
        throw updateError;
      }

      if (!updatedPayment) {
        console.log(
          "Payment was already updated by another webhook attempt.",
        );
      }
    }

    // Verify that the payment really is saved as paid.
    const { data: finalPayment, error: finalError } =
      await admin
        .from("payments")
        .select("payment_status, receipt_number")
        .eq("id", payment.id)
        .single();

    if (finalError) throw finalError;

    if (finalPayment.payment_status !== "paid") {
      throw new Error(
        "Payment status was not successfully updated.",
      );
    }

    // Confirm the booking only after the payment is verified.
    const { error: bookingError } = await admin
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", payment.booking_id);

    if (bookingError) {
      console.error(
        "Booking confirmation failed:",
        bookingError.message,
      );
      throw bookingError;
    }

    console.log("--------------------------------");
    console.log("PAYMENT SUCCESSFULLY VERIFIED");
    console.log("Booking ID:", payment.booking_id);
    console.log("Payment ID:", payment.id);
    console.log("Payment Status: paid");
    console.log("Receipt:", finalPayment.receipt_number);
    console.log("--------------------------------");

    return jsonResponse({
      received: true,
      success: true,
      payment_status: "paid",
      booking_status: "confirmed",
      booking_id: payment.booking_id,
      receipt_number: finalPayment.receipt_number,
    });
  } catch (error) {
    console.error("WEBHOOK PROCESSING ERROR:", error);

    return jsonResponse(
      {
        received: false,
        error:
          error instanceof Error
            ? error.message
            : "Webhook processing failed.",
      },
      500,
    );
  }
});
