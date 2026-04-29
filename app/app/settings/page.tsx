import { SettingsForm } from "@/components/SettingsForm";
import { getSettings } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Inställningar</h2>
          <p className="page-subtitle">Konfigurера när, hur och vad som skickas — och om det skickas på riktigt.</p>
        </div>
      </div>
      <SettingsForm settings={settings} />
    </>
  );
}
