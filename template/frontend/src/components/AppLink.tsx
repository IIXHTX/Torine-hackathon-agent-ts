import type { AnchorHTMLAttributes, ReactNode } from 'react';

// Plain anchors, NOT react-router <Link>: test helpers assert immediately
// after a click resolves, and SPA transitions race those checks. Full page
// loads make Playwright's click() wait for the destination to render.
export function Link({
  to,
  children,
  className,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  );
}
