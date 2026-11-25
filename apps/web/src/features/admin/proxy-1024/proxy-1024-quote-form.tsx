import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import {
  formatCents,
  PROXY1024_PRODUCTS,
  type Proxy1024Product,
  type Proxy1024QuoteRequest,
  proxy1024QuoteRequestSchema,
  type ProxyOrderView,
} from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { PRODUCT_LABELS, QUANTITY_UNITS } from './order-meta';
import { proxy1024Api } from './proxy-1024-api';
import { errorMessage, Field, NativeSelect, Panel } from '../shared/vendor-ui';

interface StaticRow {
  country: string;
  days: 7 | 30 | 90;
  count: string;
}

const DAYS = [7, 30, 90] as const;

export function useProxy1024Catalogue(enabled = true) {
  return useQuery({
    queryKey: queryKeys.admin.proxy1024Catalogue,
    queryFn: () => proxy1024Api.catalogue(),
    staleTime: 10 * 60_000,
    enabled,
    retry: false,
  });
}

/** 报价表单：价格来自 1024 公开价目页；提交后服务端生成报价单（不下单），由确认弹窗完成下单 */
export function Proxy1024QuoteForm({ disabled, onQuoted }: { disabled: boolean; onQuoted: (order: ProxyOrderView) => void }) {
  const queryClient = useQueryClient();
  const catalogue = useProxy1024Catalogue(!disabled);
  const [product, setProduct] = useState<Proxy1024Product>('static_isp');
  const [rows, setRows] = useState<StaticRow[]>([{ country: '', days: 30, count: '1' }]);
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState('');

  const items = useMemo(() => catalogue.data?.items ?? [], [catalogue.data]);
  const countries = useMemo(
    () => [...new Set(items.filter((i) => i.product === 'static_isp' && i.country).map((i) => i.country as string))].sort(),
    [items],
  );
  const skus = items.filter((i) => i.product === product && product !== 'static_isp');

  const quote = useMutation({
    mutationFn: (body: Proxy1024QuoteRequest) => proxy1024Api.quote(body),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.proxyOrdersRoot });
      queryClient.setQueryData(queryKeys.admin.proxyOrder(order.id), order);
      onQuoted(order);
    },
    onError: (err) => {
      setError(errorMessage(err, '报价失败'));
      toast({ title: errorMessage(err, '报价失败'), variant: 'error' });
    },
  });

  const build = (): unknown => {
    if (product === 'static_isp') {
      return {
        product,
        items: rows.map((r) => ({ country: r.country.trim().toUpperCase(), days: r.days, count: Number(r.count) })),
      };
    }
    if (product === 'unlimited_bandwidth') return { product, sku, quantity: 1 };
    return { product, sku, quantity: Number(quantity) };
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const parsed = proxy1024QuoteRequestSchema.safeParse(build());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '输入有误');
      return;
    }
    if (product !== 'static_isp' && !sku) {
      setError('请选择套餐');
      return;
    }
    quote.mutate(parsed.data);
  };

  const setRow = (index: number, patch: Partial<StaticRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Panel title="新建报价" description="报价不下单、不扣费；确认弹窗会再次核对价格与余额后才向 1024 下单。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="产品">
          {(id) => (
            <NativeSelect
              id={id}
              className="max-w-xs"
              value={product}
              onChange={(e) => {
                setProduct(e.target.value as Proxy1024Product);
                setSku('');
                setQuantity('1');
              }}
            >
              {PROXY1024_PRODUCTS.map((p) => (
                <option key={p} value={p}>
                  {PRODUCT_LABELS[p]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>

        {catalogue.isError && (
          <p className="text-[13px] text-caution">价目表加载失败：{errorMessage(catalogue.error)}。静态 ISP 可手填国家代码。</p>
        )}

        {product === 'static_isp' ? (
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <Field label={`国家/地区 ${index + 1}`}>
                  {(id) => (
                    <>
                      <Input
                        id={id}
                        className="w-28"
                        list="proxy1024-static-countries"
                        value={row.country}
                        maxLength={4}
                        placeholder="US"
                        onChange={(e) => setRow(index, { country: e.target.value.toUpperCase() })}
                      />
                    </>
                  )}
                </Field>
                <Field label="时长">
                  {(id) => (
                    <NativeSelect id={id} className="w-24" value={row.days} onChange={(e) => setRow(index, { days: Number(e.target.value) as 7 | 30 | 90 })}>
                      {DAYS.map((d) => (
                        <option key={d} value={d}>
                          {d} 天
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field label="数量">
                  {(id) => (
                    <Input id={id} className="w-24" inputMode="numeric" value={row.count} onChange={(e) => setRow(index, { count: e.target.value.replace(/\D/g, '') })} />
                  )}
                </Field>
                <IconButton
                  type="button"
                  aria-label={`删除第 ${index + 1} 行`}
                  disabled={rows.length === 1}
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ))}
            <datalist id="proxy1024-static-countries">
              {countries.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <div>
              <Button type="button" variant="ghost" size="sm" disabled={rows.length >= 20} onClick={() => setRows((prev) => [...prev, { country: '', days: 30, count: '1' }])}>
                <Plus className="size-4" />
                添加一行
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="套餐">
              {(id) => (
                <NativeSelect id={id} className="min-w-64" value={sku} disabled={catalogue.isPending} onChange={(e) => setSku(e.target.value)}>
                  <option value="">{catalogue.isPending ? '价目表加载中…' : skus.length ? '请选择' : '价目表中没有该产品'}</option>
                  {skus.map((item) => (
                    <option key={item.sku} value={item.sku}>
                      {item.label} · {formatCents(item.unitPriceCents)} / {QUANTITY_UNITS[product]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            {product !== 'unlimited_bandwidth' && (
              <Field label={`数量（${QUANTITY_UNITS[product]}）`}>
                {(id) => <Input id={id} className="w-28" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} />}
              </Field>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={disabled} loading={quote.isPending}>
            获取报价
          </Button>
          {disabled && <span className="ml-3 text-xs text-ink-tertiary">采购未开启或未配置完整</span>}
        </div>
      </form>
    </Panel>
  );
}
