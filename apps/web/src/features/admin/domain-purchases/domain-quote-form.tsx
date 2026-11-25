import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MAX_DOMAIN_QUOTE_NAMES } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { domainPurchaseApi } from './domain-purchases-api';
import { splitDomains } from './domain-meta';
import { errorMessage, Field, IntField, Panel } from '../shared/vendor-ui';

/** 粘贴域名列表 → 报价（可用性 + 价格，不扣费）→ 进入批次页核对并确认 */
export function DomainQuoteForm({ disabled, maxBatchDomains, defaultYears }: { disabled: boolean; maxBatchDomains: number; defaultYears: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [years, setYears] = useState<number | null>(null);
  const [error, setError] = useState('');
  const count = splitDomains(text).length;
  const limit = Math.min(maxBatchDomains, MAX_DOMAIN_QUOTE_NAMES);
  const tooMany = count > limit;

  const quote = useMutation({
    mutationFn: () => domainPurchaseApi.quote({ domains: text, years: years ?? undefined }),
    onSuccess: (batch) => {
      queryClient.setQueryData(queryKeys.admin.domainBatch(batch.id), batch);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.domainPurchasesRoot });
      navigate(`/admin/domain-purchases/${batch.id}`);
    },
    onError: (err) => {
      setError(errorMessage(err, '报价失败'));
      toast({ title: errorMessage(err, '报价失败'), variant: 'error' });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (count === 0) return setError('请粘贴至少一个域名');
    if (tooMany) return setError(`每批最多 ${limit} 个域名`);
    quote.mutate();
  };

  return (
    <Panel title="新建采购报价" description="报价只查询可用性与价格，不会注册或扣费。">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="域名列表" hint={`空白、逗号或分号分隔；已识别 ${count} 个，每批最多 ${limit} 个`}>
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              className="font-mono text-[13px]"
              placeholder={'example-one.com\nexample-two.net'}
              value={text}
              invalid={tooMany}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <IntField label="注册年限" value={years ?? defaultYears} min={1} max={10} onChange={setYears} />
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={disabled || count === 0 || tooMany} loading={quote.isPending}>
            获取报价
          </Button>
          {disabled && <span className="ml-3 text-xs text-ink-tertiary">采购未开启或未配置完整</span>}
        </div>
      </form>
    </Panel>
  );
}
