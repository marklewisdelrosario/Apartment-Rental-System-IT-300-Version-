
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
// FUNCTION ERROR HANDLER
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

  // --------------------------------------------------
  // BOOKING INFORMATION
  // --------------------------------------------------

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

  const initialBookingId =
    params.booking_id ||
    params.bookingId ||
    null;

  const [bookingId, setBookingId] = useState(
    initialBookingId
      ? String(initialBookingId)
      : null
  );

  // --------------------------------------------------
  // PAYMENT INFORMATION
  // --------------------------------------------------

  const [paymentStatus, setPaymentStatus] = useState(
    initialBookingId ? "pending" : "Not yet paid"
  );

  const [paymentMethod, setPaymentMethod] = useState(null);
  const [paidAt, setPaidAt] = useState(null);
  const [receiptNumber, setReceiptNumber] = useState(null);
  const [receiptAmount, setReceiptAmount] = useState(null);

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);

  // --------------------------------------------------
  // REFERENCES
  // --------------------------------------------------

  const statusCheckInProgress = useRef(false);
  const appState = useRef(AppState.currentState);
  const mounted = useRef(true);

  // --------------------------------------------------
  // FORMAT HELPERS
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

    if (Number.isNaN(date.getTime())) {
      return "-";
    }

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

  // --------------------------------------------------
  // STATUS CONDITIONS
  // --------------------------------------------------

  const currentPaymentStatus = String(
    paymentStatus || ""
  ).toLowerCase();

  const isPaid = currentPaymentStatus === "paid";

  const isFailed = [
    "failed",
    "cancelled",
    "canceled",
    "expired",
    "payment_failed",
    "payment_setup_failed",
  ].includes(currentPaymentStatus);

  const paymentStyle = isPaid
    ? {
        color: "#15803D",
        background: "#DCFCE7",
        icon: "check-circle",
        title: "Payment Successful!",
        description:
          "Your payment has been received and verified.",
      }
    : isFailed
    ? {
        color: "#DC2626",
        background: "#FEE2E2",
        icon: "x-circle",
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
          "Your payment is waiting for confirmation.",
      };

  // --------------------------------------------------
  // FETCH BOOKING AND PAYMENT STATUS
  // --------------------------------------------------

  const checkPaymentStatus = useCallback(
    async (id, silent = false) => {
      if (!id || statusCheckInProgress.current) {
        return;
      }

      statusCheckInProgress.current = true;

      if (!silent && mounted.current) {
        setChecking(true);
      }

      try {
        const numericId = Number(id);

        if (
          !Number.isSafeInteger(numericId) ||
          numericId <= 0
        ) {
          throw new Error("Invalid booking reference.");
        }

        // Get booking information.
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

        if (bookingError) {
          throw bookingError;
        }

        if (!booking) {
          throw new Error("Booking record was not found.");
        }

        // Get payment information.
        const {
          data: payment,
          error: paymentError,
        } = await supabase
          .from("payments")
          .select(`
            payment_status,
            paid_at,
            payment_method,
            receipt_number,
            amount,
            currency
          `)
          .eq("booking_id", numericId)
          .maybeSingle();

        if (paymentError) {
          throw paymentError;
        }

        if (!mounted.current) return;

        // Update screen information.
        setBookingId(String(booking.id));

        setRentalType(booking.rental_type);
        setDuration(booking.duration);
        setStartDate(booking.start_date);
        setEndDate(booking.end_date);
        setTotalAmount(booking.total_amount);

        if (booking.apartment) {
          setApartment(booking.apartment);
        }

        // Do not mark paid unless Supabase says paid.
        setPaymentStatus(
          payment?.payment_status || "pending"
        );

        setPaymentMethod(
          payment?.payment_method || null
        );

        setPaidAt(payment?.paid_at || null);

        setReceiptNumber(
          payment?.receipt_number || null
        );

        setReceiptAmount(
          payment?.amount || null
        );

        setStatusLoaded(true);

        console.log("--------------------------------");
        console.log("PAYMENT STATUS CHECK");
        console.log("Booking ID:", booking.id);
        console.log("Booking Status:", booking.status);
        console.log(
          "Payment Status:",
          payment?.payment_status
        );
        console.log(
          "Receipt Number:",
          payment?.receipt_number
        );
        console.log("Paid At:", payment?.paid_at);
        console.log("--------------------------------");
      } catch (error) {
        console.log(
          "PAYMENT STATUS ERROR:",
          error
        );

        if (!silent && mounted.current) {
          Alert.alert(
            "Status Check Failed",
            error.message ||
              "Unable to retrieve payment status."
          );
        }
      } finally {
        statusCheckInProgress.current = false;

        if (!silent && mounted.current) {
          setChecking(false);
        }
      }
    },
    []
  );

  // --------------------------------------------------
  // GET BOOKING ID FROM NAVIGATION PARAMETERS
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
  // GET BOOKING ID FROM WEB RETURN URL
  // --------------------------------------------------

  useEffect(() => {
    if (Platform.OS !== "web") return;

    try {
      const urlParams = new URLSearchParams(
        window.location.search
      );

      const returnedId =
        urlParams.get("booking_id") ||
        urlParams.get("bookingId");

      if (returnedId) {
        console.log(
          "BOOKING ID FROM PAYMONGO RETURN:",
          returnedId
        );

        setBookingId(String(returnedId));
      }
    } catch (error) {
      console.log(
        "Could not read payment return URL:",
        error
      );
    }
  }, []);

  // --------------------------------------------------
  // GET BOOKING ID FROM EXPO LINKING
  // --------------------------------------------------

  useEffect(() => {
    if (Platform.OS === "web") return;

    const subscription =
      ExpoLinking.addEventListener("url", ({ url }) => {
        try {
          const parsed = ExpoLinking.parse(url);

          const returnedId =
            parsed.queryParams?.booking_id ||
            parsed.queryParams?.bookingId;

          if (returnedId) {
            console.log(
              "BOOKING ID FROM MOBILE RETURN:",
              returnedId
            );

            setBookingId(String(returnedId));
          }
        } catch (error) {
          console.log(
            "Could not parse mobile return URL:",
            error
          );
        }
      });

    return () => subscription.remove();
  }, []);

  // --------------------------------------------------
  // INITIAL STATUS CHECK
  // --------------------------------------------------

  useEffect(() => {
    if (!bookingId) return;

    checkPaymentStatus(bookingId, true);
  }, [bookingId, checkPaymentStatus]);

  // --------------------------------------------------
  // AUTOMATIC PAYMENT STATUS REFRESH
  // --------------------------------------------------

  useEffect(() => {
    if (!bookingId || isPaid || isFailed) {
      return;
    }

    const interval = setInterval(() => {
      checkPaymentStatus(bookingId, true);
    }, 5000);

    return () => clearInterval(interval);
  }, [
    bookingId,
    isPaid,
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
  }, [
    bookingId,
    checkPaymentStatus,
  ]);

  // --------------------------------------------------
  // COMPONENT CLEANUP
  // --------------------------------------------------

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  // --------------------------------------------------
  // BACK BUTTON
  // --------------------------------------------------

  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate("Home");
    }
  };

  // --------------------------------------------------
  // PAYMENT STATUS BUTTON
  // --------------------------------------------------

  const handleStatusAction = () => {
    if (isPaid) {
      navigation.reset({
        index: 0,
        routes: [{ name: "Home" }],
      });

      return;
    }

    checkPaymentStatus(bookingId);
  };

  // --------------------------------------------------
  // START PAYMONGO CHECKOUT
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

      const mobileRedirectUrl =
        Platform.OS === "web"
          ? null
          : ExpoLinking.createURL("payment");

      console.log("--------------------------------");
      console.log("CREATING PAYMONGO CHECKOUT");
      console.log("Apartment ID:", apartment.id);
      console.log("Rental Type:", rentalType);
      console.log("Duration:", duration);
      console.log("Start Date:", formattedStartDate);
      console.log("Success URL:", successUrl);
      console.log("Cancel URL:", cancelUrl);
      console.log("--------------------------------");

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
        const actualError =
          await getFunctionError(error);

        console.log(
          "EDGE FUNCTION ERROR:",
          actualError
        );

        throw new Error(actualError);
      }

      if (!data?.success) {
        throw new Error(
          data?.error ||
            "Checkout session creation failed."
        );
      }

      if (
        !data?.checkout_url ||
        !data?.booking_id
      ) {
        throw new Error(
          "The checkout response is missing its URL or booking ID."
        );
      }

      if (
        !data.checkout_url.startsWith(
          "https://checkout.paymongo.com/"
        )
      ) {
        throw new Error(
          "Invalid PayMongo checkout URL."
        );
      }

      const newBookingId = String(data.booking_id);

      // Save the booking ID before redirecting.
      setBookingId(newBookingId);
      setPaymentStatus("pending");
      setStatusLoaded(false);

      console.log(
        "CREATED BOOKING ID:",
        newBookingId
      );

      if (Platform.OS === "web") {
        // Use the same browser tab.
        // PayMongo redirects back to the payment screen.
        window.location.href = data.checkout_url;

        return;
      }

      // Mobile checkout.
      const result =
        await WebBrowser.openAuthSessionAsync(
          data.checkout_url,
          mobileRedirectUrl
        );

      console.log(
        "PAYMONGO BROWSER RESULT:",
        result
      );

      // Verify the actual saved status.
      await checkPaymentStatus(newBookingId);
    } catch (error) {
      console.log("PAYMENT ERROR:", error);

      Alert.alert(
        "Payment Error",
        error.message ||
          "Unable to start payment."
      );
    } finally {
      setLoading(false);
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
            activeOpacity={0.75}
          >
            <Feather
              name="arrow-left"
              size={21}
              color="#1E293B"
            />
          </TouchableOpacity>

          <View style={styles.headerText}>
            <Text style={styles.title}>
              Payment
            </Text>

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
                source={{
                  uri: apartment.image_url,
                }}
                style={styles.apartmentImage}
                resizeMode="cover"
              />
            ) : (
              <View
                style={styles.apartmentImagePlaceholder}
              >
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

              {apartment?.location ? (
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
              ) : null}
            </View>

            <View style={styles.selectedBadge}>
              <View style={styles.selectedDot} />

              <Text style={styles.selectedText}>
                Selected
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionSubtitle}>
            Rental Information
          </Text>

          {[
            {
              label: "Rental Type",
              value: rentalType || "-",
              icon: "calendar",
            },
            {
              label: "Duration",
              value: duration
                ? `${duration} ${
                    rentalType === "Daily"
                      ? "day(s)"
                      : "month(s)"
                  }`
                : "-",
              icon: "clock",
            },
            {
              label: "Start Date",
              value: formatDate(startDate),
              icon: "calendar",
            },
            {
              label: "End Date",
              value: formatDate(endDate),
              icon: "calendar",
            },
          ].map((item, index, array) => (
            <View
              key={item.label}
              style={[
                styles.detailRow,
                index === array.length - 1 &&
                  styles.lastDetailRow,
              ]}
            >
              <View style={styles.detailLeft}>
                <View style={styles.detailIcon}>
                  <Feather
                    name={item.icon}
                    size={15}
                    color="#64748B"
                  />
                </View>

                <Text style={styles.label}>
                  {item.label}
                </Text>
              </View>

              <Text style={styles.value}>
                {item.value}
              </Text>
            </View>
          ))}
        </View>

        {/* TOTAL AMOUNT */}

        <View style={styles.amountCard}>
          <View>
            <Text style={styles.amountLabel}>
              Grand Total
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

        {bookingId && (
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
                  backgroundColor:
                    paymentStyle.background,
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
                  {
                    color: paymentStyle.color,
                  },
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
                      backgroundColor:
                        paymentStyle.color,
                    },
                  ]}
                />

                <Text
                  style={[
                    styles.mainStatusPillText,
                    {
                      color: paymentStyle.color,
                    },
                  ]}
                >
                  {normalizeStatus(paymentStatus)}
                </Text>
              </View>

              {!statusLoaded && !isPaid && (
                <Text style={styles.loadingStatusText}>
                  Checking payment information...
                </Text>
              )}
            </View>

            {/* RECEIPT - ONLY WHEN SUPABASE CONFIRMS PAID */}

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

                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>
                    Receipt Number
                  </Text>

                  <Text style={styles.receiptValue}>
                    {receiptNumber || "Generating..."}
                  </Text>
                </View>

                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>
                    Amount Paid
                  </Text>

                  <Text style={styles.receiptValue}>
                    ₱
                    {formatAmount(
                      receiptAmount || totalAmount
                    )}
                  </Text>
                </View>

                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>
                    Payment Method
                  </Text>

                  <Text style={styles.receiptValue}>
                    {paymentMethod
                      ? normalizeStatus(paymentMethod)
                      : "Not available"}
                  </Text>
                </View>

                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>
                    Payment Date
                  </Text>

                  <Text style={styles.receiptValue}>
                    {paidAt
                      ? new Date(
                          paidAt
                        ).toLocaleString("en-PH")
                      : "Not available"}
                  </Text>
                </View>
              </View>
            )}

            {/* STATUS BUTTON */}

            <TouchableOpacity
              style={[
                styles.checkButton,
                isPaid && styles.paidActionButton,
              ]}
              onPress={handleStatusAction}
              disabled={checking && !isPaid}
              activeOpacity={0.8}
            >
              {checking && !isPaid ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Feather
                    name={isPaid ? "home" : "refresh-cw"}
                    size={17}
                    color="#FFFFFF"
                  />

                  <Text style={styles.buttonText}>
                    {isPaid
                      ? "Back to Home"
                      : "Refresh Payment Status"}
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {!isPaid && !isFailed && (
              <Text style={styles.autoRefreshText}>
                Automatically checking for payment updates
              </Text>
            )}

            {isFailed && (
              <Text style={styles.failedHelpText}>
                If you believe your payment was successful,
                refresh the status or contact the administrator.
              </Text>
            )}
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
                  size={18}
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

  headerText: {
    flex: 1,
  },

  title: {
    fontSize: 27,
    fontWeight: "800",
    color: "#172033",
    letterSpacing: -0.7,
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
    shadowColor: "#172033",
    shadowOffset: {
      width: 0,
      height: 3,
    },
    shadowOpacity: 0.04,
    shadowRadius: 10,
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

  sectionSubtitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 17,
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

  selectedBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 5,
  },

  selectedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#2563EB",
  },

  selectedText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#2563EB",
  },

  divider: {
    height: 1,
    backgroundColor: "#EDF0F5",
    marginVertical: 20,
  },

  detailRow: {
    minHeight: 42,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    gap: 12,
  },

  lastDetailRow: {
    marginBottom: 0,
  },

  detailLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    flex: 1,
  },

  detailIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },

  label: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: "500",
  },

  value: {
    color: "#273449",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "right",
    flexShrink: 0,
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
    elevation: 2,
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

  checkButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 9,
    marginTop: 22,
  },

  paidActionButton: {
    backgroundColor: "#2563EB",
  },

  autoRefreshText: {
    textAlign: "center",
    color: "#94A3B8",
    fontSize: 11,
    marginTop: 13,
  },

  failedHelpText: {
    textAlign: "center",
    color: "#DC2626",
    fontSize: 11,
    lineHeight: 18,
    marginTop: 13,
  },

  payButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 17,
    paddingHorizontal: 20,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
    shadowColor: "#2563EB",
    shadowOffset: {
      width: 0,
      height: 5,
    },
    shadowOpacity: 0.18,
    shadowRadius: 9,
    elevation: 4,
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
    opacity: 0.65,
  },
});
