import { ImportForm } from "@/components/ImportForm";

export const dynamic = "force-dynamic";

export default function ImportPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Importera</h2>
          <p className="page-subtitle">Ladda upp en semikolonseparerad BokaDirekt-export för att synka bokningar och patienter.</p>
        </div>
      </div>
      <ImportForm />
      <div className="notice" style={{ marginTop: 16, maxWidth: 780 }}>
        Import kan köras flera gånger utan risk. Bokningar uppdateras med befintligt boknings-ID när det finns, annars används en stabil hash baserad på datum, tidsintervall, kund, telefon, tjänst och utförare.
      </div>
    </>
  );
}
