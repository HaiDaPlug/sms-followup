export default function AppLoading() {
  return (
    <div className="route-loading" role="status" aria-live="polite" aria-label="Laddar sidan">
      <span className="route-loading-sr">Laddar sidan…</span>

      <div className="route-loading-heading" aria-hidden="true">
        <span className="route-skeleton route-skeleton-kicker" />
        <span className="route-skeleton route-skeleton-title" />
        <span className="route-skeleton route-skeleton-subtitle" />
      </div>

      <div className="route-loading-metrics" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="route-loading-metric" key={item}>
            <span className="route-skeleton route-skeleton-label" />
            <span className="route-skeleton route-skeleton-value" />
          </div>
        ))}
      </div>

      <div className="route-loading-columns" aria-hidden="true">
        <div className="route-loading-panel">
          <span className="route-skeleton route-skeleton-panel-title" />
          {["wide", "medium", "wide", "short", "medium"].map((width, index) => (
            <div className="route-loading-row" key={`${width}-${index}`}>
              <span className="route-skeleton route-skeleton-dot" />
              <span className={`route-skeleton route-skeleton-line ${width}`} />
              <span className="route-skeleton route-skeleton-chip" />
            </div>
          ))}
        </div>
        <div className="route-loading-panel route-loading-panel-compact">
          <span className="route-skeleton route-skeleton-panel-title" />
          <span className="route-skeleton route-skeleton-block" />
          <span className="route-skeleton route-skeleton-block short" />
        </div>
      </div>
    </div>
  );
}
