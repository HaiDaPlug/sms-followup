import { AnalyticsChart } from "@/components/AnalyticsChart";
import { getAnalyticsData } from "@/lib/analytics/getAnalyticsData";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const days = 90;
  const {
    series, bookings, conversions, activeBookingsCount,
    smsSentCount, smsPatientCount, conversionRate,
  } = await getAnalyticsData(days);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Analys</h2>
          <p className="page-subtitle">Bokningar och SMS-utskick över tid — se om utskicken driver återbesök.</p>
        </div>
      </div>
      <AnalyticsChart
        initialSeries={series}
        initialBookings={bookings}
        initialConversions={conversions}
        initialActiveBookingsCount={activeBookingsCount}
        initialSmsSentCount={smsSentCount}
        initialSmsPatientCount={smsPatientCount}
        initialConversionRate={conversionRate}
        initialDays={days}
      />
    </>
  );
}
