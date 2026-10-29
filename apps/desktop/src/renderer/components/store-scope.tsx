import { Store } from 'lucide-react';
import { useData, useUi } from '../api';
import { platformNames, type PlatformId } from '../../../../../packages/contracts/src/platform';
export function StoreScope({
  label = '当前店铺',
  allowAll = false,
  value,
  onChange,
}: {
  label?: string;
  allowAll?: boolean;
  value?: string;
  onChange?: (storeId: string) => void;
}) {
  const { data: stores = [] } = useData<any[]>('stores.list');
  const ui = useUi();
  const current =
    value !== undefined
      ? value
      : stores.some((s) => s.id === ui.storeId)
        ? ui.storeId
        : (stores[0]?.id ?? '');
  return (
    <label className="page-store-scope">
      <Store size={15} />
      <span>{label}</span>
      <select
        aria-label={label}
        value={current}
        onChange={(e) => (onChange ? onChange(e.target.value) : ui.setStore(e.target.value))}
      >
        {allowAll && <option value="">全部店铺</option>}
        {!stores.length && !allowAll && <option value="">尚未连接店铺</option>}
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {platformNames[s.platform as PlatformId]}
          </option>
        ))}
      </select>
    </label>
  );
}
