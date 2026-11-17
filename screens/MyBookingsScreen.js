
import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from "react-native";

import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { supabase } from "../services/supabase";

const BLUE = "#2563EB";
const GREEN = "#15803D";
const ORANGE = "#D97706";
const RED = "#DC2626";
const TEXT = "#111827";
const MUTED = "#64748B";
const BORDER = "#E5E7EB";
const BG = "#F8FAFC";

const FILTERS = [
  "All",
  "Pending",
  "Confirmed",
  "Completed",
  "Cancelled",
];

export default function MyBookingsScreen({ navigation }) {
  const { width } = useWindowDimensions();
  const isMobile = width < 700;

  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");

  const formatDate = (date) => {
    if (!date) return "N/A";

    const value = new Date(`${date}T00:00:00`);
    if (Number.isNaN(value.getTime())) return "N/A";

    return value.toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatDateTime = (date) => {
    if (!date) return "N/A";

    const value = new Date(date);
    if (Number.isNaN(value.getTime())) return "N/A";

    return value.toLocaleString("en-PH", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatCurrency = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      style: "currency",
      currency: "PHP",
    });

  const getStatus = (booking) => {
    const status = String(booking.status || "").toLowerCase();

    if (status === "cancelled" || status === "canceled") {
      return "Cancelled";
    }

    if (status === "completed") return "Completed";

    if (status === "confirmed") {
      if (
        booking.end_date &&
        new Date(`${booking.end_date}T00:00:00`) <
          new Date(new Date().toDateString())
      ) {
        return "Completed";
      }

      return "Confirmed";
    }

    return "Pending";
  };

  const getStatusColor = (status) => {
    switch (String(status).toLowerCase()) {
      case "confirmed":
      case "paid":
      case "completed":
        return GREEN;
      case "cancelled":
      case "canceled":
      case "failed":
      case "payment_failed":
        return RED;
      case "pending":
      case "unpaid":
        return ORANGE;
      default:
        return MUTED;
    }
  };

  const loadBookings = useCallback(async () => {
    try {
      setError("");

      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError) throw authError;

      if (!user) {
        setBookings([]);
        setError("Please log in to view your bookings.");
        return;
      }

      const { data, error: bookingError } = await supabase
        .from("bookings")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (bookingError) throw bookingError;

      if (!data || data.length === 0) {
        setBookings([]);
        return;
      }

      const apartmentIds = [
        ...new Set(data.map((item) => item.apartment_id)),
      ];

      const bookingIds = data.map((item) => item.id);

      const [apartmentsResult, paymentsResult] = await Promise.all([
        supabase
          .from("apartments")
          .select("id, title, location, image_url")
          .in("id", apartmentIds),

        supabase
          .from("payments")
          .select("*")
          .in("booking_id", bookingIds)
          .eq("user_id", user.id),
      ]);

      if (apartmentsResult.error) throw apartmentsResult.error;
      if (paymentsResult.error) throw paymentsResult.error;

      const apartmentMap = {};
      const paymentMap = {};

      (apartmentsResult.data || []).forEach((item) => {
        apartmentMap[item.id] = item;
      });

      (paymentsResult.data || []).forEach((item) => {
        paymentMap[item.booking_id] = item;
      });

      setBookings(
        data.map((booking) => {
          const apartment = apartmentMap[booking.apartment_id] || {};
          const payment = paymentMap[booking.id] || {};

          return {
            ...booking,
            apartment_title: apartment.title || "Apartment",
            apartment_location:
              apartment.location || "Location unavailable",
            image_url: apartment.image_url || null,
            payment_status: payment.payment_status || "pending",
            payment_method: payment.payment_method || null,
            paid_at: payment.paid_at || null,
          };
        })
      );
    } catch (err) {
      console.error("MY BOOKINGS ERROR:", err);
      setError(err.message || "Unable to load bookings.");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      const fetchData = async () => {
        setLoading(true);
        await loadBookings();
        if (active) setLoading(false);
      };

      fetchData();

      return () => {
        active = false;
      };
    }, [loadBookings])
  );

  const refresh = async () => {
    setRefreshing(true);
    await loadBookings();
    setRefreshing(false);
  };

  const filteredBookings = useMemo(() => {
    if (activeFilter === "All") return bookings;

    return bookings.filter(
      (booking) => getStatus(booking) === activeFilter
    );
  }, [bookings, activeFilter]);

  const counts = useMemo(
    () => ({
      total: bookings.length,
      pending: bookings.filter((b) => getStatus(b) === "Pending").length,
      confirmed: bookings.filter((b) => getStatus(b) === "Confirmed").length,
      completed: bookings.filter((b) => getStatus(b) === "Completed").length,
    }),
    [bookings]
  );

  const renderStat = (label, value, color, icon) => (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: `${color}15` }]}>
        <Feather name={icon} size={17} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.statNumber}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    </View>
  );

  const renderDetail = (icon, label, value) => (
    <View style={styles.detailItem}>
      <Feather name={icon} size={13} color={MUTED} />
      <View style={styles.detailInfo}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue} numberOfLines={1}>
          {value || "N/A"}
        </Text>
      </View>
    </View>
  );

  const renderBooking = (booking) => {
    const status = getStatus(booking);
    const color = getStatusColor(status);
    const paymentColor = getStatusColor(booking.payment_status);

    return (
      <View
        key={booking.id}
        style={[
          styles.bookingCard,
          isMobile && styles.mobileBookingCard,
        ]}
      >
        {/* Apartment photo */}
        <View
          style={[
            styles.photoContainer,
            isMobile && styles.mobilePhotoContainer,
          ]}
        >
          {booking.image_url ? (
            <Image
              source={{ uri: booking.image_url }}
              style={styles.apartmentImage}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.noImage}>
              <Feather name="image" size={28} color="#94A3B8" />
              <Text style={styles.noImageText}>No apartment photo</Text>
            </View>
          )}
        </View>

        {/* Booking details */}
        <View style={styles.bookingContent}>
          <View style={styles.bookingTop}>
            <View style={styles.apartmentInfo}>
              <Text style={styles.apartmentTitle} numberOfLines={1}>
                {booking.apartment_title}
              </Text>

              <View style={styles.locationRow}>
                <Feather name="map-pin" size={11} color={MUTED} />
                <Text style={styles.locationText} numberOfLines={1}>
                  {booking.apartment_location}
                </Text>
              </View>
            </View>

            <View
              style={[
                styles.statusBadge,
                { backgroundColor: `${color}15` },
              ]}
            >
              <View style={[styles.statusDot, { backgroundColor: color }]} />
              <Text style={[styles.statusText, { color }]}>
                {status}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionTitle}>RENTAL DETAILS</Text>

          <View style={styles.detailsGrid}>
            {renderDetail(
              "calendar",
              "Check-in",
              formatDate(booking.start_date)
            )}
            {renderDetail(
              "calendar",
              "Check-out",
              formatDate(booking.end_date)
            )}
            {renderDetail(
              "home",
              "Rental Type",
              booking.rental_type
            )}
            {renderDetail(
              "clock",
              "Duration",
              `${booking.duration} ${
                booking.rental_type === "Monthly" ? "month(s)" : "day(s)"
              }`
            )}
          </View>

          <View style={styles.divider} />

          <View style={styles.paymentHeader}>
            <Text style={styles.sectionTitle}>PAYMENT</Text>

            <View
              style={[
                styles.paymentBadge,
                { backgroundColor: `${paymentColor}15` },
              ]}
            >
              <Text style={[styles.paymentStatus, { color: paymentColor }]}>
                {booking.payment_status}
              </Text>
            </View>
          </View>

          <View style={styles.paymentDetails}>
            <View style={styles.paymentInfo}>
              <Text style={styles.detailLabel}>Method</Text>
              <Text style={styles.detailValue} numberOfLines={1}>
                {booking.payment_method || "Not available"}
              </Text>
            </View>

            {booking.paid_at ? (
              <View style={styles.paymentInfo}>
                <Text style={styles.detailLabel}>Date Paid</Text>
                <Text style={styles.detailValue} numberOfLines={1}>
                  {formatDateTime(booking.paid_at)}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.totalRow}>
            <View>
              <Text style={styles.totalLabel}>TOTAL AMOUNT</Text>
              <Text style={styles.totalAmount}>
                {formatCurrency(booking.total_amount)}
              </Text>
            </View>

            <View style={styles.referenceBox}>
              <Text style={styles.referenceLabel}>BOOKING ID</Text>
              <Text style={styles.referenceValue}>#{booking.id}</Text>
            </View>
          </View>

          {status === "Pending" && (
            <View style={styles.pendingNotice}>
              <Feather name="info" size={13} color={ORANGE} />
              <Text style={styles.pendingText}>
                Awaiting payment confirmation.
              </Text>
            </View>
          )}

          <Text style={styles.createdDate}>
            Booked on {formatDate(booking.created_at?.slice(0, 10))}
          </Text>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color={BLUE} />
        <Text style={styles.loadingText}>Loading your bookings...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            colors={[BLUE]}
          />
        }
      >
        {/* Header - scrolls with the page like Apartment Details */}
        <View style={styles.topBar}>
          <Pressable
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Feather name="arrow-left" size={22} color="#17243A" />
          </Pressable>

          <Text style={styles.pageHeaderTitle}>My Bookings</Text>

          <Pressable
            style={styles.refreshButton}
            onPress={refresh}
          >
            <Feather name="refresh-cw" size={18} color={BLUE} />
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Feather name="alert-circle" size={25} color={RED} />
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryButton} onPress={refresh}>
              <Text style={styles.retryText}>Try Again</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* Overview */}
            <View style={styles.pageIntro}>
              <Text style={styles.pageTitle}>Your Reservations</Text>
              <Text style={styles.pageDescription}>
                Keep track of your apartment rental bookings.
              </Text>
            </View>

            <View style={styles.statsGrid}>
              {renderStat("Total Bookings", counts.total, BLUE, "layers")}
              {renderStat("Pending", counts.pending, ORANGE, "clock")}
              {renderStat("Confirmed", counts.confirmed, GREEN, "check-circle")}
              {renderStat("Completed", counts.completed, BLUE, "calendar")}
            </View>

            {/* Booking History */}
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.historyTitle}>Booking History</Text>
                <Text style={styles.historySubtitle}>
                  {filteredBookings.length} reservation(s)
                </Text>
              </View>
            </View>

            {/* Filters */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filters}
            >
              {FILTERS.map((filter) => {
                const selected = activeFilter === filter;

                return (
                  <Pressable
                    key={filter}
                    onPress={() => setActiveFilter(filter)}
                    style={[
                      styles.filterButton,
                      selected && styles.selectedFilter,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterText,
                        selected && styles.selectedFilterText,
                      ]}
                    >
                      {filter}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Booking cards */}
            {filteredBookings.length > 0 ? (
              filteredBookings.map(renderBooking)
            ) : (
              <View style={styles.emptyCard}>
                <View style={styles.emptyIcon}>
                  <Feather name="calendar" size={32} color="#94A3B8" />
                </View>

                <Text style={styles.emptyTitle}>
                  {bookings.length === 0
                    ? "No Bookings Yet"
                    : "No Bookings Found"}
                </Text>

                <Text style={styles.emptyDescription}>
                  {bookings.length === 0
                    ? "Your apartment reservations will appear here after you make a booking."
                    : `You don't have any ${activeFilter.toLowerCase()} bookings.`}
                </Text>

                {bookings.length === 0 && (
                  <Pressable
                    style={styles.browseButton}
                    onPress={() => navigation.navigate("Home")}
                  >
                    <Text style={styles.browseText}>Browse Apartments</Text>
                    <Feather name="arrow-right" size={15} color="#FFFFFF" />
                  </Pressable>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: BG,
  },

  loadingScreen: {
    flex: 1,
    backgroundColor: BG,
    alignItems: "center",
    justifyContent: "center",
  },

  loadingText: {
    marginTop: 10,
    fontSize: 13,
    color: MUTED,
  },

  mainScroll: {
    flex: 1,
    width: "100%",
  },

  mainContent: {
    width: "100%",
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 35,
  },

  /* Header matching ApartmentDetailsScreen */
  topBar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
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

  pageHeaderTitle: {
    fontSize: 21,
    fontWeight: "800",
    color: "#17243A",
  },

  refreshButton: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F2",
    alignItems: "center",
    justifyContent: "center",
  },

  pageIntro: {
    marginBottom: 16,
  },

  pageTitle: {
    fontSize: 21,
    fontWeight: "800",
    color: TEXT,
  },

  pageDescription: {
    fontSize: 12,
    color: MUTED,
    marginTop: 4,
  },

  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 24,
  },

  statCard: {
    flex: 1,
    minWidth: 150,
    backgroundColor: "#FFFFFF",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  statIcon: {
    width: 37,
    height: 37,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },

  statNumber: {
    fontSize: 20,
    fontWeight: "800",
    color: TEXT,
  },

  statLabel: {
    fontSize: 10,
    color: MUTED,
    marginTop: 2,
  },

  historyHeader: {
    marginBottom: 12,
  },

  historyTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: TEXT,
  },

  historySubtitle: {
    fontSize: 11,
    color: MUTED,
    marginTop: 3,
  },

  filters: {
    gap: 8,
    paddingBottom: 14,
  },

  filterButton: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: BORDER,
  },

  selectedFilter: {
    backgroundColor: BLUE,
    borderColor: BLUE,
  },

  filterText: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
  },

  selectedFilterText: {
    color: "#FFFFFF",
  },

  bookingCard: {
    width: "100%",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 15,
    marginBottom: 15,
    overflow: "hidden",
    flexDirection: "row",
  },

  photoContainer: {
    width: "50%",
    aspectRatio: 1.7,
    backgroundColor: "#F1F5F9",
    padding: 0,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },

  apartmentImage: {
    width: "100%",
    height: "100%",
    backgroundColor: "#F1F5F9",
  },

  noImage: {
    flex: 1,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },

  noImageText: {
    fontSize: 11,
    color: MUTED,
    marginTop: 7,
  },

  bookingContent: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },

  bookingTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },

  apartmentInfo: {
    flex: 1,
    minWidth: 0,
  },

  apartmentTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: TEXT,
  },

  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },

  locationText: {
    fontSize: 10,
    color: MUTED,
    flexShrink: 1,
  },

  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 18,
    gap: 5,
  },

  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 5,
  },

  statusText: {
    fontSize: 9,
    fontWeight: "800",
  },

  divider: {
    height: 1,
    backgroundColor: BORDER,
    marginVertical: 10,
  },

  sectionTitle: {
    fontSize: 9,
    fontWeight: "800",
    color: MUTED,
    letterSpacing: 0.8,
    marginBottom: 9,
  },

  detailsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 10,
  },

  detailItem: {
    width: "50%",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingRight: 8,
  },

  detailInfo: {
    flex: 1,
    minWidth: 0,
  },

  detailLabel: {
    fontSize: 9,
    color: MUTED,
    marginBottom: 2,
  },

  detailValue: {
    fontSize: 10,
    fontWeight: "700",
    color: TEXT,
  },

  paymentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },

  paymentBadge: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 15,
  },

  paymentStatus: {
    fontSize: 9,
    fontWeight: "800",
    textTransform: "capitalize",
  },

  paymentDetails: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 15,
  },

  paymentInfo: {
    minWidth: 100,
    flex: 1,
  },

  totalRow: {
    backgroundColor: "#F8FAFC",
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  totalLabel: {
    fontSize: 8,
    color: MUTED,
    fontWeight: "800",
  },

  totalAmount: {
    fontSize: 17,
    color: BLUE,
    fontWeight: "900",
    marginTop: 2,
  },

  referenceBox: {
    alignItems: "flex-end",
  },

  referenceLabel: {
    fontSize: 8,
    fontWeight: "800",
    color: MUTED,
  },

  referenceValue: {
    fontSize: 11,
    fontWeight: "800",
    color: TEXT,
    marginTop: 3,
  },

  pendingNotice: {
    backgroundColor: "#FFFBEB",
    padding: 7,
    borderRadius: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },

  pendingText: {
    fontSize: 9,
    color: "#92400E",
    flex: 1,
  },

  createdDate: {
    color: MUTED,
    fontSize: 9,
    marginTop: 7,
  },

  mobileBookingCard: {
    flexDirection: "column",
  },

  mobilePhotoContainer: {
    width: "100%",
    height: 155,
    aspectRatio: undefined,
    minHeight: 155,
    padding: 0,
  },

  emptyCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 15,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 30,
    alignItems: "center",
  },

  emptyIcon: {
    width: 65,
    height: 65,
    backgroundColor: "#F1F5F9",
    borderRadius: 35,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 13,
  },

  emptyTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: TEXT,
  },

  emptyDescription: {
    maxWidth: 320,
    textAlign: "center",
    color: MUTED,
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },

  browseButton: {
    backgroundColor: BLUE,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 17,
  },

  browseText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 11,
  },

  errorCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#FECACA",
  },

  errorText: {
    fontSize: 12,
    color: RED,
    textAlign: "center",
    marginTop: 10,
  },

  retryButton: {
    backgroundColor: BLUE,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 14,
  },

  retryText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
  },
});
