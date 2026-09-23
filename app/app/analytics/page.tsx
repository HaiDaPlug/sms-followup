import { AnalyticsChart } from "@/components/AnalyticsChart";
import { PageHeader } from "@/components/ui/PageHeader";
import { getAnalyticsData } from "@/lib/analytics/getAnalyticsData";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const days = 90;
  const {
    series, bookings, conversions, activeBookingsCount,
    smsSentCount, smsPatientCount, conversionRate,
    attributionDays, conversionsOutsideWindow, lifetime,
  } = await getAnalyticsData(days);

  return (
    <div className="page">
      <PageHeader
        title="Analys"
        subtitle="Bokningar och SMS-utskick över tid — och om utskicken faktiskt driver återbesök."
      />
      <AnalyticsChart
        initialSeries={series}
        initialBookings={bookings}
        initialConversions={conversions}
        initialActiveBookingsCount={activeBookingsCount}
        initialSmsSentCount={smsSentCount}
        initialSmsPatientCount={smsPatientCount}
        initialConversionRate={conversionRate}
        initialDays={days}
        initialAttributionDays={attributionDays}
        initialConversionsOutsideWindow={conversionsOutsideWindow}
        initialLifetime={lifetime}
      />
    </div>
  );
}
