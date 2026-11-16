
























import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  AppState,
  Platform,
} from "react-native";

import * as ExpoLinking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "../services/supabase";

// Extract the actual error returned by Supabase Edge Functions.
async function getFunctionError(error) {
  if (error?.context) {
    try {
      const response = error.context.clone();
      const body = await response.json();

      return (
        body.error ||
        body.message ||
        body.msg ||
        JSON.stringify(body)
      );
    } catch {
      try {
        const response = error.context.clone();
        const text = await response.text();

        if (text) return text;
      } catch {
        // Use the generic error below.
      }
    }
  }

  return error?.message || "An unexpected error occurred.";
}

export default function PaymentScreen({ route }) {
  const {
    apartment,
    rentalType,
    duration,
    startDate,
    endDate,
    totalAmount,
  } = route.params || {};

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [bookingId, setBookingId] = useState(null);
  const [bookingStatus, setBookingStatus] = useState("Not yet booked");
  const [paymentStatus, setPaymentStatus] = useState("Not yet paid");

  // Format date without changing the local calendar day.
  const formatDate = (value) => {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  };

  // Check actual booking and payment status in Supabase.
  const checkPaymentStatus = useCallback(async (id) => {
    if (!id) return;

    setChecking(true);

    try {
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .select("id, status")
        .eq("id", id)
        .single();

      if (bookingError) throw bookingError;

      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .select("payment_status")
        .eq("booking_id", id)
        .maybeSingle();

      if (paymentError) throw paymentError;

      setBookingStatus(booking?.status || "pending");
      setPaymentStatus(payment?.payment_status || "pending");

    } catch (error) {
      console.log("Payment status error:", error);

      Alert.alert(
        "Status Check Failed",
        error.message || "Unable to retrieve payment status."
      );
    } finally {
      setChecking(false);
    }
  }, []);

  // Refresh payment status when returning to the app.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "active" && bookingId) {
          checkPaymentStatus(bookingId);
        }
      }
    );

    return () => subscription.remove();
  }, [bookingId, checkPaymentStatus]);

  // Start PayMongo checkout.
  const handlePayment = async () => {
    if (loading) return;

    if (!apartment?.id || !rentalType || !duration || !startDate) {
      Alert.alert(
        "Missing Details",
        "Booking information is incomplete. Please return to the booking screen."
      );
      return;
    }

    // On web, open a blank tab immediately from the button click.
    // This prevents the browser from blocking the later checkout URL.
    let checkoutWindow = null;

    if (Platform.OS === "web") {
      checkoutWindow = window.open("about:blank", "_blank");

      if (!checkoutWindow) {
        Alert.alert(
          "Popup Blocked",
          "Please allow popups for this website and try again."
        );
        return;
      }
    }

    setLoading(true);

    try {
      const formattedStartDate = formatDate(startDate);

      if (!formattedStartDate) {
        throw new Error("Invalid booking start date.");
      }

      const successUrl = ExpoLinking.createURL("payment-success");
      const cancelUrl = ExpoLinking.createURL("payment-cancelled");

      console.log("--------------------------------");
      console.log("CREATING PAYMONGO CHECKOUT");
      console.log("Apartment ID:", apartment.id);
      console.log("Rental Type:", rentalType);
      console.log("Duration:", duration);
      console.log("Start Date:", formattedStartDate);
      console.log("Success URL:", successUrl);
      console.log("Cancel URL:", cancelUrl);
      console.log("--------------------------------");

      const { data, error } = await supabase.functions.invoke(
        "create-paymongo-checkout",
        {
          body: {
            apartment_id: apartment.id,
            rental_type: rentalType,
            duration: Number(duration),
            start_date: formattedStartDate,
            success_url: successUrl,
            cancel_url: cancelUrl,
          },
        }
      );

      // Show the real Edge Function error.
      if (error) {
        const actualError = await getFunctionError(error);

        console.log("EDGE FUNCTION ERROR:", actualError);

        throw new Error(actualError);
      }

      console.log("CHECKOUT RESPONSE:", data);

      if (!data?.success) {
        throw new Error(
          data?.error || "Checkout session creation failed."
        );
      }

      if (!data?.checkout_url || !data?.booking_id) {
        throw new Error(
          "The checkout response is missing its URL or booking ID."
        );
      }

      if (
        typeof data.checkout_url !== "string" ||
        !data.checkout_url.startsWith(
          "https://checkout.paymongo.com/"
        )
      ) {
        throw new Error("Invalid PayMongo checkout URL.");
      }

      // Save booking information.
      setBookingId(data.booking_id);
      setBookingStatus("pending");
      setPaymentStatus("pending");

      console.log("PAYMONGO CHECKOUT URL:", data.checkout_url);

      // WEB: Navigate the already-opened tab to PayMongo.
      if (Platform.OS === "web") {
        checkoutWindow.location.href = data.checkout_url;
      } else {
        // MOBILE: Open the PayMongo hosted checkout.
        const result = await WebBrowser.openBrowserAsync(
          data.checkout_url
        );

        console.log("BROWSER RESULT:", result);

        // Refresh status when the customer closes the browser.
        await checkPaymentStatus(data.booking_id);
      }

    } catch (error) {
      console.log("PAYMENT ERROR:", error);

      // Close the blank browser tab if checkout creation failed.
      if (checkoutWindow && !checkoutWindow.closed) {
        checkoutWindow.close();
      }

      Alert.alert(
        "Payment Error",
        error.message || "Unable to start payment."
      );

    } finally {
      setLoading(false);
    }
  };

  const handleCheckStatus = () => {
    checkPaymentStatus(bookingId);
  };

  const isPaid = paymentStatus?.toLowerCase() === "paid";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Payment</Text>

      <Text style={styles.subtitle}>
        Review your booking details before proceeding.
      </Text>

      {/* BOOKING SUMMARY */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Booking Summary</Text>

        <View style={styles.detailRow}>
          <Text style={styles.label}>Apartment</Text>
          <Text style={styles.value}>
            {apartment?.title || "Apartment"}
          </Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.label}>Rental Type</Text>
          <Text style={styles.value}>{rentalType || "-"}</Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.label}>Duration</Text>
          <Text style={styles.value}>
            {duration || "-"}{" "}
            {rentalType === "Daily" ? "day(s)" : "month(s)"}
          </Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.label}>Start Date</Text>
          <Text style={styles.value}>
            {formatDate(startDate) || "-"}
          </Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.label}>End Date</Text>
          <Text style={styles.value}>
            {formatDate(endDate) || "-"}
          </Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total Amount</Text>

          <Text style={styles.totalAmount}>
            ₱
            {Number(totalAmount || 0).toLocaleString("en-PH", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </Text>
        </View>
      </View>

      {/* PAYMENT STATUS */}
      {bookingId && (
        <View style={styles.statusCard}>
          <Text style={styles.sectionTitle}>Payment Status</Text>

          <Text style={styles.label}>
            Booking ID: {bookingId}
          </Text>

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Booking</Text>
            <Text style={styles.statusValue}>
              {bookingStatus}
            </Text>
          </View>

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Payment</Text>

            <Text
              style={[
                styles.statusValue,
                isPaid ? styles.paidText : styles.pendingText,
              ]}
            >
              {paymentStatus}
            </Text>
          </View>

          {isPaid && (
            <Text style={styles.successText}>
              Payment confirmed! Your booking is confirmed.
            </Text>
          )}

          {!isPaid && (
            <Text style={styles.pendingMessage}>
              Your payment has not yet been confirmed. If you have
              completed payment, please check again in a moment.
            </Text>
          )}

          <TouchableOpacity
            style={styles.checkButton}
            onPress={handleCheckStatus}
            disabled={checking}
          >
            {checking ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>
                Check Payment Status
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* PROCEED TO PAYMENT */}
      {!bookingId && (
        <TouchableOpacity
          style={[
            styles.payButton,
            loading && styles.disabledButton,
          ]}
          onPress={handlePayment}
          disabled={loading}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.buttonText}>
                Creating Checkout...
              </Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>
              Proceed to Payment
            </Text>
          )}
        </TouchableOpacity>
      )}

      <Text style={styles.note}>
        Payments are processed securely through PayMongo. Your booking
        will only be confirmed after the payment webhook verifies
        the transaction.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: "#F8F9FA",
    padding: 20,
  },

  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#1F2937",
    marginBottom: 6,
  },

  subtitle: {
    color: "#6B7280",
    marginBottom: 22,
    fontSize: 14,
  },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
    elevation: 2,
  },

  sectionTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#1F2937",
    marginBottom: 18,
  },

  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
    gap: 12,
  },

  label: {
    color: "#6B7280",
    fontSize: 14,
  },

  value: {
    color: "#1F2937",
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },

  divider: {
    height: 1,
    backgroundColor: "#E5E7EB",
    marginVertical: 12,
  },

  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  totalLabel: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#1F2937",
  },

  totalAmount: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#2563EB",
  },

  payButton: {
    backgroundColor: "#2563EB",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
  },

  disabledButton: {
    opacity: 0.7,
  },

  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  checkButton: {
    backgroundColor: "#2563EB",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 16,
  },

  buttonText: {
    color: "#FFFFFF",
    fontWeight: "bold",
    fontSize: 15,
  },

  statusCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
    elevation: 2,
  },

  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 14,
  },

  statusLabel: {
    color: "#6B7280",
    fontSize: 14,
  },

  statusValue: {
    color: "#1F2937",
    fontSize: 14,
    fontWeight: "600",
    textTransform: "capitalize",
  },

  paidText: {
    color: "#15803D",
  },

  pendingText: {
    color: "#D97706",
  },

  successText: {
    color: "#15803D",
    fontWeight: "bold",
    marginTop: 16,
  },

  pendingMessage: {
    color: "#6B7280",
    fontSize: 13,
    marginTop: 16,
    lineHeight: 19,
  },

  note: {
    color: "#6B7280",
    fontSize: 12,
    textAlign: "center",
    marginTop: 18,
    lineHeight: 18,
  },
});
