import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { jsPDF } from "jspdf";

type User = "najani" | "ali";

type Booking = {
  id: number;
  date: string; // YYYY-MM-DD
  user_name: User;
  created_at?: string;
};

type BillingPeriodStatus = {
  id?: number;
  start_date: string; // inklusiv
  end_date: string; // exklusiv (10. des Folgemonats)
  is_paid: boolean;
};

const DAILY_RATE = 2.5;
const MONTHLY_RENT = 50;
const CONTRACT_START_DATE = "2025-11-10"; // Anker: 10. -> 10.

// -------- Date Utils --------

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addOneMonth(date: Date): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Generiert Abrechnungszeiträume:
 * - Start = CONTRACT_START_DATE
 * - jeder Zeitraum = [start, start+1 Monat) (Ende exklusiv)
 * - mindestens bis zum Zeitraum, der maxRelevantStr enthält
 * - wenn letzter gespeicherter Zeitraum bezahlt ist, ein zusätzlicher Zeitraum
 */
function generateBillingPeriods(
  maxRelevantStr: string,
  paid: BillingPeriodStatus[]
): { start: string; end: string }[] {
  const contractStart = parseDate(CONTRACT_START_DATE);
  const maxRelevant = parseDate(maxRelevantStr);

  let endLimit = addOneMonth(contractStart);
  while (maxRelevant >= endLimit) {
    endLimit = addOneMonth(endLimit);
  }

  if (paid.length > 0) {
    const latestPaid = paid.reduce((acc, cur) => {
      const accEnd = parseDate(acc.end_date);
      const curEnd = parseDate(cur.end_date);
      return curEnd > accEnd ? cur : acc;
    });
    if (latestPaid.is_paid) {
      const latestPaidEnd = parseDate(latestPaid.end_date);
      if (latestPaidEnd >= endLimit) {
        endLimit = addOneMonth(latestPaidEnd);
      }
    }
  }

  const periods: { start: string; end: string }[] = [];
  let start = new Date(contractStart);

  while (start < endLimit) {
    const end = addOneMonth(start);
    periods.push({
      start: formatDate(start),
      end: formatDate(end),
    });
    start = end;
  }

  return periods;
}

// Monatslabel, z.B. "November 2025"
function getMonthLabel(year: number, month: number): string {
  const formatter = new Intl.DateTimeFormat("de-CH", {
    month: "long",
    year: "numeric",
  });
  return formatter.format(new Date(year, month, 1));
}

/**
 * Kalenderzellen (Montag erste Spalte), month: 0-11
 */
function getCalendarCells(year: number, month: number) {
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const daysInMonth = lastOfMonth.getDate();

  const startWeekday = (firstOfMonth.getDay() + 6) % 7; // Mo=0..So=6

  const cells: { date: string; inCurrentMonth: boolean }[] = [];

  // Tage aus Vormonat
  for (let i = 0; i < startWeekday; i++) {
    const d = new Date(year, month, 1 - (startWeekday - i));
    cells.push({ date: formatDate(d), inCurrentMonth: false });
  }

  // Tage aktueller Monat
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    cells.push({ date: formatDate(d), inCurrentMonth: true });
  }

  // Tage nächster Monat bis volle Woche
  const rest = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= rest; i++) {
    const d = new Date(year, month + 1, i);
    cells.push({ date: formatDate(d), inCurrentMonth: false });
  }

  return cells;
}

// -------- App --------

const App: React.FC = () => {
  const [activeUser, setActiveUser] = useState<User>("najani");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [billingStatuses, setBillingStatuses] = useState<BillingPeriodStatus[]>(
    []
  );
  const [selectedDate, setSelectedDate] = useState<string>(formatDate(new Date()));
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);

  const today = formatDate(new Date());

  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const calendarCells = getCalendarCells(currentMonth.year, currentMonth.month);
  const monthLabel = getMonthLabel(currentMonth.year, currentMonth.month);

  const goToPrevMonth = () => {
    setCurrentMonth((prev) => {
      const m = prev.month - 1;
      if (m < 0) return { year: prev.year - 1, month: 11 };
      return { year: prev.year, month: m };
    });
  };

  const goToNextMonth = () => {
    setCurrentMonth((prev) => {
      const m = prev.month + 1;
      if (m > 11) return { year: prev.year + 1, month: 0 };
      return { year: prev.year, month: m };
    });
  };

  const goToTodayMonth = () => {
    const d = new Date();
    setCurrentMonth({ year: d.getFullYear(), month: d.getMonth() });
    setSelectedDate(formatDate(d));
  };

  // ---- Helpers ----

  const getBookingForDate = (date: string): Booking | undefined =>
    bookings.find((b) => b.date === date);

  const setSavingState = (value: boolean) => setSaving(value);

  const updateLocalBookings = (next: Booking[]) => {
    const sorted = [...next].sort((a, b) => a.date.localeCompare(b.date));
    setBookings(sorted);
  };

  // ---- Initial load ----

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);

      const [
        { data: bookingsData, error: bookingsError },
        { data: billingData, error: billingError },
      ] = await Promise.all([
        supabase.from("bookings").select("*").order("date", { ascending: true }),
        supabase.from("billing_periods").select("*"),
      ]);

      if (bookingsError) {
        console.error("Fehler beim Laden (bookings):", bookingsError);
        alert("Konnte Buchungen nicht laden. Bitte Supabase prüfen.");
      } else if (bookingsData) {
        setBookings(bookingsData as Booking[]);
      }

      if (billingError) {
        console.error("Fehler beim Laden (billing_periods):", billingError);
      } else if (billingData) {
        setBillingStatuses(billingData as BillingPeriodStatus[]);
      }

      setLoading(false);
    };

    loadData();
  }, []);

  // ---- Booking setzen: niemand überschreibt ----

  const setBooking = async (date: string, user: User) => {
    if (!date) return;

    const existing = getBookingForDate(date);
    if (existing) {
      if (existing.user_name === user) return; // gleiche Person klickt doppelt
      alert("Für dieses Datum ist bereits jemand eingetragen.");
      return;
    }

    setSavingState(true);
    const { data, error } = await supabase
      .from("bookings")
      .insert({ date, user_name: user })
      .select();
    setSavingState(false);

    if (error) {
      console.error("Insert-Fehler:", error);
      alert("Konnte Eintrag nicht speichern.");
      return;
    }

    if (data && data[0]) {
      updateLocalBookings([...bookings, data[0] as Booking]);
    }
  };

  // ---- Delete Booking: nur eigene Einträge ----

  const deleteBooking = async (booking: Booking) => {
    if (booking.user_name !== activeUser) {
      alert("Du kannst nur deine eigenen Einträge löschen.");
      return;
    }

    setSavingState(true);
    const { error } = await supabase.from("bookings").delete().eq("id", booking.id);
    setSavingState(false);

    if (error) {
      console.error("Delete-Fehler:", error);
      alert("Konnte Eintrag nicht löschen.");
      return;
    }

    updateLocalBookings(bookings.filter((b) => b.id !== booking.id));
  };

  const deleteBookingByDate = async (date: string) => {
    const booking = getBookingForDate(date);
    if (!booking) {
      alert("Für dieses Datum gibt es keinen Eintrag.");
      return;
    }
    await deleteBooking(booking);
  };

  // ---- Billing Periods & Summaries ----

  const lastBookingDate =
    bookings.length > 0 ? bookings[bookings.length - 1].date : today;

  const maxOfTodayAndSelected = selectedDate > today ? selectedDate : today;
  const maxRelevant =
    lastBookingDate > maxOfTodayAndSelected
      ? lastBookingDate
      : maxOfTodayAndSelected;

  const billingPeriods = generateBillingPeriods(maxRelevant, billingStatuses);

  const billingSummaries = billingPeriods.map((p) => {
    const bookingsInPeriod = bookings.filter(
      (b) => b.date >= p.start && b.date < p.end
    );

    const aliDays = bookingsInPeriod.filter((b) => b.user_name === "ali").length;
    const aliAmount = Math.min(aliDays * DAILY_RATE, MONTHLY_RENT);
    const najaniPays = Math.max(MONTHLY_RENT - aliAmount, 0);

    const status = billingStatuses.find(
      (s) => s.start_date === p.start && s.end_date === p.end
    );
    const isPaid = status?.is_paid ?? false;

    const endDisplay = p.end;
    const isCurrent =
      selectedDate >= p.start && selectedDate < p.end;

    return {
      ...p,
      endDisplay,
      aliDays,
      aliAmount,
      najaniPays,
      isPaid,
      isCurrent,
    };
  });

  const currentSummary =
    billingSummaries.find((p) => p.isCurrent) ||
    billingSummaries[billingSummaries.length - 1];

  const monthlyBookings =
    currentSummary
      ? bookings.filter(
          (b) =>
            b.date >= currentSummary.start &&
            b.date < currentSummary.end
        )
      : [];

  const currentAliDays = monthlyBookings.filter(
    (b) => b.user_name === "ali"
  ).length;
  const currentAliAmount = Math.min(
    currentAliDays * DAILY_RATE,
    MONTHLY_RENT
  );
  const currentNajaniPays = Math.max(
    MONTHLY_RENT - currentAliAmount,
    0
  );

  const todayBooking = getBookingForDate(today);
  const selectedBooking = getBookingForDate(selectedDate);

  // ---- Toggle Billing Paid ----

  const toggleBillingPaid = async (
    start: string,
    end: string,
    currentPaid: boolean
  ) => {
    const newPaid = !currentPaid;

    const { data, error } = await supabase
      .from("billing_periods")
      .upsert(
        {
          start_date: start,
          end_date: end,
          is_paid: newPaid,
        },
        { onConflict: "start_date,end_date" }
      )
      .select();

    if (error) {
      console.error("Fehler beim Speichern des Zahlungsstatus:", error);
      alert("Konnte Zahlungsstatus nicht speichern.");
      return;
    }

    if (data && data[0]) {
      const row = data[0] as BillingPeriodStatus;
      setBillingStatuses((prev) => {
        const others = prev.filter(
          (p) =>
            !(
              p.start_date === row.start_date &&
              p.end_date === row.end_date
            )
        );
        return [...others, row];
      });
    }
  };

  // ---- PDF Download für Zeitraum ----

  const downloadPeriodPdf = (period: {
    start: string;
    end: string;
    endDisplay: string;
    aliDays: number;
    aliAmount: number;
    najaniPays: number;
    isPaid: boolean;
  }) => {
    const doc = new jsPDF();

    doc.setFontSize(14);
    doc.text("Parkplatz-Abrechnung", 14, 16);

    doc.setFontSize(10);
    doc.text(
      `Zeitraum: ${period.start} bis ${period.endDisplay}`,
      14,
      24
    );
    doc.text(
      `Status: ${period.isPaid ? "bezahlt" : "offen"}`,
      14,
      30
    );

    let y = 40;
    doc.setFontSize(11);
    doc.text("Zusammenfassung", 14, y);
    y += 6;

    doc.setFontSize(10);
    doc.text(
      `Ali: ${period.aliDays} Tag(e)  →  CHF ${period.aliAmount.toFixed(
        2
      )}`,
      14,
      y
    );
    y += 5;
    doc.text(
      `Najani: CHF ${period.najaniPays.toFixed(2)}`,
      14,
      y
    );
    y += 8;

    doc.setFontSize(11);
    doc.text("Details pro Tag", 14, y);
    y += 6;
    doc.setFontSize(9);

    const bookingsInPeriod = bookings
      .filter(
        (b) => b.date >= period.start && b.date < period.end
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    if (bookingsInPeriod.length === 0) {
      doc.text("Keine Buchungen in diesem Zeitraum.", 14, y);
    } else {
      bookingsInPeriod.forEach((b) => {
        if (y > 280) {
          doc.addPage();
          y = 20;
        }
        const who = b.user_name === "ali" ? "Ali" : "Najani";
        doc.text(`${b.date}: ${who}`, 14, y);
        y += 5;
      });
    }

    doc.save(`parkplatz_${period.start}_${period.endDisplay}.pdf`);
  };

  // ---- Styles ----

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    width: "100vw",
    margin: 0,
    padding: 0,
    display: "flex",
    justifyContent: "center",
    background: "#f1f5f9",
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  };

  const wrapperStyle: React.CSSProperties = {
    width: "100%",
    padding: "16px",
    boxSizing: "border-box",
  };

  const card: React.CSSProperties = {
    background: "#ffffff",
    borderRadius: "16px",
    padding: "12px 14px",
    boxShadow: "0 4px 10px rgba(15,23,42,0.06)",
    marginBottom: "12px",
  };

  const primaryBtn: React.CSSProperties = {
    border: "none",
    borderRadius: "14px",
    padding: "10px",
    fontSize: "0.85rem",
    fontWeight: 500,
    background: "#0f172a",
    color: "#ffffff",
    width: "100%",
    cursor: "pointer",
  };

  const secondaryBtn: React.CSSProperties = {
    ...primaryBtn,
    background: "#e5e7eb",
    color: "#111827",
  };

  const smallDeleteBtn: React.CSSProperties = {
    border: "none",
    borderRadius: "999px",
    padding: "4px 8px",
    fontSize: "0.65rem",
    background: "#fee2e2",
    color: "#b91c1c",
    cursor: "pointer",
    marginLeft: "6px",
  };

  const pill = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    borderRadius: "999px",
    fontSize: "0.7rem",
    border: active ? "none" : "1px solid #e5e7eb",
    background: active ? "#0f172a" : "#ffffff",
    color: active ? "#ffffff" : "#4b5563",
    cursor: "pointer",
  });

  // ---- JSX ----

  return (
    <div style={pageStyle}>
      <div style={wrapperStyle}>
        {/* HEADER */}
        <h1
          style={{
            textAlign: "center",
            fontSize: "1.6rem",
            fontWeight: 600,
            marginBottom: 4,
            color: "#0f172a",
          }}
        >
          Parkplatz Tracker 🚗
        </h1>
        <p
          style={{
            textAlign: "center",
            fontSize: "0.7rem",
            color: "#6b7280",
            marginBottom: 10,
          }}
        >
          Ein Eintrag pro Tag. Beide sehen immer denselben Stand.
        </p>

        {/* USER SWITCH */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <button
            style={pill(activeUser === "najani")}
            onClick={() => setActiveUser("najani")}
          >
            Ich bin Najani
          </button>
          <button
            style={pill(activeUser === "ali")}
            onClick={() => setActiveUser("ali")}
          >
            Ich bin Ali
          </button>
        </div>

        {/* SEKTION 1: HEUTE */}
        <div style={card}>
          <div
            style={{
              fontSize: "0.7rem",
              color: "#9ca3af",
              marginBottom: 4,
            }}
          >
            Heute
          </div>

          {loading ? (
            <div
              style={{ fontSize: "0.8rem", color: "#9ca3af" }}
            >
              Lade…
            </div>
          ) : todayBooking ? (
            <div style={{ fontSize: "1rem" }}>
              Status:{" "}
              <span
                style={{ color: "#ef4444", fontWeight: 600 }}
              >
                besetzt von{" "}
                {todayBooking.user_name === "najani"
                  ? "Najani"
                  : "Ali"}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: "1rem" }}>
              Status:{" "}
              <span
                style={{ color: "#22c55e", fontWeight: 600 }}
              >
                frei
              </span>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginTop: 10,
            }}
          >
            <button
              style={primaryBtn}
              onClick={() => setBooking(today, "najani")}
            >
              Najani parkt heute
            </button>
            <button
              style={secondaryBtn}
              onClick={() => setBooking(today, "ali")}
            >
              Ali parkt heute
            </button>
          </div>

          {todayBooking &&
            todayBooking.user_name === activeUser && (
              <div style={{ marginTop: 6 }}>
                <button
                  style={smallDeleteBtn}
                  onClick={() => deleteBookingByDate(today)}
                >
                  Eintrag für heute löschen
                </button>
              </div>
            )}

          {saving && (
            <div
              style={{
                marginTop: 4,
                fontSize: "0.6rem",
                color: "#9ca3af",
              }}
            >
              Speichere…
            </div>
          )}
        </div>

        {/* SEKTION 2: MONATSKALENDER */}
        <div style={card}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 4,
              gap: 4,
            }}
          >
            <button
              onClick={goToPrevMonth}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: "0.9rem",
                color: "#111827",
              }}
            >
              «
            </button>
            <div
              style={{
                fontSize: "0.85rem",
                fontWeight: 600,
                color: "#111827",
              }}
            >
              {monthLabel}
            </div>
            <div
              style={{
                display: "flex",
                gap: 4,
                alignItems: "center",
              }}
            >
              <button
                onClick={goToTodayMonth}
                style={{
                  border: "none",
                  background: "#0f172a",
                  color: "#ffffff",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontSize: "0.6rem",
                  cursor: "pointer",
                }}
              >
                Heute
              </button>
              <button
                onClick={goToNextMonth}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                  color: "#111827",
                }}
              >
                »
              </button>
            </div>
          </div>

          <div
            style={{
              fontSize: "0.65rem",
              color: "#6b7280",
              marginBottom: 6,
            }}
          >
            Violett = Najani, Blau = Ali, Grau = frei. Tippe auf
            einen Tag, um ihn unten zu wählen.
          </div>

          {/* Wochentage */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              fontSize: "0.6rem",
              color: "#9ca3af",
              marginBottom: 4,
              textAlign: "center",
            }}
          >
            <div>Mo</div>
            <div>Di</div>
            <div>Mi</div>
            <div>Do</div>
            <div>Fr</div>
            <div>Sa</div>
            <div>So</div>
          </div>

          {/* Tage */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
            }}
          >
            {calendarCells.map(({ date, inCurrentMonth }) => {
              const booking = getBookingForDate(date);
              const dayNum = parseInt(date.split("-")[2], 10);

              let bg = "#e5e7eb";
              let color = "#6b7280";

              if (booking?.user_name === "najani") {
                bg = "#ede9fe"; // violett
                color = "#6d28d9";
              } else if (booking?.user_name === "ali") {
                bg = "#dbeafe"; // blau
                color = "#1d4ed8";
              }

              const isToday = date === today;
              const isSelected = date === selectedDate;
              const opacity = inCurrentMonth ? 1 : 0.35;

              return (
                <button
                  key={date}
                  onClick={() => setSelectedDate(date)}
                  style={{
                    border: "none",
                    borderRadius: "10px",
                    padding: "4px 0",
                    fontSize: "0.7rem",
                    background: bg,
                    color,
                    cursor: "pointer",
                    opacity,
                    outline: isSelected
                      ? "2px solid #0f172a"
                      : isToday
                      ? "1px solid #9ca3af"
                      : "none",
                    boxShadow: isSelected
                      ? "0 0 0 1px rgba(15,23,42,0.05)"
                      : "none",
                  }}
                >
                  {dayNum}
                </button>
              );
            })}
          </div>

          {/* Aktionen für ausgewählten Tag */}
          <div
            style={{
              marginTop: 8,
              fontSize: "0.7rem",
              color: "#6b7280",
            }}
          >
            Ausgewählt: <strong>{selectedDate}</strong>{" "}
            {selectedBooking && (
              <>
                – aktuell{" "}
                <strong>
                  {selectedBooking.user_name === "najani"
                    ? "Najani"
                    : "Ali"}
                </strong>
              </>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              marginTop: 6,
            }}
          >
            <button
              style={primaryBtn}
              onClick={() => setBooking(selectedDate, "najani")}
            >
              Najani parkt (Tag setzen)
            </button>
            <button
              style={secondaryBtn}
              onClick={() => setBooking(selectedDate, "ali")}
            >
              Ali parkt (Tag setzen)
            </button>
          </div>

          {selectedBooking &&
            selectedBooking.user_name === activeUser && (
              <div style={{ marginTop: 6 }}>
                <button
                  style={smallDeleteBtn}
                  onClick={() =>
                    deleteBookingByDate(selectedDate)
                  }
                >
                  Eintrag für {selectedDate} löschen
                </button>
              </div>
            )}
        </div>

        {/* SEKTION 3: ABRECHNUNGEN NACH ZEITRÄUMEN */}
        <div style={card}>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              marginBottom: 6,
              color: "#111827",
            }}
          >
            Abrechnungen nach Zeitraum
          </div>

          {billingSummaries.length === 0 ? (
            <div
              style={{
                fontSize: "0.7rem",
                color: "#9ca3af",
              }}
            >
              Noch keine Abrechnungszeiträume.
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {billingSummaries
                .slice()
                .sort((a, b) => a.start.localeCompare(b.start))
                .map((p) => (
                  <div
                    key={p.start}
                    style={{
                      padding: "6px 8px",
                      borderRadius: "10px",
                      border: "1px solid #e5e7eb",
                      background: p.isCurrent
                        ? "#eff6ff"
                        : "#f9fafb",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      fontSize: "0.75rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            color: "#111827",
                          }}
                        >
                          {p.start} – {p.endDisplay}
                          {p.isCurrent && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: "0.65rem",
                                color: "#2563eb",
                              }}
                            >
                              (für Auswahl)
                            </span>
                          )}
                        </div>
                        <div
                          style={{ color: "#4b5563" }}
                        >
                          Ali: {p.aliDays} Tag(e), zahlt{" "}
                          <strong>
                            CHF {p.aliAmount.toFixed(2)}
                          </strong>
                          {" · "}
                          Najani zahlt{" "}
                          <strong>
                            CHF {p.najaniPays.toFixed(2)}
                          </strong>
                        </div>
                        <div
                          style={{
                            fontSize: "0.65rem",
                            color: p.isPaid
                              ? "#16a34a"
                              : "#dc2626",
                          }}
                        >
                          Status:{" "}
                          {p.isPaid ? "bezahlt" : "offen"}
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          alignItems: "flex-end",
                        }}
                      >
                        <button
                          onClick={() =>
                            toggleBillingPaid(
                              p.start,
                              p.end,
                              p.isPaid
                            )
                          }
                          style={{
                            border: "none",
                            borderRadius: "999px",
                            padding: "4px 8px",
                            fontSize: "0.65rem",
                            cursor: "pointer",
                            background: p.isPaid
                              ? "#e5e7eb"
                              : "#111827",
                            color: p.isPaid
                              ? "#111827"
                              : "#ffffff",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.isPaid
                            ? "als offen markieren"
                            : "als bezahlt markieren"}
                        </button>
                        <button
                          onClick={() =>
                            downloadPeriodPdf(p)
                          }
                          style={{
                            border: "1px solid #e5e7eb",
                            borderRadius: "999px",
                            padding: "4px 8px",
                            fontSize: "0.65rem",
                            cursor: "pointer",
                            background: "#ffffff",
                            color: "#111827",
                            whiteSpace: "nowrap",
                          }}
                        >
                          PDF downloaden
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* SEKTION 4: LISTE FÜR GEWÄHLTEN ZEITRAUM */}
        <div style={card}>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              marginBottom: 4,
              color: "#111827",
            }}
          >
            Buchungen (gewählter Zeitraum)
          </div>
          {!currentSummary || monthlyBookings.length === 0 ? (
            <div
              style={{
                fontSize: "0.7rem",
                color: "#9ca3af",
              }}
            >
              Noch keine Buchungen.
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "#6b7280",
                  marginBottom: 4,
                }}
              >
                Zeitraum {currentSummary.start} –{" "}
                {currentSummary.endDisplay} · Ali zahlt{" "}
                <strong>
                  CHF {currentAliAmount.toFixed(2)}
                </strong>{" "}
                · Najani zahlt{" "}
                <strong>
                  CHF {currentNajaniPays.toFixed(2)}
                </strong>
              </div>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  fontSize: "0.8rem",
                  color: "#111827",
                }}
              >
                {monthlyBookings
                  .slice()
                  .sort((a, b) =>
                    a.date.localeCompare(b.date)
                  )
                  .map((b) => (
                    <li
                      key={b.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 0",
                        borderBottom:
                          "1px solid #f3f4f6",
                      }}
                    >
                      <div>
                        <span
                          style={{
                            fontWeight: 500,
                          }}
                        >
                          {b.date}
                        </span>
                        <span
                          style={{ marginLeft: 8 }}
                        >
                          {b.user_name === "najani" ? (
                            <span
                              style={{
                                padding:
                                  "2px 8px",
                                borderRadius:
                                  "999px",
                                background:
                                  "#ede9fe",
                                color:
                                  "#6d28d9",
                                fontSize:
                                  "0.7rem",
                                fontWeight: 600,
                              }}
                            >
                              Najani
                            </span>
                          ) : (
                            <span
                              style={{
                                padding:
                                  "2px 8px",
                                borderRadius:
                                  "999px",
                                background:
                                  "#dbeafe",
                                color:
                                  "#1d4ed8",
                                fontSize:
                                  "0.7rem",
                                fontWeight: 600,
                              }}
                            >
                              Ali
                            </span>
                          )}
                        </span>
                      </div>

                      {b.user_name ===
                        activeUser && (
                        <button
                          style={{
                            border: "none",
                            borderRadius:
                              "999px",
                            padding:
                              "4px 8px",
                            fontSize:
                              "0.65rem",
                            background:
                              "#fee2e2",
                            color:
                              "#b91c1c",
                            cursor:
                              "pointer",
                          }}
                          onClick={() =>
                            deleteBooking(b)
                          }
                        >
                          löschen
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>

        <div
          style={{
            textAlign: "center",
            fontSize: "0.6rem",
            color: "#9ca3af",
            marginTop: 4,
          }}
        >
          © 2025 Parking Tracker from Dragon to Dragon
        </div>
      </div>
    </div>
  );
};

export default App;
