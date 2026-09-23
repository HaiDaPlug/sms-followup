/** Route transition skeleton — the shape every page shares: header, tiles, a panel. */
export default function AppLoading() {
  return (
    <div className="page route-loading" role="status" aria-live="polite" aria-label="Laddar sidan">
      <span className="sr-only">Laddar sidan…</span>

      <div className="route-loading-heading" aria-hidden="true">
        <span className="skeleton" style={{ width: 96, height: 10 }} />
        <span className="skeleton" style={{ width: 220, height: 28, borderRadius: 8 }} />
        <span className="skeleton" style={{ width: "min(440px, 72%)", height: 12 }} />
      </div>

      <div className="route-loading-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="route-loading-tile" key={item}>
            <span className="skeleton" style={{ width: "58%", height: 10 }} />
            <span className="skeleton" style={{ width: 64, height: 34, borderRadius: 8 }} />
          </div>
        ))}
      </div>

      <div className="route-loading-panel" aria-hidden="true">
        <span className="skeleton" style={{ width: 140, height: 12, marginBottom: 18 }} />
        {["68%", "52%", "74%", "40%", "61%", "47%"].map((width, index) => (
          <div className="route-loading-row" key={index}>
            <span className="skeleton" style={{ width: 16, height: 16, borderRadius: 4, flex: "0 0 auto" }} />
            <span className="skeleton" style={{ width, height: 11 }} />
            <span className="skeleton" style={{ width: 72, height: 22, marginLeft: "auto" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
