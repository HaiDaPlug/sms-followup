import { ImportForm } from "@/components/ImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconInfo } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function ImportPage() {
  return (
    <div className="page">
      <PageHeader
        title="Importera"
        subtitle="Ladda upp en semikolonseparerad BokaDirekt-export för att synka bokningar och patienter."
      />
      <ImportForm />
      <div className="notice info rise" style={{ ["--i" as string]: 2, marginTop: 16, maxWidth: 820 }}>
        <IconInfo />
        <span>
          Import kan köras flera gånger utan risk. Bokningar uppdateras med befintligt boknings-ID när det finns, annars
          används en stabil hash baserad på datum, tidsintervall, kund, telefon, tjänst och utförare.
        </span>
      </div>
    </div>
  );
}
