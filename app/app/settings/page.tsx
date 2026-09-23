import { SettingsForm } from "@/components/SettingsForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSettings } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="page">
      <PageHeader
        title="Inställningar"
        subtitle="Konfigurera när, hur och vad som skickas — och om det skickas på riktigt."
      />
      <SettingsForm settings={settings} />
    </div>
  );
}
