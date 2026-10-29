import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { useData } from '../api';
import { Field } from './ui';

type StoreGoodsItem = {
  goodsId: string;
  title?: string;
  imageUrl?: string;
  priceText?: string;
};
type StoreGoodsResult = {
  products: StoreGoodsItem[];
  page: number;
  pageSize: number;
  hasMore: boolean | null;
  online: boolean;
  reason?: string;
};

export function productLabel(id: string, catalog: Record<string, StoreGoodsItem>) {
  return catalog[id]?.title || `商品 ${id}`;
}

export function StoreProductField({
  storeId,
  selected,
  onChange,
}: {
  storeId: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [seen, setSeen] = useState<Record<string, StoreGoodsItem>>({});
  const root = useRef<HTMLDivElement>(null);
  const catalog = useData<StoreGoodsResult>(
    'stores.goods',
    { storeId, page, pageSize: 20 },
    storeId !== null,
  );
  useEffect(() => {
    const products = catalog.data?.products;
    if (!products) return;
    setSeen((prev) => {
      const next = { ...prev };
      for (const item of products) next[item.goodsId] = item;
      return next;
    });
  }, [catalog.data]);
  useEffect(() => {
    if (!open) return;
    const hide = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', hide);
    return () => document.removeEventListener('mousedown', hide);
  }, [open]);
  const products = Object.values(seen);
  const filtered = products.filter((item) => {
    const q = query.trim();
    if (!q) return true;
    return (item.title || '').includes(q) || item.goodsId.includes(q);
  });
  const missing = selected.filter((id) => !seen[id]);
  const canMore =
    catalog.data?.hasMore === true ||
    (catalog.data?.hasMore == null && (catalog.data?.products.length || 0) >= 20);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <Field
      label="适用商品"
      hint={
        storeId === null
          ? '通用问答不绑定商品；需要限定商品时请选择店铺。'
          : '下拉勾选店铺商品，可多选；不选则适用全店。'
      }
    >
      <div className="product-picker" ref={root}>
        <button
          type="button"
          className="product-picker-trigger"
          disabled={storeId === null}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => storeId !== null && setOpen((v) => !v)}
        >
          <span>
            {storeId === null
              ? '通用问答不绑定商品'
              : selected.length
                ? `已选 ${selected.length} 件商品`
                : '不限定商品 · 适用全店'}
          </span>
          <ChevronDown size={16} />
        </button>
        {open && storeId !== null && (
          <div className="product-picker-menu" role="listbox" aria-multiselectable>
            <label className="product-picker-search">
              <Search size={14} />
              <input
                aria-label="筛选店铺商品"
                placeholder="筛选名称或编号"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {catalog.isPending && page === 1 && <p className="muted">正在读取店铺商品…</p>}
            {catalog.error && (
              <p className="muted" role="alert">
                {catalog.error.message}
              </p>
            )}
            {catalog.data?.reason && <p className="muted">{catalog.data.reason}</p>}
            {missing.map((id) => (
              <label key={id} className="product-picker-item">
                <input type="checkbox" checked onChange={() => toggle(id)} />
                <span>
                  {productLabel(id, seen)}
                  <small>当前列表未包含，取消勾选后不再保留</small>
                </span>
              </label>
            ))}
            {filtered.map((item) => (
              <label key={item.goodsId} className="product-picker-item">
                <input
                  type="checkbox"
                  checked={selected.includes(item.goodsId)}
                  onChange={() => toggle(item.goodsId)}
                />
                {item.imageUrl ? <img src={item.imageUrl} alt="" /> : null}
                <span>
                  {item.title || `商品 ${item.goodsId}`}
                  <small>
                    {item.priceText ? `${item.priceText} · ${item.goodsId}` : item.goodsId}
                  </small>
                </span>
              </label>
            ))}
            {!catalog.isPending && !filtered.length && !missing.length && !catalog.data?.reason && (
              <p className="muted">没有可勾选的店铺商品</p>
            )}
            {canMore && (
              <button
                type="button"
                className="product-picker-more"
                disabled={catalog.isFetching}
                onClick={() => setPage((n) => n + 1)}
              >
                {catalog.isFetching ? '加载中…' : '加载更多商品'}
              </button>
            )}
          </div>
        )}
        {!!selected.length && (
          <div className="product-picker-chips">
            {selected.map((id) => (
              <button key={id} type="button" onClick={() => toggle(id)}>
                {productLabel(id, seen)}
                <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}
