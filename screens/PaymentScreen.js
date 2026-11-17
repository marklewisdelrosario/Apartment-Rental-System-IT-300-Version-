
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

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
  Image,
} from "react-native";

import { Feather } from "@expo/vector-icons";
import * as ExpoLinking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useNavigation } from "@react-navigation/native";
import { supabase } from "../services/supabase";

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

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
        const message = await response.text();

        if (message) return message;
      } catch {}
    }
  }

  return error?.message || "An unexpected error occurred.";
}

// --------------------------------------------------
// PAYMENT SCREEN
// --------------------------------------------------

export default function PaymentScreen({ route }) {
  const navigation = useNavigation();
  const params = route?.params || {};

  const [apartment, setApartment] = useState(
    params.apartment || null
  );

  const [rentalType, setRentalType] = useState(
    params.rentalType || null
  );

  const [duration, setDuration] = useState(
    params.duration || null
  );

  const [startDate, setStartDate] = useState(
    params.startDate || null
  );

  const [endDate, setEndDate] = useState(
    params.endDate || null
  );

  const [totalAmount, setTotalAmount] = useState(
    params.totalAmount || null
  );

  const initialId =
    params.booking_id ||
    params.bookingId ||
    null;

  const [bookingId, setBookingId] = useState(
    initialId ? String(initialId) : null
  );

  const [paymentStatus, setPaymentStatus] = useState(
    initialId ? "pending" : "not_paid"
  );

  const [bookingStatus, setBookingStatus] = useState("pending");

  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState(null);
  const [paidAt, setPaidAt] = useState(null);
  const [receiptAmount, setReceiptAmount] = useState(null);

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);

  const mounted = useRef(true);
  const statusRequestRef = useRef(null);
  const appState = useRef(AppState.currentState);

  // --------------------------------------------------
  // HELPERS
  // --------------------------------------------------

  const formatDate = (value) => {
    if (!value) return "-";

    const match = String(value).match(
      /^(\d{4})-(\d{2})-(\d{2})/
    );

    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "-";

    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  };

  const formatAmount = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const normalizeStatus = (status) =>
    String(status || "pending")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());

  const currentPaymentStatus = String(
    paymentStatus || ""
  ).toLowerCase();

  const currentBookingStatus = String(
    bookingStatus || ""
  ).toLowerCase();

  const isPaid = currentPaymentStatus === "paid";

  const isPending =
    currentPaymentStatus === "pending" &&
    currentBookingStatus === "pending";

  const isCancelled =
    ["cancelled", "canceled"].includes(currentPaymentStatus) ||
    ["cancelled", "canceled"].includes(currentBookingStatus);

  const isFailed = [
    "failed",
    "expired",
    "payment_failed",
    "payment_setup_failed",
  ].includes(currentPaymentStatus);

  const canCancel = isPending && !isPaid;

  const paymentStyle = isPaid
    ? {
        color: "#15803D",
        background: "#DCFCE7",
        icon: "check-circle",
        title: "Payment Successful!",
        description:
          "Your payment has been received and verified.",
      }
    : isCancelled
    ? {
        color: "#DC2626",
        background: "#FEE2E2",
        icon: "x-circle",
        title: "Reservation Cancelled",
        description: "This reservation has been cancelled.",
      }
    : isFailed
    ? {
        color: "#DC2626",
        background: "#FEE2E2",
        icon: "alert-circle",
        title: "Payment Unsuccessful",
        description:
          "Your payment was not completed successfully.",
      }
    : {
        color: "#B45309",
        background: "#FEF3C7",
        icon: "clock",
        title: "Awaiting Payment",
        description:
          "Your reservation is pending payment confirmation.",
      };

  // --------------------------------------------------
  // FETCH BOOKING AND PAYMENT STATUS
  // --------------------------------------------------

  const checkPaymentStatus = useCallback(
    async (id, silent = false) => {
      if (!id || !mounted.current) return;

      if (statusRequestRef.current) {
        await statusRequestRef.current;

        if (!mounted.current) return;

        return checkPaymentStatus(id, silent);
      }

      if (!silent) {
        setChecking(true);
      }

      const request = (async () => {
        try {
          const numericId = Number(id);

          if (
            !Number.isSafeInteger(numericId) ||
            numericId <= 0
          ) {
            throw new Error("Invalid booking reference.");
          }

          const {
            data: booking,
            error: bookingError,
          } = await supabase
            .from("bookings")
            .select(`
              id,
              status,
              rental_type,
              duration,
              start_date,
              end_date,
              total_amount,
              apartment:apartments (
                id,
                title,
                location,
                image_url
              )
            `)
            .eq("id", numericId)
            .single();

          if (bookingError) throw bookingError;

          const {
            data: payment,
            error: paymentError,
          } = await supabase
            .from("payments")
            .select(`
              payment_status,
              paid_at,
              payment_method,
              amount,
              currency,
              checkout_url
            `)
            .eq("booking_id", numericId)
            .maybeSingle();

          if (paymentError) throw paymentError;

          if (!mounted.current) return;

          setBookingId(String(booking.id));

          setBookingStatus(
            String(booking.status || "pending").toLowerCase()
          );

          setRentalType(booking.rental_type);
          setDuration(booking.duration);
          setStartDate(booking.start_date);
          setEndDate(booking.end_date);
          setTotalAmount(booking.total_amount);

          if (booking.apartment) {
            setApartment(booking.apartment);
          }

          setPaymentStatus(
            String(
              payment?.payment_status || "pending"
            ).toLowerCase()
          );

          setPaymentMethod(payment?.payment_method || null);
          setPaidAt(payment?.paid_at || null);
          setReceiptAmount(payment?.amount || null);
          setCheckoutUrl(payment?.checkout_url || null);

          setStatusLoaded(true);

          console.log("--------------------------------");
          console.log("PAYMENT STATUS CHECK");
          console.log("Booking ID:", booking.id);
          console.log("Booking Status:", booking.status);
          console.log(
            "Payment Status:",
            payment?.payment_status
          );
          console.log("Checkout URL:", !!payment?.checkout_url);
          console.log("--------------------------------");
        } catch (error) {
          console.log("PAYMENT STATUS ERROR:", error);

          if (!silent && mounted.current) {
            Alert.alert(
              "Status Check Failed",
              error.message ||
                "Unable to retrieve payment status."
            );
          }
        }
      })();

      statusRequestRef.current = request;

      try {
        await request;
      } finally {
        if (statusRequestRef.current === request) {
          statusRequestRef.current = null;
        }

        if (!silent && mounted.current) {
          setChecking(false);
        }
      }
    },
    []
  );

  // --------------------------------------------------
  // INITIAL BOOKING ID
  // --------------------------------------------------

  useEffect(() => {
    const returnedId =
      route?.params?.booking_id ||
      route?.params?.bookingId;

    if (returnedId) {
      setBookingId(String(returnedId));
    }
  }, [
    route?.params?.booking_id,
    route?.params?.bookingId,
  ]);

  // --------------------------------------------------
  // INITIAL STATUS CHECK
  // --------------------------------------------------

  useEffect(() => {
    if (bookingId) {
      checkPaymentStatus(bookingId, true);
    }
  }, [bookingId, checkPaymentStatus]);

  // --------------------------------------------------
  // AUTOMATIC STATUS REFRESH EVERY 5 SECONDS
  // --------------------------------------------------

  useEffect(() => {
    if (!bookingId || isPaid || isCancelled || isFailed) {
      return;
    }

    const interval = setInterval(() => {
      checkPaymentStatus(bookingId, true);
    }, 5000);

    return () => clearInterval(interval);
  }, [
    bookingId,
    isPaid,
    isCancelled,
    isFailed,
    checkPaymentStatus,
  ]);

  // --------------------------------------------------
  // REFRESH WHEN APP RETURNS TO FOREGROUND
  // --------------------------------------------------

  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextState) => {
        const wasBackground = appState.current.match(
          /inactive|background/
        );

        if (
          wasBackground &&
          nextState === "active" &&
          bookingId
        ) {
          checkPaymentStatus(bookingId, true);
        }

        appState.current = nextState;
      }
    );

    return () => subscription.remove();
  }, [bookingId, checkPaymentStatus]);

  // --------------------------------------------------
  // CLEANUP
  // --------------------------------------------------

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  // --------------------------------------------------
  // BACK
  // --------------------------------------------------

  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate("Home");
    }
  };

  // --------------------------------------------------
  // VALIDATE CHECKOUT URL
  // --------------------------------------------------

  const isValidCheckoutUrl = (url) => {
    try {
      const parsed = new URL(url);

      return (
        parsed.protocol === "https:" &&
        parsed.hostname === "checkout.paymongo.com"
      );
    } catch {
      return false;
    }
  };

  // --------------------------------------------------
  // OPEN CHECKOUT IN CURRENT TAB
  // --------------------------------------------------

  const openCheckout = async (url) => {
    if (!url) {
      const message = "Checkout link is unavailable.";

      if (Platform.OS === "web") {
        window.alert(message);
      } else {
        Alert.alert("Checkout Unavailable", message);
      }

      return;
    }

    if (!isValidCheckoutUrl(url)) {
      const message = "The checkout URL is invalid.";

      if (Platform.OS === "web") {
        window.alert(message);
      } else {
        Alert.alert("Invalid Checkout", message);
      }

      return;
    }

    if (Platform.OS === "web") {
      window.location.href = url;
      return;
    }

    try {
      await WebBrowser.openBrowserAsync(url);
      await checkPaymentStatus(bookingId, true);
    } catch (error) {
      Alert.alert(
        "Checkout Error",
        error.message || "Unable to open checkout."
      );
    }
  };

  // --------------------------------------------------
  // CREATE PAYMENT CHECKOUT
  // --------------------------------------------------

  const handlePayment = async () => {
    if (loading) return;

    if (
      !apartment?.id ||
      !rentalType ||
      !duration ||
      !startDate
    ) {
      Alert.alert(
        "Missing Details",
        "Booking information is incomplete. Please return to the booking screen."
      );
      return;
    }

    setLoading(true);

    try {
      const formattedStartDate = formatDate(startDate);

      if (formattedStartDate === "-") {
        throw new Error("Invalid booking start date.");
      }

      const successUrl =
        Platform.OS === "web"
          ? `${window.location.origin}/payment?payment_result=success`
          : ExpoLinking.createURL("payment", {
              queryParams: {
                payment_result: "success",
              },
            });

      const cancelUrl =
        Platform.OS === "web"
          ? `${window.location.origin}/payment?payment_result=cancelled`
          : ExpoLinking.createURL("payment", {
              queryParams: {
                payment_result: "cancelled",
              },
            });

      const { data, error } =
        await supabase.functions.invoke(
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

      if (error) {
        throw new Error(await getFunctionError(error));
      }

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

      if (!isValidCheckoutUrl(data.checkout_url)) {
        throw new Error("Invalid PayMongo checkout URL.");
      }

      const newBookingId = String(data.booking_id);

      setBookingId(newBookingId);
      setBookingStatus("pending");
      setPaymentStatus("pending");
      setCheckoutUrl(data.checkout_url);
      setStatusLoaded(false);

      console.log("--------------------------------");
      console.log("CREATED BOOKING ID:", newBookingId);
      console.log("OPENING CHECKOUT IN CURRENT TAB");
      console.log("--------------------------------");

      if (Platform.OS === "web") {
        window.location.href = data.checkout_url;
        return;
      }

      await WebBrowser.openBrowserAsync(data.checkout_url);

      await checkPaymentStatus(newBookingId, true);
    } catch (error) {
      console.log("PAYMENT ERROR:", error);

      Alert.alert(
        "Payment Error",
        error.message || "Unable to start payment."
      );
    } finally {
      setLoading(false);
    }
  };

  // --------------------------------------------------
  // CANCEL CONFIRMATION
  // --------------------------------------------------

  const handleCancelBooking = () => {
    if (!bookingId || !canCancel || cancelling) return;

    if (Platform.OS === "web") {
      const confirmed = window.confirm(
        "Are you sure you want to cancel this unpaid reservation?"
      );

      if (confirmed) {
        confirmCancelBooking();
      }

      return;
    }

    Alert.alert(
      "Cancel Reservation",
      "Are you sure you want to cancel this unpaid reservation?",
      [
        {
          text: "Keep Reservation",
          style: "cancel",
        },
        {
          text: "Cancel Reservation",
          style: "destructive",
          onPress: confirmCancelBooking,
        },
      ]
    );
  };

  // --------------------------------------------------
  // CANCEL UNPAID BOOKING
  // --------------------------------------------------

  const confirmCancelBooking = async () => {
    if (!bookingId || cancelling || !canCancel) return;

    setCancelling(true);

    try {
      const numericBookingId = Number(bookingId);

      if (
        !Number.isSafeInteger(numericBookingId) ||
        numericBookingId <= 0
      ) {
        throw new Error("Invalid booking reference.");
      }

      console.log("========== CANCELLATION ==========");
      console.log("Booking ID:", numericBookingId);
      console.log("Payment Status:", paymentStatus);
      console.log("Booking Status:", bookingStatus);

      const { data, error } = await supabase.rpc(
        "cancel_unpaid_booking",
        {
          p_booking_id: numericBookingId,
        }
      );

      console.log("RPC RESULT:", data);
      console.log("RPC ERROR:", error);

      if (error) {
        throw error;
      }

      if (data !== true) {
        await checkPaymentStatus(bookingId, true);

        const message =
          "This reservation could not be cancelled. It may already be paid or no longer pending.";

        if (Platform.OS === "web") {
          window.alert(message);
        } else {
          Alert.alert("Unable to Cancel", message);
        }

        return;
      }

      await checkPaymentStatus(bookingId, true);

      if (Platform.OS === "web") {
        window.alert(
          "Your reservation has been cancelled successfully."
        );
      } else {
        Alert.alert(
          "Reservation Cancelled",
          "Your unpaid reservation has been cancelled successfully."
        );
      }
    } catch (error) {
      console.log("CANCEL BOOKING ERROR:", error);

      const message =
        error?.message ||
        "Unable to cancel this reservation.";

      if (Platform.OS === "web") {
        window.alert("Cancellation Failed: " + message);
      } else {
        Alert.alert("Cancellation Failed", message);
      }

      await checkPaymentStatus(bookingId, true);
    } finally {
      setCancelling(false);
    }
  };

  // --------------------------------------------------
  // BACK TO HOME AFTER PAYMENT
  // --------------------------------------------------

  const handleStatusAction = () => {
    if (isPaid) {
      navigation.reset({
        index: 0,
        routes: [{ name: "Home" }],
      });
    }
  };

  // --------------------------------------------------
  // UI
  // --------------------------------------------------

  return (
    <View style={styles.screen}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.container}
      >
        {/* HEADER */}

        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
          >
            <Feather
              name="arrow-left"
              size={21}
              color="#1E293B"
            />
          </TouchableOpacity>

          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Payment</Text>
            <Text style={styles.subtitle}>
              Review your reservation details.
            </Text>
          </View>
        </View>

        {/* APARTMENT DETAILS */}

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Feather
                name="home"
                size={18}
                color="#2563EB"
              />
            </View>

            <Text style={styles.sectionTitle}>
              Apartment Details
            </Text>
          </View>

          <View style={styles.apartmentInfo}>
            {apartment?.image_url ? (
              <Image
                source={{ uri: apartment.image_url }}
                style={styles.apartmentImage}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.apartmentImagePlaceholder}>
                <Feather
                  name="home"
                  size={26}
                  color="#2563EB"
                />
              </View>
            )}

            <View style={styles.apartmentText}>
              <Text style={styles.apartmentName}>
                {apartment?.title || "Apartment"}
              </Text>

              {!!apartment?.location && (
                <View style={styles.locationRow}>
                  <Feather
                    name="map-pin"
                    size={12}
                    color="#94A3B8"
                  />

                  <Text
                    style={styles.apartmentLocation}
                    numberOfLines={2}
                  >
                    {apartment.location}
                  </Text>
                </View>
              )}
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionSubtitle}>
            Rental Information
          </Text>

          {[
            ["Rental Type", rentalType || "-"],
            [
              "Duration",
              duration
                ? `${duration} ${
                    rentalType === "Daily"
                      ? "day(s)"
                      : "month(s)"
                  }`
                : "-",
            ],
            ["Start Date", formatDate(startDate)],
            ["End Date", formatDate(endDate)],
          ].map(([label, value], index, array) => (
            <View
              key={label}
              style={[
                styles.detailRow,
                index === array.length - 1 &&
                  styles.lastDetailRow,
              ]}
            >
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.value}>{value}</Text>
            </View>
          ))}
        </View>

        {/* TOTAL */}

        <View style={styles.amountCard}>
          <View>
            <Text style={styles.amountLabel}>
              Total
            </Text>

            <Text style={styles.amountCaption}>
              {rentalType || "Rental"} reservation
            </Text>
          </View>

          <Text style={styles.amountValue}>
            ₱{formatAmount(totalAmount)}
          </Text>
        </View>

        {/* PAYMENT STATUS */}

        {bookingId ? (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <Feather
                  name="activity"
                  size={18}
                  color="#2563EB"
                />
              </View>

              <Text style={styles.sectionTitle}>
                Payment Status
              </Text>
            </View>

            <View
              style={[
                styles.mainStatusCard,
                {
                  backgroundColor: paymentStyle.background,
                },
              ]}
            >
              <View style={styles.mainStatusIcon}>
                <Feather
                  name={paymentStyle.icon}
                  size={30}
                  color={paymentStyle.color}
                />
              </View>

              <Text
                style={[
                  styles.mainStatusTitle,
                  { color: paymentStyle.color },
                ]}
              >
                {paymentStyle.title}
              </Text>

              <Text style={styles.mainStatusDescription}>
                {paymentStyle.description}
              </Text>

              <View style={styles.mainStatusPill}>
                <View
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor: paymentStyle.color,
                    },
                  ]}
                />

                <Text
                  style={[
                    styles.mainStatusPillText,
                    { color: paymentStyle.color },
                  ]}
                >
                  {normalizeStatus(paymentStatus)}
                </Text>
              </View>

              {!statusLoaded && (
                <Text style={styles.loadingStatusText}>
                  Checking payment information...
                </Text>
              )}
            </View>

            {/* RECEIPT */}

            {isPaid && (
              <View style={styles.receiptCard}>
                <View style={styles.receiptHeader}>
                  <View style={styles.receiptIcon}>
                    <Feather
                      name="file-text"
                      size={20}
                      color="#15803D"
                    />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={styles.receiptTitle}>
                      Payment Receipt
                    </Text>

                    <Text style={styles.receiptSubtitle}>
                      Your payment has been verified.
                    </Text>
                  </View>

                  <Feather
                    name="check-circle"
                    size={21}
                    color="#15803D"
                  />
                </View>

                <View style={styles.receiptDivider} />

                {[
                  ["Booking Reference", bookingId],
                  [
                    "Amount Paid",
                    `₱${formatAmount(
                      receiptAmount || totalAmount
                    )}`,
                  ],
                  [
                    "Payment Method",
                    paymentMethod
                      ? normalizeStatus(paymentMethod)
                      : "Not available",
                  ],
                  [
                    "Payment Date",
                    paidAt
                      ? new Date(paidAt).toLocaleString("en-PH")
                      : "Not available",
                  ],
                ].map(([label, value]) => (
                  <View
                    key={label}
                    style={styles.receiptRow}
                  >
                    <Text style={styles.receiptLabel}>
                      {label}
                    </Text>

                    <Text style={styles.receiptValue}>
                      {value}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* PAY NOW AND CANCEL */}

            {isPending && (
              <>
                <TouchableOpacity
                  style={[
                    styles.payButton,
                    !checkoutUrl && styles.disabledButton,
                  ]}
                  onPress={() => openCheckout(checkoutUrl)}
                  disabled={!checkoutUrl}
                  activeOpacity={0.85}
                >
                  <Feather
                    name="credit-card"
                    size={18}
                    color="#FFFFFF"
                  />

                  <Text style={styles.buttonText}>
                    Pay Now
                  </Text>

                  <Feather
                    name="arrow-right"
                    size={17}
                    color="#FFFFFF"
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.cancelButton,
                    cancelling && styles.disabledButton,
                  ]}
                  onPress={handleCancelBooking}
                  disabled={cancelling || !canCancel}
                  activeOpacity={0.85}
                >
                  {cancelling ? (
                    <ActivityIndicator color="#DC2626" />
                  ) : (
                    <>
                      <Feather
                        name="x-circle"
                        size={17}
                        color="#DC2626"
                      />

                      <Text style={styles.cancelButtonText}>
                        Cancel Reservation
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}

            {/* BACK TO HOME - ONLY AFTER PAYMENT */}

            {isPaid && (
              <TouchableOpacity
                style={[
                  styles.checkButton,
                  styles.paidActionButton,
                ]}
                onPress={handleStatusAction}
                activeOpacity={0.8}
              >
                <Feather
                  name="home"
                  size={17}
                  color="#FFFFFF"
                />

                <Text style={styles.buttonText}>
                  Back to Home
                </Text>
              </TouchableOpacity>
            )}

            {isCancelled && (
              <Text style={styles.failedHelpText}>
                This reservation is cancelled. You can return
                to your bookings to make another reservation.
              </Text>
            )}

            {isFailed && (
              <Text style={styles.failedHelpText}>
                Your payment was not completed. Please check
                your bookings or contact the administrator.
              </Text>
            )}
          </View>
        ) : (
          <TouchableOpacity
            style={[
              styles.payButton,
              loading && styles.disabledButton,
            ]}
            onPress={handlePayment}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <View style={styles.buttonContent}>
                <ActivityIndicator color="#FFFFFF" />

                <Text style={styles.buttonText}>
                  Creating Checkout...
                </Text>
              </View>
            ) : (
              <View style={styles.buttonContent}>
                <Feather
                  name="lock"
                  size={18}
                  color="#FFFFFF"
                />

                <Text style={styles.buttonText}>
                  Proceed to Payment
                </Text>

                <Feather
                  name="arrow-right"
                  size={17}
                  color="#FFFFFF"
                />
              </View>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

// --------------------------------------------------
// STYLES
// --------------------------------------------------

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F5F7FB",
  },

  container: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 850,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 40,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 25,
    gap: 15,
  },

  backButton: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F2",
    alignItems: "center",
    justifyContent: "center",
  },

  title: {
    fontSize: 27,
    fontWeight: "800",
    color: "#172033",
  },

  subtitle: {
    fontSize: 13,
    color: "#8490A3",
    marginTop: 4,
  },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 20,
    marginBottom: 17,
    borderWidth: 1,
    borderColor: "#E9EDF5",
    elevation: 2,
  },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginBottom: 20,
  },

  sectionIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },

  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#1E293B",
  },

  apartmentInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  apartmentImage: {
    width: 65,
    height: 65,
    borderRadius: 13,
    backgroundColor: "#EFF6FF",
  },

  apartmentImagePlaceholder: {
    width: 65,
    height: 65,
    borderRadius: 13,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },

  apartmentText: {
    flex: 1,
    minWidth: 0,
  },

  apartmentName: {
    fontSize: 15,
    fontWeight: "800",
    color: "#1E293B",
  },

  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 6,
  },

  apartmentLocation: {
    fontSize: 11,
    color: "#94A3B8",
    flex: 1,
  },

  divider: {
    height: 1,
    backgroundColor: "#EDF0F5",
    marginVertical: 20,
  },

  sectionSubtitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 12,
  },

  detailRow: {
    minHeight: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    gap: 12,
  },

  lastDetailRow: {
    marginBottom: 0,
  },

  label: {
    color: "#64748B",
    fontSize: 13,
  },

  value: {
    color: "#273449",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "right",
  },

  amountCard: {
    backgroundColor: "#EFF6FF",
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#DBEAFE",
    padding: 20,
    marginBottom: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  amountLabel: {
    fontSize: 14,
    fontWeight: "800",
    color: "#1E40AF",
  },

  amountCaption: {
    fontSize: 11,
    color: "#64748B",
    marginTop: 5,
  },

  amountValue: {
    fontSize: 23,
    fontWeight: "900",
    color: "#2563EB",
    flexShrink: 1,
  },

  mainStatusCard: {
    alignItems: "center",
    paddingVertical: 25,
    paddingHorizontal: 17,
    borderRadius: 17,
    marginBottom: 17,
  },

  mainStatusIcon: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },

  mainStatusTitle: {
    fontSize: 20,
    fontWeight: "900",
    textAlign: "center",
  },

  mainStatusDescription: {
    fontSize: 12,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 19,
    marginTop: 7,
  },

  mainStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 30,
    backgroundColor: "#FFFFFF",
    marginTop: 16,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  mainStatusPillText: {
    fontSize: 11,
    fontWeight: "800",
  },

  loadingStatusText: {
    color: "#64748B",
    fontSize: 11,
    marginTop: 12,
  },

  receiptCard: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
    borderRadius: 14,
    padding: 16,
    marginTop: 4,
  },

  receiptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },

  receiptIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#DCFCE7",
    alignItems: "center",
    justifyContent: "center",
  },

  receiptTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#166534",
  },

  receiptSubtitle: {
    fontSize: 11,
    color: "#64748B",
    marginTop: 3,
  },

  receiptDivider: {
    height: 1,
    backgroundColor: "#BBF7D0",
    marginVertical: 15,
  },

  receiptRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 13,
  },

  receiptLabel: {
    fontSize: 12,
    color: "#64748B",
    flex: 1,
  },

  receiptValue: {
    fontSize: 12,
    color: "#166534",
    fontWeight: "700",
    textAlign: "right",
    flex: 1,
  },

  payButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: 5,
  },

  cancelButton: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 9,
    marginTop: 12,
  },

  cancelButtonText: {
    color: "#DC2626",
    fontSize: 13,
    fontWeight: "800",
  },

  checkButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 9,
    marginTop: 18,
  },

  paidActionButton: {
    backgroundColor: "#2563EB",
  },

  failedHelpText: {
    textAlign: "center",
    color: "#DC2626",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 13,
  },

  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  buttonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
  },

  disabledButton: {
    opacity: 0.55,
  },
});
