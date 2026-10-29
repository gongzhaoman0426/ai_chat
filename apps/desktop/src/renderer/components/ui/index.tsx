import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
export const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(inputs));
const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      secondary: 'btn-secondary',
      ghost: 'btn-ghost',
      danger: 'btn-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});
export function Button({
  variant,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  layer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  layer?: number;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="modal-overlay"
          style={layer === undefined ? undefined : { zIndex: layer }}
        />
        <DialogPrimitive.Content
          className={cn('modal', wide && 'modal-wide')}
          style={layer === undefined ? undefined : { zIndex: layer + 1 }}
        >
          <div className="modal-header">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>
                {description || '修改后保存生效。'}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="modal-close" aria-label="关闭弹窗">
              <X size={18} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function Empty({
  icon,
  children,
  action,
}: {
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div>{children}</div>
      {action}
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={cn('toggle', checked && 'on')}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </label>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
