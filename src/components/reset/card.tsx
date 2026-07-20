import type { CSSProperties, ReactNode } from "react";

/* Approved card grammar (tokens.css .card/.hd/.ti/.st/.bd/.foot/.legend).
   Presentational only — no data fetching. */

export type CardProps = {
  /** Card title (.ti). Wrapped in a [data-def] definition span when def is set. */
  title?: ReactNode;
  def?: string;
  /** Subtitle line (.st). */
  subtitle?: ReactNode;
  /** Right-hand header slot (legend, seg control, ctl button…). */
  aside?: ReactNode;
  /** Footer row (.foot). */
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export function Card({ title, def, subtitle, aside, footer, className, style, children }: CardProps) {
  const hasHeader = title != null || subtitle != null || aside != null;
  return (
    <div className={className ? `card ${className}` : "card"} style={style}>
      {hasHeader ? (
        <div className="hd">
          <div>
            {title != null ? (
              <div className="ti">{def ? <span className="def" data-def={def}>{title}</span> : title}</div>
            ) : null}
            {subtitle != null ? <div className="st">{subtitle}</div> : null}
          </div>
          {aside}
        </div>
      ) : null}
      {children}
      {footer != null ? <div className="foot">{footer}</div> : null}
    </div>
  );
}

export type CardBodyProps = { className?: string; style?: CSSProperties; children?: ReactNode };

export function CardBody({ className, style, children }: CardBodyProps) {
  return (
    <div className={className ? `bd ${className}` : "bd"} style={style}>
      {children}
    </div>
  );
}

export type LegendItem = {
  label: ReactNode;
  color?: string;
  /** e.g. "hatch" for the hatched interim-allocation swatch. */
  swatchClassName?: string;
  swatchStyle?: CSSProperties;
};

export type LegendProps = { items: LegendItem[]; className?: string; style?: CSSProperties };

export function Legend({ items, className, style }: LegendProps) {
  return (
    <div className={className ? `legend ${className}` : "legend"} style={style}>
      {items.map((item, i) => (
        <span key={i}>
          <i className={item.swatchClassName} style={{ background: item.color, ...item.swatchStyle }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
