import type { PayBasis, WorkerDto } from '@meridian/shared';
import { Check, Copy } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Alert, Button, Modal } from '../../components/ui';
import { formatMoney } from '../../lib/format';

/** "€60,000.00/yr" or "€5,000.00/mo". */
export function formatSalary(
  worker: Pick<WorkerDto, 'salaryMinor' | 'currency' | 'payBasis'>,
): string {
  return `${formatMoney(worker.salaryMinor, worker.currency)}${worker.payBasis === 'annual' ? '/yr' : '/mo'}`;
}

export const PAY_BASIS_LABELS: Record<PayBasis, string> = {
  annual: 'Annual',
  monthly: 'Monthly',
};

/**
 * A labelled group of radio buttons. The UI kit has no radio control, and two
 * pages here need one, so it lives next to them (reported as a shell gap).
 */
export function RadioGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
  error,
}: {
  legend: string;
  value: T;
  options: { value: T; label: string; description?: ReactNode }[];
  onChange: (value: T) => void;
  error?: string;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-ink-700">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
              value === option.value ? 'border-brand-600 bg-brand-50' : 'border-ink-300 bg-white'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-0.5 accent-brand-700"
            />
            <span>
              <span className="font-medium text-ink-900">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block text-xs text-ink-500">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-sm text-red-600">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Shows a freshly created portal invite link. There is no email service, so the
 * person hiring has to send the link themselves — the modal says so plainly.
 */
export function InviteLinkModal({
  open,
  acceptUrl,
  workerName,
  onClose,
  closeLabel = 'Done',
}: {
  open: boolean;
  acceptUrl: string;
  workerName: string;
  onClose: () => void;
  closeLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(acceptUrl);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Clipboard access can be refused (permissions, insecure context): let them copy by hand.
      setCopyFailed(true);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Portal invite link"
      description={`Send this link to ${workerName} so they can set a password and use the worker portal.`}
      footer={<Button onClick={onClose}>{closeLabel}</Button>}
    >
      <div className="space-y-4">
        <Alert tone="info">
          Meridian does not send email in this version. Copy the link and send it yourself. It can
          only be used once, and creating a new link replaces this one.
        </Alert>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={acceptUrl}
            aria-label="Invite link"
            onFocus={(event) => event.currentTarget.select()}
            className="block h-10 w-full min-w-0 rounded-lg border border-ink-300 bg-ink-50 px-3 text-sm text-ink-800"
          />
          <Button
            variant="secondary"
            onClick={() => void copy()}
            icon={
              copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )
            }
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
        {copyFailed && (
          <p className="text-sm text-ink-600">
            Your browser blocked copying. Select the link above and copy it manually.
          </p>
        )}
      </div>
    </Modal>
  );
}
