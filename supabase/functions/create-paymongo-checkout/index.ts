
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RentalType = "Daily" | "Monthly";

const RESERVATION_TIMEOUT_MINUTES = 10;
const RESERVATION_TIMEOUT_MS =
  RESERVATION_TIMEOUT_MINUTES * 60 * 1000;

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
    return "Unknown error.";
  }
}

// --------------------------------------------------
// ADMIN CLIENT
// --------------------------------------------------

function getAdminSecret(): string | null {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");

  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);

      if (typeof parsed === "string") {
        return parsed;
      }

      if (parsed?.default) {
        return parsed.default;
      }

      if (parsed?.service_role) {
        return parsed.service_role;
      }
    } catch {
      // Continue to other environment variables.
    }
  }

  return (
    Deno.env.get("SUPABASE_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    null
  );
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = getAdminSecret();

  if (!url || !secret) {
    throw new Error(
      "Missing Supabase server credentials. Check your Supabase environment variables.",
    );
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// --------------------------------------------------
// DATE HELPERS
// --------------------------------------------------

function addRentalDuration(
  startDate: string,
  type: RentalType,
  duration: number,
): string {
  const [year, month, day] = startDate.split("-").map(Number);

  if (type === "Daily") {
    const date = new Date(
      Date.UTC(year, month - 1, day),
    );

    date.setUTCDate(date.getUTCDate() + duration);

    return date.toISOString().slice(0, 10);
  }

  const targetMonth = month - 1 + duration;
  const targetYear =
    year + Math.floor(targetMonth / 12);

  const normalizedMonth = targetMonth % 12;

  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();

  return [
    targetYear,
    String(normalizedMonth + 1).padStart(2, "0"),
    String(Math.min(day, lastDay)).padStart(2, "0"),
  ].join("-");
}

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

function validRedirect(value: unknown): value is string {
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

// --------------------------------------------------
// PAYMONGO RETURN URL
// --------------------------------------------------

function addBookingIdToUrl(
  baseUrl: string,
  bookingId: number,
  result: "success" | "cancelled",
): string {
  const url = new URL(baseUrl);

  url.searchParams.set("booking_id", String(bookingId));
  url.searchParams.set("payment_result", result);

  return url.toString();
}

// --------------------------------------------------
// UPDATE BOOKING STATUS
// --------------------------------------------------

async function updateBookingStatus(
  admin: ReturnType<typeof getAdminClient>,
  bookingId: number,
  status: string,
) {
  const { error } = await admin
    .from("bookings")
    .update({ status })
    .eq("id", bookingId);

  if (error) {
    console.error(
      `Could not update booking ${bookingId} to ${status}:`,
      error.message,
    );
  }
}

// --------------------------------------------------
// EXPIRE OLD PENDING RESERVATIONS
// --------------------------------------------------

async function expireOldPendingReservations(
  admin: ReturnType<typeof getAdminClient>,
  apartmentId: number,
  startDate: string,
  endDate: string,
): Promise<boolean> {
  const pendingCutoffTime =
    Date.now() - RESERVATION_TIMEOUT_MS;

  const pendingCutoff = new Date(
    pendingCutoffTime,
  ).toISOString();

  const { data: pendingBookings, error: pendingError } =
    await admin
      .from("bookings")
      .select("id, created_at")
      .eq("apartment_id", apartmentId)
      .eq("status", "pending")
      .lt("start_date", endDate)
      .gt("end_date", startDate);

  if (pendingError) {
    throw new Error(
      `Could not check pending reservations: ${pendingError.message}`,
    );
  }

  if (!pendingBookings?.length) {
    return false;
  }

  const pendingIds = pendingBookings.map(
    (booking) => Number(booking.id),
  );

  const { data: existingPayments, error: paymentError } =
    await admin
      .from("payments")
      .select("booking_id, payment_status")
      .in("booking_id", pendingIds);

  if (paymentError) {
    throw new Error(
      `Could not check reservation payments: ${paymentError.message}`,
    );
  }

  const paymentStatusMap = new Map<number, string>();

  for (const payment of existingPayments || []) {
    paymentStatusMap.set(
      Number(payment.booking_id),
      String(payment.payment_status || "pending").toLowerCase(),
    );
  }

  const terminalStatuses = [
    "failed",
    "cancelled",
    "canceled",
    "expired",
    "payment_failed",
    "payment_setup_failed",
  ];

  let activeReservationFound = false;

  for (const booking of pendingBookings) {
    const id = Number(booking.id);

    const paymentStatus =
      paymentStatusMap.get(id) || "pending";

    const createdAt = new Date(
      booking.created_at,
    ).getTime();

    const isPaid = paymentStatus === "paid";

    const isTerminal = terminalStatuses.includes(
      paymentStatus,
    );

    const isOlderThan10Minutes =
      !Number.isNaN(createdAt) &&
      createdAt < pendingCutoffTime;

    // Never expire a paid reservation.
    if (isPaid) {
      console.log(
        "Paid reservation remains protected:",
        id,
      );

      activeReservationFound = true;
      continue;
    }

    // Protect recent pending reservations for 10 minutes.
    if (!isOlderThan10Minutes && !isTerminal) {
      console.log(
        "Active pending reservation:",
        id,
      );

      activeReservationFound = true;
      continue;
    }

    // Expire old unpaid or terminal reservations.
    console.log(
      "Expiring pending reservation:",
      id,
      "Payment status:",
      paymentStatus,
      "Cutoff:",
      pendingCutoff,
    );

    const { data: expiredBooking, error: expireError } =
      await admin
        .from("bookings")
        .update({
          status: "expired",
        })
        .eq("id", id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

    if (expireError) {
      throw new Error(
        `Could not expire booking ${id}: ${expireError.message}`,
      );
    }

    if (expiredBooking && paymentStatus === "pending") {
      const { error: expirePaymentError } = await admin
        .from("payments")
        .update({
          payment_status: "expired",
        })
        .eq("booking_id", id)
        .eq("payment_status", "pending");

      if (expirePaymentError) {
        throw new Error(
          `Could not expire payment for booking ${id}: ${expirePaymentError.message}`,
        );
      }
    }

    console.log(
      "Reservation expired:",
      id,
    );
  }

  return activeReservationFound;
}

// --------------------------------------------------
// MAIN EDGE FUNCTION
// --------------------------------------------------

Deno.serve(async (req: Request) => {
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
  let paymentSaved = false;

  try {
    // --------------------------------------------------
    // 1. SUPABASE CONFIGURATION
    // --------------------------------------------------

    const supabaseUrl = Deno.env.get("SUPABASE_URL");

    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    if (!supabaseUrl || !anonKey) {
      throw new Error(
        "Missing Supabase URL or public API key.",
      );
    }

    // --------------------------------------------------
    // 2. VERIFY AUTHENTICATED USER
    // --------------------------------------------------

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        {
          error:
            "Missing authentication token. Please sign in again.",
        },
        401,
      );
    }

    const accessToken = authorization.substring(7);

    const authClient = createClient(
      supabaseUrl,
      anonKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const { data: authData, error: authError } =
      await authClient.auth.getUser(accessToken);

    if (authError || !authData.user) {
      console.error(
        "Authentication error:",
        authError?.message,
      );

      return jsonResponse(
        {
          error:
            "Your session is invalid or expired. Please sign in again.",
        },
        401,
      );
    }

    const user = authData.user;

    // --------------------------------------------------
    // 3. PAYMONGO CONFIGURATION
    // --------------------------------------------------

    const paymongoSecret = Deno.env.get(
      "PAYMONGO_SECRET_KEY",
    );

    if (!paymongoSecret) {
      throw new Error(
        "PAYMONGO_SECRET_KEY is not configured in Supabase Secrets.",
      );
    }

    if (!paymongoSecret.startsWith("sk_test_")) {
      throw new Error(
        "The PayMongo secret key must be a Test Mode key beginning with sk_test_.",
      );
    }

    // --------------------------------------------------
    // 4. READ REQUEST BODY
    // --------------------------------------------------

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
    const rentalType = body?.rental_type as RentalType;
    const duration = Number(body?.duration);
    const startDate = body?.start_date;

    const successUrl = body?.success_url;
    const cancelUrl = body?.cancel_url;

    // --------------------------------------------------
    // 5. VALIDATE BOOKING DETAILS
    // --------------------------------------------------

    if (
      !Number.isSafeInteger(apartmentId) ||
      apartmentId <= 0
    ) {
      return jsonResponse(
        { error: "Invalid apartment ID." },
        400,
      );
    }

    if (!["Daily", "Monthly"].includes(rentalType)) {
      return jsonResponse(
        {
          error: "Rental type must be Daily or Monthly.",
        },
        400,
      );
    }

    if (
      !Number.isInteger(duration) ||
      duration <= 0 ||
      duration > 12
    ) {
      return jsonResponse(
        {
          error: "Rental duration must be between 1 and 12.",
        },
        400,
      );
    }

    if (
      typeof startDate !== "string" ||
      !isValidDate(startDate)
    ) {
      return jsonResponse(
        {
          error: "Invalid start date. Expected YYYY-MM-DD.",
        },
        400,
      );
    }

    if (!validRedirect(successUrl)) {
      return jsonResponse(
        { error: "Invalid success redirect URL." },
        400,
      );
    }

    if (!validRedirect(cancelUrl)) {
      return jsonResponse(
        { error: "Invalid cancel redirect URL." },
        400,
      );
    }

    if (startDate < getPhilippineToday()) {
      return jsonResponse(
        {
          error: "The start date cannot be in the past.",
        },
        400,
      );
    }

    // --------------------------------------------------
    // 6. CREATE ADMIN CLIENT
    // --------------------------------------------------

    admin = getAdminClient();

    // --------------------------------------------------
    // 7. GET APARTMENT DETAILS
    // --------------------------------------------------

    const { data: apartment, error: apartmentError } =
      await admin
        .from("apartments")
        .select("id, title, price, daily_rate, status")
        .eq("id", apartmentId)
        .maybeSingle();

    if (apartmentError) {
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
        {
          error:
            "This apartment is not currently available.",
        },
        409,
      );
    }

    // --------------------------------------------------
    // 8. CALCULATE RENTAL AMOUNT
    // --------------------------------------------------

    const rate =
      rentalType === "Daily"
        ? Number(apartment.daily_rate ?? 0)
        : Number(apartment.price ?? 0);

    if (!Number.isFinite(rate) || rate <= 0) {
      return jsonResponse(
        {
          error:
            `The ${rentalType} rental rate must be greater than zero.`,
        },
        400,
      );
    }

    const totalAmount =
      Math.round(rate * duration * 100) / 100;

    const amountInCentavos = Math.round(
      totalAmount * 100,
    );

    if (
      !Number.isSafeInteger(amountInCentavos) ||
      amountInCentavos <= 0
    ) {
      return jsonResponse(
        { error: "Invalid payment amount." },
        400,
      );
    }

    const endDate = addRentalDuration(
      startDate,
      rentalType,
      duration,
    );

    if (!isValidDate(endDate) || endDate <= startDate) {
      return jsonResponse(
        {
          error: "The calculated rental end date is invalid.",
        },
        400,
      );
    }

    console.log("--------------------------------");
    console.log("CREATING PAYMONGO CHECKOUT");
    console.log("User ID:", user.id);
    console.log("Apartment ID:", apartmentId);
    console.log("Rental Type:", rentalType);
    console.log("Duration:", duration);
    console.log("Start Date:", startDate);
    console.log("End Date:", endDate);
    console.log("Total Amount:", totalAmount);
    console.log(
      "Pending Reservation Timeout:",
      `${RESERVATION_TIMEOUT_MINUTES} minutes`,
    );
    console.log("--------------------------------");

    // --------------------------------------------------
    // 9. CHECK CONFIRMED BOOKINGS
    // --------------------------------------------------

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
        `Could not check confirmed bookings: ${confirmedError.message}`,
      );
    }

    if (confirmedBookings?.length) {
      return jsonResponse(
        {
          error:
            "This apartment is already booked for those dates. Please choose another date.",
        },
        409,
      );
    }

    // --------------------------------------------------
    // 10. CHECK AND EXPIRE PENDING RESERVATIONS
    // --------------------------------------------------

    const activeReservationFound =
      await expireOldPendingReservations(
        admin,
        apartmentId,
        startDate,
        endDate,
      );

    if (activeReservationFound) {
      return jsonResponse(
        {
          error:
            "Another customer has an active or paid reservation for these dates. Please choose another date.",
          conflict: true,
        },
        409,
      );
    }

    // --------------------------------------------------
    // 11. CREATE PENDING BOOKING
    // --------------------------------------------------

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
      throw new Error(
        `Could not create booking: ${
          bookingError?.message ??
          "No booking record returned."
        }`,
      );
    }

    bookingId = Number(booking.id);

    if (
      !Number.isSafeInteger(bookingId) ||
      bookingId <= 0
    ) {
      throw new Error(
        "Invalid booking ID returned by Supabase.",
      );
    }

    console.log("Created booking:", bookingId);

    // --------------------------------------------------
    // 12. BUILD PAYMONGO RETURN URLS
    // --------------------------------------------------

    const finalSuccessUrl = addBookingIdToUrl(
      successUrl,
      bookingId,
      "success",
    );

    const finalCancelUrl = addBookingIdToUrl(
      cancelUrl,
      bookingId,
      "cancelled",
    );

    console.log(
      "PayMongo success URL:",
      finalSuccessUrl,
    );

    console.log(
      "PayMongo cancel URL:",
      finalCancelUrl,
    );

    // --------------------------------------------------
    // 13. CREATE PAYMONGO CHECKOUT SESSION
    // --------------------------------------------------

    const referenceNumber = `BOOKING-${bookingId}`;

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
              success_url: finalSuccessUrl,
              cancel_url: finalCancelUrl,
              reference_number: referenceNumber,
              send_email_receipt: true,
              metadata: {
                booking_id: String(bookingId),
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
      throw new Error(
        "PayMongo returned an unreadable response.",
      );
    }

    if (!paymongoResponse.ok) {
      console.error(
        "PayMongo API error:",
        JSON.stringify(paymongoData),
      );

      await updateBookingStatus(
        admin,
        bookingId,
        "payment_failed",
      );

      const paymongoMessage =
        paymongoData?.errors?.[0]?.detail ??
        paymongoData?.errors?.[0]?.code ??
        paymongoData?.error?.message ??
        "Unknown PayMongo API error.";

      return jsonResponse(
        {
          error:
            `PayMongo rejected the checkout request: ${paymongoMessage}`,
          paymongo_status: paymongoResponse.status,
          booking_id: bookingId,
        },
        502,
      );
    }

    // --------------------------------------------------
    // 14. GET CHECKOUT SESSION DETAILS
    // --------------------------------------------------

    const checkoutSessionId = paymongoData?.data?.id;

    const checkoutUrl =
      paymongoData?.data?.attributes?.checkout_url;

    if (
      typeof checkoutSessionId !== "string" ||
      typeof checkoutUrl !== "string" ||
      !checkoutUrl.startsWith(
        "https://checkout.paymongo.com/",
      )
    ) {
      console.error(
        "Invalid PayMongo checkout response:",
        JSON.stringify(paymongoData),
      );

      await updateBookingStatus(
        admin,
        bookingId,
        "payment_setup_failed",
      );

      throw new Error(
        "PayMongo did not return a valid checkout session or checkout URL.",
      );
    }

    console.log(
      "Checkout Session ID:",
      checkoutSessionId,
    );

    // --------------------------------------------------
    // 15. SAVE PAYMENT RECORD
    // --------------------------------------------------

    const { error: paymentError } = await admin
      .from("payments")
      .insert({
        booking_id: bookingId,
        user_id: user.id,
        amount: totalAmount,
        currency: "PHP",
        payment_status: "pending",
        paymongo_checkout_session_id: checkoutSessionId,
        checkout_url: checkoutUrl,
      });

    if (paymentError) {
      console.error(
        "Payment database insert error:",
        paymentError.message,
      );

      await updateBookingStatus(
        admin,
        bookingId,
        "payment_setup_failed",
      );

      throw new Error(
        `Could not save payment record: ${paymentError.message}`,
      );
    }

    paymentSaved = true;

    // --------------------------------------------------
    // 16. RETURN CHECKOUT DETAILS
    // --------------------------------------------------

    console.log("--------------------------------");
    console.log("PAYMONGO CHECKOUT CREATED");
    console.log("Booking ID:", bookingId);
    console.log("Checkout Session:", checkoutSessionId);
    console.log("Amount:", totalAmount);
    console.log("--------------------------------");

    return jsonResponse({
      success: true,
      booking_id: bookingId,
      checkout_session_id: checkoutSessionId,
      checkout_url: checkoutUrl,
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
      total_amount: totalAmount,
      currency: "PHP",
    });
  } catch (error) {
    const message = getErrorMessage(error);

    console.error(
      "CREATE PAYMONGO CHECKOUT ERROR:",
      message,
    );

    if (
      admin &&
      bookingId !== null &&
      !paymentSaved
    ) {
      await updateBookingStatus(
        admin,
        bookingId,
        "payment_setup_failed",
      );
    }

    return jsonResponse(
      {
        success: false,
        error: message,
        booking_id: bookingId,
      },
      500,
    );
  }
});
