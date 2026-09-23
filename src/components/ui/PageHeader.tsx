/** Shared page header: eyebrow, serif title (with optional count), subtitle, actions. */
export function PageHeader({
  eyebrow,
  title,
  count,
  subtitle,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  count?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-head rise">
      <div style={{ minWidth: 0 }}>
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1 className="page-title">
          {title}
          {count != null && <span className="page-title-count">{count}</span>}
        </h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
