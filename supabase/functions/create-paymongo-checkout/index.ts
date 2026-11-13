
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

// Get the Supabase service-role/secret key.
function getAdminSecret(): string | null {
  const rawSecretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");

  if (rawSecretKeys) {
    try {
      const parsed = JSON.parse(rawSecretKeys);
      if (parsed.default) return parsed.default;
    } catch {
      // Ignore invalid JSON and try the service-role fallback.
    }
  }

  return (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    null
  );
}

// Create the privileged Supabase client.
function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = getAdminSecret();

  if (!url || !secret) {
    throw new Error(
      "Missing Supabase server credentials. Check SUPABASE_URL and SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// Calculate the rental end date.
function addRentalDuration(
  startDate: string,
  type: string,
  duration: number,
): string {
  const [year, month, day] = startDate.split("-").map(Number);

  if (type === "Daily") {
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + duration);

    return date.toISOString().slice(0, 10);
  }

  const targetMonth = month - 1 + duration;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;

  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();

  const finalDay = Math.min(day, lastDay);

  return [
    targetYear,
    String(normalizedMonth + 1).padStart(2, "0"),
    String(finalDay).padStart(2, "0"),
  ].join("-");
}

// Get today's date in Philippine time.
function getPhilippineToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values: Record<string, string> = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// Validate YYYY-MM-DD dates.
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

// Allow HTTP/HTTPS URLs, including localhost during development.
// For production, use publicly accessible HTTPS URLs.
function validRedirect(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      ["https:", "http:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  // Handle browser preflight requests.
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405,
    );
  }

  let admin: ReturnType<typeof getAdminClient> | null = null;
  let bookingId: number | null = null;

  try {
    // 1. Check Supabase configuration.
    const supabaseUrl = Deno.env.get("SUPABASE_URL");

    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    if (!supabaseUrl || !anonKey) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_ANON_KEY/SUPABASE_PUBLISHABLE_KEY.",
      );
    }

    // 2. Verify the user's access token.
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        { error: "Missing authentication token. Please sign in again." },
        401,
      );
    }

    const accessToken = authorization.substring(7);

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: authData, error: authError } =
      await authClient.auth.getUser(accessToken);

    if (authError || !authData.user) {
      console.error("Authentication error:", authError);

      return jsonResponse(
        { error: "Your session is invalid or expired. Please sign in again." },
        401,
      );
    }

    const user = authData.user;

    // 3. Check PayMongo secret.
    const paymongoSecret = Deno.env.get("PAYMONGO_SECRET_KEY");

    if (!paymongoSecret) {
      throw new Error("PAYMONGO_SECRET_KEY is not configured.");
    }

    if (!paymongoSecret.startsWith("sk_test_")) {
      throw new Error(
        "The PayMongo secret key must be a Test Mode secret key beginning with sk_test_.",
      );
    }

    // 4. Read request body.
    let body: any;

    try {
      body = await req.json();
    } catch {
      return jsonResponse(
        { error: "Invalid JSON request body." },
        400,
      );
    }

    const apartmentId = Number(body?.apartment_id);
    const rentalType = body?.rental_type;
    const duration = Number(body?.duration);
    const startDate = body?.start_date;
    const successUrl = body?.success_url;
    const cancelUrl = body?.cancel_url;

    // 5. Validate booking information.
    if (
      !Number.isSafeInteger(apartmentId) ||
      apartmentId <= 0
    ) {
      return jsonResponse(
        { error: "Invalid apartment ID. Check the selected apartment." },
        400,
      );
    }

    if (!["Daily", "Monthly"].includes(rentalType)) {
      return jsonResponse(
        { error: "Rental type must be Daily or Monthly." },
        400,
      );
    }

    if (
      !Number.isInteger(duration) ||
      duration <= 0 ||
      duration > 12
    ) {
      return jsonResponse(
        { error: "Rental duration must be between 1 and 12." },
        400,
      );
    }

    if (
      typeof startDate !== "string" ||
      !isValidDate(startDate)
    ) {
      return jsonResponse(
        { error: "Invalid start date. Expected YYYY-MM-DD." },
        400,
      );
    }

    // 6. Validate redirect URLs.
    if (!validRedirect(successUrl)) {
      return jsonResponse(
        {
          error: `Invalid success URL: ${String(successUrl)}. A valid HTTP or HTTPS URL is required.`,
        },
        400,
      );
    }

    if (!validRedirect(cancelUrl)) {
      return jsonResponse(
        {
          error: `Invalid cancel URL: ${String(cancelUrl)}. A valid HTTP or HTTPS URL is required.`,
        },
        400,
      );
    }

    // 7. Reject past dates.
    if (startDate < getPhilippineToday()) {
      return jsonResponse(
        { error: "The start date cannot be in the past." },
        400,
      );
    }

    // 8. Connect to the database.
    admin = getAdminClient();

    // 9. Retrieve apartment.
    const { data: apartment, error: apartmentError } =
      await admin
        .from("apartments")
        .select("id, title, price, daily_rate, status")
        .eq("id", apartmentId)
        .maybeSingle();

    if (apartmentError) {
      console.error("Apartment query error:", apartmentError);
      throw new Error(
        `Could not retrieve apartment: ${apartmentError.message}`,
      );
    }

    if (!apartment) {
      return jsonResponse(
        { error: "Apartment not found." },
        404,
      );
    }

    if (
      apartment.status &&
      String(apartment.status).toLowerCase() !== "available"
    ) {
      return jsonResponse(
        { error: "This apartment is not currently available." },
        409,
      );
    }

    // 10. Calculate rental amount.
    const rate =
      rentalType === "Daily"
        ? Number(apartment.daily_rate ?? 0)
        : Number(apartment.price ?? 0);

    if (!Number.isFinite(rate) || rate <= 0) {
      return jsonResponse(
        {
          error: `Invalid apartment price. The ${rentalType} rental rate must be greater than zero.`,
        },
        400,
      );
    }

    const totalAmount =
      Math.round(rate * duration * 100) / 100;

    const amountInCentavos = Math.round(totalAmount * 100);

    if (
      !Number.isSafeInteger(amountInCentavos) ||
      amountInCentavos <= 0
    ) {
      return jsonResponse(
        { error: "Invalid payment amount." },
        400,
      );
    }

    // 11. Calculate end date.
    const endDate = addRentalDuration(
      startDate,
      rentalType,
      duration,
    );

    // 12. Check confirmed bookings.
    const { data: confirmedBookings, error: confirmedError } =
      await admin
        .from("bookings")
        .select("id")
        .eq("apartment_id", apartmentId)
        .eq("status", "confirmed")
        .lt("start_date", endDate)
        .gt("end_date", startDate)
        .limit(1);

    if (confirmedError) {
      throw new Error(
        `Could not check existing bookings: ${confirmedError.message}`,
      );
    }

    if (confirmedBookings?.length) {
      return jsonResponse(
        {
          error: "This apartment is already booked for those dates.",
        },
        409,
      );
    }

    // 13. Check recent pending bookings.
    const pendingCutoff = new Date(
      Date.now() - 30 * 60 * 1000,
    ).toISOString();

    const { data: pendingBookings, error: pendingError } =
      await admin
        .from("bookings")
        .select("id")
        .eq("apartment_id", apartmentId)
        .eq("status", "pending")
        .gte("created_at", pendingCutoff)
        .lt("start_date", endDate)
        .gt("end_date", startDate)
        .limit(1);

    if (pendingError) {
      throw new Error(
        `Could not check pending bookings: ${pendingError.message}`,
      );
    }

    if (pendingBookings?.length) {
      return jsonResponse(
        {
          error:
            "Another customer has a pending reservation for these dates. Please try again later.",
        },
        409,
      );
    }

    // 14. Create pending booking.
    const { data: booking, error: bookingError } =
      await admin
        .from("bookings")
        .insert({
          user_id: user.id,
          apartment_id: apartmentId,
          rental_type: rentalType,
          duration,
          start_date: startDate,
          end_date: endDate,
          total_amount: totalAmount,
          status: "pending",
        })
        .select("id")
        .single();

    if (bookingError || !booking) {
      console.error("Booking creation error:", bookingError);

      throw new Error(
        `Could not create booking: ${bookingError?.message ?? "No booking record returned."}`,
      );
    }

    bookingId = booking.id;

    // 15. Create PayMongo Checkout Session.
    const referenceNumber = `BOOKING-${booking.id}`;

    const paymongoResponse = await fetch(
      "https://api.paymongo.com/v2/checkout_sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${paymongoSecret}:`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              line_items: [
                {
                  name: `Apartment Rental - ${apartment.title}`,
                  amount: amountInCentavos,
                  currency: "PHP",
                  quantity: 1,
                },
              ],
              payment_method_types: [
                "card",
                "gcash",
                "qrph",
              ],
              success_url: successUrl,
              cancel_url: cancelUrl,
              reference_number: referenceNumber,
              send_email_receipt: true,
              metadata: {
                booking_id: String(booking.id),
                user_id: user.id,
              },
            },
          },
        }),
      },
    );

    let paymongoData: any;

    try {
      paymongoData = await paymongoResponse.json();
    } catch {
      throw new Error("PayMongo returned an unreadable response.");
    }

    if (!paymongoResponse.ok) {
      console.error(
        "PayMongo API error:",
        JSON.stringify(paymongoData),
      );

      await admin
        .from("bookings")
        .update({ status: "payment_failed" })
        .eq("id", booking.id);

      const paymongoMessage =
        paymongoData?.errors?.[0]?.detail ??
        paymongoData?.errors?.[0]?.code ??
        paymongoData?.error?.message ??
        "Unknown PayMongo API error.";

      return jsonResponse(
        {
          error: `PayMongo rejected the checkout request: ${paymongoMessage}`,
          paymongo_status: paymongoResponse.status,
        },
        502,
      );
    }

    // 16. Extract checkout details.
    const checkoutSessionId = paymongoData?.data?.id;

    const checkoutUrl =
      paymongoData?.data?.attributes?.checkout_url;

    if (
      typeof checkoutSessionId !== "string" ||
      typeof checkoutUrl !== "string" ||
      !checkoutUrl.startsWith("https://checkout.paymongo.com/")
    ) {
      console.error(
        "Invalid PayMongo checkout response:",
        JSON.stringify(paymongoData),
      );

      await admin
        .from("bookings")
        .update({ status: "payment_setup_failed" })
        .eq("id", booking.id);

      throw new Error(
        "PayMongo did not return a valid checkout URL.",
      );
    }

    // 17. Save payment record.
    const { error: paymentError } = await admin
      .from("payments")
      .insert({
        booking_id: booking.id,
        user_id: user.id,
        amount: totalAmount,
        currency: "PHP",
        payment_status: "pending",
        paymongo_checkout_session_id: checkoutSessionId,
        checkout_url: checkoutUrl,
      });

    if (paymentError) {
      console.error("Payment record error:", paymentError);

      await admin
        .from("bookings")
        .update({ status: "payment_setup_failed" })
        .eq("id", booking.id);

      throw new Error(
        `Could not save payment record: ${paymentError.message}`,
      );
    }

    // 18. Return checkout URL.
    console.log(
      `Checkout session created successfully for booking ${booking.id}.`,
    );

    return jsonResponse({
      success: true,
      booking_id: booking.id,
      checkout_url: checkoutUrl,
      total_amount: totalAmount,
      currency: "PHP",
    });
  } catch (error) {
    const message = getErrorMessage(error);

    console.error("CHECKOUT FUNCTION ERROR:", message);

    if (admin && bookingId !== null) {
      const { error: updateError } = await admin
        .from("bookings")
        .update({ status: "payment_setup_failed" })
        .eq("id", bookingId);

      if (updateError) {
        console.error(
          "Could not update failed booking:",
          updateError.message,
        );
      }
    }

    return jsonResponse(
      {
        error: message,
      },
      500,
    );
  }
});