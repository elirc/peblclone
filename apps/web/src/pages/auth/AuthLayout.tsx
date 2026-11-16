import { Globe2 } from 'lucide-react';
import type { ReactNode } from 'react';

/** Centered card used by login, register and accept-invite. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-700 text-white">
            <Globe2 className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-ink-500">{subtitle}</p>}
        </div>
        <div className="rounded-xl border border-ink-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
        {footer && <p className="mt-6 text-center text-sm text-ink-500">{footer}</p>}
      </div>
    </div>
  );
}
